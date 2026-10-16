// node examples/restarting-service.js — offline, with a real killed writer process.
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Vfs } from "js-agent/kernel";
import { createEnvironment, createRunStore, createRunObserver, createView, createWorkflowGraph } from "js-agent/runtime";

const root = "/state/runs";
const graphId = "restart";
const runId = `${graphId}-root`;
const agent = { model: "/models/local", tools: [] };
// Exact grants: raw payload reads and other runs are not authorized even on the View.
// For dynamically allocated runs, build these grants from authorized run IDs server-side.
const observerGrants = [
  { path: root, operations: ["list"] },
  { path: `${root}/${runId}`, operations: ["stat"] },
  { path: `${root}/${runId}/status.json`, operations: ["read"] },
  { path: `${root}/${runId}/events.jsonl`, operations: ["read"] },
];

async function openService(directory, request) {
  const storage = new Vfs();
  await storage.mount("hostfs", "/", { source: directory, mode: "rw" });
  const resources = new Vfs();
  await resources.mount("mem", "/");
  const store = createRunStore(storage, { root, mode: "durable" });
  const environment = createEnvironment({
    resources, storage, store, // run/observer root is inferred from store.root
    model: { path: agent.model, adapter: request },
    permissions: { observer: observerGrants },
  });
  const graph = createWorkflowGraph({ storage, store: environment.store });
  return { storage, environment, graph };
}

async function writer(directory) {
  const { environment, graph } = await openService(directory, async () => {
    // start() and graph ownership are persisted before dispatch reaches the adapter.
    // Keep the process alive; no response or cancellation cleanup will be committed.
    setInterval(() => {}, 60_000);
    process.send({ phase: "dispatched" });
    await new Promise(() => {});
  });
  await graph.startRoot({ graphId, ...await environment.prepareWorkflow({ agent, input: "private request" }) });
}

export async function runRestartingService({ log = console.log } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "js-agent-service-"));
  const child = fork(fileURLToPath(import.meta.url), ["--writer", directory], {
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  const exited = once(child, "exit");
  // Register the rejection handler immediately, including the spawn-error path.
  exited.catch(() => {});
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error("writer did not dispatch within 10s")), 10_000);
      const onMessage = (message) => { if (message?.phase === "dispatched") finish(); };
      const onExit = () => finish(new Error("writer exited before dispatch"));
      const onError = (error) => finish(error);
      function finish(error) {
        clearTimeout(timer);
        child.off("message", onMessage);
        child.off("exit", onExit);
        child.off("error", onError);
        if (error) reject(error); else resolve();
      }
      child.on("message", onMessage);
      child.once("exit", onExit);
      child.once("error", onError);
    });
    child.kill("SIGKILL");
    await exited; // Recovery is a writer operation: fence/stop the old writer first.

    let dispatchesAfterRestart = 0;
    const { storage, environment, graph } = await openService(directory, async () => {
      dispatchesAfterRestart++;
      throw new Error("recovery must not redispatch a model request");
    });
    // A separate UI needs only this facade, not storage, Environment, or its trusted store.
    const observer = createRunObserver(createView(storage, { grants: observerGrants }), { root });
    const before = await observer.snapshot(runId);
    // Reconcile authoritative invocation journals BEFORE the graph's derived index.
    const recovery = await environment.store.recover(runId);
    const recoveredGraph = await graph.recover(graphId);
    const after = await observer.snapshot(runId);
    const report = {
      backend: { driver: "hostfs", remounted: true, capabilities: storage.capabilities(root) },
      storage: environment.describe().runs,
      before,
      recovery,
      after,
      graphStatus: recoveredGraph.status,
      dispatchesAfterRestart,
      limits: {
        graphCrashConsistent: false,
        distributedTransactions: false,
        externalEffect: "unknown; never automatically replayed",
        observation: "best-effort snapshot, not a transaction or recovery operation",
      },
    };
    log(JSON.stringify(report, null, 2));
    return report;
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited.catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv[2] === "--writer") await writer(process.argv[3]);
  else await runRestartingService();
}
