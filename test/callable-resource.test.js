import { test } from "node:test";
import assert from "node:assert/strict";
import { createView } from "../src/kernel/view.js";
import { createCallableDemo, OfflineJobResource } from "../examples/real-use-callable.js";

test("callable resource is separately authorized and records an unknown effect on abort", async () => {
  const external = new OfflineJobResource();
  const resources = {
    async stat(path) { return external.stat(path.slice("/external".length) || "/"); },
    async list(path) { return external.list(path.slice("/external".length) || "/"); },
    async read(path, options) { return external.read(path.slice("/external".length) || "/", options); },
    async invoke(path, input, options) { return external.invoke(path.slice("/external".length) || "/", input, options); },
  };
  const view = createView(resources, { grants: [
    { path: "/external/jobs/submit", operations: ["stat", "read", "invoke"] },
    { path: "/external/effects/**", operations: ["stat", "read"] },
  ] });
  const signal = new AbortController();
  const pending = view.invoke("/external/jobs/submit", { jobId: "test-abort" }, { signal: signal.signal });
  setTimeout(() => signal.abort(), 2);
  await assert.rejects(pending, (error) => {
    assert.equal(error.code, "ABORT_ERR");
    assert.equal(error.outcome, "unknown");
    assert.equal(error.effect.state, "unknown");
    return true;
  });
  const effect = external.effects().find(({ jobId }) => jobId === "test-abort");
  assert.equal(effect.state, "unknown");
  assert.deepEqual(JSON.parse(await view.read(`/external/effects/${effect.id}.json`)), effect);

  const readOnly = createView(resources, { grants: [{ path: "/external/jobs/submit", operations: ["stat", "read"] }] });
  await assert.rejects(() => readOnly.invoke("/external/jobs/submit", { jobId: "denied" }), { code: "EACCES" });
});

test("offline callable resource composes with Environment, WorkflowGraph, and RunObserver", async () => {
  const report = await createCallableDemo();
  assert.equal(report.uncertainty.code, "ABORT_ERR");
  assert.equal(report.uncertainty.outcome, "unknown");
  assert.deepEqual(report.uncertainty.effect, {
    id: "effect-1", state: "unknown", resource: "/external/jobs/submit", jobId: "aborted-job",
    reason: report.uncertainty.effect.reason,
  });
  assert.equal(report.callable.status, true);
  assert.equal(report.workflow.graph, "completed");
  assert.equal(report.workflow.run, "completed");
  assert.deepEqual(report.workflow.events, ["started", "completed"]);
  assert.equal(report.completedEffect.state, "completed");
  assert.equal(report.completedEffect.jobId, "demo-job");
});
