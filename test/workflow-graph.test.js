import { test } from "node:test";
import assert from "node:assert/strict";
import { Vfs } from "../src/kernel/vfs.js";
import { createRunStore } from "../src/core/run-store.js";
import { createWorkflowGraph, inspectWorkflowGraph } from "../src/core/workflow-graph.js";

const tools = [
  { path: "/tools/read", name: "read", description: "Read", input_schema: { type: "object" } },
  { path: "/tools/count", name: "count", description: "Count", input_schema: { type: "object" } },
];
const agent = { model: "/models/fake", tools: tools.map((tool) => tool.path) };

async function setup() {
  const storage = new Vfs();
  await storage.mount("mem", "/");
  return { storage, store: createRunStore(storage) };
}

function adapters() {
  return {
    read: async ({ input }) => `read:${input.path}`,
    count: async ({ input }) => `count:${input.path}`,
  };
}

function rootModel({ calls, childGate = null, childStarted = null, active = null, maxActive = null } = {}) {
  return {
    path: "/models/fake",
    async request(request) {
      calls?.push(request);
      if (request.messages.length === 1) {
        return {
          id: "response-tools",
          content: [
            { type: "tool_use", id: "read-1", name: "read", input: { path: "/fixtures/a" } },
            { type: "tool_use", id: "count-1", name: "count", input: { path: "/fixtures/a" } },
          ],
        };
      }
      if (active && maxActive) {
        active.value += 1;
        maxActive.value = Math.max(maxActive.value, active.value);
      }
      childStarted?.();
      try {
        if (childGate) await childGate;
        return { id: `response-child-${calls?.length ?? 0}`, content: [{ type: "text", text: "done" }] };
      } finally {
        if (active && maxActive) active.value -= 1;
      }
    },
  };
}

async function start(graph, model, graphId = "graph") {
  return graph.startRoot({
    graphId,
    agent,
    input: "investigate",
    model,
    tools,
    toolAdapters: adapters(),
  });
}

function branchOptions(started, branchKey, model, id = undefined) {
  return {
    graphId: started.graphId,
    branchKey,
    ...(id ? { id } : {}),
    parent: started.root,
    parentResponse: started.root.response,
    toolResults: started.toolResults,
    agent,
    model,
    tools,
  };
}

test("graph evaluates independent continuation branches concurrently and joins explicitly", async () => {
  const { storage, store } = await setup();
  const active = { value: 0 };
  const maxActive = { value: 0 };
  const calls = [];
  let release;
  const childGate = new Promise((resolve) => { release = resolve; });
  let childrenStarted = 0;
  let markChild;
  const childrenReady = new Promise((resolve) => {
    markChild = () => {
      childrenStarted += 1;
      if (childrenStarted === 2) resolve();
    };
  });
  const model = rootModel({
    calls, active, maxActive, childGate,
    childStarted: () => markChild(),
  });
  const graph = createWorkflowGraph({ storage, store });
  const started = await start(graph, model, "fanout");

  const branches = Promise.all([
    graph.continueBranch(branchOptions(started, "left", model, "fanout-left")),
    graph.continueBranch(branchOptions(started, "right", model, "fanout-right")),
  ]);
  await childrenReady;
  release();
  const [left, right] = await branches;
  const closed = await graph.close("fanout");

  assert.equal(started.status, "waiting");
  assert.equal(left.status, "completed");
  assert.equal(right.status, "completed");
  assert.equal(closed.status, "completed");
  assert.equal(maxActive.value, 2);
  assert.equal(calls.length, 3, "one root request and one request per branch");
  const inspected = await inspectWorkflowGraph(storage, "fanout");
  assert.deepEqual(inspected.edges.map((edge) => edge.key), ["root:left", "root:right"]);
  assert.equal(inspected.staleNodes.length, 0);
});

test("concurrent duplicate continuation attempts claim one logical edge", async () => {
  const { storage, store } = await setup();
  const calls = [];
  const graph = createWorkflowGraph({ storage, store });
  const started = await start(graph, rootModel({ calls }), "dedupe");
  const options = branchOptions(started, "same", rootModel({ calls }), "caller-chosen-a");
  const [first, second] = await Promise.all([
    graph.continueBranch(options),
    graph.continueBranch({ ...options, id: "caller-chosen-b" }),
  ]);

  assert.equal(calls.length, 2, "the duplicate edge does not dispatch a second child");
  assert.equal((first.result ?? first).status, "completed");
  assert.equal(first.deduplicated || second.deduplicated, true);
  assert.equal((await graph.close("dedupe")).status, "completed");
  const inspected = await inspectWorkflowGraph(storage, "dedupe");
  assert.equal(inspected.nodes.filter((node) => node.kind === "continuation").length, 1);
  assert.equal(inspected.nodes.find((node) => node.kind === "continuation").invocationId, "caller-chosen-a");
});

test("graph cancellation wins a child completion race and preserves invocation evidence", async () => {
  const { storage, store } = await setup();
  let release;
  const childGate = new Promise((resolve) => { release = resolve; });
  let childStarted;
  const childRequestStarted = new Promise((resolve) => { childStarted = resolve; });
  const calls = [];
  const graph = createWorkflowGraph({ storage, store });
  const model = rootModel({ calls, childGate, childStarted });
  const started = await start(graph, model, "cancel-race");
  const branch = graph.continueBranch(branchOptions(started, "child", model, "cancel-race-child"));
  await childRequestStarted;

  const cancelling = await graph.cancel("cancel-race");
  assert.equal(cancelling.status, "cancelling");
  release();
  const result = await branch;
  const inspected = await graph.inspect("cancel-race");

  assert.equal(result.status, "cancelled");
  assert.equal(inspected.status, "cancelled");
  assert.equal(inspected.nodes.find((node) => node.kind === "continuation").status, "cancelled");
  assert.equal(inspected.nodes.find((node) => node.kind === "continuation").invocationStatus, "unknown");
  assert.equal((await store.readStatus("cancel-race-child")).status, "unknown");
});

test("a restarted inspector detects and recovers a stale child without late overwrite", async () => {
  const { storage, store } = await setup();
  let release;
  const childGate = new Promise((resolve) => { release = resolve; });
  let childStarted;
  const childRequestStarted = new Promise((resolve) => { childStarted = resolve; });
  const calls = [];
  const graph = createWorkflowGraph({ storage, store });
  const model = rootModel({ calls, childGate, childStarted });
  const started = await start(graph, model, "restart");
  const branch = graph.continueBranch(branchOptions(started, "child", model, "restart-child"));
  await childRequestStarted;

  const restartedStore = createRunStore(storage);
  const restartedGraph = createWorkflowGraph({ storage, store: restartedStore });
  const before = await restartedGraph.inspect("restart");
  assert.equal(before.uncertainNodes[0].invocationId, "restart-child");
  assert.equal(before.uncertainNodes[0].persistedStatus, "started");

  const recovered = await restartedGraph.recover("restart");
  assert.equal(recovered.status, "unknown");
  assert.equal(recovered.nodes.find((node) => node.kind === "continuation").recovery, "process_restart");

  release();
  await branch;
  const after = await restartedGraph.inspect("restart");
  assert.equal(after.status, "unknown");
  assert.equal(after.nodes.find((node) => node.kind === "continuation").status, "unknown");
});
