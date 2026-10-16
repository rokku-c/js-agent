import { test } from "node:test";
import assert from "node:assert/strict";
import { Vfs } from "../src/kernel/vfs.js";
import { createRunStore } from "../src/core/run-store.js";
import { inspectInvocation, runWorkflow } from "../src/core/workflow-harness.js";

async function setup() {
  const storage = new Vfs();
  await storage.mount("mem", "/");
  return { storage, store: createRunStore(storage) };
}

const tools = [
  { path: "/tools/read", name: "read", description: "Read a fixture", input_schema: { type: "object" } },
  { path: "/tools/count", name: "count", description: "Count a fixture", input_schema: { type: "object" } },
];
const agent = { model: "/models/fake", tools: tools.map((tool) => tool.path) };

function modelAdapter({ calls, failFor = new Set() } = {}) {
  return {
    path: "/models/fake",
    async request(request) {
      const prompt = request.messages[0]?.content;
      calls?.push(request);
      if (failFor.has(prompt)) throw Object.assign(new Error(`provider unavailable for ${prompt}`), { code: "ECONNRESET" });
      if (request.messages.length === 1) {
        const key = prompt.includes("alpha") ? "alpha" : "beta";
        return {
          id: `response-${key}-tools`,
          content: [
            { type: "tool_use", id: `${key}-read`, name: "read", input: { path: `/fixtures/${key}.txt` } },
            { type: "tool_use", id: `${key}-count`, name: "count", input: { path: `/fixtures/${key}.txt` } },
          ],
        };
      }
      const resultBlock = request.messages.at(-1).content;
      return {
        id: `response-${prompt}-done`,
        content: [{ type: "text", text: `${prompt}: ${resultBlock.map((block) => block.content).join(" | ")}` }],
      };
    },
  };
}

function adapters({ active, maxActive, trace, broken = false } = {}) {
  async function run(name, wait, input, signal, runId) {
    active.value += 1;
    maxActive.value = Math.max(maxActive.value, active.value);
    trace.push({ event: "adapter_started", runId, name });
    try {
      await new Promise((resolve) => setTimeout(resolve, wait));
      if (signal?.aborted) throw Object.assign(new Error("tool cancelled"), { code: "ABORT_ERR" });
      if (broken && name === "read") throw new Error(`fixture missing: ${input.path}`);
      return `${name}:${input.path}`;
    } finally {
      active.value -= 1;
      trace.push({ event: "adapter_finished", runId, name });
    }
  }
  return {
    read: ({ input, signal, runId }) => run("read", 12, input, signal, runId),
    count: ({ input, signal, runId }) => run("count", 2, input, signal, runId),
  };
}

test("workflow harness executes two tools concurrently and exposes parent/child state", async () => {
  const { storage, store } = await setup();
  const modelCalls = [];
  const trace = [];
  const active = { value: 0 };
  const maxActive = { value: 0 };
  const result = await runWorkflow({
    storage, resources: {}, agent, input: "investigate alpha", model: modelAdapter({ calls: modelCalls }),
    tools, store, toolAdapters: adapters({ active, maxActive, trace }), id: "alpha-root", continuationId: "alpha-child", trace,
  });

  assert.equal(result.status, "completed");
  assert.equal(result.root.status, "completed_with_tool_calls");
  assert.equal(result.continuation.status, "completed");
  assert.equal(result.toolResults.map((item) => item.tool_use_id).join(","), "alpha-read,alpha-count");
  assert.equal(maxActive.value, 2, "the two independent tool calls overlap");
  assert.deepEqual(modelCalls.map((request) => request.messages.length), [1, 3]);
  assert.deepEqual(modelCalls[1].messages.at(-1).content.map((block) => block.tool_use_id), ["alpha-read", "alpha-count"]);

  const root = await inspectInvocation(storage, "alpha-root");
  const child = await inspectInvocation(storage, "alpha-child");
  assert.equal(root.status.status, "completed_with_tool_calls");
  assert.equal(child.status.status, "completed");
  assert.deepEqual(root.events.map((event) => event.kind), ["started", "completed"]);
  assert.deepEqual(child.events.map((event) => event.kind), ["started", "completed"]);
  assert.deepEqual(child.plan.continuation.parent, { id: "alpha-root", path: "/runs/alpha-root", responseId: "response-alpha-tools" });
  assert.deepEqual(child.request.messages.at(-1).content.map((block) => block.type), ["tool_result", "tool_result"]);
  assert.equal(child.request.messages.at(-1).content[0].content, "read:/fixtures/alpha.txt");
});

