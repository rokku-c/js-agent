import { test } from "node:test";
import assert from "node:assert/strict";
import { Vfs } from "../src/kernel/vfs.js";
import { createEnvironment, createRunObserver, createWorkflowGraph, inspectWorkflowGraph } from "../src/runtime.js";
import { runPersistenceConformance } from "../examples/workflow-persistence.js";

function model() {
  return {
    path: "/models/offline",
    adapter: { async request() { return { content: [{ type: "text", text: "ok" }] }; } },
  };
}

test("public persistence example covers snapshot, journal, and redacted observer metadata", async () => {
  const reports = await runPersistenceConformance({ log() {} });
  assert.deepEqual(reports.map(({ persistence, graphFormat }) => ({ persistence, graphFormat })), [
    { persistence: "snapshot", graphFormat: 1 },
    { persistence: "journal", graphFormat: 2 },
  ]);
  assert.ok(reports.every(({ observer }) => observer.redacted && observer.volatile));
});

test("journal selection migrates an existing snapshot on its first graph mutation", async () => {
  const storage = new Vfs();
  await storage.mount("mem", "/");
  const environment = createEnvironment({ resources: storage, storage, model: model() });
  const snapshot = environment.createWorkflowGraph({ root: "/workflows", persistence: "snapshot" });
  await snapshot.run({
    id: "migrate",
    root: await environment.prepareWorkflow({ agent: { model: "/models/offline" }, input: "before" }),
  });
  assert.equal(JSON.parse(await storage.read("/workflows/migrate/graph.json")).version, 1);

  const journal = createWorkflowGraph({ storage, store: environment.store, persistence: "journal" });
  await journal.close("migrate");
  assert.equal(JSON.parse(await storage.read("/workflows/migrate/graph.json")).version, 2);
  assert.match(await storage.read("/workflows/migrate/journal/000000000001.json"), /migrate/);

  const reopenedWithDefault = createWorkflowGraph({ storage, store: environment.store });
  assert.equal((await reopenedWithDefault.inspect("migrate")).nodes.length, 1);
});

test("standalone graph inspection validates and normalizes its root", async () => {
  const storage = new Vfs();
  await storage.mount("mem", "/");
  const environment = createEnvironment({ resources: storage, storage, model: model() });
  const graph = environment.createWorkflowGraph({ root: "/custom" });
  await graph.run({
    id: "root-check",
    root: await environment.prepareWorkflow({ agent: { model: "/models/offline" }, input: "check" }),
  });
  const inspected = await createWorkflowGraph({ storage, store: environment.store, root: "/custom" }).inspect("root-check");
  assert.equal(inspected.path, "/custom/root-check");
  await assert.rejects(
    () => inspectWorkflowGraph(storage, "root-check", { root: "/custom/../unsafe" }),
    { code: "EINVAL" },
  );
});

test("observer watch reports storage metadata changes", async () => {
  const storage = new Vfs();
  await storage.mount("mem", "/");
  await storage.mkdirp("/runs/metadata");
  await storage.write("/runs/metadata/status.json", JSON.stringify({ id: "metadata", status: "started", storage: "volatile" }), { create: true });
  await storage.write("/runs/metadata/events.jsonl", JSON.stringify({ seq: 1, kind: "started" }) + "\n", { create: true });
  const observer = createRunObserver(storage, { interval: 1 });
  const watch = observer.watch("metadata");
  assert.equal((await watch.next()).value.storage, "volatile");
  await storage.write("/runs/metadata/status.json", JSON.stringify({ id: "metadata", status: "started", storage: "durable" }), { create: true });
  assert.equal((await watch.next()).value.storage, "durable");
  await storage.write("/runs/metadata/status.json", JSON.stringify({ id: "metadata", status: "completed", storage: "durable" }), { create: true });
  await storage.write("/runs/metadata/events.jsonl", JSON.stringify({ seq: 1, kind: "started" }) + "\n" + JSON.stringify({ seq: 2, kind: "completed" }) + "\n", { create: true });
  assert.equal((await watch.next()).value.terminal, true);
  assert.equal((await watch.next()).done, true);
});
