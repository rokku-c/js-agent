import { test } from "node:test";
import assert from "node:assert/strict";
import { createIntegratedApp } from "../examples/integrated-environment-graph.js";

const agent = {
  model: "/models/reviewer",
  context: ["/workspace/brief.md"],
  tools: ["/tools/summary", "/tools/risks"],
};

test("environment workflow options compose with a live graph and redacted observer", async () => {
  const app = await createIntegratedApp({ holdBranches: true });
  const { environment, graph, observer, store } = app;
  const workflow = await environment.prepareWorkflow({ agent, input: "Review and fan out." });

  assert.equal(workflow.store, store);
  assert.deepEqual(workflow.tools.map(({ name }) => name), ["summary", "risks"]);
  assert.equal(typeof workflow.toolAdapters.get("summary"), "function");

  const started = await graph.startRoot({ graphId: "integration-test", ...workflow });
  assert.equal(started.status, "waiting");
  assert.equal((await observer.snapshot(started.root.id)).status, "completed_with_tool_calls");

  const branches = ["summary", "risks"].map((branchKey) => graph.continueBranch({
    graphId: "integration-test",
    branchKey,
    parent: started.root,
    parentResponse: started.root.response,
    toolResults: started.toolResults,
    agent: workflow.agent,
    model: workflow.model,
    tools: workflow.tools,
    input: `branch:${branchKey}`,
  }));
  await app.branchesReady;

  const liveGraph = await graph.inspect("integration-test");
  assert.equal(liveGraph.status, "waiting");
  assert.deepEqual(liveGraph.nodes.map(({ key, status }) => [key, status]), [
    ["root", "completed_with_tool_calls"],
    ["branch:summary", "running"],
    ["branch:risks", "running"],
  ]);
  const liveRuns = await observer.list();
  assert.deepEqual(liveRuns.filter(({ id }) => id.includes("integration-test")).map(({ status }) => status).sort(), [
    "completed_with_tool_calls", "started", "started",
  ]);

  const rootSnapshot = await observer.snapshot("integration-test-root");
  assert.equal(rootSnapshot.redacted, true);
  assert.equal("request" in rootSnapshot, false);
  assert.equal("response" in rootSnapshot, false);

  app.releaseBranches();
  const results = await Promise.all(branches);
  assert.deepEqual(results.map(({ status }) => status).sort(), ["completed", "completed"]);
  const finalGraph = await graph.close("integration-test");
  assert.equal(finalGraph.status, "completed");
  assert.deepEqual(finalGraph.edges.map(({ key, status }) => [key, status]), [
    ["root:summary", "completed"],
    ["root:risks", "completed"],
  ]);
  assert.equal(app.maxConcurrentBranches, 2);
  assert.deepEqual((await observer.list()).filter(({ id }) => id.includes("integration-test")).map(({ status }) => status).sort(), [
    "completed", "completed", "completed_with_tool_calls",
  ]);
});
