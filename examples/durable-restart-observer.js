// Run with: node examples/durable-restart-observer.js
// A hostfs-backed process restart. The second Environment uses the same resource APIs after
// remounting the directory, while its redacted observer never reads invocation payloads.
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Vfs } from "../src/kernel/vfs.js";
import { createEnvironment, createRunStore, createWorkflowGraph } from "../src/runtime.js";

const agent = { model: "/models/reviewer", context: ["/workspace/brief.md"], tools: [] };
const observerPermissions = [{ path: "/runs/**", operations: ["stat", "list", "read"] }];

async function openStorage(directory) {
  const storage = new Vfs();
  await storage.mount("hostfs", "/", { source: directory, mode: "rw" });
  return storage;
}

async function seed(storage) {
  await storage.mkdirp("/models");
  await storage.mkdirp("/workspace");
  await storage.write("/models/reviewer.json", JSON.stringify({ provider: "durable-fixture" }), { create: true });
  await storage.write("/workspace/brief.md", "Review the migration and retain rollback evidence.\n", { create: true });
}

function environmentFor(storage, requestStarted, gate) {
  return createEnvironment({
    resources: storage,
    storage,
    store: createRunStore(storage, { root: "/runs" }),
    root: "/runs",
    observerInterval: 1,
    model: {
      path: "/models/reviewer",
      adapter: {
        async request(_request, { resources }) {
          await resources.read("/models/reviewer.json");
          requestStarted?.();
          if (gate) await gate;
          return { content: [{ type: "text", text: "review complete" }], stop_reason: "end_turn" };
        },
      },
    },
    permissions: {
      agent: [{ path: "/workspace/**", operations: ["read"] }],
      model: [{ path: "/models/reviewer.json", operations: ["read"] }],
      tools: [],
      observer: observerPermissions,
    },
  });
}

function publicRun(snapshot) {
  return {
    id: snapshot.id,
    status: snapshot.status,
    storage: snapshot.storage,
    sequence: snapshot.sequence,
    partial: snapshot.partial,
    redacted: snapshot.redacted,
    payloadFieldsAbsent: ["request", "plan", "response"].every((field) => !(field in snapshot)),
  };
}

export async function runDurableRestartObserver({ log = console.log } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "js-agent-durable-"));
  let release;
  let markStarted;
  const gate = new Promise((resolve) => { release = resolve; });
  const requestStarted = new Promise((resolve) => { markStarted = resolve; });
  try {
    const storage1 = await openStorage(directory);
    await seed(storage1);
    const environment1 = environmentFor(storage1, () => markStarted(), gate);
    // The graph owns the same store that the Environment uses; prepareWorkflow supplies it
    // after the catalog boundary has been assembled.
    const workflow = await environment1.prepareWorkflow({ agent, input: "Review the release." });
    const graph = createWorkflowGraph({ storage: storage1, store: workflow.store, root: "/workflows" });
    const controller = new AbortController();
    const running = graph.startRoot({ graphId: "durable-restart", ...workflow, signal: controller.signal });
    await requestStarted;

    const beforeRestart = {
      graph: (await graph.inspect("durable-restart")).status,
      run: publicRun(await environment1.observer.snapshot("durable-restart-root")),
    };

    // Simulate a new process: remount the same hostfs directory and rebuild all process-local
    // stores/coordinators. No invocation payload is passed to the observer.
    const storage2 = await openStorage(directory);
    const environment2 = environmentFor(storage2);
    const workflow2 = await environment2.prepareWorkflow({ agent, input: "unused after recovery" });
    const graph2 = createWorkflowGraph({ storage: storage2, store: workflow2.store, root: "/workflows" });
    const observer2 = environment2.observer;
    const persisted = publicRun(await observer2.snapshot("durable-restart-root"));
    const inspected = await graph2.inspect("durable-restart");
    const recovered = await graph2.recover("durable-restart");
    const afterRecovery = {
      graph: recovered.status,
      node: recovered.nodes[0].recovery,
      run: persisted,
      graphUncertainty: inspected.uncertainNodes.map(({ invocationId, persistedStatus }) => ({ invocationId, persistedStatus })),
    };

    controller.abort();
    release();
    await running;
    const afterShutdown = publicRun(await observer2.snapshot("durable-restart-root"));
    const report = {
      backend: { driver: "hostfs", remounted: true, resourceApi: ["stat", "list", "read"] },
      beforeRestart,
      afterRecovery,
      afterShutdown,
      limits: {
        runStoreMode: workflow.store.mode,
        distributedTransactions: false,
        recoveryOutcome: "unknown when the in-flight model result was not durably committed",
      },
    };
    log(JSON.stringify(report, null, 2));
    return report;
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  await runDurableRestartObserver();
}
