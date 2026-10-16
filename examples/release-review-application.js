// Run with: node examples/release-review-application.js
//
// A realistic, offline release-review application. The release brief and the tool
// implementation are resources, the model and tool are trusted adapters, service calls
// are explicitly delegated, and the graph/run records survive a remount.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Vfs } from "../src/kernel/vfs.js";
import { createView } from "../src/kernel/view.js";
import {
  bindToolResource,
  createEnvironment,
  createRunStore,
} from "../src/runtime.js";

const GRAPH_ID = "release-review";
const RELEASE_ID = "acme-api-2026-10";
const TOOL_PATH = "/tools/release-evidence";
const MODEL_PATH = "/models/release-reviewer";
const agent = {
  model: MODEL_PATH,
  context: ["/workspace/release-brief.md", "/workspace/review-policy.md"],
  tools: [TOOL_PATH],
};

const permissions = {
  agent: [{ path: "/workspace/**", operations: ["read"] }],
  model: [{ path: "/models/release-reviewer.json", operations: ["read"] }],
  tools: [
    { path: "/tools/**", operations: ["read"] },
    { path: "/workspace/**", operations: ["read"] },
  ],
  observer: [{ path: "/runs/**", operations: ["stat", "list", "read"] }],
};

function moduleLoader({ source }) {
  const encoded = Buffer.from(source, "utf8").toString("base64");
  return import(`data:text/javascript;base64,${encoded}`).then((module) => {
    if (typeof module.default !== "function") {
      throw new TypeError("resource-defined tool must default-export a function");
    }
    return module.default;
  });
}

async function openStorage(directory) {
  const storage = new Vfs();
  await storage.mount("hostfs", "/", { source: directory, mode: "rw" });
  return storage;
}

async function seed(storage) {
  await storage.mkdirp("/models");
  await storage.mkdirp(TOOL_PATH);
  await storage.mkdirp("/workspace");
  await storage.write("/models/release-reviewer.json", JSON.stringify({
    provider: "offline-release-fixture",
    model: "reviewer-v2",
  }), { create: true });
  await storage.write("/workspace/release-brief.md", [
    "Release: acme-api-2026-10",
    "Ship the idempotency-key migration after the API compatibility review.",
    "Rollback remains available through the previous gateway route.",
  ].join("\n") + "\n", { create: true });
  await storage.write("/workspace/review-policy.md", [
    "Check compatibility, migration safety, and rollback evidence.",
    "Record external evidence before approving a release.",
  ].join("\n") + "\n", { create: true });
  await storage.write(`${TOOL_PATH}/definition.json`, JSON.stringify({
    name: "release-evidence",
    description: "Fetch release evidence and pair it with the local release brief.",
    input_schema: {
      type: "object",
      properties: {
        release: { type: "string" },
        path: { type: "string" },
      },
      required: ["release", "path"],
    },
    entry: "entry.js",
  }), { create: true });
  await storage.write(`${TOOL_PATH}/entry.js`, `
export default async function ({ input, resources, services }) {
  const brief = await resources.read(input.path);
  const evidence = await services.call("release.evidence", { release: input.release });
  return JSON.stringify({ release: input.release, brief, evidence });
}
`, { create: true });
}

function createServices(serviceCalls) {
  return {
    "release.status": async ({ release }) => {
      serviceCalls.push({ operation: "release.status", release });
      return { release, state: "in-review", owner: "release-platform" };
    },
    "release.evidence": async ({ release }) => {
      serviceCalls.push({ operation: "release.evidence", release });
      return {
        release,
        checks: ["compatibility", "migration", "rollback"],
        rollbackRoute: "gateway-v1",
        capturedAt: "fixture-2026-10-16T09:00:00Z",
      };
    },
  };
}

