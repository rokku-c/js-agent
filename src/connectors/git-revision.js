// Git-backed revision connector for self-modifying runtimes.
//
// Git is used as the revision store, while the connector journal is the observable lifecycle:
// candidate -> edited -> committed -> validated -> activated. Candidate and future request
// callbacks receive a captured worktree/revision, so activation cannot retarget an in-flight
// request.
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, readFile, rename, writeFile, realpath, rm, lstat } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep as pathSeparator } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const MAX_OUTPUT = 64 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const LOCK_WAIT_MS = 5_000;

function error(message, code = "EINVAL", details = {}) {
  const e = new Error(message);
  e.code = code;
  Object.assign(e, details);
  return e;
}

function hash(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function textBytes(value) {
  return new TextEncoder().encode(String(value)).byteLength;
}

function trimOutput(value) {
  const text = String(value ?? "");
  return text.length <= MAX_OUTPUT ? text : `${text.slice(0, MAX_OUTPUT)}\n…[truncated]`;
}

function gitRevision(value) {
  const revision = String(value ?? "");
  return revision.startsWith("git:") ? revision.slice(4) : revision;
}

function revision(value) {
  const commit = gitRevision(value);
  if (!/^[0-9a-f]{40,64}$/.test(commit)) throw error(`invalid Git revision: ${value}`, "EINVAL");
  return commit;
}

function revisionName(value) {
  const revision = String(value ?? "");
  return revision.startsWith("git:") ? revision : `git:${revision}`;
}

function validateId(value, label = "id") {
  if (typeof value !== "string" || !ID.test(value)) {
    throw error(`${label} must match ${ID}`, "EINVAL");
  }
  return value;
}

function validateRelativePath(value) {
  if (typeof value !== "string" || value.length === 0 || isAbsolute(value)) {
    throw error("edit path must be a non-empty relative path", "EINVAL");
  }
  const normalized = value.replaceAll("\\", "/");
  const parts = normalized.split("/");
  if (parts.some((part) => part === "" || part === "." || part === ".." || part.toLowerCase() === ".git")) {
    throw error(`edit path escapes candidate worktree: ${value}`, "EINVAL");
  }
  return normalized;
}

function jsonClone(value, label = "value") {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("value is not JSON-serializable");
    return JSON.parse(encoded);
  } catch (cause) {
    throw error(`cannot record ${label}: ${cause.message}`, "EINVAL");
  }
}

async function writeJsonAtomic(path, value) {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temp, path);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function isSymlink(path) {
  try { return (await lstat(path)).isSymbolicLink(); } catch (cause) {
    if (cause.code === "ENOENT") return false;
    throw cause;
  }
}

function isInside(root, target) {
  const child = relative(root, target);
  return child === "" || (child !== ".." && !child.startsWith(`..${pathSeparator}`) && !isAbsolute(child));
}

async function assertNoSymlinkPath(root, target) {
  const parts = relative(root, target).split(pathSeparator).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    if (await isSymlink(current)) throw error(`edit path contains a symlink: ${part}`, "ELOOP");
  }
}

/**
 * Create a Git-backed self-modification connector.
 *
 * Host filesystem and Git access intentionally stop at this connector boundary; core code
 * receives only the lifecycle API and immutable provenance records.
 *
 * The callback passed to runCandidate/runFuture is the trusted integration point to the
 * runtime's one-request primitive (usually invokeOnce). It is deliberately supplied the
 * candidate/future worktree and revision rather than letting the callback rediscover them.
 */
