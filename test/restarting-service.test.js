import { test } from "node:test";
import assert from "node:assert/strict";
import { Vfs } from "js-agent/kernel";
import { createEnvironment, createRunStore, createRunObserver, createView } from "js-agent/runtime";
import { runRestartingService } from "../examples/restarting-service.js";

const model = { path: "/models/local", adapter: async () => ({ content: [] }) };

async function memory() {
  const storage = new Vfs();
  await storage.mount("mem", "/");
  return storage;
}

test("Environment infers the injected store root and exposes the same trusted store", async () => {
  const storage = await memory();
  const store = createRunStore(storage, { root: "/service/runs" });
  const environment = createEnvironment({
    resources: storage, store, model,
    permissions: { observer: [{ path: "/service/runs/**", operations: ["stat", "read", "list"] }] },
  });
  assert.equal(environment.store, store);
  assert.equal((await environment.prepareWorkflow()).store, store);
  assert.equal(environment.observer.root, store.root);
  assert.equal(environment.describe().runs.mode, "volatile");
  assert.equal(environment.describe().runs.recovery, false);
  await store.reserve("custom", { request: {}, plan: {} });
  assert.equal((await environment.observer.snapshot("custom")).status, "reserved");
  assert.throws(() => createEnvironment({ resources: storage, store, root: "/wrong", model }), { code: "EINVAL" });
  assert.equal(createEnvironment({ resources: storage, model }).store.root, "/runs");
});

test("durable capability claims also require an implemented sync method", async () => {
  const storage = await memory();
  const declaredOnly = {
    capabilities: () => ({ durable: true, exclusiveMkdir: true, atomicRename: true, append: true, flush: true }),
  };
  for (const name of ["mkdirp", "mkdir", "write", "read", "rename", "remove", "exists"]) {
    declaredOnly[name] = storage[name].bind(storage);
  }
  assert.throws(() => createRunStore(declaredOnly, { mode: "durable" }), {
    code: "ENOTSUP", message: "durable run store requires storage.sync()",
  });
});

test("exact observer grants expose only authorized run metadata, not raw payloads", async () => {
  const storage = await memory();
  const store = createRunStore(storage);
  for (const id of ["allowed", "secret"]) {
    await store.reserve(id, { request: { secret: "request-payload" }, plan: {} });
    await store.start(id);
    await store.finish(id, { secret: "response-payload" });
  }
  const grants = [
    { path: "/runs", operations: ["list"] },
    { path: "/runs/allowed", operations: ["stat"] },
    { path: "/runs/allowed/status.json", operations: ["read"] },
    { path: "/runs/allowed/events.jsonl", operations: ["read"] },
  ];
  const view = createView(storage, { grants });
  const observer = createRunObserver(view);
  assert.deepEqual((await observer.list()).map(({ id }) => id), ["allowed"]);
  assert.equal((await observer.snapshot("allowed")).partial, false);
  await assert.rejects(() => observer.snapshot("secret"), { code: "EACCES" });
  for (const file of ["request.json", "plan.json", "response.json"]) {
    await assert.rejects(() => view.read(`/runs/allowed/${file}`), { code: "EACCES" });
  }
  await assert.rejects(() => view.write("/runs/allowed/status.json", "{}"), { code: "EACCES" });
  assert.equal(JSON.stringify(await observer.list()).includes("payload"), false);
});

test("killed service remounts durable runs, recovers before graph reconciliation, and never replays", { timeout: 20_000 }, async () => {
  const report = await runRestartingService({ log: () => {} });
  assert.equal(report.backend.remounted, true);
  assert.equal(report.backend.capabilities.flush, true);
  assert.equal(report.storage.mode, "durable");
  assert.equal(report.storage.recovery, true);
  assert.equal(report.before.status, "started");
  assert.equal(report.before.storage, "durable");
  assert.equal(report.recovery.status, "unknown");
  assert.equal(report.after.status, "unknown");
  assert.equal(report.after.partial, false);
  assert.equal(report.after.redacted, true);
  assert.equal(report.after.sequence, 2);
  assert.equal(report.graphStatus, "unknown");
  assert.equal(report.dispatchesAfterRestart, 0);
  assert.equal(JSON.stringify(report).includes("private request"), false);
});