function createModel({ migrationStarted, releaseMigration, dispatches, serviceCalls }) {
  return {
    path: MODEL_PATH,
    async request(request, { resources, services }) {
      dispatches.count += 1;
      await resources.read("/models/release-reviewer.json");
      if (request.messages.length === 1) {
        await services.call("release.status", { release: RELEASE_ID });
        return {
          content: [{
            type: "tool_use",
            id: "evidence-1",
            name: "release-evidence",
            input: { release: RELEASE_ID, path: "/workspace/release-brief.md" },
          }],
          stop_reason: "tool_use",
        };
      }

      const input = request.messages.at(-1)?.content;
      const branch = typeof input === "string" ? input.replace(/^branch:/, "") : "unknown";
      if (branch === "migration") {
        migrationStarted.resolve();
        await releaseMigration;
        return {
          content: [{ type: "text", text: "Migration review completed after the restart boundary." }],
          stop_reason: "end_turn",
        };
      }
      serviceCalls.push({ operation: "review.branch", branch });
      return {
        content: [{ type: "text", text: `${branch} review passed with recorded release evidence.` }],
        stop_reason: "end_turn",
      };
    },
  };
}

async function bindEvidenceTool(storage) {
  const toolResources = createView(storage, {
    grants: [
      { path: "/tools/**", operations: ["read"] },
      { path: "/workspace/**", operations: ["read"] },
    ],
  });
  return bindToolResource(toolResources, TOOL_PATH, { loader: moduleLoader });
}

function environmentFor(storage, model, binding, serviceCalls) {
  const store = createRunStore(storage, { root: "/runs", mode: "durable" });
  return createEnvironment({
    resources: storage,
    storage,
    store,
    observerInterval: 1,
    model: {
      path: MODEL_PATH,
      adapter: model,
      serviceGrants: ["release.status"],
    },
    tools: {
      paths: [TOOL_PATH],
      adapters: [{
        path: TOOL_PATH,
        invoke: binding.invoke,
        serviceGrants: ["release.evidence"],
      }],
    },
    permissions,
    services: createServices(serviceCalls),
  });
}

function publicRun(snapshot) {
  return {
    id: snapshot.id,
    status: snapshot.status,
    sequence: snapshot.sequence,
    terminal: snapshot.terminal,
    partial: snapshot.partial,
    redacted: snapshot.redacted,
    payloadFieldsAbsent: ["request", "plan", "response"].every((field) => !(field in snapshot)),
  };
}

function graphSummary(graph) {
  return {
    id: graph.id,
    status: graph.status,
    nodes: graph.nodes.map(({ key, kind, status, invocationStatus, recovery }) => ({
      key,
      kind,
      status,
      invocationStatus,
      ...(recovery ? { recovery } : {}),
    })),
    edges: graph.edges.map(({ key, status }) => ({ key, status })),
  };
}

function runsSummary(runs) {
  return runs.map(publicRun);
}

export function renderReleaseReviewReport(report) {
  const lines = [
    "RELEASE REVIEW UI",
    `workflow ${report.workflow.id}: ${report.after.graph.status}`,
    `tool ${report.tool.name} @ ${report.tool.entryRevision}`,
    `before restart: ${report.before.graph.status}; after recovery: ${report.after.graph.status}`,
    "nodes:",
    ...report.after.graph.nodes.map((node) => `  ${node.key.padEnd(18)} ${node.status}${node.recovery ? ` (${node.recovery})` : ""}`),
    "runs:",
    ...report.after.runs.map((run) => `  ${run.id.padEnd(32)} ${run.status} events=${run.sequence}`),
    `service calls: ${report.services.calls.map(({ operation }) => operation).join(", ")}`,
    `observer redacted: ${report.observer.redacted}; payloads exposed: ${!report.observer.payloadFieldsAbsent}`,
    `late pre-restart branch: ${report.recovery.lateBranch.status}`,
  ];
  return lines.join("\n");
}

