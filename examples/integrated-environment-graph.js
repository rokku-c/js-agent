// Run with: node examples/integrated-environment-graph.js
// A small end-user application that composes an Environment, WorkflowGraph, and
// redacted RunObserver into one live report.
import { Vfs } from "../src/kernel/vfs.js";
import { createRunStore } from "../src/core/run-store.js";
import { createRunObserver } from "../src/runtime.js";
import { createEnvironment, createWorkflowGraph } from "../src/runtime.js";

const agent = {
  model: "/models/reviewer",
  context: ["/workspace/brief.md"],
  tools: ["/tools/summary", "/tools/risks"],
};

function summarizeGraph(graph) {
  return {
    id: graph.id,
    status: graph.status,
    nodes: graph.nodes.map(({ key, kind, status, invocationStatus, parent }) => ({
      key, kind, status, invocationStatus, ...(parent ? { parent } : {}),
    })),
    edges: graph.edges.map(({ key, status }) => ({ key, status })),
  };
}

function summarizeRuns(runs) {
  return runs.map(({ id, status, terminal, sequence, partial }) => ({
    id, status, terminal, sequence, partial,
  }));
}

export function renderReport({ graph, runs, root }) {
  const lines = [
    "INTEGRATED REVIEW UI",
    `graph ${graph.id}: ${graph.status}`,
    "nodes:",
    ...graph.nodes.map((node) => `  ${node.key.padEnd(14)} ${node.status}`),
    "runs:",
    ...runs.map((run) => `  ${run.id.padEnd(24)} ${run.status ?? "unavailable"} events=${run.sequence}`),
    `root observer: ${root.status} events=${root.sequence}`,
  ];
  return lines.join("\n");
}

export async function createIntegratedApp({ holdBranches = true } = {}) {
  const storage = new Vfs();
  await storage.mount("mem", "/");
  await storage.mkdirp("/models");
  await storage.mkdirp("/tools/summary");
  await storage.mkdirp("/tools/risks");
  await storage.mkdirp("/workspace");
  await storage.write("/models/reviewer.json", JSON.stringify({ provider: "offline-fixture", model: "reviewer" }), { create: true });
  for (const [name, description] of [
    ["summary", "Summarize the review brief."],
    ["risks", "Extract risks from the review brief."],
  ]) {
    await storage.write(`/tools/${name}/definition.json`, JSON.stringify({
      name,
      description,
      input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    }), { create: true });
  }
  await storage.write("/workspace/brief.md", "Ship the small API, keep state observable, and document uncertainty.\n", { create: true });

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

      const input = request.messages.at(-1).content;
      const branch = typeof input === "string" ? input.replace(/^branch:/, "") : "unknown";
      activeBranches += 1;
      branchRequests += 1;
      maxConcurrentBranches = Math.max(maxConcurrentBranches, activeBranches);
      if (branchRequests === 2) resolveBranchesReady();
      try {
        await branchGate;
        return {
          content: [{ type: "text", text: `${branch} branch joined the review: ${request.messages.at(-2).content.map((result) => result.content).join(" | ")}` }],
          stop_reason: "end_turn",
        };
      } finally {
        activeBranches -= 1;
      }
    },
  };

  const environment = createEnvironment({
    resources: storage,
    storage,
    store,
    model: { path: model.path, adapter: model },
    tools: {
      paths: ["/tools/summary", "/tools/risks"],
      adapters: [
        {
          path: "/tools/summary",
          async invoke({ input, resources }) {
            await new Promise((resolve) => setTimeout(resolve, 10));
            return `summary:${await resources.read(input.path)}`;
          },
        },
        {
          path: "/tools/risks",
          async invoke({ input, resources }) {
            await new Promise((resolve) => setTimeout(resolve, 2));
            return `risks:${await resources.read(input.path)}`;
          },
        },
      ],
    },
    permissions: {
      agent: [{ path: "/workspace/**", operations: ["read"] }],
      model: [{ path: "/models/reviewer.json", operations: ["read"] }],
      tools: [
        { path: "/tools/**", operations: ["read"] },
        { path: "/workspace/**", operations: ["read"] },
      ],
      observer: [{ path: "/runs/**", operations: ["stat", "list", "read"] }],
    },
  });

  const graph = createWorkflowGraph({ storage, store, root: "/workflows" });
  // Wrapping the Environment's observer view preserves its permission boundary while
  // adding redacted snapshots and polling for a UI.
  const observer = createRunObserver(environment.observe, { root: "/runs", interval: 1 });

  return {
    storage,
    store,
    environment,
    graph,
    observer,
    agent,
    branchesReady,
    releaseBranches: releaseBranches ?? (() => {}),
    get maxConcurrentBranches() { return maxConcurrentBranches; },
  };
}

export async function runIntegratedDemo() {
  const app = await createIntegratedApp({ holdBranches: true });
  const { environment, graph, observer } = app;
  const graphId = "integrated-review";
  const workflow = await environment.prepareWorkflow({
    agent,
    input: "Review this brief and fan out the follow-up work.",
    trace: [],
  });
  const started = await graph.startRoot({ graphId, ...workflow });
  const rootWatch = observer.watch(started.root.id);
  const rootLive = (await rootWatch.next()).value;

  const branchRuns = ["summary", "risks"].map((branchKey) => graph.continueBranch({
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
  const live = {
    graph: summarizeGraph(await graph.inspect(graphId)),
    runs: summarizeRuns(await observer.list()),
  };

  app.releaseBranches();
  await Promise.all(branchRuns);
  const finalGraph = await graph.close(graphId);
  const finalRuns = await observer.list();
  const final = {
    graph: summarizeGraph(finalGraph),
    runs: summarizeRuns(finalRuns),
  };
  const report = {
    live,
    final,
    root: { status: rootLive.status, sequence: rootLive.sequence },
    concurrency: { branches: app.maxConcurrentBranches },
  };

  console.log(renderReport({ graph: final.graph, runs: final.runs, root: report.root }));
  console.log("\nREPORT JSON");
  console.log(JSON.stringify(report, null, 2));
  return report;
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  await runIntegratedDemo();
}
