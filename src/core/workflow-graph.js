import { invokeOnce } from "./invocation.js";
import { continueOnce } from "./workflow.js";
import { executeToolCalls } from "./workflow-harness.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const GRAPH_TERMINAL = new Set(["completed", "cancelled", "unknown"]);
const INVOCATION_TERMINAL = new Set(["completed", "completed_with_tool_calls", "failed", "unknown", "cancelled"]);
const graphLocks = new WeakMap();

function fail(message, code = "EINVAL") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw fail(`${label} must be an object`);
  return value;
}

function id(value, label) {
  if (typeof value !== "string" || !ID.test(value)) throw fail(`${label} must be a nonempty run id`);
  return value;
}

function key(value, label = "branchKey") {
  if (typeof value !== "string" || value.trim() === "") throw fail(`${label} must be a nonempty string`);
  if (value.length > 128) throw fail(`${label} exceeds 128 characters`);
  return value;
}

function isAbort(error) {
  return error?.code === "ABORT_ERR" || error?.name === "AbortError";
}

function abortError(signal) {
  if (!signal?.aborted) return null;
  const error = signal.reason instanceof Error ? signal.reason : fail("workflow cancelled", "ABORT_ERR");
  if (!error.code) error.code = "ABORT_ERR";
  return error;
}

function failure(error) {
  return { name: error?.name ?? "Error", message: error?.message ?? String(error), code: error?.code ?? null };
}

function pathJoin(root, graphId, file = "") {
  const base = root === "/" ? "" : root;
  return `${base}/${graphId}${file ? `/${file}` : ""}`;
}

function graphLock(storage, graphPath, operation) {
  let locks = graphLocks.get(storage);
  if (!locks) {
    locks = new Map();
    graphLocks.set(storage, locks);
  }
  const previous = locks.get(graphPath) ?? Promise.resolve();
  const current = previous.then(operation, operation);
  const tracked = current.then(() => undefined, () => undefined).finally(() => {
    if (locks.get(graphPath) === tracked) locks.delete(graphPath);
  });
  locks.set(graphPath, tracked);
  return current;
}

async function writeSnapshot(storage, path, value) {
  const text = JSON.stringify(value, null, 2);
  const temporary = `${path}.tmp-${Math.random().toString(36).slice(2, 12)}`;
  await storage.write(temporary, text, { create: true });
  if (typeof storage.rename !== "function") {
    await storage.write(path, text, { create: true });
    try { await storage.remove?.(temporary); } catch { /* best effort */ }
    return;
  }
  try {
    await storage.rename(temporary, path);
  } catch (error) {
    if (error?.code !== "ENOTSUP") throw error;
    await storage.write(path, text, { create: true });
    try { await storage.remove?.(temporary); } catch { /* best effort */ }
  }
}

async function readJson(storage, path) {
  return JSON.parse(await storage.read(path));
}

function now() {
  return new Date().toISOString();
}

function cloneNode(node) {
  return JSON.parse(JSON.stringify(node));
}

function graphStatus(state) {
  if (state.cancelRequested) return "cancelled";
  const nodes = state.nodes ?? [];
  if (nodes.some((node) => node.status === "unknown" || node.invocationStatus === "unknown")) return "unknown";
  if (nodes.some((node) => node.status === "cancelled" || node.invocationStatus === "cancelled")) return "cancelled";
  if (nodes.some((node) => !INVOCATION_TERMINAL.has(node.invocationStatus ?? node.status))) return "running";
  return "completed";
}

function linkedSignal(primary, secondary) {
  if (!primary) return secondary;
  if (!secondary) return primary;
  if (primary === secondary) return primary;
  const controller = new AbortController();
  const abort = (signal) => {
    if (!controller.signal.aborted) controller.abort(signal.reason);
  };
  if (primary.aborted) abort(primary);
  if (secondary.aborted) abort(secondary);
  primary.addEventListener("abort", () => abort(primary), { once: true });
  secondary.addEventListener("abort", () => abort(secondary), { once: true });
  return controller.signal;
}

function defaultInvocationId(graphId, branchKey) {
  const clean = branchKey.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "branch";
  const suffix = `${graphId}-${clean}`.slice(0, 128);
  return suffix;
}

