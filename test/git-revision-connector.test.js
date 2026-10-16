import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "./helpers.js";
import { createGitRevisionConnector } from "../src/connectors/git-revision.js";
import { Vfs } from "../src/kernel/vfs.js";
import { createRunStore } from "../src/core/run-store.js";
import { createRunObserver } from "../src/core/run-observer.js";
import { createEnvironment } from "../src/core/environment.js";
import { createWorkflowGraph } from "../src/core/workflow-graph.js";

const exec = promisify(execFileCallback);

async function git(cwd, ...args) {
  return (await exec("git", args, { cwd, encoding: "utf8" })).stdout.trim();
}

async function fixture() {
  const repository = await tmpdir("js-agent-git-connector-");
  const state = await tmpdir("js-agent-git-state-");
  await git(repository.path, "init", "-q");
  await git(repository.path, "config", "user.name", "connector test");
  await git(repository.path, "config", "user.email", "connector@example.test");
  await fs.writeFile(path.join(repository.path, "README.md"), "base\n");
  await git(repository.path, "add", "README.md");
  await git(repository.path, "commit", "-qm", "base");
  const connector = await createGitRevisionConnector({
    repository: repository.path,
    stateDir: state.path,
  });
  return { repository, state, connector };
}

async function cleanup({ repository, state }) {
  const worktrees = path.join(state.path, "worktrees");
  const names = await fs.readdir(worktrees).catch(() => []);
  for (const name of names) {
    await exec("git", ["worktree", "remove", "--force", path.join(worktrees, name)], {
      cwd: repository.path,
      encoding: "utf8",
    }).catch(() => undefined);
  }
  await Promise.all([repository.cleanup(), state.cleanup()]);
}

async function candidateReady(connector, id, content = `${id}\n`) {
  const candidate = await connector.createCandidate({ id });
  await connector.editCandidate(id, [{ path: "prompt.md", content }]);
  await connector.commitCandidate(id);
  await connector.runCheck(id, {
    command: process.execPath,
    args: ["-e", "process.exit(0)"],
    label: "smoke",
  });
  await connector.runCandidate(id, {
    input: id,
    invoke: async () => ({ status: "passed" }),
  });
  return candidate;
}

test("connector keeps checks, cleanup, path confinement, and stale trees in the connector boundary", async () => {
  const fixtureValue = await fixture();
  const { connector, repository } = fixtureValue;
  try {
    const candidate = await connector.createCandidate({ id: "adversarial" });
    for (const edit of [".git", ".GIT/config", "../outside", "/tmp/outside", "nested/../../outside", "nested\\..\\outside"]) {
      await assert.rejects(
        () => connector.editCandidate(candidate.id, [{ path: edit, content: "escape" }]),
        (error) => ["EINVAL", "EACCES"].includes(error.code),
        edit,
      );
    }
    await fs.symlink("/tmp", path.join(candidate.worktree, "link"));
    await assert.rejects(
      () => connector.editCandidate(candidate.id, [{ path: "link/escaped", content: "escape" }]),
      { code: "ELOOP" },
    );
    await fs.unlink(path.join(candidate.worktree, "link"));
    await connector.editCandidate(candidate.id, [{ path: "prompt.md", content: "candidate\n" }]);
    await connector.commitCandidate(candidate.id);

    await assert.rejects(
      () => connector.runCheck(candidate.id, {
        command: process.execPath,
        args: ["-e", "process.exit(7)"],
        label: "intentional failure",
      }),
      { code: "ECHECK" },
    );
    await connector.runCandidate(candidate.id, {
      input: "failed checks must block activation",
      invoke: async () => ({ status: "passed" }),
    });
    await assert.rejects(() => connector.activate(candidate.id), { code: "EPERM" });

    const record = await connector.readCandidate(candidate.id);
    assert.equal(record.checksPassed, false);
    assert.equal(record.status, "validated");
    await connector.removeCandidate(candidate.id);
    assert.equal((await connector.readCandidate(candidate.id)).status, "removed");
    assert.equal((await connector.removeCandidate(candidate.id)).status, "removed");
    assert.equal(await fs.access(candidate.worktree).then(() => true).catch(() => false), false);
    assert.equal((await git(repository.path, "worktree", "list", "--porcelain")).includes(candidate.worktree), false);
  } finally {
    await cleanup(fixtureValue);
  }
});

