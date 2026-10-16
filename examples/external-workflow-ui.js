// Run with: node examples/external-workflow-ui.js
// A remote-shaped UI flow. External files/status use InMemoryConnector + View.watch;
// run files/events use a redacted RunObserver; WorkflowGraph owns the join state.
import { Vfs } from "../src/kernel/vfs.js";
import { createView } from "../src/kernel/view.js";
import { createRunStore } from "../src/core/run-store.js";
import { createRunObserver } from "../src/core/run-observer.js";
import { createInMemoryConnector } from "../src/connectors/in-memory.js";
import { createEnvironment, createWorkflowGraph } from "../src/runtime.js";
import { resolveReference } from "../src/core/references.js";

const briefPath = "/remote/release/brief.md";
const rulesPath = "/remote/release/review-rules.md";
const summaryToolPath = "/remote/tools/summary";
const risksToolPath = "/remote/tools/risks";

const fullOperations = ["stat", "list", "read", "write", "watch"];

function summarizeGraph(graph) {
  return {
    id: graph.id,
    status: graph.status,
    nodes: graph.nodes.map(({ key, kind, status, invocationStatus, parent }) => ({
      key,
      kind,
      status,
      invocationStatus,
      ...(parent ? { parent } : {}),
    })),
    edges: graph.edges.map(({ key, status }) => ({ key, status })),
  };
}

function summarizeRuns(runs) {
  return runs.map(({ id, status, terminal, sequence, partial, redacted, volatile }) => ({
    id,
    status,
    terminal,
    sequence,
    partial,
    redacted,
    volatile,
  }));
}

function terminalSnapshot(stream) {
  return (async () => {
    let step;
    do step = await stream.next(); while (!step.done && !step.value.terminal);
    return step.value;
  })();
}

export function renderExternalWorkflowReport(report) {
  const lines = [
    "REMOTE RELEASE REVIEW UI",
    `graph ${report.final.graph.id}: ${report.final.graph.status}`,
    `remote changes: ${report.external.changes.map(({ kind, path }) => `${kind}:${path}`).join(", ")}`,
    "nodes:",
    ...report.final.graph.nodes.map((node) => `  ${node.key.padEnd(18)} ${node.status}`),
    "runs:",
    ...report.final.runs.map((run) => `  ${run.id.padEnd(28)} ${run.status} events=${run.sequence}`),
    `pinned rules: ${report.references.pinnedRules}`,
    `live brief after update: ${report.references.liveBriefAfterUpdate}`,
    `observer redacted: ${report.observer.redacted}`,
  ];
  return lines.join("\n");
}

export async function createExternalWorkflowUi({ holdBranches = true } = {}) {
  const connector = createInMemoryConnector({
    source: "remote-release-fixture",
    status: {
      state: "connected",
      provider: "release-system",
      endpoint: "remote://release-system/acme",
      last_error: null,
    },
    resources: {
      [briefPath]: {
        value: "Ship the API changes and verify the migration before release.\n",
        metadata: {
          provider: "release-system",
          externalId: "release://acme/2026-10-16/brief",
          freshness: "read-through",
        },
      },
      [rulesPath]: {
        value: "Check behavior, migration safety, and rollback evidence.\n",
        metadata: {
          provider: "release-system",
          externalId: "release://acme/policies/review",
          freshness: "pinned-at-admission",
        },
      },
      [`${summaryToolPath}/definition.json`]: {
        value: {
          name: "summary",
          description: "Summarize the remote release brief.",
          input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
          entry: "summary.js",
        },
        metadata: { provider: "release-system", externalId: "tool://summary" },
      },
      [`${risksToolPath}/definition.json`]: {
        value: {
          name: "risks",
          description: "Extract migration risks from the remote release brief.",
          input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
          entry: "risks.js",
        },
        metadata: { provider: "release-system", externalId: "tool://risks" },
      },
    },
  });
  const remote = createView(connector, {
    grants: [
      { path: "/remote/**", operations: fullOperations },
      { path: "/status.json", operations: ["read", "watch"] },
    ],
  });
  const rulesRevision = (await remote.stat(rulesPath)).revision;
  const initialBriefRevision = (await remote.stat(briefPath)).revision;

  const storage = new Vfs();
  await storage.mount("mem", "/");
  const store = createRunStore(storage, { root: "/runs" });
  let activeBranches = 0;
  let maxConcurrentBranches = 0;
  let resolveBranchesReady;
  let branchRequests = 0;
  const branchesReady = new Promise((resolve) => { resolveBranchesReady = resolve; });
  let releaseBranches;
  const branchGate = holdBranches
    ? new Promise((resolve) => { releaseBranches = resolve; })
    : Promise.resolve();

  const model = {
    path: "/models/release-reviewer",
    async request(request, { resources }) {
      await resources.read(briefPath);
      if (request.messages.length === 1) {
        return {
          content: [
            { type: "tool_use", id: "summary-1", name: "summary", input: { path: briefPath } },
            { type: "tool_use", id: "risks-1", name: "risks", input: { path: briefPath } },
          ],
          stop_reason: "tool_use",
        };
      }
      activeBranches += 1;
      branchRequests += 1;
      maxConcurrentBranches = Math.max(maxConcurrentBranches, activeBranches);
      if (branchRequests === 2) resolveBranchesReady();
      try {
        await branchGate;
        return {
          content: [{ type: "text", text: "remote branch completed with current release evidence" }],
          stop_reason: "end_turn",
        };
      } finally {
        activeBranches -= 1;
      }
    },
  };

  const environment = createEnvironment({
    resources: remote,
    storage,
    store,
    model: { path: model.path, adapter: model },
    tools: {
      paths: [summaryToolPath, risksToolPath],
      adapters: [
        {
          path: summaryToolPath,
          async invoke({ input, resources }) {
            return `summary:${await resources.read(input.path)}`;
          },
        },
        {
          path: risksToolPath,
          async invoke({ input, resources }) {
            return `risks:${await resources.read(input.path)}`;
          },
        },
      ],
    },
    permissions: {
      agent: [{ path: "/remote/**", operations: ["read"] }],
      model: [{ path: "/remote/**", operations: ["read"] }],
      tools: [{ path: "/remote/**", operations: ["read"] }],
      observer: [{ path: "/runs/**", operations: ["stat", "list", "read"] }],
    },
  });
  const graph = createWorkflowGraph({ storage, store, root: "/workflows" });
  const observer = createRunObserver(environment.observe, { root: "/runs", interval: 1 });

  return {
    connector,
    remote,
    storage,
    store,
    environment,
    graph,
    observer,
    rulesRevision,
    initialBriefRevision,
    branchesReady,
    releaseBranches: releaseBranches ?? (() => {}),
    get maxConcurrentBranches() { return maxConcurrentBranches; },
  };
}

