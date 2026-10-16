import { test } from "node:test";
import assert from "node:assert/strict";
import { Vfs } from "../src/kernel/vfs.js";
import { createRunStore } from "../src/core/run-store.js";
import { continueOnce, assembleContinuationRequest } from "../src/core/workflow.js";

async function setup() {
  const vfs = new Vfs();
  await vfs.mount("mem", "/", {});
  return { vfs, store: createRunStore(vfs) };
}

function parent() {
  return {
    id: "parent-1",
    path: "/runs/parent-1",
    request: {
      system: "keep this system exactly",
      messages: [
        { role: "user", content: "inspect" },
        { role: "assistant", content: [{ type: "tool_use", id: "tool-1", name: "read", input: {} }] },
      ],
      tools: [{ name: "read", input_schema: { type: "object" } }],
    },
  };
}

const parentResponse = { id: "response-1", content: [{ type: "tool_use", id: "tool-1", name: "read", input: {} }] };
const results = [{ tool_use_id: "tool-1", content: "file contents" }];
const agent = { model: "/models/default", system: [], context: [], tools: [] };

function modelSpy(response = { content: [{ type: "text", text: "done" }] }) {
  const calls = [];
  return {
    calls,
    adapter: { path: "/models/default", async request(request, options) { calls.push({ request, options }); return response; } },
  };
}

test("continuation preserves canonical request configuration and appends the builder tail", async () => {
  const { vfs, store } = await setup();
  const prior = parent();
  const before = structuredClone(prior);
  const fake = modelSpy();
  const result = await continueOnce({
    resources: {}, parent: prior, parentResponse, toolResults: results,
    agent, model: fake.adapter, store, id: "continuation-1", input: "summarize",
  });

  assert.equal(result.status, "completed");
  assert.equal(fake.calls.length, 1);
  const request = fake.calls[0].request;
  assert.equal(request.system, before.request.system);
  assert.deepEqual(request.tools, before.request.tools);
  assert.deepEqual(request.messages.map((message) => message.role), ["user", "assistant", "assistant", "user", "user"]);
  assert.deepEqual(prior, before);
  assert.ok(Object.isFrozen(request));
  assert.ok(Object.isFrozen(request.messages));
  assert.ok(Object.isFrozen(request.tools));

  const plan = JSON.parse(await vfs.read("/runs/continuation-1/plan.json"));
  assert.equal(plan.parent.id, "parent-1");
  assert.equal(plan.continuation.parentResponseId, "response-1");
  const events = (await vfs.read("/runs/continuation-1/events.jsonl")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(events.map((event) => event.kind), ["started", "completed"]);
});

test("continuation accepts parent.plan.request and rejects mismatched or unknown tool data", () => {
  const base = parent();
  const fromPlan = { id: base.id, plan: { request: base.request } };
  assert.doesNotThrow(() => assembleContinuationRequest({ parent: fromPlan, parentResponse, toolResults: results }));
  assert.throws(
    () => assembleContinuationRequest({ parent: base, parentResponse: { ...parentResponse, content: [] }, toolResults: results }),
    /does not match/,
  );
  assert.throws(
    () => assembleContinuationRequest({ parent: base, parentResponse, toolResults: [{ tool_use_id: "unknown", content: "x" }] }),
    /unknown tool result id/,
  );
  assert.throws(() => assembleContinuationRequest({ parent: { id: "missing-request" }, parentResponse, toolResults: results }), /parent.request/);
});

test("explicit ids are reserved by the store and adapter failures become unknown", async () => {
  const { store } = await setup();
  const failure = new Error("adapter failed");
  const fake = modelSpy();
  fake.adapter.request = async () => { throw failure; };
  await assert.rejects(
    () => continueOnce({ parent: parent(), parentResponse, toolResults: results, agent, model: fake.adapter, store, id: "failed-continuation" }),
    /adapter failed/,
  );
  assert.equal((await store.readStatus("failed-continuation")).status, "unknown");
  await assert.rejects(
    () => continueOnce({ parent: parent(), parentResponse, toolResults: results, agent, model: fake.adapter, store, id: "failed-continuation" }),
    (error) => error.code === "EEXIST",
  );
});