export async function runReleaseReviewApplication({ log = console.log } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "js-agent-release-review-"));
  const dispatches = { count: 0 };
  const serviceCalls = [];
  let releaseMigration;
  let releaseMigrationBranch;
  const migrationGate = new Promise((resolve) => { releaseMigration = resolve; });
  const migrationStarted = Promise.withResolvers();

  try {
    const storage1 = await openStorage(directory);
    await seed(storage1);
    const binding1 = await bindEvidenceTool(storage1);
    const model1 = createModel({ migrationStarted, releaseMigration: migrationGate, dispatches, serviceCalls });
    const environment1 = environmentFor(storage1, model1, binding1, serviceCalls);
    const graph1 = environment1.createWorkflowGraph({ root: "/workflows" });
    const workflow = await environment1.prepareWorkflow({ agent, input: "Review this release for approval." });
    const started = await graph1.startRoot({ graphId: GRAPH_ID, ...workflow });

    let securityBranch;
    let migrationBranch;
    try {
      securityBranch = graph1.continueBranch({
        graphId: GRAPH_ID,
        branchKey: "security",
        parent: started.root,
        parentResponse: started.root.response,
        toolResults: started.toolResults,
        agent: workflow.agent,
        model: workflow.model,
        tools: workflow.tools,
        input: "branch:security",
      });
      migrationBranch = graph1.continueBranch({
        graphId: GRAPH_ID,
        branchKey: "migration",
        parent: started.root,
        parentResponse: started.root.response,
        toolResults: started.toolResults,
        agent: workflow.agent,
        model: workflow.model,
        tools: workflow.tools,
        input: "branch:migration",
      });
      releaseMigrationBranch = migrationBranch;
      await Promise.all([securityBranch, migrationStarted.promise]);
    } catch (error) {
      throw error;
    }

    const dispatchesBeforeRecovery = dispatches.count;
    const before = {
      graph: graphSummary(await graph1.inspect(GRAPH_ID)),
      runs: runsSummary(await environment1.observer.list()),
    };

    // Simulate a process restart by remounting the same directory and rebuilding every
    // process-local coordinator. The new model throws if recovery accidentally dispatches.
    const storage2 = await openStorage(directory);
    const binding2 = await bindEvidenceTool(storage2);
    const model2 = {
      path: MODEL_PATH,
      async request() {
        dispatches.count += 1;
        throw new Error("recovery must not dispatch an uncertain model request");
      },
    };
    const environment2 = environmentFor(storage2, model2, binding2, serviceCalls);
    const graph2 = environment2.createWorkflowGraph({ root: "/workflows" });
    const observedBeforeRecovery = publicRun(await environment2.observer.snapshot(`${GRAPH_ID}-migration`));
    const recovery = await environment2.recoverWorkflow(graph2, GRAPH_ID);
    releaseMigration();

    let lateBranch;
    try {
      lateBranch = await releaseMigrationBranch;
    } catch (error) {
      lateBranch = {
        status: "unknown",
        error: { code: error.code ?? null, message: error.message },
      };
    }

    const afterGraph = graphSummary(await graph2.inspect(GRAPH_ID));
    const afterRuns = runsSummary(await environment2.observer.list());
    const report = {
      workflow: { id: GRAPH_ID, root: started.root.status },
      tool: {
        name: binding2.definition.name,
        path: binding2.path,
        entry: binding2.entryPath,
        entryRevision: binding2.entryRevision,
      },
      before,
      recovery: {
        graph: recovery.graph.status,
        uncertainNodes: recovery.inspected.uncertainNodes.map(({ key, invocationId, persistedStatus }) => ({ key, invocationId, persistedStatus })),
        recoveredRuns: recovery.runs.map(({ id, status, recovered }) => ({ id, status, recovered })),
        observedBeforeRecovery,
        lateBranch: {
          status: lateBranch.status ?? lateBranch.result?.status ?? "unknown",
          error: lateBranch.error ?? null,
        },
      },
      after: { graph: afterGraph, runs: afterRuns },
      services: { grants: environment2.describe().delegation, calls: serviceCalls },
      observer: {
        redacted: afterRuns.every((run) => run.redacted),
        payloadFieldsAbsent: afterRuns.every((run) => run.payloadFieldsAbsent),
      },
      dispatches: { beforeRecovery: dispatchesBeforeRecovery, afterRecovery: dispatches.count },
      limits: {
        restart: "simulated by remounting the durable directory and rebuilding Environment/WorkflowGraph",
        externalEffect: "unknown after an interrupted dispatch; recovery never replays it",
      },
    };
    log(renderReleaseReviewReport(report));
    log("\nREPORT JSON\n" + JSON.stringify(report, null, 2));
    return report;
  } finally {
    releaseMigration?.();
    if (releaseMigrationBranch) {
      try { await releaseMigrationBranch; } catch { /* report path records the fenced late completion */ }
    }
    await fs.rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  await runReleaseReviewApplication();
}
