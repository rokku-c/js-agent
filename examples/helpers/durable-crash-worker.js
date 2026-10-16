// A separate OS process, deliberately parked at an IPC checkpoint until its parent SIGKILLs it.
import { Vfs } from "../../src/kernel/vfs.js";
import { createRunStore } from "../../src/core/run-store.js";
import { createRunObserver } from "../../src/core/run-observer.js";

const [phase, directory, scenario] = process.argv.slice(2);
const id = "crash-run";
const vfs = new Vfs();
await vfs.mount("hostfs", "/", { source: directory, mode: "rw" });
let failStatus = false;
let stopInsideStart = false;
const adapter = new Proxy(vfs, {
  get(target, key) {
    if (key === "write") return async (path, data, options) => {
      if (path.includes("/status.json.tmp-")) {
        if (stopInsideStart) await checkpoint({ point: "started-event-before-status" });
        if (failStatus) {
          failStatus = false;
          throw Object.assign(new Error("injected status write failure"), { code: "EIO" });
        }
      }
      return target.write(path, data, options);
    };
    const value = target[key];
    return typeof value === "function" ? value.bind(target) : value;
  },
});
const store = createRunStore(adapter, { mode: "durable", lockTimeoutMs: 25 });
const observer = createRunObserver(vfs);

function send(message) {
  return new Promise((resolve, reject) => process.send({ pid: process.pid, ...message }, (e) => e ? reject(e) : resolve()));
}
async function checkpoint(details) {
  // A pending Promise alone does not keep a Node process alive.
  setInterval(() => {}, 60_000);
  await send({ type: "checkpoint", ...details });
  await new Promise(() => {});
}
function failure(e) {
  return { code: e.code, outcome: e.outcome, intendedStatus: e.intendedStatus, eventCommitted: e.eventCommitted };
}
async function attempt(operation) {
  try { return { result: await operation() }; } catch (e) { return { error: failure(e) }; }
}

if (phase === "write") {
  await store.reserve(id, { request: { input: "private request" }, plan: { model: "local-test" } });
  stopInsideStart = scenario === "started-locked";
  await store.start(id);
  let writeFailure;
  if (scenario === "completed") await store.finish(id, { text: "private response" });
  if (scenario === "status-failure") {
    failStatus = true;
    writeFailure = (await attempt(() => store.fail(id, "unknown", new Error("external outcome unavailable")))).error;
  }
  if (scenario === "completed-status-failure" || scenario === "tool-status-failure") {
    failStatus = true;
    const tools = scenario === "tool-status-failure" ? [{ id: "tool-1", name: "send" }] : undefined;
    writeFailure = (await attempt(() => store.finish(id, { text: "response committed" }, tools))).error;
  }
  if (scenario === "malformed-tail") {
    await vfs.write(`/runs/${id}/events.jsonl`, '{"seq":2,"kind":"completed"', { append: true });
    await vfs.sync(`/runs/${id}/events.jsonl`);
  }
  if (scenario === "external-effect-unknown") {
    // Represents a receiver accepting an effect before the caller journals its result.
    // The recovery worker must never re-dispatch this effect.
    await vfs.write("/effect-receipts.jsonl", '{"effect":"accepted","id":"receipt-1"}\n', { create: true, append: true });
    await vfs.sync("/effect-receipts.jsonl");
    await vfs.sync("/");
  }
  await checkpoint({ point: scenario, writeFailure });
} else if (phase === "duplicate") {
  await send({ type: "result", ...await attempt(() => store.reserve(id, { request: {}, plan: {} })) });
  process.disconnect();
} else if (phase === "recover") {
  const before = await observer.snapshot(id);
  const journalBefore = await vfs.read(`/runs/${id}/events.jsonl`);
  let busy;
  if (scenario === "started-locked") busy = (await attempt(() => store.recover(id))).error;
  let failedRecovery;
  if (scenario === "recovery-status-failure") {
    failStatus = true;
    failedRecovery = (await attempt(() => store.recover(id))).error;
  }
  const recovered = await store.recover(id, { takeover: scenario === "started-locked" });
  const after = await observer.snapshot(id);
  const journalAfter = await vfs.read(`/runs/${id}/events.jsonl`);
  // A second store must see an idempotent recovery, not append another terminal record.
  const again = await createRunStore(vfs, { mode: "durable" }).recover(id);
  const journalAgain = await vfs.read(`/runs/${id}/events.jsonl`);
  const files = await vfs.list(`/runs/${id}`);
  const corrupt = await Promise.all(files.filter(({ name }) => name.startsWith("events.jsonl.corrupt-")).map(async ({ name }) => ({ name, text: await vfs.read(`/runs/${id}/${name}`) })));
  const effects = await vfs.exists("/effect-receipts.jsonl") ? await vfs.read("/effect-receipts.jsonl") : "";
  const duplicate = await attempt(() => createRunStore(vfs, { mode: "durable" }).reserve(id, { request: {}, plan: {} }));
  await send({ type: "result", before, recovered, after, again, busy, failedRecovery,
    journalBefore, journalAfter, journalAgain, corrupt, effects, duplicate,
    temporaryFiles: files.filter(({ name }) => name.includes(".tmp-")).map(({ name }) => name) });
  process.disconnect();
} else {
  throw new Error(`unknown worker phase: ${phase}`);
}
