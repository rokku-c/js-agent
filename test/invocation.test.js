import { test } from "node:test";
import assert from "node:assert/strict";
import { Vfs } from "../src/kernel/vfs.js";
import { createRunStore } from "../src/core/run-store.js";
import { invokeOnce } from "../src/core/invocation.js";

async function setup() {
  const vfs = new Vfs();
  await vfs.mount("mem", "/", {});
  const resources = {
    async read(path) {
      const files = { "/system": "be exact", "/context": "known fact" };
      if (!(path in files)) { const e = new Error(`missing ${path}`); e.code = "ENOENT"; throw e; }
      return files[path];
    },
  };
  return { vfs, resources, store: createRunStore(vfs) };
}

function modelSpy(response = { content: [{ type: "text", text: "done" }] }) {
  const calls = [];
  return {
    adapter: { path: "/models/default", async request(request, options) { calls.push({ request, options }); return response; } },
    calls,
  };
}

const agent = { model: "/models/default", system: ["/system"], context: ["/context"], tools: ["/tools/read"] };
const tools = [{ path: "/tools/read", name: "read", description: "Read", input_schema: { type: "object" } }];

test("invocation performs one request and persists its frozen materialization", async () => {
  const { vfs, resources, store } = await setup();
  const fake = modelSpy({ content: [{ type: "tool_use", id: "t1", name: "read", input: {} }] });
  const result = await invokeOnce({ resources, agent, input: "inspect", model: fake.adapter, tools, store, id: "one" });

  assert.equal(result.status, "completed");
  assert.deepEqual(result.toolCalls[0].name, "read");
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].request.messages[0].content, "inspect\n\n[context /context]\nknown fact");
  assert.ok(Object.isFrozen(fake.calls[0].request));
  assert.ok(Object.isFrozen(fake.calls[0].request.tools));
  const events = (await vfs.read("/runs/one/events.jsonl")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(events.map((event) => event.kind), ["started", "completed"]);
  assert.deepEqual(events.map((event) => event.seq), [1, 2]);
  assert.match(await vfs.read("/runs/one/status.json"), /"status": "completed"/);
  assert.deepEqual(JSON.parse(await vfs.read("/runs/one/response.json")), { content: [{ type: "tool_use", id: "t1", name: "read", input: {} }] });
});

test("missing references and unsupported authored fields fail before dispatch", async () => {
  const { resources, store } = await setup();
  const fake = modelSpy();
  await assert.rejects(() => invokeOnce({ resources, agent: { ...agent, context: ["/missing"] }, input: "x", model: fake.adapter, tools, store, id: "missing" }), /missing/);
  for (const field of ["view", "revision", "runtime"]) {
    await assert.rejects(() => invokeOnce({ resources, agent: { ...agent, [field]: "host" }, input: "x", model: fake.adapter, tools, store, id: `unsupported-${field}` }), /unsupported AgentSpec field/);
  }
  assert.equal(fake.calls.length, 0);
});

test("trusted model and selected tools require exact paths and unique names", async () => {
  const { resources, store } = await setup();
  const fake = modelSpy();
  await assert.rejects(() => invokeOnce({ resources, agent, input: "x", model: { ...fake.adapter, path: "/models/other" }, tools, store, id: "wrong-model" }), /exact supplied/);
  await assert.rejects(() => invokeOnce({ resources, agent: { ...agent, tools: ["/tools/a", "/tools/b"] }, input: "x", model: fake.adapter, tools: [{ ...tools[0], path: "/tools/a" }, { ...tools[0], path: "/tools/b" }], store, id: "duplicate" }), /duplicate/);
  assert.equal(fake.calls.length, 0);
});

test("duplicate reservations are rejected concurrently", async () => {
  const { resources, store } = await setup();
  const fake = modelSpy();
  const runs = await Promise.allSettled([
    invokeOnce({ resources, agent: { model: "/models/default" }, input: "a", model: fake.adapter, store, id: "same" }),
    invokeOnce({ resources, agent: { model: "/models/default" }, input: "b", model: fake.adapter, store, id: "same" }),
  ]);
  assert.equal(runs.filter((x) => x.status === "fulfilled").length, 1);
  assert.equal(runs.filter((x) => x.status === "rejected")[0].reason.code, "EEXIST");
  assert.equal(fake.calls.length, 1);
});

test("cancellation before start is recorded without a model request", async () => {
  const { resources, store } = await setup();
  const fake = modelSpy();
  const controller = new AbortController();
  controller.abort();
  const result = await invokeOnce({ resources, agent: { model: "/models/default" }, input: "x", model: fake.adapter, store, signal: controller.signal, id: "cancelled" });
  assert.equal(result.status, "cancelled");
  assert.equal(fake.calls.length, 0);
  assert.match(await store.readStatus("cancelled").then((x) => x.status), /cancelled/);
});

