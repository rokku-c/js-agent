// Run with: node examples/git-revision-environment.js
// A real Git candidate worktree is edited, invoked through Environment + WorkflowGraph,
// observed through RunObserver, activated, and then captured by a future request.
import { execFile as execFileCallback } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { Vfs } from "../src/kernel/vfs.js";
import { createRunStore } from "../src/core/run-store.js";
import { createRunObserver } from "../src/core/run-observer.js";
import { createEnvironment } from "../src/core/environment.js";
import { createWorkflowGraph } from "../src/core/workflow-graph.js";
import { createGitRevisionConnector } from "../src/connectors/git-revision.js";

const exec = promisify(execFileCallback);

async function git(cwd, ...args) {
  return (await exec("git", args, { cwd, encoding: "utf8" })).stdout.trim();
}

async function makeRepository() {
  const repository = await fs.mkdtemp(path.join(os.tmpdir(), "js-agent-git-example-"));
  await git(repository, "init", "-q");
  await git(repository, "config", "user.name", "example");
  await git(repository, "config", "user.email", "example@example.test");
  await fs.writeFile(path.join(repository, "README.md"), "base\n");
  await git(repository, "add", "README.md");
  await git(repository, "commit", "-qm", "base");
  return repository;
}

async function appFor(worktree, label) {
  const storage = new Vfs();
  await storage.mount("mem", "/");
  await storage.mount("hostfs", "/candidate", { source: worktree, mode: "ro" });
  await storage.mkdirp("/models");
  await storage.write("/models/reviewer.json", JSON.stringify({ provider: "offline-example", model: "reviewer" }), { create: true });

  const store = createRunStore(storage, { root: "/runs" });
  const model = {
    path: "/models/reviewer",
    async request(request, { resources }) {
      const config = await resources.read("/models/reviewer.json");
      return {
        content: [{ type: "text", text: `${label}:${config}:${request.messages[0].content}` }],
        stop_reason: "end_turn",
      };
    },
  };
  const environment = createEnvironment({
    resources: storage,
    storage,
    store,
    model: { path: model.path, adapter: model },
    permissions: {
      agent: [{ path: "/candidate/**", operations: ["read"] }],
      model: [{ path: "/models/reviewer.json", operations: ["read"] }],
      tools: [],
      observer: [
        { path: "/candidate/**", operations: ["read"] },
        { path: "/runs/**", operations: ["stat", "list", "read"] },
      ],
    },
  });
  return {
    environment,
    graph: createWorkflowGraph({ storage, store, root: "/workflows" }),
    observer: createRunObserver(environment.observe, { root: "/runs", interval: 1 }),
    async close() {
      await storage.umount("/candidate");
    },
  };
}

async function invokeCandidate({ worktree, revision, id, label }) {
  const app = await appFor(worktree, label);
  try {
    const workflow = await app.environment.prepareWorkflow({
      agent: "/candidate/agent.json",
      input: `${label} review`,
    });
    const result = await app.graph.run({ id, root: workflow });
    const observed = await app.observer.snapshot(result.root.id);
    return {
      status: result.status,
      revision,
      prompt: await app.environment.observe.read("/candidate/prompt.md"),
      agent: JSON.parse(await app.environment.observe.read("/candidate/agent.json")),
      graph: { status: result.status, nodeStatus: result.graph.nodes[0].status },
      run: { status: observed.status, events: observed.events.map(({ kind }) => kind) },
    };
  } finally {
    await app.close();
  }
}

export async function runGitRevisionExample() {
  const repository = await makeRepository();
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "js-agent-git-state-"));
  const connector = await createGitRevisionConnector({ repository, stateDir: state });
  let candidate;
  try {
    candidate = await connector.createCandidate({ id: "prompt-review" });
    await connector.editCandidate(candidate.id, [
      { path: "prompt.md", content: "Review the candidate prompt.\n" },
      { path: "agent.json", content: JSON.stringify({ model: "/models/reviewer", context: ["/candidate/prompt.md"], tools: [] }, null, 2) + "\n" },
    ]);
    await connector.commitCandidate(candidate.id, { message: "add review prompt candidate" });
    await connector.runCheck(candidate.id, {
      command: process.execPath,
      args: ["-e", "const fs=require('node:fs'); JSON.parse(fs.readFileSync('agent.json')); if (!fs.readFileSync('prompt.md','utf8').includes('candidate prompt')) process.exit(2)"],
      label: "candidate resources",
    });

    const candidateRun = await connector.runCandidate(candidate.id, {
      input: "candidate review",
      invoke: (provenance) => invokeCandidate({ ...provenance, id: "candidate-review", label: "candidate" }),
    });
    const activation = await connector.activate(candidate.id, { activatedBy: "candidate-review" });
    const futureRun = await connector.runFuture({
      id: "activated-review",
      input: "future review",
      invoke: (provenance) => invokeCandidate({ ...provenance, id: "future-review", label: "future" }),
    });

    const report = {
      candidate: {
        id: candidate.id,
        status: (await connector.readCandidate(candidate.id)).status,
        revision: candidateRun.provenance.revision,
        prompt: candidateRun.result.prompt,
        agent: candidateRun.result.agent,
        graph: candidateRun.result.graph,
        run: candidateRun.result.run,
      },
      activation: {
        candidateId: activation.active.candidateId,
        revision: activation.active.revision,
      },
      future: {
        candidateId: futureRun.provenance.candidateId,
        revision: futureRun.provenance.revision,
        prompt: futureRun.result.prompt,
        graph: futureRun.result.graph,
        run: futureRun.result.run,
      },
    };
    console.log(JSON.stringify(report, null, 2));
    return report;
  } finally {
    const worktrees = path.join(state, "worktrees");
    for (const name of await fs.readdir(worktrees).catch(() => [])) {
      await exec("git", ["worktree", "remove", "--force", path.join(worktrees, name)], { cwd: repository }).catch(() => undefined);
    }
    await Promise.all([
      fs.rm(repository, { recursive: true, force: true }),
      fs.rm(state, { recursive: true, force: true }),
    ]);
  }
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  await runGitRevisionExample();
}
