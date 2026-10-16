// Run with: node examples/durable-multi-step-recovery.js
// A durable, multi-step workflow that recovers an in-flight branch without replaying it.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Vfs } from "../src/kernel/vfs.js";
import { createEnvironment, createRunStore } from "../src/runtime.js";

const agent = {
  model: "/models/reviewer",
  context: ["/workspace/brief.md"],
  tools: ["/tools/summary", "/tools/risks"],
};

const permissions = {
  agent: [{ path: "/workspace/**", operations: ["read"] }],
  model: [{ path: "/models/reviewer.json", operations: ["read"] }],
  tools: [
    { path: "/tools/**", operations: ["read"] },
    { path: "/workspace/**", operations: ["read"] },
  ],
  observer: [{ path: "/runs/**", operations: ["stat", "list", "read"] }],
};

async function openStorage(directory) {
  const storage = new Vfs();
  await storage.mount("hostfs", "/", { source: directory, mode: "rw" });
  return storage;
}

async function seed(storage) {
  await storage.mkdirp("/models");
  await storage.mkdirp("/tools/summary");
  await storage.mkdirp("/tools/risks");
  await storage.mkdirp("/workspace");
  await storage.write("/models/reviewer.json", JSON.stringify({ provider: "durable-fixture" }), { create: true });
  await storage.write("/workspace/brief.md", "Retain evidence for every review step.\n", { create: true });
  for (const name of ["summary", "risks"]) {
    await storage.write(`/tools/${name}/definition.json`, JSON.stringify({
      name,
      description: `Run the ${name} review step.`,
      input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    }), { create: true });
  }
}

function publicRun(snapshot) {
  return {
    id: snapshot.id,
    status: snapshot.status,
    sequence: snapshot.sequence,
    partial: snapshot.partial,
    redacted: snapshot.redacted,
    payloadFieldsAbsent: ["request", "plan", "response"].every((field) => !(field in snapshot)),
  };
}

function createModel({ branchStarted, releaseBranch, dispatches }) {
  return {
    path: "/models/reviewer",
    async request(request, { resources }) {
      await resources.read("/models/reviewer.json");
      if (request.messages.length === 1) {
        return {
          content: [
            { type: "tool_use", id: "summary-1", name: "summary", input: { path: "/workspace/brief.md" } },
            { type: "tool_use", id: "risks-1", name: "risks", input: { path: "/workspace/brief.md" } },
          ],
          stop_reason: "tool_use",
        };
      }
      dispatches.count += 1;
      const input = request.messages.at(-1)?.content;
      const branch = typeof input === "string" ? input.replace(/^branch:/, "") : "unknown";
      if (branch === "risks") {
        branchStarted.resolve();
        await releaseBranch;
      }
      return { content: [{ type: "text", text: `${branch} completed` }], stop_reason: "end_turn" };
    },
  };
}

function environmentFor(storage, model) {
  return createEnvironment({
    resources: storage,
    storage,
    store: createRunStore(storage, { root: "/runs", mode: "durable" }),
    model: { path: model.path, adapter: model },
    observerInterval: 1,
    permissions,
    tools: {
      paths: ["/tools/summary", "/tools/risks"],
      adapters: [
        { path: "/tools/summary", async invoke({ input, resources }) { return `summary:${await resources.read(input.path)}`; } },
        { path: "/tools/risks", async invoke({ input, resources }) { return `risks:${await resources.read(input.path)}`; } },
      ],
    },
  });
}

export async function runDurableMultiStepRecovery({ log = console.log } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "js-agent-multi-step-"));
  let release;
  const releaseBranch = new Promise((resolve) => { release = resolve; });
  const branchStarted = Promise.withResolvers();
  const dispatches = { count: 0 };
  try {
    const storage1 = await openStorage(directory);
    await seed(storage1);
    const model1 = createModel({ branchStarted, releaseBranch, dispatches });
    const environment1 = environmentFor(storage1, model1);
    const graph1 = environment1.createWorkflowGraph({ root: "/workflows" });
    const workflow = await environment1.prepareWorkflow({ agent, input: "Review and fan out." });
    const started = await graph1.startRoot({ graphId: "multi-step", ...workflow });
    const branch = graph1.continueBranch({
      graphId: "multi-step",
      branchKey: "risks",
      parent: started.root,
      parentResponse: started.root.response,
      toolResults: started.toolResults,
      agent,
      model: workflow.model,
      tools: workflow.tools,
      toolAdapters: workflow.toolAdapters,
      input: "branch:risks",
    });
    await branchStarted.promise;

    const dispatchesBeforeRecovery = dispatches.count;
    const storage2 = await openStorage(directory);
    const model2 = {
      path: "/models/reviewer",
      async request() {
        dispatches.count += 1;
        throw new Error("recovery must not dispatch a model request");
      },
    };
    const environment2 = environmentFor(storage2, model2);
    const graph2 = environment2.createWorkflowGraph({ root: "/workflows" });
    const before = {
      graph: (await graph2.inspect("multi-step")).status,
      run: publicRun(await environment2.observer.snapshot("multi-step-risks")),
    };
    const recovery = await environment2.recoverWorkflow(graph2, "multi-step");
    release();
    let late = null;
    let lateError = null;
    try { late = await branch; } catch (error) { lateError = { code: error.code ?? null, message: error.message }; }
    const after = {
      graph: (await graph2.inspect("multi-step")).status,
      run: publicRun(await environment2.observer.snapshot("multi-step-risks")),
    };
    const report = {
      workflow: {
        root: started.root.status,
        recoveredRuns: recovery.runs.map(({ id, status, recovered }) => ({ id, status, recovered })),
        lateBranch: { status: late?.status ?? "unknown", result: late?.result?.status ?? null, error: lateError },
      },
      before,
      recovery: { graph: recovery.graph.status, uncertain: recovery.inspected.uncertainNodes.map(({ key }) => key) },
      after,
      dispatches: { beforeRecovery: dispatchesBeforeRecovery, afterRecovery: dispatches.count },
      limits: {
        externalEffect: "unknown after interrupted dispatch; recovery never replays it",
        recoveryOrder: "RunStore journals, then WorkflowGraph index",
      },
    };
    log(JSON.stringify(report, null, 2));
    return report;
  } finally {
    release?.();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  await runDurableMultiStepRecovery();
}