test("adapter failure after dispatch is recorded as unknown", async () => {
  const { resources, store } = await setup();
  const error = new Error("adapter failed");
  const fake = { path: "/models/default", async request() { throw error; } };
  await assert.rejects(() => invokeOnce({ resources, agent: { model: "/models/default" }, input: "x", model: fake, store, id: "unknown" }), /adapter failed/);
  assert.equal((await store.readStatus("unknown")).status, "unknown");
});

test("admission reference failure is recorded and never dispatches", async () => {
  const { vfs, resources, store } = await setup();
  const fake = modelSpy();
  await assert.rejects(() => invokeOnce({ resources, agent: { model: "/models/default", context: ["/missing"] }, input: "x", model: fake.adapter, store, id: "admission-failed" }), /missing/);
  assert.equal(fake.calls.length, 0);
  assert.equal((await store.readStatus("admission-failed")).status, "failed");
});

test("start storage failure prevents dispatch", async () => {
  const { vfs, resources } = await setup();
  const originalWrite = vfs.write.bind(vfs);
  const broken = {
    mkdirp: vfs.mkdirp.bind(vfs),
    mkdir: vfs.mkdir.bind(vfs),
    rename: vfs.rename.bind(vfs),
    async write(path, data, options) {
      if (path.endsWith("/events.jsonl")) { const e = new Error("journal unavailable"); e.code = "EIO"; throw e; }
      return originalWrite(path, data, options);
    },
    read: vfs.read.bind(vfs),
  };
  const store = createRunStore(broken);
  const fake = modelSpy();
  await assert.rejects(() => invokeOnce({ resources, agent: { model: "/models/default" }, input: "x", model: fake.adapter, store, id: "start-failed" }), /journal unavailable/);
  assert.equal(fake.calls.length, 0);
  assert.equal((await store.readStatus("start-failed")).status, "failed");
});

test("atomic directory reservation rejects the same id across stores", async () => {
  const { vfs } = await setup();
  const first = createRunStore(vfs);
  const second = createRunStore(vfs);
  await first.reserve("cross-store", { request: {}, plan: {} });
  await assert.rejects(() => second.reserve("cross-store", { request: {}, plan: {} }), (error) => error.code === "EEXIST");
});

test("agent, tools, and model method are captured before awaited reference reads", async () => {
  const vfs = new Vfs();
  await vfs.mount("mem", "/", {});
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const resources = { async read(path) { await gate; return path === "/context" ? "stable" : "{}"; } };
  const calls = [];
  const model = {
    path: "/models/default",
    async request(request) { calls.push(request); return { content: [{ type: "text", text: "ok" }] }; },
  };
  const mutableAgent = { model: "/models/default", context: ["/context"] };
  const mutableTools = [];
  const run = invokeOnce({ resources, agent: mutableAgent, input: "x", model, tools: mutableTools, store: createRunStore(vfs), id: "captured" });
  mutableAgent.context = [];
  mutableAgent.model = "/models/changed";
  mutableTools.push({ path: "/tools/changed", name: "changed" });
  const originalRequest = model.request;
  model.request = async () => { throw new Error("mutated method used"); };
  release();
  await run;
  assert.equal(calls.length, 1);
  assert.match(calls[0].messages[0].content, /stable/);
  assert.notEqual(model.request, originalRequest);
});

test("response shape and byte bounds are terminal unknown outcomes", async () => {
  const { resources, store } = await setup();
  const invalid = modelSpy({});
  await assert.rejects(() => invokeOnce({ resources, agent: { model: "/models/default" }, input: "x", model: invalid.adapter, store, id: "bad-response" }), /content array/);
  assert.equal((await store.readStatus("bad-response")).status, "unknown");

  const tooLarge = modelSpy({ content: [{ type: "text", text: "x".repeat(8 * 1024 * 1024) }] });
  await assert.rejects(() => invokeOnce({ resources, agent: { model: "/models/default" }, input: "x", model: tooLarge.adapter, store, id: "large-response" }), /exceeds/);
  assert.equal((await store.readStatus("large-response")).status, "unknown");
});

test("store write APIs validate ownership and terminal transitions", async () => {
  const { vfs } = await setup();
  assert.throws(() => createRunStore(vfs, { mode: "durable" }), (error) => error.code === "ENOTSUP");
  const store = createRunStore(vfs);
  await assert.rejects(() => store.start("never"), (error) => error.code === "EACCES");
  await assert.rejects(() => store.readStatus("bad/id"), (error) => error.code === "EINVAL");
  await store.reserve("guarded", { request: {}, plan: {} });
  await store.start("guarded");
  await store.finish("guarded", { content: [] });
  await assert.rejects(() => store.finish("guarded", { content: [] }), (error) => error.code === "EALREADY");
  await assert.rejects(() => store.fail("guarded", "unknown", new Error("late")), (error) => error.code === "EALREADY");
  assert.equal((await store.readStatus("guarded")).status, "completed");
});