function emptyGraph(id, root) {
  const timestamp = now();
  return {
    version: 1,
    id,
    path: pathJoin(root, id),
    status: "running",
    cancelRequested: false,
    created: timestamp,
    updated: timestamp,
    root: null,
    nodes: [],
    edges: [],
  };
}

async function inspectRaw(storage, graphId, { root = "/workflows" } = {}) {
  id(graphId, "graph id");
  const path = pathJoin(root, graphId);
  const graph = await readJson(storage, `${path}/graph.json`);
  const reconciliation = await Promise.all((graph.nodes ?? []).map(async (node) => {
    let persistedStatus = null;
    try {
      persistedStatus = (await readJson(storage, `${node.invocationPath}/status.json`)).status;
    } catch (error) {
      persistedStatus = error?.code === "ENOENT" ? "missing" : "unreadable";
    }
    const declaredStatus = node.invocationStatus ?? node.status;
    return {
      key: node.key,
      invocationId: node.invocationId,
      declaredStatus,
      persistedStatus,
      stale: declaredStatus !== persistedStatus,
      uncertain: node.status === "running" && !INVOCATION_TERMINAL.has(persistedStatus),
    };
  }));
  return {
    ...graph,
    reconciliation,
    staleNodes: reconciliation.filter((item) => item.stale),
    uncertainNodes: reconciliation.filter((item) => item.uncertain),
  };
}

/**
 * Read a persisted workflow graph and compare its node claims with invocation snapshots.
 * This is deliberately a graph-specific recovery view; it is not a generic RunState observer.
 */
export async function inspectWorkflowGraph(storage, graphId, options = {}) {
  if (!storage || typeof storage.read !== "function") throw fail("workflow graph requires storage.read", "EINVAL");
  return inspectRaw(storage, graphId, options);
}

/**
 * Coordinate one root Invocation and explicitly keyed continuation edges. The graph record is
 * a small persisted index over the existing RunStore invocation records. It supplies the
 * missing ownership/idempotency boundary without changing the one-request primitives.
 */
