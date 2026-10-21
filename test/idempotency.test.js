import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { createView } from "../src/kernel/view.js";
import { createRunStore } from "../src/core/run-store.js";
import { createWorkflowGraph } from "../src/core/workflow-graph.js";
import { executeToolCalls } from "../src/core/workflow-harness.js";
import { createOfflineEffectConnector } from "../src/connectors/offline-effect.js";
import { Vfs } from "../src/kernel/vfs.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function effectView(connector) {
  return createView(connector, { grants: [
    { path: "/effects/submit", operations: ["stat", "read", "invoke"] },
    { path: "/effects/receipts/**", operations: ["stat", "read"] },
    { path: "/effects/status/**", operations: ["stat", "read"] },
  ] });
}

async function durableStorage() {
  const directory = await mkdtemp(`${os.tmpdir()}/js-agent-idempotency-`);
  const storage = new Vfs();
  await storage.mount("hostfs", "/", { source: directory, mode: "rw" });
  return { storage, directory };
}

test("callable identity options are validated and forwarded", async () => {
  const calls = [];
  const resource = {
    async stat() { return { callable: true }; },
    async invoke(path, input, options) { calls.push({ path, input, options }); return { status: "completed" }; },
  };
  const view = createView(resource, { grants: [{ path: "/effect", operations: ["stat", "invoke"] }] });
  await view.invoke("/effect", { value: 1 }, { operationId: "run-1:tool-1", idempotencyKey: "key-1" });
  assert.deepEqual(calls[0].options, { operationId: "run-1:tool-1", idempotencyKey: "key-1" });
  await assert.rejects(() => view.invoke("/effect", {}, { idempotencyKey: "" }), { code: "EINVAL" });
  await assert.rejects(() => view.invoke("/effect", {}, { operationId: "bad\u0000id" }), { code: "EINVAL" });
});

test("deduplicating connector reconciles a timeout and concurrent retry to one receipt", async () => {
  const connector = createOfflineEffectConnector({ deduplicate: true, delayMs: 25 });
  const view = effectView(connector);
  const identity = { operationId: "run-durable:tool-submit", idempotencyKey: "provider-key-1" };
  const first = view.invoke("/effects/submit", { payload: { amount: 3 } }, { ...identity, timeoutMs: 2 });
  let unknown;
  await assert.rejects(first, (error) => {
    unknown = error;
    assert.equal(error.outcome, "unknown");
    assert.equal(error.effect.state, "unknown");
    return true;
  });

  // The provider accepted the operation even though this waiter timed out. The receipt is
  // the reconciliation authority, and a retry with the same key attaches to that operation.
  await sleep(35);
  const receiptPath = `/effects/receipts/${unknown.receipt.id}.json`;
  const receipt = JSON.parse(await view.read(receiptPath));
  assert.equal(receipt.state, "completed");
  assert.equal(JSON.parse(await view.read(`/effects/status/${encodeURIComponent(identity.operationId)}.json`)).state, "completed");

  const [retry, concurrent] = await Promise.all([
    view.invoke("/effects/submit", { payload: { amount: 3 } }, identity),
    view.invoke("/effects/submit", { payload: { amount: 999 } }, identity),
  ]);
  assert.equal(retry.status, "completed");
  assert.equal(retry.deduplicated, true);
  assert.equal(concurrent.deduplicated, true);
  assert.equal(retry.effect.id, unknown.receipt.id);
  assert.equal(connector.receipts().length, 1);
});

test("non-deduplicating connector leaves interrupted receipts unknown", async () => {
  const connector = createOfflineEffectConnector({ deduplicate: false, delayMs: 20 });
  const view = effectView(connector);
  const identity = { operationId: "run-unknown:tool-submit", idempotencyKey: "ignored-key" };
  let firstError;
  await assert.rejects(
    () => view.invoke("/effects/submit", { payload: { attempt: 1 } }, { ...identity, timeoutMs: 1 }),
    (error) => { firstError = error; return error.outcome === "unknown"; },
  );
  await sleep(30);
  assert.equal(JSON.parse(await view.read(`/effects/receipts/${firstError.receipt.id}.json`)).state, "unknown");
  const retry = await view.invoke("/effects/submit", { payload: { attempt: 2 } }, identity);
  assert.equal(retry.status, "completed");
  assert.notEqual(retry.effect.id, firstError.receipt.id);
  assert.equal(connector.receipts().length, 2);
});

test("tool retries derive stable operationId and idempotencyKey from the durable run and tool call", async () => {
  const connector = createOfflineEffectConnector({ deduplicate: true, delayMs: 2 });
  const view = effectView(connector);
  const seen = [];
  const adapters = {
    submit: ({ input, operationId, idempotencyKey }) => {
      seen.push({ operationId, idempotencyKey });
      return view.invoke("/effects/submit", input, { operationId, idempotencyKey });
    },
  };
  const call = { id: "submit-1", name: "submit", input: { payload: { source: "retry" } } };
  await executeToolCalls([call], adapters, { runId: "run-stable" });
  await executeToolCalls([call], adapters, { runId: "run-stable" });
  assert.deepEqual(seen, [
    { operationId: "run-stable:submit-1", idempotencyKey: "run-stable:submit-1" },
    { operationId: "run-stable:submit-1", idempotencyKey: "run-stable:submit-1" },
  ]);
  assert.equal(connector.receipts().length, 1);
});

test("durable RunStore recovery keeps an interrupted operation unknown", async () => {
  const { storage, directory } = await durableStorage();
  try {
    const store = createRunStore(storage, { mode: "durable" });
    await store.reserve("operation-run", {
      request: { messages: [] },
      plan: { operationId: "operation-run", idempotencyKey: "provider-key" },
    });
    await store.materialize("operation-run", { request: { messages: [] }, plan: { operationId: "operation-run", idempotencyKey: "provider-key" } });
    await store.start("operation-run");
    const restarted = createRunStore(storage, { mode: "durable" });
    assert.equal((await restarted.recover("operation-run")).status, "unknown");
    assert.deepEqual((await restarted.readStatus("operation-run")).status, "unknown");
    assert.deepEqual(JSON.parse(await storage.read("/runs/operation-run/plan.json")), {
      operationId: "operation-run", idempotencyKey: "provider-key",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("WorkflowGraph recovery fences a late completion after durable restart", async () => {
  const { storage, directory } = await durableStorage();
  try {
    const store = createRunStore(storage, { mode: "durable" });
    const graph = createWorkflowGraph({ storage, store, root: "/workflows", persistence: "journal" });
    let release;
    let started;
    const requestStarted = new Promise((resolve) => { started = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    const model = {
      path: "/models/offline",
      async request() { started(); await gate; return { content: [{ type: "text", text: "done" }] }; },
    };
    const options = {
      graphId: "recoverable",
      agent: { model: "/models/offline", tools: [] },
      input: "recover",
      model,
      tools: [],
      toolAdapters: {},
    };
    const pending = graph.startRoot(options);
    await requestStarted;
    const restartedStore = createRunStore(storage, { mode: "durable" });
    const restartedGraph = createWorkflowGraph({ storage, store: restartedStore, root: "/workflows", persistence: "journal" });
    assert.equal((await restartedStore.recover("recoverable-root")).status, "unknown");
    const recovered = await restartedGraph.recover("recoverable");
    assert.equal(recovered.status, "unknown");
    assert.equal(recovered.nodes[0].recovery, "process_restart");
    release();
    await assert.rejects(pending);
    const final = await restartedGraph.inspect("recoverable");
    assert.equal(final.status, "unknown");
    assert.equal(final.nodes[0].invocationStatus, "unknown");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
