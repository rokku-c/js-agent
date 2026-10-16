import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { Vfs } from "../src/kernel/vfs.js";
import { createEnvironment, createRunStore, createWorkflowGraph } from "../src/runtime.js";

async function openStorage(directory) {
  const storage = new Vfs();
  await storage.mount("hostfs", "/", { source: directory, mode: "rw" });
  return storage;
}

async function seed(storage, tenant) {
  const base = `/tenants/${tenant}`;
  await storage.mkdirp(`${base}/models`);
  await storage.mkdirp(`${base}/tools/echo`);
  await storage.mkdirp(`${base}/workspace`);
  await storage.write(`${base}/models/model.json`, JSON.stringify({ tenant }), { create: true });
  await storage.write(`${base}/tools/echo/definition.json`, JSON.stringify({
    name: "echo",
    description: `Echo ${tenant} input`,
    input_schema: { type: "object", properties: { path: { type: "string" } } },
  }), { create: true });
  await storage.write(`${base}/workspace/secret.txt`, `${tenant}-secret`, { create: true });
}

function grants(tenant) {
  const base = `/tenants/${tenant}`;
  return {
    agent: [{ path: `${base}/workspace/**`, operations: ["read"] }],
    model: [{ path: `${base}/models/model.json`, operations: ["read"] }],
    tools: [
      { path: `${base}/tools/**`, operations: ["read"] },
      { path: `${base}/workspace/**`, operations: ["read"] },
    ],
    observer: [{ path: `${base}/runs/**`, operations: ["stat", "list", "read"] }],
  };
}

function denyOtherTenant(promise) {
  return assert.rejects(promise, { code: "EACCES" });
}

function tenantConfig(storage, tenant, services) {
  const base = `/tenants/${tenant}`;
  const other = tenant === "a" ? "b" : "a";
  const model = {
    path: `${base}/models/model`,
    serviceGrants: [`${tenant}.model`],
    async request(request, { resources, services: authority }) {
      assert.equal(await resources.read(`${base}/models/model.json`), JSON.stringify({ tenant }));
      await denyOtherTenant(resources.read(`/tenants/${other}/workspace/secret.txt`));
      assert.equal(await authority.call(`${tenant}.model`), `${tenant}-model`);
      await denyOtherTenant(authority.call(`${other}.model`));
      if (request.messages.length === 1) {
        return {
          content: [{ type: "tool_use", id: `${tenant}-echo-1`, name: "echo", input: { path: `${base}/workspace/secret.txt` } }],
          stop_reason: "tool_use",
        };
      }
      return { content: [{ type: "text", text: `${tenant}-done` }], stop_reason: "end_turn" };
    },
  };
  const adapter = {
    path: `${base}/tools/echo`,
    serviceGrants: [`${tenant}.tool`],
    async invoke({ input, resources, services: authority }) {
      assert.equal(await resources.read(input.path), `${tenant}-secret`);
      await denyOtherTenant(resources.read(`/tenants/${other}/workspace/secret.txt`));
      assert.equal(await authority.call(`${tenant}.tool`), `${tenant}-tool`);
      await denyOtherTenant(authority.call(`${other}.tool`));
      return `${tenant}-tool-result`;
    },
  };
  return {
    model,
    tools: { paths: [adapter.path], adapters: [adapter] },
    modelConfig: { path: model.path, serviceGrants: model.serviceGrants, adapter: model },
    adapterConfig: adapter,
    services: {
      [`${tenant}.model`]: () => `${tenant}-model`,
      [`${tenant}.tool`]: () => `${tenant}-tool`,
      [`${other}.model`]: () => `${other}-model`,
      [`${other}.tool`]: () => `${other}-tool`,
    },
  };
}

