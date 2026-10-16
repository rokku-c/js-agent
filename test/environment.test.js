import { test } from "node:test";
import assert from "node:assert/strict";
import { Vfs } from "../src/kernel/vfs.js";
import { createEnvironment } from "../src/runtime.js";

async function fixture() {
  const storage = new Vfs();
  await storage.mount("mem", "/");
  await storage.mkdirp("/models");
  await storage.mkdirp("/tools/lookup");
  await storage.mkdirp("/tools/hidden");
  await storage.mkdirp("/workspace");
  await storage.write("/models/reviewer.json", JSON.stringify({ provider: "fixture", model: "reviewer" }), { create: true });
  await storage.write("/tools/lookup/definition.json", JSON.stringify({
    name: "lookup",
    description: "Look up the review brief.",
    input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    entry: "entry.js",
  }), { create: true });
  await storage.write("/tools/hidden/definition.json", JSON.stringify({
    name: "hidden",
    description: "A tool that is discoverable but not selected.",
    input_schema: { type: "object" },
  }), { create: true });
  await storage.write("/workspace/brief.md", "Keep the API small.\n", { create: true });
  return storage;
}

function permissions() {
  return {
    agent: [
      { path: "/workspace/**", operations: ["read"] },
    ],
    model: [
      { path: "/models/reviewer.json", operations: ["read"] },
    ],
    tools: [
      { path: "/tools", operations: ["list"] },
      { path: "/tools/**", operations: ["read"] },
      { path: "/workspace/**", operations: ["read"] },
    ],
    observer: [
      { path: "/runs/**", operations: ["stat", "list", "read"] },
    ],
  };
}

test("createEnvironment runs a resource-backed app with isolated adapter and observer views", async () => {
  const storage = await fixture();
  const modelReads = [];
  const toolReads = [];
  const model = {
    path: "/models/reviewer",
    async request(request, { resources }) {
      modelReads.push(await resources.read("/models/reviewer.json"));
      await assert.rejects(() => resources.read("/workspace/brief.md"), { code: "EACCES" });
      if (request.messages.length === 1) {
        return {
          content: [{ type: "tool_use", id: "lookup-1", name: "lookup", input: { path: "/workspace/brief.md" } }],
          stop_reason: "tool_use",
        };
      }
      return { content: [{ type: "text", text: request.messages.at(-1).content[0].content }], stop_reason: "end_turn" };
    },
  };
  const env = createEnvironment({
    resources: storage,
    model: { path: model.path, adapter: model },
    tools: {
      paths: ["/tools/lookup"],
      adapters: [{
        path: "/tools/lookup",
        async invoke({ input, resources }) {
          toolReads.push(await resources.read(input.path));
          await assert.rejects(() => resources.read("/models/reviewer.json"), { code: "EACCES" });
          return await resources.read(input.path);
        },
      }],
    },
    permissions: permissions(),
  });

  assert.deepEqual((await env.catalog()).map(({ name }) => name), ["lookup"]);
  assert.deepEqual((await env.discoverTools()).map(({ name }) => name).sort(), ["hidden", "lookup"]);
  assert.deepEqual(env.describe().adapterBoundary, {
    model: { path: "/models/reviewer", kind: "trusted-host-adapter" },
    tools: [{ path: "/tools/lookup", kind: "trusted-host-adapter" }],
  });
  assert.deepEqual(env.permissions.model().grants, permissions().model);
  assert.deepEqual(env.permissions.observer().grants, permissions().observer);

  const result = await env.run({
    agent: {
      model: "/models/reviewer",
      context: ["/workspace/brief.md"],
      tools: ["/tools/lookup"],
    },
    input: "Review the brief.",
    id: "environment-root",
    continuationId: "environment-continuation",
  });

  assert.equal(result.status, "completed");
  assert.equal(result.root.status, "completed_with_tool_calls");
  assert.equal(result.continuation.status, "completed");
  assert.deepEqual(modelReads, [JSON.stringify({ provider: "fixture", model: "reviewer" }), JSON.stringify({ provider: "fixture", model: "reviewer" })]);
  assert.deepEqual(toolReads, ["Keep the API small.\n"]);
  assert.equal(result.root.response.content[0].name, "lookup");
  assert.equal(result.continuation.response.content[0].text, "Keep the API small.\n");

  const observed = await env.observe.inspect(result.root.id);
  assert.equal(observed.status.status, "completed_with_tool_calls");
  assert.deepEqual(observed.events.map((event) => event.kind), ["started", "completed"]);
  const redacted = await env.observer.snapshot(result.root.id);
  assert.equal(redacted.status, "completed_with_tool_calls");
  assert.equal(redacted.storage, "volatile");
  assert.equal(redacted.redacted, true);
  assert.equal("request" in redacted, false);
  assert.equal("plan" in redacted, false);
  assert.equal("response" in redacted, false);
  await assert.rejects(() => env.observe.read("/workspace/brief.md"), { code: "EACCES" });
});

test("model, tool, and run observer permissions remain independently configurable", async () => {
  const storage = await fixture();
  const env = createEnvironment({
    resources: storage,
    model: {
      path: "/models/reviewer",
      adapter: { async request() { return { content: [{ type: "text", text: "ok" }] }; } },
    },
    tools: { paths: [], adapters: [] },
    permissions: {
      agent: [{ path: "/workspace/**", operations: ["read"] }],
      model: [{ path: "/models/reviewer.json", operations: ["read"] }],
      tools: [],
      observer: [],
    },
  });

  const result = await env.run({
    agent: { model: "/models/reviewer", context: ["/workspace/brief.md"], tools: [] },
    input: "Read it.",
    id: "unobserved-run",
  });
  await assert.rejects(() => env.observe.inspect(result.root?.id ?? result.id), { code: "EACCES" });
  assert.deepEqual(env.permissions.tools().grants, []);
});

test("createEnvironment requires exact trusted adapter paths and does not discover tools during a run", async () => {
  const storage = await fixture();
  const env = createEnvironment({
    resources: storage,
    model: { path: "/models/reviewer", adapter: { async request() { return { content: [{ type: "text", text: "ok" }] }; } } },
    tools: {
      paths: ["/tools/lookup"],
      adapters: [{ path: "/tools/other", invoke() {} }],
    },
    permissions: permissions(),
  });
  await assert.rejects(
    () => env.run({ agent: { model: "/models/reviewer", tools: ["/tools/lookup"] }, input: "run" }),
    { code: "EACCES" },
  );
});
