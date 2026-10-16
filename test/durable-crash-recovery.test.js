import { test } from "node:test";
import assert from "node:assert/strict";
import { runCrashScenario, scenarios } from "../examples/durable-crash-recovery.js";

for (const scenario of scenarios) {
  test(`durable SIGKILL + fresh process: ${scenario}`, { timeout: 30_000 }, async () => {
    const result = await runCrashScenario(scenario);
    const expected = scenario === "tool-status-failure" ? "completed_with_tool_calls"
      : ["completed", "completed-status-failure"].includes(scenario) ? "completed" : "unknown";
    assert.equal(result.killed.signal, "SIGKILL");
    assert.notEqual(result.checkpoint.pid, result.pid);
    assert.equal(result.recovered.status, expected);
    assert.equal(result.after.status, expected, "read-only observers must agree with recovery");
    assert.equal(result.again.status, expected);
    assert.equal(result.after.partial, false);
    assert.equal(result.after.storage, "durable");
    assert.equal(result.after.redacted, true);
    for (const snapshot of [result.before, result.after]) {
      for (const field of ["request", "plan", "response"]) assert.equal(field in snapshot, false);
    }
    assert.equal(result.journalAfter, result.journalAgain, "recovery must not append another terminal event");
    const events = result.journalAfter.trim().split("\n").map(JSON.parse);
    assert.deepEqual(events.map(({ seq }) => seq), [1, 2]);
    assert.deepEqual(events.map(({ kind }) => kind), ["started", expected.startsWith("completed") ? "completed" : "unknown"]);
    assert.equal(result.duplicate.error.code, "EEXIST");
    assert.deepEqual(result.temporaryFiles, []);
    if (scenario === "completed") assert.equal(result.before.status, "completed");
    else if (scenario === "started-locked") {
      assert.equal(result.before.status, "reserved");
      assert.equal(result.busy.code, "EBUSY");
    } else assert.equal(result.before.status, "started");
    if (scenario === "malformed-tail") {
      assert.equal(result.before.partial, true);
      assert.equal(result.recovered.partial, true);
      assert.equal(result.corrupt.length, 1);
      assert.equal(result.corrupt[0].text, result.journalBefore);
    } else assert.deepEqual(result.corrupt, []);
    if (scenario === "status-failure") {
      assert.equal(result.checkpoint.writeFailure.code, "EIO");
      assert.equal(result.checkpoint.writeFailure.eventCommitted, true);
    }
    if (["completed-status-failure", "tool-status-failure"].includes(scenario)) {
      assert.equal(result.checkpoint.writeFailure.code, "EIO");
      assert.equal(result.checkpoint.writeFailure.eventCommitted, true);
      assert.equal(result.checkpoint.writeFailure.intendedStatus, expected);
    }
    if (scenario === "recovery-status-failure") assert.equal(result.failedRecovery.code, "EIO");
    if (scenario === "duplicate-id") assert.equal(result.duplicateWhileAlive.error.code, "EEXIST");
    if (scenario === "external-effect-unknown") {
      assert.deepEqual(result.effects.trim().split("\n").map(JSON.parse), [{ effect: "accepted", id: "receipt-1" }]);
      assert.equal(events[1].recovery, "process_restart");
    } else assert.equal(result.effects, "");
  });
}
