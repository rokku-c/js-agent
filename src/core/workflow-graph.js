import { readGraphDocument, writeGraphJournal, hasJournal } from "./workflow-journal.js";
import { invokeOnce } from "./invocation.js";
import { normalize } from "../kernel/paths.js";
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

function key(value, label = "branchKey", maxLength = 128) {
  if (typeof value !== "string" || value.trim() === "") throw fail(`${label} must be a nonempty string`);
  if (value.length > maxLength) throw fail(`${label} exceeds ${maxLength} characters`);
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

async function writeSnapshot(storage, path, value, durable = false) {
  const text = JSON.stringify(value, null, 2);
  const temporary = `${path}.tmp-${Math.random().toString(36).slice(2, 12)}`;
  await storage.write(temporary, text, { create: true });
  if (durable) await storage.sync(temporary);
  if (typeof storage.rename !== "function") {
    await storage.write(path, text, { create: true });
    try { await storage.remove?.(temporary); } catch { /* best effort */ }
    return;
  }
  try {
    await storage.rename(temporary, path);
    if (durable) {
      await storage.sync(path);
      await storage.sync(path.slice(0, path.lastIndexOf("/")));
    }
  } catch (error) {
    if (durable || error?.code !== "ENOTSUP") throw error;
    await storage.write(path, text, { create: true });
    try { await storage.remove?.(temporary); } catch { /* best effort */ }
  }
}

async function readJson(storage, path) {
  return JSON.parse(await storage.read(path));
}

// graph.json is an index, not authority to select a different write destination.
// Reject ambiguous/corrupt topology before inspection reads links or recovery mutates it.
async function readGraph(storage, graphId, root) {
  const path = pathJoin(root, graphId);
  let state;
  try { state = await readGraphDocument(storage, path, graphId); }
  catch (error) {
    if (error instanceof SyntaxError) throw fail("invalid workflow graph JSON", "EPROTO");
    throw error;
  }
  const invalid = () => { throw fail(`invalid workflow graph schema: ${graphId}`, "EPROTO"); };
  if (!state || state.version !== 1 || state.id !== graphId || state.path !== path
    || !Array.isArray(state.nodes) || !Array.isArray(state.edges)
    || typeof state.cancelRequested !== "boolean") invalid();
  const nodes = new Map();
  const invocations = new Set();
  for (const node of state.nodes) {
    if (!node || typeof node.key !== "string" || !node.key || nodes.has(node.key)
      || typeof node.invocationId !== "string" || !ID.test(node.invocationId)
      || invocations.has(node.invocationId) || typeof node.invocationPath !== "string"
      || !node.invocationPath.startsWith("/") || !node.invocationPath.endsWith(`/${node.invocationId}`)
      || node.invocationPath.includes("//") || node.invocationPath.split("/").includes("..")) invalid();
    nodes.set(node.key, node);
    invocations.add(node.invocationId);
  }
  if (state.root === null ? nodes.size !== 0 : !nodes.has(state.root)) invalid();
  const edges = new Set();
  const targets = new Set();
  for (const edge of state.edges) {
    if (!edge || typeof edge.key !== "string" || !edge.key || edges.has(edge.key)
      || !nodes.has(edge.from) || !nodes.has(edge.to) || edge.to === state.root
      || targets.has(edge.to) || nodes.get(edge.to).parent !== edge.from) invalid();
    edges.add(edge.key);
    targets.add(edge.to);
  }
  for (const node of nodes.values()) {
    if (node.key !== state.root && !targets.has(node.key)) invalid();
  }
  return state;
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

// Hash the full logical identity, not a lossy slug: parents, punctuation and long
// graph IDs must not alias one durable invocation reservation.
async function branchIdentity(graphId, parentKey, branchKey) {
  const bytes = new TextEncoder().encode(JSON.stringify([graphId, parentKey, branchKey]));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
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
  const graph = await readGraph(storage, graphId, root);
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
export function createWorkflowGraph({ storage, store, root = "/workflows", persistence = "snapshot", lockTimeoutMs = 2_000 } = {}) {
  if (!storage || typeof storage.read !== "function" || typeof storage.write !== "function") {
    throw fail("workflow graph requires storage read/write", "EINVAL");
  }
  if (!store || typeof store.reserve !== "function") throw fail("workflow graph requires a RunStore", "EINVAL");
  if (typeof root !== "string" || !root.startsWith("/") || root.includes("//") || root.split("/").includes("..")) {
    throw fail("workflow graph root must be an absolute path", "EINVAL");
  }
  root = normalize(root);
  const storeRoot = normalize(store.root ?? "/runs");
  const overlaps = (a, b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
  if (overlaps(root, storeRoot)) {
    throw fail("workflow graph root must be separate from the run store root", "EINVAL");
  }

  if (!["snapshot", "journal"].includes(persistence)) throw fail("unsupported graph persistence", "EINVAL");
  if (!Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs < 1) throw fail("invalid graph lock timeout", "EINVAL");
  const durable = store.mode === "durable";
  if (durable) {
    const caps = storage.capabilities?.(root) ?? {};
    if (!(caps.durable && caps.exclusiveMkdir && caps.atomicRename && caps.flush)
      || ["sync", "remove", "rename", "mkdir", "mkdirp"].some(method => typeof storage[method] !== "function")) {
      throw fail("durable graph requires exclusive mkdir, atomic rename and flush at its root", "ENOTSUP");
    }
  }

  // The lock is outside the graph directory so creation is covered as well.
  // Never steal a stale lock automatically: a paused writer may still commit.
  async function locked(graphId, operation) {
    const path = pathJoin(root, graphId);
    return graphLock(storage, path, async () => {
      if (!durable) return operation();
      await storage.mkdirp(root);
      const lock = pathJoin(root, `.lock-${graphId}`);
      const started = Date.now();
      for (;;) {
        try { await storage.mkdir(lock, { exclusive: true }); break; }
        catch (error) {
          if (error.code !== "EEXIST") throw error;
          if (Date.now() - started >= lockTimeoutMs) throw fail(`workflow graph writer is busy: ${graphId}`, "EBUSY");
          await new Promise(resolve => setTimeout(resolve, 2));
        }
      }
      try { return await operation(); }
      finally { await storage.remove(lock, { recursive: true }); }
    });
  }

  const controllers = new Map();
  const inFlight = new Map();

  async function load(graphId) {
    return readGraph(storage, id(graphId, "graph id"), root);
  }

  async function save(state) {
    state.updated = now();
    if (hasJournal(state) || (persistence === "journal" && state.nodes.length === 0)) {
      await writeGraphJournal(storage, state, (path, value) => writeSnapshot(storage, path, value, durable));
    } else {
      await writeSnapshot(storage, `${state.path}/graph.json`, state, durable);
    }
    return state;
  }

  async function create(graphId) {
    graphId = id(graphId, "graph id");
    const path = pathJoin(root, graphId);
    return locked(graphId, async () => {
      if (typeof storage.exists === "function" && await storage.exists(path)) {
        throw fail(`workflow graph already exists: ${graphId}`, "EEXIST");
      }
      await storage.mkdirp(root);
      await storage.mkdir(path, { exclusive: true });
      if (durable) await storage.sync(root);
      const state = emptyGraph(graphId, root);
      await save(state);
      controllers.set(graphId, new AbortController());
      return state;
    });
  }

  async function mutate(graphId, operation) {
    id(graphId, "graph id");
    return locked(graphId, async () => {
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
      const invocationId = id(options.rootId ?? `${graphId}-root`, "root invocation id");
      const invocationPath = pathJoin(store.root ?? "/runs", invocationId);
      const claim = await mutate(graphId, (current) => {
        if (current.root) return { existing: true, state: current };
        if (current.cancelRequested) return { existing: true, state: current };
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
      let rootCancelled = false;
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
            if (!node || node.recovery === "process_restart") return current;
            Object.assign(node, {
              status: current.cancelRequested ? "cancelled" : "unknown",
              invocationStatus: "unknown",
              error: failure(error),
            });
            current.status = current.cancelRequested ? "cancelled" : "unknown";
            return current;
          });
          throw error;
        }
        rootCancelled = true;
        if (!rootResult) {
          let persistedStatus;
          try { persistedStatus = (await readJson(storage, `${invocationPath}/status.json`)).status; }
          catch { /* Missing evidence must not imply a known cancellation outcome. */ }
          rootResult = {
            id: invocationId, path: invocationPath,
            status: INVOCATION_TERMINAL.has(persistedStatus) ? persistedStatus : "unknown",
            response: null,
          };
        }
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
        status: rootCancelled ? "cancelled" : rootResult.status,
        invocationStatus: rootResult.status,
        ...(rootResult.toolCalls?.length ? { toolCallIds: rootResult.toolCalls.map((call) => call.id) } : {}),
      };
      await mutate(graphId, (current) => {
        const currentNode = current.nodes.find((item) => item.key === "root");
        // A restarted graph may have already classified this dispatch as unknown. A
        // late completion must not make that recovered claim look successful.
        if (!currentNode || currentNode.recovery === "process_restart") return current;
        Object.assign(currentNode, node, current.cancelRequested ? { status: "cancelled" } : {});
        current.status = current.cancelRequested || rootCancelled || rootResult.status === "cancelled"
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
    const parentKey = key(options.parentKey ?? "root", "parentKey", 135);
    const edgeKey = `${encodeURIComponent(parentKey)}:${encodeURIComponent(branchKey)}`;
    const flightKey = `${graphId}:${edgeKey}`;
    const existingFlight = inFlight.get(flightKey);
    if (existingFlight) {
      return existingFlight.then((result) => ({ ...result, deduplicated: true }));
    }

    // A coordinator reconstructed from disk has no startRoot-created controller.
    if (!controllers.has(graphId)) controllers.set(graphId, new AbortController());
    const claim = await mutate(graphId, async (state) => {
      if (state.cancelRequested || state.status === "cancelled") return { cancelled: true, state };
      // Match the stored relationship rather than its encoding, including v1 keys
      // written before edge components were escaped.
      const nodesByKey = new Map(state.nodes.map(node => [node.key, node]));
      const existing = state.edges.find((edge) => edge.from === parentKey
        && nodesByKey.get(edge.to)?.branchKey === branchKey);
      if (existing) return { existing: true, state, edge: existing };
      const parentNode = state.nodes.find((node) => node.key === parentKey);
      if (!parentNode) throw fail(`parent invocation has not completed: ${parentKey}`, "EAGAIN");
      if (parentNode.invocationStatus !== "completed_with_tool_calls") {
        throw fail(`parent cannot continue from ${parentNode.invocationStatus}`, "EALREADY");
      }
      if (!options.parent || options.parent.id !== parentNode.invocationId) {
        throw fail(`parent result does not match graph node: ${parentKey}`);
      }
      const identity = await branchIdentity(graphId, parentKey, branchKey);
      const legacyId = `${graphId}-${branchKey}`;
      const compatibleId = parentKey === "root" && ID.test(branchKey) && ID.test(legacyId)
        && !state.nodes.some((node) => node.invocationId === legacyId) ? legacyId : null;
      const invocationId = options.id ?? compatibleId ?? `${graphId.slice(0, 60)}-${identity}`;
      id(invocationId, "branch invocation id");
      if (state.nodes.some((node) => node.invocationId === invocationId)) {
        throw fail(`invocation already belongs to another graph node: ${invocationId}`, "EEXIST");
      }
      const nodeKey = parentKey === "root" ? `branch:${branchKey}` : `node:${identity}`;
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
      if (state.status === "completed") state.status = "running";
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
            status: state.cancelRequested ? "cancelled" : status,
            invocationStatus,
            finishedAt: now(),
            ...(error && !cancelled ? { error: failure(error) } : {}),
          });
          edge.status = node.status;
          if (state.cancelRequested) state.status = "cancelled";
          else if (status === "unknown") state.status = "unknown";
        }
        return state;
      });
      if (error && !cancelled) throw error;
      const finalNode = finalState.nodes.find((node) => node.key === claim.node.key);
      return { graphId, branchKey, status: finalNode.status, result, node: cloneNode(finalNode) };
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
    if (!state.cancelRequested) return state;
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
        const edge = state.edges.find((candidate) => candidate.to === node.key);
        const invocationStatus = INVOCATION_TERMINAL.has(item.persistedStatus) ? item.persistedStatus : "unknown";
        node.status = state.cancelRequested ? "cancelled" : invocationStatus;
        node.invocationStatus = invocationStatus;
        // Fence every reconciled claim, including an unknown already committed by
        // RunStore.recover(), from a pre-recovery evaluator's late completion.
        node.recovery = "process_restart";
        if (edge) edge.status = node.status;
        recovered = true;
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