test("independent workflows overlap while their parent links remain isolated", async () => {
  const { storage, store } = await setup();
  const active = { value: 0 };
  const maxActive = { value: 0 };
  const result = await Promise.all(["alpha", "beta"].map((key) => runWorkflow({
    storage, resources: {}, agent, input: `investigate ${key}`, model: modelAdapter(), tools, store,
    toolAdapters: adapters({ active, maxActive, trace: [] }), id: `${key}-root`, continuationId: `${key}-child`,
  })));

  assert.equal(maxActive.value, 4, "both runs dispatch their independent tool batches concurrently");
  assert.deepEqual(result.map((item) => item.status), ["completed", "completed"]);
  const [alphaChild, betaChild] = await Promise.all([
    inspectInvocation(storage, "alpha-child"), inspectInvocation(storage, "beta-child"),
  ]);
  assert.equal(alphaChild.plan.parent.id, "alpha-root");
  assert.equal(betaChild.plan.parent.id, "beta-root");
  assert.notEqual(alphaChild.plan.parent.id, betaChild.plan.parent.id);
});

test("tool adapter errors become ordered is_error results for the continuation", async () => {
  const { storage, store } = await setup();
  const result = await runWorkflow({
    storage, resources: {}, agent, input: "investigate alpha", model: modelAdapter(), tools, store,
    toolAdapters: adapters({ active: { value: 0 }, maxActive: { value: 0 }, trace: [], broken: true }),
    id: "error-root", continuationId: "error-child",
  });

  assert.equal(result.status, "completed");
  assert.equal(result.toolResults[0].is_error, true);
  assert.equal(result.toolResults[1].is_error, undefined);
  const child = await inspectInvocation(storage, "error-child");
  const [failed, succeeded] = child.request.messages.at(-1).content;
  assert.equal(failed.is_error, true);
  assert.match(failed.content, /fixture missing/);
  assert.equal(succeeded.content, "count:/fixtures/alpha.txt");
});

test("provider failures are unknown and cancellation leaves no child invocation", async () => {
  const { storage, store } = await setup();
  const calls = [];
  await assert.rejects(
    () => runWorkflow({
      storage, resources: {}, agent, input: "investigate alpha", model: modelAdapter({ calls, failFor: new Set(["investigate alpha"]) }),
      tools, store, toolAdapters: {}, id: "unknown-root", continuationId: "unknown-child",
    }),
    /provider unavailable/,
  );
  const unknown = await inspectInvocation(storage, "unknown-root");
  assert.equal(unknown.status.status, "unknown");
  assert.deepEqual(unknown.events.map((event) => event.kind), ["started", "unknown"]);
  assert.equal(await storage.exists("/runs/unknown-child"), false);

  const controller = new AbortController();
  const cancelled = runWorkflow({
    storage, resources: {}, agent, input: "investigate beta", model: modelAdapter(), tools, store,
    toolAdapters: adapters({ active: { value: 0 }, maxActive: { value: 0 }, trace: [] }),
    signal: controller.signal, id: "cancel-root", continuationId: "cancel-child",
  });
  setTimeout(() => controller.abort(), 3);
  const cancellation = await cancelled;
  assert.equal(cancellation.status, "cancelled");
  const cancelledRoot = await inspectInvocation(storage, "cancel-root");
  assert.equal(cancelledRoot.status.status, "completed_with_tool_calls");
  assert.equal(await storage.exists("/runs/cancel-child"), false);
});