export async function runExternalWorkflowUi({ log = console.log } = {}) {
  const app = await createExternalWorkflowUi({ holdBranches: true });
  const { environment, graph, observer, remote, connector } = app;
  const graphId = "remote-release-review";
  const agent = {
    model: "/models/release-reviewer",
    system: [{ $ref: rulesPath, mode: "pinned", revision: app.rulesRevision }],
    context: [briefPath],
    tools: [summaryToolPath, risksToolPath],
  };
  const workflow = await environment.prepareWorkflow({
    agent,
    input: "Review the remote release and fan out the checks.",
    trace: [],
  });

  const fileWatch = remote.watch("/remote/release", { includeInitial: true });
  const statusWatch = remote.watch("/status.json", { includeInitial: false });
  const initialExternal = await fileWatch.next();
  const started = await graph.startRoot({ graphId, ...workflow });
  const rootWatch = observer.watch(started.root.id);
  const rootInitial = (await rootWatch.next()).value;
  await rootWatch.return();

  const branchKeys = ["summary", "risks"];
  const branchRuns = branchKeys.map((branchKey) => graph.continueBranch({
    graphId,
    branchKey,
    parent: started.root,
    parentResponse: started.root.response,
    toolResults: started.toolResults,
    agent: workflow.agent,
    model: workflow.model,
    tools: workflow.tools,
    input: `branch:${branchKey}`,
  }));
  await app.branchesReady;
  const branchWatches = branchKeys.map((branchKey) => observer.watch(`${graphId}-${branchKey}`));
  const branchInitial = await Promise.all(branchWatches.map((watch) => watch.next()));

  await remote.write(briefPath, "Migration evidence is now attached; verify rollback before release.\n", {
    revision: app.initialBriefRevision,
  });
  await connector.setStatus({
    state: "degraded",
    provider: "release-system",
    endpoint: "remote://release-system/acme",
    last_error: "upstream sync is delayed",
  }, { source: "remote-sync" });
  const changedFile = await fileWatch.next();
  const changedStatus = await statusWatch.next();
  const liveGraph = await graph.inspect(graphId);
  const liveRuns = await observer.list();
  const liveBriefAfterUpdate = (await resolveReference(remote, briefPath)).value;
  const pinnedRules = (await resolveReference(remote, {
    $ref: rulesPath,
    mode: "pinned",
    revision: app.rulesRevision,
  })).value;

  app.releaseBranches();
  const branchFinal = await Promise.all(branchWatches.map(terminalSnapshot));
  const branchResults = await Promise.all(branchRuns);
  const finalGraph = await graph.close(graphId);
  const finalRuns = await observer.list();
  await Promise.all(branchWatches.map((watch) => watch.return()));
  await fileWatch.return();
  await statusWatch.return();

  const observerSnapshot = await observer.snapshot(started.root.id);
  const report = {
    external: {
      initial: { kind: initialExternal.value.kind, path: initialExternal.value.path },
      changes: [changedFile.value, changedStatus.value].map(({ kind, path, source }) => ({ kind, path, source })),
      status: connector.status(),
      metadata: (await remote.stat(briefPath)).resource,
    },
    references: {
      pinnedRules: pinnedRules.trim(),
      liveBriefAfterUpdate: liveBriefAfterUpdate.trim(),
    },
    live: {
      graph: summarizeGraph(liveGraph),
      runs: summarizeRuns(liveRuns.filter(({ id }) => id.includes(graphId))),
      branches: branchInitial.map(({ value }) => ({ id: value.id, status: value.status, sequence: value.sequence })),
    },
    final: {
      graph: summarizeGraph(finalGraph),
      runs: summarizeRuns(finalRuns.filter(({ id }) => id.includes(graphId))),
      branches: branchFinal.map((value) => ({ id: value.id, status: value.status, sequence: value.sequence })),
      results: branchResults.map(({ status }) => status),
    },
    observer: {
      redacted: observerSnapshot.redacted,
      volatile: observerSnapshot.volatile,
      payloadFieldsAbsent: ["request", "plan", "response", "metadata"].every((field) => !(field in observerSnapshot)),
    },
    concurrency: { branches: app.maxConcurrentBranches },
    root: { status: rootInitial.status, sequence: rootInitial.sequence },
  };
  log(renderExternalWorkflowReport(report));
  log("\nREPORT JSON");
  log(JSON.stringify(report, null, 2));
  return report;
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  await runExternalWorkflowUi();
}