test("two durable environments keep views, adapters, services, runs, and graphs tenant-local", async () => {
  const directory = await mkdtemp(`${os.tmpdir()}/js-agent-tenants-`);
  try {
    const storage = await openStorage(directory);
    await seed(storage, "a");
    await seed(storage, "b");
    const configA = tenantConfig(storage, "a");
    const configB = tenantConfig(storage, "b");
    const sharedServices = { ...configA.services, ...configB.services };
    const storeA = createRunStore(storage, { root: "/tenants/a/runs", mode: "durable" });
    const storeB = createRunStore(storage, { root: "/tenants/b/runs", mode: "durable" });
    const envA = createEnvironment({
      resources: storage,
      storage,
      store: storeA,
      graphRoot: "/tenants/a/graphs",
      model: configA.modelConfig,
      tools: configA.tools,
      services: sharedServices,
      permissions: grants("a"),
    });
    const envB = createEnvironment({
      resources: storage,
      storage,
      store: storeB,
      graphRoot: "/tenants/b/graphs",
      model: configB.modelConfig,
      tools: configB.tools,
      services: sharedServices,
      permissions: grants("b"),
    });

    // Configuration objects can be reused by a host and then mutated. Bound paths,
    // functions, views, and service grants must remain the values captured at build time.
    configA.modelConfig.path = "/tenants/b/models/changed";
    configA.modelConfig.adapter = async () => { throw new Error("mutated model called"); };
    configA.modelConfig.serviceGrants.splice(0, 1, "b.model");
    configA.tools.paths[0] = "/tenants/b/tools/echo";
    configA.adapterConfig.invoke = async () => { throw new Error("mutated tool called"); };
    configA.adapterConfig.serviceGrants.splice(0, 1, "b.tool");

    const [runA, runB] = await Promise.all([
      envA.run({
        agent: { model: "/tenants/a/models/model", context: ["/tenants/a/workspace/secret.txt"], tools: ["/tenants/a/tools/echo"] },
        input: "a request",
        id: "same-run",
        continuationId: "same-continuation",
      }),
      envB.run({
        agent: { model: "/tenants/b/models/model", context: ["/tenants/b/workspace/secret.txt"], tools: ["/tenants/b/tools/echo"] },
        input: "b request",
        id: "same-run",
        continuationId: "same-continuation",
      }),
    ]);
    assert.equal(runA.continuation.response.content[0].text, "a-done");
    assert.equal(runB.continuation.response.content[0].text, "b-done");
    assert.equal((await envA.observer.snapshot("same-run")).status, "completed_with_tool_calls");
    assert.equal((await envB.observer.snapshot("same-run")).status, "completed_with_tool_calls");

    const [graphA, graphB] = await Promise.all([
      envA.createWorkflowGraph().startRoot({ graphId: "shared-graph", ...await envA.prepareWorkflow({
        agent: { model: "/tenants/a/models/model", tools: ["/tenants/a/tools/echo"] }, input: "graph-a",
      }) }),
      envB.createWorkflowGraph().startRoot({ graphId: "shared-graph", ...await envB.prepareWorkflow({
        agent: { model: "/tenants/b/models/model", tools: ["/tenants/b/tools/echo"] }, input: "graph-b",
      }) }),
    ]);
    assert.equal(graphA.graph.path, "/tenants/a/graphs/shared-graph");
    assert.equal(graphB.graph.path, "/tenants/b/graphs/shared-graph");
    assert.equal((await envA.observe.inspect("same-run")).path, "/tenants/a/runs/same-run");
    assert.equal((await envB.observe.inspect("same-run")).path, "/tenants/b/runs/same-run");

    await denyOtherTenant(envA.observe.read("/tenants/b/workspace/secret.txt"));
    await denyOtherTenant(envB.observe.read("/tenants/a/workspace/secret.txt"));
    await denyOtherTenant(envA.observe.list("/tenants/b/runs"));
    await denyOtherTenant(envB.observe.list("/tenants/a/runs"));
    await denyOtherTenant(envA.observe.inspect("/tenants/b/runs/same-run"));
    await denyOtherTenant(envB.observe.inspect("/tenants/a/runs/same-run"));
    assert.throws(() => envA.createWorkflowGraph({ root: "/tenants/b/graphs" }), { code: "EACCES" });
    assert.throws(() => envB.createWorkflowGraph({ root: "/tenants/a/graphs" }), { code: "EACCES" });
    await assert.rejects(() => envA.createWorkflowGraph().inspect("../b"), { code: "EINVAL" });
    assert.throws(() => envA.createWorkflowGraph({ root: "/tenants/a/runs" }), { code: "EACCES" });
    await assert.rejects(() => envA.run({
      agent: { model: "/tenants/b/models/model", context: ["/tenants/b/workspace/secret.txt"], tools: [] },
      input: "cross-tenant", id: "cross-tenant",
    }), { code: "EACCES" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("environment rejects stores from a different storage adapter", async () => {
  const directory = await mkdtemp(`${os.tmpdir()}/js-agent-store-owner-`);
  try {
    const storageA = await openStorage(directory);
    const storageB = await openStorage(directory);
    const storeB = createRunStore(storageB, { root: "/tenants/b/runs", mode: "durable" });
    assert.throws(() => createEnvironment({
      resources: storageA,
      storage: storageA,
      store: storeB,
      model: { path: "/model", adapter: async () => ({ content: [] }) },
    }), { code: "EINVAL" });
    assert.throws(() => createWorkflowGraph({ storage: storageA, store: storeB, root: "/tenants/b/runs" }), { code: "EINVAL" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
