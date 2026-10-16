import { test } from "node:test";
import assert from "node:assert/strict";
import {
  renderReleaseReviewReport,
  runReleaseReviewApplication,
} from "../examples/release-review-application.js";

test("release review application composes resource tools, services, graph, observer, and recovery", async () => {
  const report = await runReleaseReviewApplication({ log: () => {} });

  assert.equal(report.workflow.root, "completed_with_tool_calls");
  assert.equal(report.before.graph.status, "waiting");
  assert.deepEqual(report.before.graph.nodes.map(({ key, status }) => [key, status]), [
    ["root", "completed_with_tool_calls"],
    ["branch:security", "completed"],
    ["branch:migration", "running"],
  ]);
  assert.equal(report.tool.name, "release-evidence");
  assert.match(report.tool.entryRevision, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(report.recovery.uncertainNodes.map(({ key, persistedStatus }) => [key, persistedStatus]), [
    ["branch:migration", "started"],
  ]);
  assert.deepEqual(report.recovery.recoveredRuns, [{
    id: "release-review-migration",
    status: "unknown",
    recovered: true,
  }]);
  assert.equal(report.recovery.graph, "unknown");
  assert.equal(report.recovery.lateBranch.status, "unknown");
  assert.equal(report.recovery.lateBranch.error.code, "EALREADY");
  assert.equal(report.after.graph.status, "unknown");
  assert.deepEqual(report.after.graph.nodes.map(({ key, status, recovery }) => [key, status, recovery ?? null]), [
    ["root", "completed_with_tool_calls", null],
    ["branch:security", "completed", null],
    ["branch:migration", "unknown", "process_restart"],
  ]);
  assert.deepEqual(report.dispatches, { beforeRecovery: 3, afterRecovery: 3 });
  assert.deepEqual(report.services.calls.map(({ operation }) => operation), [
    "release.status",
    "release.evidence",
    "review.branch",
  ]);
  assert.equal(report.observer.redacted, true);
  assert.equal(report.observer.payloadFieldsAbsent, true);
  assert.match(renderReleaseReviewReport(report), /before restart: waiting; after recovery: unknown/);
});
