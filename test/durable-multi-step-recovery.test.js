import { test } from "node:test";
import assert from "node:assert/strict";
import { runDurableMultiStepRecovery } from "../examples/durable-multi-step-recovery.js";

test("environment recovery reconciles a dynamic multi-step branch without replay", async () => {
  const report = await runDurableMultiStepRecovery({ log: () => {} });

  assert.equal(report.before.graph, "waiting");
  assert.equal(report.before.run.status, "started");
  assert.deepEqual(report.recovery.uncertain, ["branch:risks"]);
  assert.deepEqual(report.workflow.recoveredRuns, [{
    id: "multi-step-risks",
    status: "unknown",
    recovered: true,
  }]);
  assert.equal(report.recovery.graph, "unknown");
  assert.equal(report.after.graph, "unknown");
  assert.equal(report.after.run.status, "unknown");
  assert.equal(report.workflow.lateBranch.status, "unknown");
  assert.equal(report.workflow.lateBranch.error.code, "EALREADY");
  assert.deepEqual(report.dispatches, { beforeRecovery: 1, afterRecovery: 1 }, "the interrupted branch is never replayed");
  assert.equal(report.after.run.payloadFieldsAbsent, true);
});
