import { test } from "node:test";
import assert from "node:assert/strict";
import { createServiceAuthority, createEnvironment } from "js-agent/runtime";
import { Vfs } from "js-agent/kernel";
import { createConnectorDemo } from "../examples/connector-service-authority.js";

const denied = (fn) => assert.rejects(fn, { code: "EACCES" });

test("service authority denies by default, snapshots handlers, and attenuates transitively", async () => {
  let calls = 0;
  const handlers = { "model.request": async (input, options) => { calls++; return { input, signal: options.signal }; }, "network.health": async () => "ok" };
  await denied(() => createServiceAuthority(handlers).call("model.request", {}));
  const grants = ["model.request"];
  const authority = createServiceAuthority(handlers, { grants });
  grants.push("network.health");
  handlers["model.request"] = () => { throw new Error("mutated handler"); };
  authority.describe().grants.push("network.health");
  const child = authority.derive({ grants: ["model.request", "network.health"] });
  assert.deepEqual(child.describe(), { grants: ["model.request"] });
  const signal = new AbortController().signal;
  assert.deepEqual(await child.call("model.request", { prompt: "hi" }, { signal }), { input: { prompt: "hi" }, signal });
  await denied(() => child.call("network.health"));
  await denied(() => child.call("toString"));
  await denied(() => child.derive().derive({ grants }).call("model.request"));
  assert.equal(calls, 1);
  assert.equal(Object.isFrozen(authority), true);
  assert.deepEqual(Object.keys(authority).sort(), ["call", "derive", "describe"]);
  for (const bad of [null, "model.request", ["*"], [null], new Array(1)]) {
    assert.throws(() => createServiceAuthority(handlers, { grants: bad }), { code: "EINVAL" });
  }
  assert.throws(() => createServiceAuthority({ bad: 1 }), { code: "EINVAL" });
});

test("model uses private credentials at a fixed endpoint; narrower tool and observer cannot read secrets", async () => {
  const outbound = [];
  const env = await createConnectorDemo({ transport: async (url, options) => {
    outbound.push({ url, options });
    const request = JSON.parse(options.body);
    return request.messages.length === 1
      ? { content: [{ type: "tool_use", id: "lookup-1", name: "lookup", input: { path: "/workspace/brief.md" } }], stop_reason: "tool_use" }
      : { content: [{ type: "text", text: request.messages.at(-1).content[0].content }] };
  } });
  const prepared = await env.prepareWorkflow();
  await denied(() => prepared.resources.read("/secrets/provider"));
  await denied(() => env.observe.read("/secrets/provider"));
  assert.match(await prepared.resources.read("/workspace/internal.md"), /Visible to the agent/);
  const lookup = prepared.toolAdapters.get("lookup");
  for (const path of ["/workspace/internal.md", "/workspace/../secrets/provider", "/tools/lookup/definition.json"]) {
    await denied(() => lookup({ input: { path } }));
  }
  const result = await env.run({
    agent: { model: "/models/default", tools: ["/tools/lookup"] }, input: "Read the brief.",
    id: "private-service", continuationId: "private-service-continuation",
  });
  assert.equal(result.status, "completed");
  assert.equal(result.continuation.response.content[0].text, "Only the brief is delegated to lookup.");
  assert.equal(outbound.length, 2);
  for (const { url, options } of outbound) {
    assert.equal(url, "https://model.example.invalid/v1/messages");
    assert.equal(options.method, "POST");
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.authorization, "Bearer offline-test-credential");
  }
  const persisted = [];
  async function readTree(path) {
    for (const entry of await env.observe.list(path)) {
      const child = `${path}/${entry.name}`;
      if ((await env.observe.stat(child)).type === "dir") await readTree(child);
      else persisted.push(await env.observe.read(child));
    }
  }
  await readTree("/runs");
  assert.ok(persisted.length > 0);
  assert.doesNotMatch(JSON.stringify({ result, persisted, description: env.describe(), observed: await env.observer.snapshot(result.root.id) }), /offline-test-credential|Bearer /);
});

test("Environment delegates services independently and cannot widen an injected authority", async () => {
  const resources = new Vfs();
  await resources.mount("mem", "/");
  for (const tool of ["narrow", "other"]) {
    await resources.mkdirp(`/tools/${tool}`);
    await resources.write(`/tools/${tool}/definition.json`, JSON.stringify({ name: tool, description: "Test scoped authority.", input_schema: { type: "object" } }), { create: true });
  }
  const authority = createServiceAuthority({ model: () => "model", network: () => "network" }, { grants: ["model"] });
  let modelServices;
  const env = createEnvironment({
    resources, services: authority,
    model: { path: "/model", serviceGrants: ["model", "network"], adapter: async (_input, options) => {
      modelServices = options.services;
      await denied(() => options.resources.read("/secrets/provider"));
      return options.services.call("model");
    } },
    tools: { paths: ["/tools/narrow", "/tools/other"], adapters: [
      { path: "/tools/narrow", resourceGrants: [{ path: "/**", operations: ["read", "write"] }], serviceGrants: ["network"], invoke: async ({ resources: view, services }) => {
        await denied(() => view.write("/tools/narrow/definition.json", "bad"));
        await denied(() => view.read("/secrets/provider"));
        await denied(() => services.call("network"));
        await denied(() => services.call("model"));
        return view.read("/tools/narrow/definition.json");
      } },
      { path: "/tools/other", serviceGrants: ["model"], invoke: ({ services }) => services.call("model") },
    ] },
    permissions: { tools: [{ path: "/tools/**", operations: ["read"] }] },
  });
  const prepared = await env.prepareWorkflow();
  assert.equal(await prepared.model.request({}, { services: authority }), "model");
  await denied(() => modelServices.call("network"));
  assert.match(await prepared.toolAdapters.get("narrow")({ input: {}, services: authority, resources }), /narrow/);
  assert.equal(await prepared.toolAdapters.get("other")({ input: {} }), "model");
  assert.deepEqual(env.describe().delegation.model.services, { grants: ["model"] });
});

test("trusted service sanitizes transport errors before they reach the adapter", async () => {
  const env = await createConnectorDemo({ transport: async () => { throw new Error("Bearer offline-test-credential"); } });
  const prepared = await env.prepareWorkflow();
  await assert.rejects(() => prepared.model.request({ messages: [] }), (error) => {
    assert.equal(error.code, "ESERVICE");
    assert.equal(error.message, "Model service request failed");
    assert.equal(error.cause, undefined);
    return true;
  });
});