export function createWorkflowGraph({ storage, store, root = "/workflows" } = {}) {
  if (!storage || typeof storage.read !== "function" || typeof storage.write !== "function") {
    throw fail("workflow graph requires storage read/write", "EINVAL");
  }
  if (!store || typeof store.reserve !== "function") throw fail("workflow graph requires a RunStore", "EINVAL");
  if (typeof root !== "string" || !root.startsWith("/") || root.includes("//") || root.split("/").includes("..")) {
    throw fail("workflow graph root must be an absolute path", "EINVAL");
  }

  const controllers = new Map();
  const inFlight = new Map();

  async function load(graphId) {
    return readJson(storage, `${pathJoin(root, id(graphId, "graph id"))}/graph.json`);
  }

  async function save(state) {
    state.updated = now();
    await writeSnapshot(storage, `${state.path}/graph.json`, state);
    return state;
  }

  async function create(graphId) {
    graphId = id(graphId, "graph id");
    const path = pathJoin(root, graphId);
    return graphLock(storage, path, async () => {
      if (typeof storage.exists === "function" && await storage.exists(path)) {
        throw fail(`workflow graph already exists: ${graphId}`, "EEXIST");
      }
      await storage.mkdirp(root);
      await storage.mkdir(path);
      const state = emptyGraph(graphId, root);
      await save(state);
      controllers.set(graphId, new AbortController());
      return state;
    });
  }

  async function mutate(graphId, operation) {
    const graphPath = pathJoin(root, id(graphId, "graph id"));
    return graphLock(storage, graphPath, async () => {
      const state = await load(graphId);
      const value = await operation(state);
      await save(state);
      return value ?? state;
    });
  }

  async function markNode(graphId, nodeKey, patch) {
    return mutate(graphId, (state) => {
      const node = state.nodes.find((item) => item.key === nodeKey);
      if (!node) throw fail(`unknown graph node: ${nodeKey}`, "ENOENT");
      Object.assign(node, patch);
      return node;
    });
  }

  async function startRoot(options = {}) {
    object(options, "root options");
    const graphId = id(options.graphId ?? options.id, "graph id");
    const existing = inFlight.get(`${graphId}:root`);
    if (existing) return existing;

    const operation = (async () => {
      let state;
      try {
        state = await load(graphId);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        try {
          state = await create(graphId);
        } catch (createError) {
          if (createError?.code !== "EEXIST") throw createError;
          state = await load(graphId);
        }
      }
      if (state.root) {
        const rootNode = state.nodes.find((node) => node.key === state.root);
        let root = rootNode ? { id: rootNode.invocationId, path: rootNode.invocationPath, status: rootNode.invocationStatus } : null;
        if (root?.status === "completed_with_tool_calls") {
          try {
            const response = await readJson(storage, `${root.path}/response.json`);
            const request = await readJson(storage, `${root.path}/request.json`);
            root = {
              ...root,
              response,
              request: {
                ...request,
                messages: [...request.messages, { role: "assistant", content: response.content }],
              },
              toolCalls: response.content.filter((part) => part?.type === "tool_use"),
            };
          } catch { /* inspection still has the persisted graph claim */ }
        }
        return { graphId, deduplicated: true, root, status: state.status, graph: state };
      }
      const controller = controllers.get(graphId) ?? new AbortController();
      controllers.set(graphId, controller);
      const invocationId = options.rootId ?? `${graphId}-root`;
      const invocationPath = pathJoin(store.root ?? "/runs", invocationId);
      const claim = await mutate(graphId, (current) => {
        if (current.root) return { existing: true, state: current };
        current.root = "root";
        current.nodes.push({
          key: "root",
          kind: "root",
          invocationId,
          invocationPath,
          status: "running",
          invocationStatus: "running",
        });
        return { claimed: true, state: current };
      });
      if (claim.existing) {
        const rootNode = claim.state.nodes.find((node) => node.key === claim.state.root);
        return {
          graphId,
          deduplicated: true,
          root: rootNode ? {
            id: rootNode.invocationId,
            path: rootNode.invocationPath,
            status: rootNode.invocationStatus,
          } : null,
          status: claim.state.status,
          graph: claim.state,
        };
      }

      const invocationOptions = { ...options, id: invocationId, signal: linkedSignal(controller.signal, options.signal) };
      delete invocationOptions.graphId;
      delete invocationOptions.rootId;

      let rootResult;
      let toolResults = [];
      try {
        rootResult = await invokeOnce({ ...invocationOptions, store });
        if (rootResult.status === "completed_with_tool_calls") {
          toolResults = await executeToolCalls(rootResult.toolCalls, options.toolAdapters, {
            signal: invocationOptions.signal,
            trace: options.trace,
            runId: rootResult.id,
          });
        }
      } catch (error) {
        const cancelled = abortError(invocationOptions.signal) ?? (isAbort(error) ? error : null);
        if (!cancelled) {
          await mutate(graphId, (current) => {
            const node = current.nodes.find((item) => item.key === "root");
            if (node) Object.assign(node, {
              status: "unknown",
              invocationStatus: "unknown",
              error: failure(error),
            });
            current.status = "unknown";
            return current;
          });
          throw error;
        }
        rootResult = rootResult ?? { id: invocationId, status: "cancelled", response: null };
      }

      let parentResult = rootResult;
      if (rootResult.status === "completed_with_tool_calls") {
        const storedRequest = await readJson(storage, `${rootResult.path}/request.json`);
        parentResult = {
          ...rootResult,
          request: {
            ...storedRequest,
            messages: [
              ...storedRequest.messages,
              { role: "assistant", content: rootResult.response.content },
            ],
          },
        };
      }
      const node = {
        status: rootResult.status,
        invocationStatus: rootResult.status,
        ...(rootResult.toolCalls?.length ? { toolCallIds: rootResult.toolCalls.map((call) => call.id) } : {}),
      };
      await mutate(graphId, (current) => {
        const currentNode = current.nodes.find((item) => item.key === "root");
        // A restarted graph may have already classified this dispatch as unknown. A
        // late completion must not make that recovered claim look successful.
        if (!currentNode || currentNode.recovery === "process_restart") return current;
        Object.assign(currentNode, node);
        current.status = current.cancelRequested || rootResult.status === "cancelled"
          ? "cancelled"
          : rootResult.status === "unknown" ? "unknown"
            : rootResult.status === "completed_with_tool_calls" ? "waiting" : "completed";
        return current;
      });
      const graph = await load(graphId);
      return { graphId, root: parentResult, toolResults, status: graph.status, graph };
    })();
    inFlight.set(`${graphId}:root`, operation);
    try { return await operation; } finally { inFlight.delete(`${graphId}:root`); }
  }

  async function continueBranch(options = {}) {
    object(options, "branch options");
    const graphId = id(options.graphId, "graph id");
    const branchKey = key(options.branchKey);
    const parentKey = key(options.parentKey ?? "root", "parentKey");
    const edgeKey = `${parentKey}:${branchKey}`;
    const flightKey = `${graphId}:${edgeKey}`;
    const existingFlight = inFlight.get(flightKey);
    if (existingFlight) {
      return existingFlight.then((result) => ({ ...result, deduplicated: true }));
    }

    const claim = await mutate(graphId, (state) => {
      if (state.cancelRequested || state.status === "cancelled") return { cancelled: true, state };
      const existing = state.edges.find((edge) => edge.key === edgeKey);
      if (existing) return { existing: true, state, edge: existing };
      const parentNode = state.nodes.find((node) => node.key === parentKey);
      if (!parentNode) throw fail(`parent invocation has not completed: ${parentKey}`, "EAGAIN");
      if (parentNode.invocationStatus !== "completed_with_tool_calls") {
        throw fail(`parent cannot continue from ${parentNode.invocationStatus}`, "EALREADY");
      }
      if (!options.parent || options.parent.id !== parentNode.invocationId) {
        throw fail(`parent result does not match graph node: ${parentKey}`);
      }
      const invocationId = options.id ?? defaultInvocationId(graphId, branchKey);
      id(invocationId, "branch invocation id");
      const nodeKey = `branch:${branchKey}`;
      const node = {
        key: nodeKey,
        kind: "continuation",
        branchKey,
        invocationId,
        invocationPath: pathJoin(store.root ?? "/runs", invocationId),
        status: "running",
        invocationStatus: "running",
        parent: parentKey,
      };
      state.nodes.push(node);
      const edge = { key: edgeKey, from: parentKey, to: nodeKey, status: "running" };
      state.edges.push(edge);
      return { claimed: true, node, edge };
    });

    if (claim.cancelled) return { graphId, branchKey, status: "cancelled", deduplicated: true };
    if (claim.existing) {
      const local = inFlight.get(flightKey);
      if (local) return local.then((result) => ({ ...result, deduplicated: true }));
      return { graphId, branchKey, deduplicated: true, status: claim.edge.status, node: claim.state.nodes.find((node) => node.key === claim.edge.to) };
    }

    const operation = (async () => {
      const graphController = controllers.get(graphId);
      const signal = linkedSignal(graphController?.signal, options.signal);
      const parent = options.parent;
      let result;
      let error = null;
      try {
        result = await continueOnce({
          parent,
          parentResponse: options.parentResponse,
          toolResults: options.toolResults,
          agent: options.agent,
          model: options.model,
          tools: options.tools,
          store,
          signal,
          id: claim.node.invocationId,
          input: options.input,
        });
      } catch (caught) {
        error = caught;
      }
      const cancelled = abortError(signal) ?? (isAbort(error) ? error : null);
      const invocationStatus = result?.status ?? (cancelled ? "unknown" : "unknown");
      const status = cancelled ? "cancelled" : invocationStatus;
      if (result?.status === "completed_with_tool_calls") {
        const storedRequest = await readJson(storage, `${result.path}/request.json`);
        result = {
          ...result,
          request: {
            ...storedRequest,
            messages: [...storedRequest.messages, { role: "assistant", content: result.response.content }],
          },
        };
      }
      const finalState = await mutate(graphId, (state) => {
        const node = state.nodes.find((item) => item.key === claim.node.key);
        const edge = state.edges.find((item) => item.key === edgeKey);
        if (node.recovery !== "process_restart") {
          Object.assign(node, {
            status,
            invocationStatus,
            finishedAt: now(),
            ...(error && !cancelled ? { error: failure(error) } : {}),
          });
          edge.status = status;
          if (state.cancelRequested) state.status = "cancelled";
          else if (status === "unknown") state.status = "unknown";
        }
        return state;
      });
      if (error && !cancelled) throw error;
      const finalNode = finalState.nodes.find((node) => node.key === claim.node.key);
      return { graphId, branchKey, status, result, node: cloneNode(finalNode) };
    })();
    inFlight.set(flightKey, operation);
    try { return await operation; } finally { inFlight.delete(flightKey); }
  }

  async function close(graphId) {
    return mutate(graphId, (state) => {
      if (state.cancelRequested) {
        state.status = "cancelled";
        return state;
      }
      const running = state.nodes.filter((node) => !INVOCATION_TERMINAL.has(node.invocationStatus ?? node.status));
      if (running.length) throw fail(`workflow graph has running nodes: ${running.map((node) => node.key).join(", ")}`, "EBUSY");
      state.status = graphStatus(state);
      return state;
    });
  }

  async function cancel(graphId, reason = undefined) {
    graphId = id(graphId, "graph id");
    const state = await mutate(graphId, (current) => {
      if (GRAPH_TERMINAL.has(current.status)) return current;
      current.cancelRequested = true;
      current.cancelReason = reason instanceof Error ? failure(reason) : { message: String(reason ?? "workflow cancelled"), code: "ABORT_ERR" };
      current.status = "cancelling";
      return current;
    });
    const controller = controllers.get(graphId);
    if (controller && !controller.signal.aborted) controller.abort(reason instanceof Error ? reason : fail("workflow cancelled", "ABORT_ERR"));
    const current = await load(graphId);
    const active = current.nodes.some((node) => !INVOCATION_TERMINAL.has(node.invocationStatus ?? node.status));
    if (!active) return mutate(graphId, (next) => { next.status = "cancelled"; return next; });
    return current;
  }

  async function recover(graphId) {
    graphId = id(graphId, "graph id");
    const inspected = await inspectRaw(storage, graphId, { root });
    return mutate(graphId, (state) => {
      let recovered = false;
      for (const item of inspected.reconciliation) {
        const node = state.nodes.find((candidate) => candidate.key === item.key);
        if (!node || node.status !== "running") continue;
        if (!INVOCATION_TERMINAL.has(item.persistedStatus)) {
          node.status = "unknown";
          node.invocationStatus = "unknown";
          node.recovery = "process_restart";
          recovered = true;
        } else if (INVOCATION_TERMINAL.has(item.persistedStatus)) {
          node.status = item.persistedStatus;
          node.invocationStatus = item.persistedStatus;
          recovered = true;
        }
      }
      if (recovered) state.status = state.cancelRequested ? "cancelled" : graphStatus(state);
      return state;
    });
  }

  async function run({ id: graphId, root: rootOptions, branches = [] } = {}) {
    if (!Array.isArray(branches)) throw fail("branches must be an array");
    const started = await startRoot({ ...rootOptions, graphId });
    if (started.status === "waiting") {
      const unique = new Set();
      for (const branch of branches) {
        const branchKey = key(branch?.branchKey);
        if (unique.has(branchKey)) throw fail(`duplicate branch key: ${branchKey}`, "EEXIST");
        unique.add(branchKey);
      }
      await Promise.all(branches.map((branch) => continueBranch({
        ...branch,
        graphId,
        branchKey: branch.branchKey,
        parent: branch.parent ?? started.root,
        parentKey: branch.parentKey ?? "root",
        parentResponse: branch.parentResponse ?? started.root.response,
        toolResults: branch.toolResults ?? started.toolResults,
        agent: branch.agent ?? rootOptions.agent,
        model: branch.model ?? rootOptions.model,
        tools: branch.tools ?? rootOptions.tools,
      })));
    }
    const graph = await close(graphId);
    return { graphId, status: graph.status, graph, root: started.root };
  }

  return Object.freeze({
    root,
    startRoot,
    continueBranch,
    run,
    close,
    cancel,
    recover,
    inspect: (graphId) => inspectWorkflowGraph(storage, graphId, { root }),
  });
}
