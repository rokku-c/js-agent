import { test } from "node:test";
import assert from "node:assert/strict";
import * as cli from "js-agent";
import * as kernel from "js-agent/kernel";
import * as runtime from "js-agent/runtime";

test("package exports expose the documented public entrypoints", () => {
  assert.equal(typeof cli.boot, "function");
  assert.equal(typeof cli.parseArgv, "function");
  assert.equal(typeof cli.VERSION, "string");
  assert.equal(typeof kernel.Vfs, "function");

  for (const name of [
    "createEnvironment",
    "createServiceAuthority",
    "createRunObserver",
    "createWorkflowGraph",
    "inspectWorkflowGraph",
    "createGitRevisionConnector",
    "createRunStore",
    "createView",
    "invokeOnce",
  ]) {
    assert.equal(typeof runtime[name], "function", `runtime export ${name}`);
  }
});