test("activation has a cross-instance compare-and-swap and rejects stale candidate bases", async () => {
  const fixtureValue = await fixture();
  const { repository, state, connector } = fixtureValue;
  try {
    const base = (await connector.activeRevision()).revision;
    const other = await createGitRevisionConnector({ repository: repository.path, stateDir: state.path });
    await candidateReady(connector, "race-one");
    await candidateReady(other, "race-two");

    const results = await Promise.allSettled([
      connector.activate("race-one", { expectedRevision: base }),
      other.activate("race-two", { expectedRevision: base }),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected" && result.reason.code === "EAGAIN").length, 1);

    const winner = (await connector.activeRevision()).candidateId;
    assert.ok(["race-one", "race-two"].includes(winner));

    const stale = await connector.createCandidate({ id: "stale-base", baseRevision: base });
    await connector.editCandidate(stale.id, [{ path: "stale.md", content: "stale\n" }]);
    await connector.commitCandidate(stale.id);
    await connector.runCheck(stale.id, { command: process.execPath, args: ["-e", "process.exit(0)"], label: "stale smoke" });
    await connector.runCandidate(stale.id, { input: "stale", invoke: async () => ({ status: "passed" }) });
    await assert.rejects(() => connector.activate(stale.id), { code: "EAGAIN" });
  } finally {
    await cleanup(fixtureValue);
  }
});

test("future requests keep their captured worktree while activation advances", async () => {
  const fixtureValue = await fixture();
  const { connector } = fixtureValue;
  try {
    await candidateReady(connector, "first");
    await connector.activate("first");
    let entered;
    let release;
    const started = new Promise((resolve) => { entered = resolve; });
    const paused = connector.runFuture({
      id: "in-flight",
      input: "old revision request",
      invoke: async (provenance) => {
        entered(provenance);
        await new Promise((resolve) => { release = resolve; });
        return { status: "completed", revision: provenance.revision };
      },
    });
    const captured = await started;

    await candidateReady(connector, "second");
    const secondActivation = await connector.activate("second");
    release();
    const result = await paused;

    assert.equal(result.provenance.revision, captured.revision);
    assert.equal(result.provenance.worktree, captured.worktree);
    assert.notEqual(secondActivation.active.revision, captured.revision);
    assert.equal((await connector.activeRevision()).candidateId, "second");
    await assert.rejects(() => connector.removeCandidate("second"), { code: "EBUSY" });
  } finally {
    await cleanup(fixtureValue);
  }
});

test("candidate invocation failures and post-commit edits cannot be activated", async () => {
  const fixtureValue = await fixture();
  const { connector } = fixtureValue;
  try {
    const failed = await connector.createCandidate({ id: "failed-invocation" });
    await connector.editCandidate(failed.id, [{ path: "prompt.md", content: "candidate\n" }]);
    await connector.commitCandidate(failed.id);
    await connector.runCheck(failed.id, { command: process.execPath, args: ["-e", "process.exit(0)"], label: "smoke" });
    await assert.rejects(
      () => connector.runCandidate(failed.id, { input: "fail", invoke: async () => ({ status: "failed" }) }),
      { code: "EINVOCATION" },
    );
    await assert.rejects(() => connector.activate(failed.id), { code: "EPERM" });

    const stale = await connector.createCandidate({ id: "post-commit-edit" });
    await connector.editCandidate(stale.id, [{ path: "prompt.md", content: "candidate\n" }]);
    const committed = await connector.commitCandidate(stale.id);
    await fs.writeFile(path.join(stale.worktree, "prompt.md"), "tampered\n");
    await assert.rejects(
      () => connector.runCheck(stale.id, { command: process.execPath, args: ["-e", "process.exit(0)"], label: "clean tree" }),
      { code: "ECHECK" },
    );
    assert.equal((await connector.readCandidate(stale.id)).candidateRevision, committed.candidateRevision);
  } finally {
    await cleanup(fixtureValue);
  }
});

test("Git candidates compose with Environment, WorkflowGraph, and RunObserver", async () => {
  const fixtureValue = await fixture();
  const { connector } = fixtureValue;
  let candidate;
  try {
    candidate = await connector.createCandidate({ id: "prompt-agent-candidate" });
    await connector.editCandidate(candidate.id, [
      { path: "prompt.md", content: "Review the candidate prompt.\n" },
      {
        path: "agent.json",
        content: JSON.stringify({
          model: "/models/reviewer",
          context: ["/candidate/prompt.md"],
          tools: [],
        }, null, 2) + "\n",
      },
    ]);
    await connector.commitCandidate(candidate.id, { message: "add candidate review prompt" });
    await connector.runCheck(candidate.id, {
      command: process.execPath,
      args: ["-e", "const fs=require('node:fs'); JSON.parse(fs.readFileSync('agent.json')); if (!fs.readFileSync('prompt.md','utf8').includes('candidate prompt')) process.exit(2)"],
      label: "candidate prompt and AgentSpec",
    });

    let candidateObservation;
    const candidateInvocation = await connector.runCandidate(candidate.id, {
      input: "candidate review",
      invoke: async ({ worktree, revision }) => {
        const app = await candidateApp(worktree, "candidate");
        try {
          const workflow = await app.environment.prepareWorkflow({
            agent: "/candidate/agent.json",
            input: "candidate review",
          });
          const result = await app.graph.run({ id: "candidate-review", root: workflow });
          const root = result.root;
          const observed = await app.observer.snapshot(root.id);
          const watched = (await app.observer.watch(root.id).next()).value;
          const graph = await app.graph.inspect("candidate-review");
          candidateObservation = {
            revision,
            prompt: await app.environment.observe.read("/candidate/prompt.md"),
            agent: JSON.parse(await app.environment.observe.read("/candidate/agent.json")),
            graph: { status: graph.status, nodeStatus: graph.nodes[0].status },
            run: { status: observed.status, eventKinds: watched.events.map((event) => event.kind) },
          };
          return { status: result.status, graph: candidateObservation.graph, run: candidateObservation.run };
        } finally {
          await app.close();
        }
      },
    });

    assert.equal(candidateInvocation.result.status, "completed");
    assert.equal(candidateObservation.prompt, "Review the candidate prompt.\n");
    assert.equal(candidateObservation.agent.model, "/models/reviewer");
    assert.deepEqual(candidateObservation.agent.context, ["/candidate/prompt.md"]);
    assert.deepEqual(candidateObservation.graph, { status: "completed", nodeStatus: "completed" });
    assert.deepEqual(candidateObservation.run, { status: "completed", eventKinds: ["started", "completed"] });
    assert.equal((await connector.readCandidate(candidate.id)).status, "validated");

    const activation = await connector.activate(candidate.id, { activatedBy: "candidate-review" });
    assert.equal(activation.active.candidateId, candidate.id);
    assert.equal((await connector.activeRevision()).candidateId, candidate.id);

    const future = await connector.runFuture({
      id: "activated-review",
      input: "future review",
      invoke: async ({ worktree, revision, candidateId }) => {
        assert.equal(worktree, candidate.worktree);
        assert.equal(candidateId, candidate.id);
        const app = await candidateApp(worktree, "future");
        try {
          const workflow = await app.environment.prepareWorkflow({
            agent: "/candidate/agent.json",
            input: "future review",
          });
          const result = await app.graph.run({ id: "future-review", root: workflow });
          const watched = (await app.observer.watch(result.root.id).next()).value;
          return {
            status: result.status,
            revision,
            prompt: await app.environment.observe.read("/candidate/prompt.md"),
            events: watched.events.map((event) => event.kind),
          };
        } finally {
          await app.close();
        }
      },
    });

    assert.equal(future.result.status, "completed");
    assert.equal(future.result.prompt, "Review the candidate prompt.\n");
    assert.deepEqual(future.result.events, ["started", "completed"]);
    assert.equal((await connector.readCandidate(candidate.id)).status, "activated");
  } finally {
    await cleanup(fixtureValue);
  }
});

async function candidateApp(worktree, label) {
  const storage = new Vfs();
  await storage.mount("mem", "/");
  await storage.mount("hostfs", "/candidate", { source: worktree, mode: "ro" });
  await storage.mkdirp("/models");
  await storage.write("/models/reviewer.json", JSON.stringify({ provider: "fixture", model: "reviewer" }), { create: true });

  const store = createRunStore(storage, { root: "/runs" });
  const model = {
    path: "/models/reviewer",
    async request(request, { resources }) {
      const configuration = await resources.read("/models/reviewer.json");
      return {
        content: [{ type: "text", text: `${label}:${configuration}:${request.messages[0].content}` }],
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
  const graph = createWorkflowGraph({ storage, store, root: "/workflows" });
  const observer = createRunObserver(environment.observe, { root: "/runs", interval: 1 });
  return {
    environment,
    graph,
    observer,
    async close() {
      await storage.umount("/candidate");
    },
  };
}
