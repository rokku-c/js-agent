import { test } from "node:test";
import assert from "node:assert/strict";
import { createExternalWorkflowUi, runExternalWorkflowUi } from "../examples/external-workflow-ui.js";


test("remote-shaped UI combines connector changes with live graph and redacted runs", async () => {
  const report = await runExternalWorkflowUi({ log: () => {} });

  assert.deepEqual(report.external.changes.map(({ kind, path }) => [kind, path]), [
    ["write", "/remote/release/brief.md"],
    ["status", "/status.json"],
  ]);
  assert.equal(report.external.status.state, "degraded");
  assert.equal(report.external.metadata.externalId, "release://acme/2026-10-16/brief");
  assert.equal(report.references.pinnedRules, "Check behavior, migration safety, and rollback evidence.");
  assert.match(report.references.liveBriefAfterUpdate, /rollback/);

  assert.equal(report.live.graph.status, "waiting");
  assert.deepEqual(report.live.graph.nodes.map(({ key, status }) => [key, status]), [
    ["root", "completed_with_tool_calls"],
    ["branch:summary", "running"],
    ["branch:risks", "running"],
  ]);
  assert.deepEqual(report.live.runs.map(({ status }) => status).sort(), [
    "completed_with_tool_calls", "started", "started",
  ]);
  assert.deepEqual(report.final.results.sort(), ["completed", "completed"]);
  assert.equal(report.final.graph.status, "completed");
  assert.equal(report.concurrency.branches, 2);
  assert.equal(report.observer.redacted, true);
  assert.equal(report.observer.volatile, true);
  assert.equal(report.observer.payloadFieldsAbsent, true);
});


test("connector and observer watches expose compatible cancellation outcomes to a UI", async () => {
  const app = await createExternalWorkflowUi();
  const connectorController = new AbortController();
  const connectorWatch = app.remote.watch("/remote/release", { signal: connectorController.signal });
  const observerController = new AbortController();
  const observerWatch = app.observer.watch("missing-run", { signal: observerController.signal });

  const connectorPending = connectorWatch.next();
  connectorController.abort(new Error("connector UI closed"));
  await assert.rejects(connectorPending, (error) => error.message === "connector UI closed");
  await assert.rejects(connectorWatch.next(), (error) => error.message === "connector UI closed");

  observerController.abort(new Error("observer UI closed"));
  await assert.rejects(observerWatch.next(), (error) => error.message === "observer UI closed");
});