export async function createGitRevisionConnector({ repository = process.cwd(), stateDir } = {}) {
  if (typeof repository !== "string" || !isAbsolute(repository)) {
    throw error("repository must be an absolute path", "EINVAL");
  }
  const repo = await realpath(resolve(repository));
  const top = await realpath((await git(["rev-parse", "--show-toplevel"], repo)).trim());
  if (top !== repo) throw error("repository must be the Git worktree root", "EINVAL");

  const root = resolve(stateDir ?? join(dirname(repo), `.js-agent-self-${repo.split(/[/\\]/).pop()}`));
  const rootRelative = relative(repo, root);
  if (root === repo || (rootRelative !== "" && !rootRelative.startsWith(`..${pathSeparator}`))) {
    throw error("stateDir must be outside the repository", "EINVAL");
  }
  const existingRoot = await realpath(root).catch((cause) => {
    if (cause.code !== "ENOENT") throw cause;
    return null;
  });
  if (existingRoot && isInside(repo, existingRoot)) {
    throw error("stateDir must resolve outside the repository", "EINVAL");
  }
  const candidatesDir = join(root, "candidates");
  const worktreesDir = join(root, "worktrees");
  const checksDir = join(root, "checks");
  const invocationsDir = join(root, "invocations");
  const requestsDir = join(root, "requests");
  const activationsDir = join(root, "activations");
  await Promise.all([candidatesDir, worktreesDir, checksDir, invocationsDir, requestsDir, activationsDir]
    .map((directory) => mkdir(directory, { recursive: true })));

  const activePath = join(root, "active.json");
  const activationLock = join(root, ".activation.lock");
  let activationTail = Promise.resolve();

  async function readActive() {
    try {
      const pointer = await readJson(activePath);
      if (!pointer || typeof pointer !== "object") throw error("active pointer is invalid", "EIO");
      const commit = gitRevision(pointer.revision);
      revision(commit);
      if (pointer.revision !== revisionName(commit) || typeof pointer.worktree !== "string") {
        throw error("active pointer is inconsistent", "EIO");
      }
      if (pointer.candidateId !== undefined && pointer.candidateId !== null) {
        validateId(pointer.candidateId, "active candidate id");
        if (!isInside(worktreesDir, resolve(pointer.worktree))) throw error("active worktree is outside connector state", "EACCES");
      } else if (resolve(pointer.worktree) !== repo) {
        throw error("repository active worktree is invalid", "EIO");
      }
      return { ...pointer };
    } catch (cause) {
      if (cause.code !== "ENOENT") throw cause;
      const current = revision((await git(["rev-parse", "HEAD"], repo)).trim());
      const initial = {
        revision: revisionName(current),
        worktree: repo,
        source: "repository",
        activatedAt: new Date().toISOString(),
      };
      await writeJsonAtomic(activePath, initial);
      return initial;
    }
  }

  async function withActivationLock(operation) {
    const started = Date.now();
    while (true) {
      try {
        await mkdir(activationLock);
        break;
      } catch (cause) {
        if (cause.code !== "EEXIST") throw cause;
        if (Date.now() - started >= LOCK_WAIT_MS) throw error("activation lock is busy", "EBUSY");
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      }
    }
    try {
      return await operation();
    } finally {
      await rm(activationLock, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async function command(args, cwd = repo, options = {}) {
    try {
      return await execFile("git", args, {
        cwd,
        encoding: "utf8",
        timeout: options.timeoutMs,
        maxBuffer: options.maxBuffer ?? 1024 * 1024,
        env: { ...process.env, ...(options.env ?? {}) },
      });
    } catch (cause) {
      const stderr = trimOutput(cause.stderr);
      throw error(`git ${args.join(" ")} failed${stderr ? `: ${stderr}` : ""}`, "EGIT", {
        cause,
        stdout: trimOutput(cause.stdout),
        stderr,
      });
    }
  }

  async function git(args, cwd = repo, options = {}) {
    return (await command(args, cwd, options)).stdout;
  }

  async function loadCandidate(id) {
    const candidateId = validateId(id, "candidate id");
    const candidate = await readJson(join(candidatesDir, `${candidateId}.json`));
    if (!candidate) throw error(`unknown candidate: ${candidateId}`, "ENOENT");
    if (candidate.id !== candidateId || candidate.worktree !== join(worktreesDir, candidateId)) {
      throw error("candidate metadata points outside its worktree", "EACCES");
    }
    if (!isInside(worktreesDir, resolve(candidate.worktree)) || await isSymlink(candidate.worktree)) {
      throw error("candidate worktree is outside connector state", "EACCES");
    }
    return candidate;
  }

  async function saveCandidate(candidate) {
    await writeJsonAtomic(join(candidatesDir, `${validateId(candidate.id)}.json`), candidate);
    return jsonClone(candidate);
  }

  async function candidateIsClean(candidate) {
    const head = revision((await git(["rev-parse", "HEAD"], candidate.worktree)).trim());
    const dirty = await git(["status", "--porcelain", "--untracked-files=all"], candidate.worktree);
    return { head, dirty };
  }

  function invocationSucceeded(result) {
    return result?.ok === true || result?.status === "passed" ||
      result?.status === "completed" || result?.status === "completed_with_tool_calls";
  }

  const controller = {
    repository: repo,
    stateDir: root,

    async activeRevision() {
      return readActive();
    },

    async createCandidate({ id = `candidate-${randomUUID()}`, baseRevision } = {}) {
      validateId(id, "candidate id");
      const current = await readActive();
      const base = revisionName(baseRevision ?? current.revision);
      const worktree = join(worktreesDir, id);
      if (await isSymlink(worktree) || await isSymlink(join(candidatesDir, `${id}.json`))) {
        throw error(`candidate path is a symlink: ${id}`, "ELOOP");
      }
      try { await readFile(join(candidatesDir, `${id}.json`), "utf8"); throw error(`candidate already exists: ${id}`, "EEXIST"); } catch (cause) {
        if (cause.code !== "ENOENT") throw cause;
      }
      const candidate = {
        id,
        status: "creating",
        baseRevision: base,
        worktree,
        createdAt: new Date().toISOString(),
        edits: [],
        checks: [],
        invocations: [],
      };
      await writeJsonAtomic(join(candidatesDir, `${id}.json`), candidate);
      try {
        await command(["worktree", "add", "--detach", worktree, gitRevision(base)], repo);
        candidate.status = "created";
        return await saveCandidate(candidate);
      } catch (cause) {
        candidate.status = "failed";
        candidate.error = { message: cause.message, code: cause.code };
        await saveCandidate(candidate).catch(() => undefined);
        throw cause;
      }
    },

    async editCandidate(id, edits) {
      const candidate = await loadCandidate(id);
      if (!["created", "edited"].includes(candidate.status)) {
        throw error(`candidate ${id} cannot be edited from ${candidate.status}`, "EALREADY");
      }
      if (!Array.isArray(edits) || edits.length === 0) throw error("edits must be a non-empty array", "EINVAL");
      for (const edit of edits) {
        if (!edit || typeof edit !== "object") throw error("each edit must be an object", "EINVAL");
        const path = validateRelativePath(edit.path);
        if (typeof edit.content !== "string") throw error(`edit ${path} content must be a string`, "EINVAL");
        const fullPath = resolve(candidate.worktree, path);
        if (!isInside(candidate.worktree, fullPath)) {
          throw error(`edit path escapes candidate worktree: ${path}`, "EINVAL");
        }
        await assertNoSymlinkPath(candidate.worktree, fullPath);
        await mkdir(dirname(fullPath), { recursive: true });
        await assertNoSymlinkPath(candidate.worktree, fullPath);
        await writeFile(fullPath, edit.content, { encoding: "utf8", flag: "w" });
        candidate.edits.push({
          path,
          operation: "write",
          contentHash: hash(edit.content),
          bytes: textBytes(edit.content),
          at: new Date().toISOString(),
        });
      }
      candidate.status = "edited";
      return saveCandidate(candidate);
    },

    async commitCandidate(id, { message = `self-modification candidate ${id}` } = {}) {
      const candidate = await loadCandidate(id);
      if (!candidate.edits.length) throw error(`candidate ${id} has no edits`, "EINVAL");
      if (!["created", "edited"].includes(candidate.status)) {
        throw error(`candidate ${id} cannot be committed from ${candidate.status}`, "EALREADY");
      }
      await command(["add", "--", ...candidate.edits.map((edit) => edit.path)], candidate.worktree);
      await command([
        "-c", "user.name=js-agent self-modifier",
        "-c", "user.email=self-modifier@invalid",
        "commit", "--no-verify", "-m", message,
      ], candidate.worktree);
      candidate.candidateRevision = revisionName((await git(["rev-parse", "HEAD"], candidate.worktree)).trim());
      candidate.status = "committed";
      candidate.committedAt = new Date().toISOString();
      return saveCandidate(candidate);
    },

    async runCheck(id, { command: executable, args = [], label = executable, timeoutMs = 120_000 } = {}) {
      const candidate = await loadCandidate(id);
      if (candidate.status !== "committed") throw error(`candidate ${id} must be committed before checks`, "EINVAL");
      if (typeof executable !== "string" || executable.length === 0 || !Array.isArray(args)) {
        throw error("check requires command and an args array", "EINVAL");
      }
      const checkId = `${id}-${candidate.checks.length}`;
      const startedAt = new Date().toISOString();
      let record;
      try {
        const result = await execFile(executable, args, {
          cwd: candidate.worktree,
          encoding: "utf8",
          timeout: timeoutMs,
          maxBuffer: 1024 * 1024,
          env: process.env,
        });
        record = {
          id: checkId, label, command: [executable, ...args], status: "passed",
          stdout: trimOutput(result.stdout), stderr: trimOutput(result.stderr), startedAt,
          finishedAt: new Date().toISOString(),
        };
      } catch (cause) {
        record = {
          id: checkId, label, command: [executable, ...args], status: "failed",
          exitCode: cause.code === "ETIMEDOUT" ? null : cause.status ?? null,
          stdout: trimOutput(cause.stdout), stderr: trimOutput(cause.stderr),
          error: cause.code ?? "COMMAND_FAILED", startedAt, finishedAt: new Date().toISOString(),
        };
      }
      if (record.status === "passed") {
        const state = await candidateIsClean(candidate);
        if (state.dirty) {
          record.status = "failed";
          record.error = "CANDIDATE_DIRTY";
          record.stderr = `${record.stderr ? `${record.stderr}\n` : ""}check changed the candidate worktree`;
        }
      }
      candidate.checks.push(record);
      candidate.checksPassed = candidate.checks.every((check) => check.status === "passed");
      await writeJsonAtomic(join(checksDir, `${checkId}.json`), record);
      await saveCandidate(candidate);
      if (record.status !== "passed") throw error(`candidate check failed: ${label}`, "ECHECK", { check: record });
      return jsonClone(record);
    },

    async runCandidate(id, { input, invoke } = {}) {
      const candidate = await loadCandidate(id);
      if (candidate.status !== "committed") throw error(`candidate ${id} must be committed before invocation`, "EINVAL");
      if (typeof input !== "string") throw error("candidate input must be a string", "EINVAL");
      if (typeof invoke !== "function") throw error("runCandidate requires an invoke callback", "EINVAL");
      const invocationId = `${id}-${candidate.invocations.length}`;
      const provenance = Object.freeze({
        phase: "candidate",
        candidateId: id,
        revision: candidate.candidateRevision,
        worktree: candidate.worktree,
        input,
        invocationId,
      });
      let result;
      try {
        result = await invoke(provenance);
        if (!invocationSucceeded(result)) {
          throw error(`candidate invocation did not pass: ${result?.status ?? "unknown status"}`, "EINVOCATION");
        }
        const state = await candidateIsClean(candidate);
        if (state.dirty || state.head !== gitRevision(candidate.candidateRevision)) {
          throw error("candidate changed during invocation", "ESTALE");
        }
        candidate.invocations.push({
          id: invocationId, status: "completed", revision: candidate.candidateRevision,
          inputHash: hash(input), result: jsonClone(result, "candidate invocation result"),
          at: new Date().toISOString(),
        });
        candidate.status = "validated";
        candidate.invocationPassed = true;
      } catch (cause) {
        candidate.invocations.push({
          id: invocationId, status: "failed", revision: candidate.candidateRevision,
          inputHash: hash(input), error: { message: cause.message, code: cause.code ?? "ERR" },
          at: new Date().toISOString(),
        });
        candidate.status = "rejected";
        candidate.invocationPassed = false;
        await writeJsonAtomic(join(invocationsDir, `${invocationId}.json`), candidate.invocations.at(-1));
        await saveCandidate(candidate);
        throw cause;
      }
      await writeJsonAtomic(join(invocationsDir, `${invocationId}.json`), candidate.invocations.at(-1));
      await saveCandidate(candidate);
      return { provenance: jsonClone(provenance), result: jsonClone(result) };
    },

    async activate(id, { expectedRevision, activatedBy = id } = {}) {
      const run = activationTail.then(() => withActivationLock(async () => {
        const candidate = await loadCandidate(id);
        if (candidate.status !== "validated" || !candidate.candidateRevision || !candidate.invocationPassed || candidate.checksPassed !== true) {
          throw error(`candidate ${id} must pass checks and one candidate invocation before activation`, "EPERM");
        }
        const before = await readActive();
        const expected = revisionName(expectedRevision ?? candidate.baseRevision);
        if (before.revision !== expected || candidate.baseRevision !== before.revision) {
          throw error(`activation conflict: candidate base ${candidate.baseRevision}, active is ${before.revision}`, "EAGAIN", {
            expectedRevision: expected, activeRevision: before.revision,
          });
        }
        const state = await candidateIsClean(candidate);
        if (state.dirty || state.head !== gitRevision(candidate.candidateRevision)) {
          throw error("candidate changed after validation; evaluate it again", "ESTALE");
        }
        const after = {
          revision: candidate.candidateRevision,
          worktree: candidate.worktree,
          source: "candidate",
          candidateId: id,
          activatedBy,
          activatedAt: new Date().toISOString(),
        };
        await writeJsonAtomic(activePath, after);
        const activation = {
          from: before.revision,
          to: after.revision,
          candidateId: id,
          activatedBy,
          when: after.activatedAt,
          checks: candidate.checks.map((check) => `${check.label}:${check.status}`),
          invocation: candidate.invocations.at(-1)?.id ?? null,
        };
        await writeJsonAtomic(join(activationsDir, `${id}-${Date.now()}.json`), activation);
        candidate.status = "activated";
        candidate.activation = activation;
        await saveCandidate(candidate);
        return { active: after, activation };
      }));
      activationTail = run.catch(() => undefined);
      return run;
    },

    async runFuture({ input, invoke, id = `request-${randomUUID()}` } = {}) {
      validateId(id, "request id");
      if (typeof input !== "string") throw error("future input must be a string", "EINVAL");
      if (typeof invoke !== "function") throw error("runFuture requires an invoke callback", "EINVAL");
      const target = await readActive();
      const provenance = Object.freeze({
        phase: "future",
        requestId: id,
        revision: target.revision,
        worktree: target.worktree,
        candidateId: target.candidateId ?? null,
        input,
      });
      let result;
      try {
        result = await invoke(provenance);
        await writeJsonAtomic(join(requestsDir, `${id}.json`), {
          ...provenance, status: "completed", inputHash: hash(input),
          result: jsonClone(result, "future invocation result"), at: new Date().toISOString(),
        });
      } catch (cause) {
        await writeJsonAtomic(join(requestsDir, `${id}.json`), {
          ...provenance, status: "failed", inputHash: hash(input),
          error: { message: cause.message, code: cause.code ?? "ERR" }, at: new Date().toISOString(),
        });
        throw cause;
      }
      return { provenance: jsonClone(provenance), result: jsonClone(result) };
    },

    async removeCandidate(id) {
      const candidate = await loadCandidate(id);
      if (candidate.status === "removed") return jsonClone(candidate);
      const pointer = await readActive();
      if (candidate.status === "activated" || pointer.candidateId === candidate.id) {
        throw error("cannot remove the active candidate", "EBUSY");
      }
      await command(["worktree", "remove", "--force", candidate.worktree], repo);
      candidate.status = "removed";
      candidate.removedAt = new Date().toISOString();
      return saveCandidate(candidate);
    },

    async readCandidate(id) {
      return loadCandidate(id);
    },
  };
  return Object.freeze(controller);
}

async function git(args, cwd) {
  try {
    const result = await execFile("git", args, { cwd, encoding: "utf8", maxBuffer: 1024 * 1024 });
    return result.stdout;
  } catch (cause) {
    throw error(`git ${args.join(" ")} failed`, "EGIT", { cause });
  }
}
