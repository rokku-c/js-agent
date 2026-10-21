// Run with: node examples/real-use-callable.js
// An offline HTTP/job-shaped callable resource used through the generic resource protocol.
import { Vfs } from "js-agent/kernel";
import { createEnvironment, createView } from "js-agent/runtime";

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    signal?.removeEventListener("abort", abort);
    resolve();
  }, ms);
  const abort = () => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    const error = signal.reason instanceof Error ? signal.reason : new Error("job invocation cancelled");
    error.code ??= "ABORT_ERR";
    reject(error);
  };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
});

function abortError(message, effect) {
  const error = new Error(message);
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  error.outcome = "unknown";
  error.effect = { ...effect };
  return error;
}

function fileStat(size = null) {
  return { type: "file", size, device: false, callable: false, appendable: false, mtime: 0, mode: 0o444 };
}

/**
 * A deterministic external job service. The endpoint looks like an HTTP POST or database
 * procedure, but its only transport is an in-process timer. The effect journal is exposed as
 * resources so an observer can inspect an interrupted dispatch without a provider special case.
 */
export class OfflineJobResource {
  #effects = new Map();
  #jobs = new Map();
  #nextEffect = 0;

  async stat(path) {
    if (path === "/" || path === "/jobs" || path === "/effects") return { type: "dir", size: null, device: false, callable: false, mtime: 0, mode: 0o755 };
    if (path === "/jobs/submit") {
      return {
        type: "device", size: null, device: true, callable: true, appendable: false, mtime: 0, mode: 0o555,
        resource: { provider: "offline-http", kind: "job-submit", method: "POST", idempotent: false },
      };
    }
    if (/^\/effects\/effect-[0-9]+\.json$/u.test(path)) {
      if (!this.#effects.has(path)) throw Object.assign(new Error("effect not found"), { code: "ENOENT" });
      return fileStat();
    }
    if (/^\/jobs\/[^/]+\/status\.json$/u.test(path)) {
      if (!this.#jobs.has(path)) throw Object.assign(new Error("job not found"), { code: "ENOENT" });
      return fileStat();
    }
    throw Object.assign(new Error("no such external resource"), { code: "ENOENT" });
  }

  async list(path) {
    if (path === "/") return [
      { name: "effects", ...(await this.stat("/effects")) },
      { name: "jobs", ...(await this.stat("/jobs")) },
    ];
    if (path === "/effects") return [...this.#effects.keys()].map((effectPath) => ({
      name: effectPath.slice("/effects/".length),
      ...fileStat(),
    }));
    if (path === "/jobs") return [{ name: "submit", ...(await this.stat("/jobs/submit")) }];
    throw Object.assign(new Error("not a directory"), { code: "ENOTDIR" });
  }

