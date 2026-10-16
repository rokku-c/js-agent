import { test } from "node:test";
import assert from "node:assert/strict";
import { createResourceToolApp } from "../examples/resource-defined-tool.js";

test("resource-defined entry.js runs through Environment and WorkflowGraph trusted adapter boundary", async () => {
  const app = await createResourceToolApp();
  assert.equal(app.binding.path, "/tools/prefix-read");
  assert.equal(app.binding.entryPath, "/tools/prefix-read/entry.js");
  assert.match(app.binding.entryRevision, /^sha256:[0-9a-f]{64}$/);

  const workflow = await app.environment.prepareWorkflow({
    agent: app.agent,
    input: "Read the brief through the resource-defined tool.",
  });
  assert.deepEqual(workflow.tools.map(({ name, path }) => ({ name, path })), [
    { name: "prefix-read", path: "/tools/prefix-read" },
  ]);
  const started = await app.graph.startRoot({ graphId: "resource-tool-test", ...workflow });
  assert.equal(started.root.status, "completed_with_tool_calls");
  assert.deepEqual(started.toolResults.map(({ content }) => content), ["answer: resource-backed behavior"]);

  const continued = await app.graph.continueBranch({
    graphId: "resource-tool-test",
    branchKey: "answer",
    parent: started.root,
    parentResponse: started.root.response,
    toolResults: started.toolResults,
    agent: workflow.agent,
    model: workflow.model,
    tools: workflow.tools,
    input: "answer",
  });
  assert.equal(continued.status, "completed");
  assert.equal(continued.result.response.content[0].text, "answer: resource-backed behavior");
  assert.equal((await app.graph.close("resource-tool-test")).status, "completed");
});
