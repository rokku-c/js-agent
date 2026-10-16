import { test } from "node:test";
import assert from "node:assert/strict";
import { runDurableRestartObserver } from "../examples/durable-restart-observer.js";

test("a remounted backend remains observable through the environment observer without payloads", async () => {
  const report = await runDurableRestartObserver({ log: () => {} });

  assert.deepEqual(report.backend, {
    driver: "hostfs",
    remounted: true,
    resourceApi: ["stat", "list", "read"],
  });
  assert.equal(report.beforeRestart.graph, "running");
  assert.equal(report.beforeRestart.run.status, "started");
  assert.equal(report.afterRecovery.graph, "unknown");
  assert.equal(report.afterRecovery.node, "process_restart");
  assert.equal(report.afterRecovery.run.status, "started");
  assert.equal(report.afterShutdown.status, "unknown");
  for (const run of [report.beforeRestart.run, report.afterRecovery.run, report.afterShutdown]) {
    assert.equal(run.redacted, true);
    assert.equal(run.payloadFieldsAbsent, true);
  }
  assert.equal(report.limits.runStoreMode, "volatile");
  assert.equal(report.limits.distributedTransactions, false);
});