  async read(path) {
    if (path === "/jobs/submit") {
      return JSON.stringify({
        kind: "job-submit",
        method: "POST",
        input: { jobId: "string", payload: "object" },
        output: { effectId: "string", jobId: "string", status: "completed" },
        cancellation: "an abort after dispatch is outcome=unknown",
      });
    }
    if (this.#effects.has(path)) return JSON.stringify(this.#effects.get(path));
    if (this.#jobs.has(path)) return JSON.stringify(this.#jobs.get(path));
    throw Object.assign(new Error("no such external resource"), { code: "ENOENT" });
  }

  async write() {
    throw Object.assign(new Error("offline job resource is read-only; use invoke"), { code: "EACCES" });
  }

  async invoke(path, input, { signal } = {}) {
    if (path !== "/jobs/submit") throw Object.assign(new Error("resource is not callable"), { code: "ENOTSUP" });
    if (!input || typeof input !== "object" || typeof input.jobId !== "string") {
      throw Object.assign(new Error("job submission requires a jobId"), { code: "EINVAL" });
    }
    if (signal?.aborted) {
      const error = signal.reason instanceof Error ? signal.reason : new Error("job invocation cancelled");
      error.code ??= "ABORT_ERR";
      throw error;
    }

    const id = `effect-${++this.#nextEffect}`;
    const effectPath = `/effects/${id}.json`;
    const effect = { id, state: "started", resource: "/external/jobs/submit", jobId: input.jobId };
    this.#effects.set(effectPath, { ...effect });
    try {
      // This is the dispatch boundary. Cancellation before here is cancelled; cancellation
      // after here cannot prove whether the provider accepted the job, so it is unknown.
      await sleep(15, signal);
      const jobPath = `/jobs/${input.jobId}/status.json`;
      const job = { jobId: input.jobId, status: "completed", payload: input.payload ?? null };
      this.#jobs.set(jobPath, job);
      const completed = { ...effect, state: "completed", result: job };
      this.#effects.set(effectPath, completed);
      return { status: "completed", value: { effectId: id, ...job }, effect: { id, state: "completed" } };
    } catch (cause) {
      const unknown = { ...effect, state: "unknown", reason: cause.message };
      this.#effects.set(effectPath, unknown);
      throw abortError("job dispatch outcome is unknown", unknown);
    }
  }

  async exists(path) {
    try { await this.stat(path); return true; } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  }

  effects() {
    return [...this.#effects.values()].map((effect) => ({ ...effect }));
  }
}

function composeResources(storage, external) {
  const externalPath = (path) => path === "/external" || path.startsWith("/external/");
  const localPath = (path) => path === "/external" ? "/" : path.slice("/external".length) || "/";
  const dispatch = (method) => async (path, ...args) => externalPath(path)
    ? external[method](localPath(path), ...args)
    : storage[method](path, ...args);
  return {
    stat: dispatch("stat"), list: dispatch("list"), read: dispatch("read"), write: dispatch("write"),
    exists: dispatch("exists"), invoke: dispatch("invoke"),
  };
}

export async function createCallableDemo() {
  const storage = new Vfs();
  await storage.mount("mem", "/");
  await storage.mkdirp("/models/offline");
  await storage.mkdirp("/tools/submit");
  await storage.write("/tools/submit/definition.json", JSON.stringify({
    name: "submit_job",
    description: "Submit one job to the external job resource.",
    input_schema: { type: "object", properties: { jobId: { type: "string" }, payload: { type: "object" } }, required: ["jobId"] },
  }), { create: true });

  const external = new OfflineJobResource();
  const resources = composeResources(storage, external);
  const callableView = createView(resources, { grants: [
    { path: "/external/jobs/submit", operations: ["stat", "read", "invoke"] },
    { path: "/external/effects/**", operations: ["stat", "read"] },
    { path: "/external/jobs/**", operations: ["stat", "read"] },
  ] });

  const controller = new AbortController();
  const uncertain = callableView.invoke("/external/jobs/submit", { jobId: "aborted-job" }, { signal: controller.signal });
  setTimeout(() => controller.abort(), 2);
  let uncertainty;
  try { await uncertain; } catch (error) {
    uncertainty = { code: error.code, outcome: error.outcome, effect: error.effect };
  }
  const uncertainEffect = external.effects().find(({ jobId }) => jobId === "aborted-job");

  const environment = createEnvironment({
    resources,
    storage,
    model: {
      path: "/models/offline",
      adapter: {
        async request(request) {
          if (request.messages.length === 1) return {
            content: [{ type: "tool_use", id: "submit-1", name: "submit_job", input: { jobId: "demo-job", payload: { source: "workflow" } } }],
            stop_reason: "tool_use",
          };
          return { content: [{ type: "text", text: "job submitted" }], stop_reason: "end_turn" };
        },
      },
    },
    tools: {
      paths: ["/tools/submit"],
      adapters: [{
        path: "/tools/submit",
        async invoke({ input, signal, resources: toolResources }) {
          return toolResources.invoke("/external/jobs/submit", input, { signal });
        },
      }],
    },
    permissions: {
      agent: [{ path: "/external/jobs/submit", operations: ["read"] }],
      tools: [
        { path: "/tools/**", operations: ["read"] },
        { path: "/external/jobs/submit", operations: ["stat", "invoke"] },
      ],
      observer: [{ path: "/runs/**", operations: ["stat", "list", "read"] }],
    },
  });

  const workflow = await environment.prepareWorkflow({
    agent: { model: "/models/offline", context: ["/external/jobs/submit"], tools: ["/tools/submit"] },
    input: "Submit the demo job.",
  });
  const graph = environment.createWorkflowGraph({ root: "/workflows" });
  const started = await graph.startRoot({ graphId: "callable-demo", ...workflow });
  const continuation = await graph.continueBranch({
    graphId: "callable-demo",
    branchKey: "after-submit",
    parent: started.root,
    parentResponse: started.root.response,
    toolResults: started.toolResults,
    agent: workflow.agent,
    model: workflow.model,
    tools: workflow.tools,
    input: "Continue after the job submission.",
  });
  const closed = await graph.close("callable-demo");
  const snapshot = await environment.observer.snapshot(continuation.result.id);

  return {
    uncertainty,
    uncertainEffect,
    callable: { status: (await callableView.stat("/external/jobs/submit")).callable },
    workflow: { graph: closed.status, run: snapshot.status, events: snapshot.events.map(({ kind }) => kind) },
    completedEffect: external.effects().find(({ jobId }) => jobId === "demo-job"),
  };
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  console.log(JSON.stringify(await createCallableDemo(), null, 2));
}
