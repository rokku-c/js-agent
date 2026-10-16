// Storage for one-request runs. The default mode is deliberately volatile: callers choose
// the VFS and this module makes no durability claim about an arbitrary filesystem.

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const TERMINAL = new Set(["completed", "completed_with_tool_calls", "failed", "unknown", "cancelled"]);
const reservationLocks = new WeakMap();
function error(message, code = "EINVAL") {
  const e = new Error(message);
  e.code = code;
  return e;
}

function validateId(id) {
  if (typeof id !== "string" || !ID.test(id) || id === "." || id === "..") {
    throw error(`invalid run id: ${id}`, "EINVAL");
  }
  return id;
}

function json(value, path) {
  let text;
  try {
    text = JSON.stringify(value, null, 2);
  } catch (e) {
    throw error(`cannot serialize ${path}: ${e.message}`, "EIO");
  }
  if (text === undefined) throw error(`cannot serialize ${path}`, "EINVAL");
  if (new TextEncoder().encode(text).byteLength > MAX_JSON_BYTES) {
    throw error(`${path} exceeds the ${MAX_JSON_BYTES} byte limit`, "EFBIG");
  }
  return text;
}

function pathJoin(root, id, file = "") {
  const base = root === "/" ? "" : root;
  return `${base}/${id}${file ? `/${file}` : ""}`;
}

function failureRecord(e) {
  return { name: e?.name ?? "Error", message: e?.message ?? String(e), code: e?.code ?? null };
}

/**
 * @param {{mkdir(path:string,opts?:object):Promise<any>,mkdirp(path:string):Promise<any>,write(path:string,data:any,opts?:object):Promise<any>}} vfs
 * @param {{root?:string,mode?:string}} opts
 */
export function createRunStore(vfs, { root = "/runs", mode = "volatile" } = {}) {
  if (!vfs || typeof vfs.mkdirp !== "function" || typeof vfs.mkdir !== "function" || typeof vfs.write !== "function") {
    throw new TypeError("createRunStore requires a VFS-like storage adapter");
  }
  if (typeof root !== "string" || !root.startsWith("/") || root.includes("//") || root.split("/").includes("..")) {
    throw error("run store root must be an absolute path", "EINVAL");
  }
  // Durable semantics require a real commit protocol. This milestone only defines the
  // honest volatile mode rather than treating an arbitrary VFS as durable.
  if (mode !== "volatile") throw error(`unsupported run store mode: ${mode}`, "ENOTSUP");

  let localCounter = 0;
  const nextId = () => {
    localCounter = (localCounter + 1) % 1_000_000;
    return `run-${Date.now().toString(36)}-${localCounter.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  };
  const owned = new Set();
  const states = new Map();
  const queues = new Map();
  const sequence = new Map();
  const lastErrors = new Map();
  const lockMap = reservationLocks.get(vfs) ?? new Map();
  reservationLocks.set(vfs, lockMap);

  const withReservationLock = (key, operation) => {
    const previous = lockMap.get(key) ?? Promise.resolve();
    const current = previous.then(operation, operation);
    const tracked = current.then(() => undefined, () => undefined).finally(() => {
      if (lockMap.get(key) === tracked) lockMap.delete(key);
    });
    lockMap.set(key, tracked);
    return current;
  };

  const queue = (id, operation) => {
    const previous = queues.get(id) ?? Promise.resolve();
    const current = previous.then(operation, operation);
    // Keep the queue's bookkeeping promise fulfilled so a rejected operation cannot become
    // an unhandled rejection. The caller still receives the original `current` rejection.
    const tracked = current.then(
      () => undefined,
      () => undefined,
    ).finally(() => {
      if (queues.get(id) === tracked) queues.delete(id);
    });
    queues.set(id, tracked);
    return current;
  };

  const assertWriteId = (value) => {
    const id = validateId(value);
    if (!owned.has(id)) throw error(`run id is not reserved by this store: ${id}`, "EACCES");
    return id;
  };

  async function writeSnapshot(path, value) {
    const text = json(value, path);
    const temp = `${path}.tmp-${Math.random().toString(36).slice(2, 12)}`;
    await vfs.write(temp, text, { create: true });
    if (typeof vfs.rename !== "function") {
      await vfs.write(path, text, { create: true });
      try { await vfs.remove?.(temp); } catch { /* best effort */ }
      return;
    }
    try {
      await vfs.rename(temp, path);
    } catch (e) {
      if (e?.code !== "ENOTSUP") throw e;
      await vfs.write(path, text, { create: true });
      try { await vfs.remove?.(temp); } catch { /* best effort */ }
    }
  }

  async function writeStatus(id, value) {
    await writeSnapshot(pathJoin(root, id, "status.json"), {
      id,
      status: value.status,
      storage: mode,
      ...value,
    });
  }

  async function appendEvent(id, kind, fields = {}) {
    const seq = (sequence.get(id) ?? 0) + 1;
    const row = { seq, kind, at: new Date().toISOString(), ...fields };
    // JSONL means one compact JSON object per physical line. Pretty JSON here would make
    // replay split one event into several invalid records.
    const text = `${JSON.stringify(row)}\n`;
    if (new TextEncoder().encode(text).byteLength > MAX_JSON_BYTES) {
      throw error(`event exceeds the ${MAX_JSON_BYTES} byte limit`, "EFBIG");
    }
    try {
      await vfs.write(pathJoin(root, id, "events.jsonl"), text, { create: true, append: true });
      sequence.set(id, seq);
    } catch (e) {
      lastErrors.set(id, e);
      throw e;
    }
    return row;
  }

  async function terminalFailure(id, state, cause) {
    const details = cause ? { error: failureRecord(cause) } : {};
    try { await appendEvent(id, state, details); } catch { /* preserve the initiating error */ }
    try { await writeStatus(id, { status: state, ...details }); } catch (e) { lastErrors.set(id, e); }
    states.set(id, state);
    return { id, path: pathJoin(root, id), status: state, ...details };
  }

  const store = {
    root,
    mode,

    async reserve(requestedId, { request, plan } = {}) {
      const id = requestedId == null ? nextId() : validateId(requestedId);
      if (owned.has(id)) throw error(`run id already reserved: ${id}`, "EEXIST");
      return withReservationLock(`${root}/${id}`, async () => {
        if (owned.has(id)) throw error(`run id already reserved: ${id}`, "EEXIST");
        owned.add(id);
        let created = false;
        try {
          await vfs.mkdirp(root);
          const runPath = pathJoin(root, id);
          if (typeof vfs.exists === "function" && await vfs.exists(runPath)) {
            throw error(`run id already exists: ${id}`, "EEXIST");
          }
          await vfs.mkdir(runPath);
          created = true;
          await writeSnapshot(pathJoin(root, id, "request.json"), request);
          await writeSnapshot(pathJoin(root, id, "plan.json"), plan);
          await writeStatus(id, { status: "reserved" });
          states.set(id, "reserved");
        } catch (e) {
          lastErrors.set(id, e);
          states.delete(id);
          owned.delete(id);
          if (created && typeof vfs.remove === "function") {
            await vfs.remove(pathJoin(root, id), { recursive: true }).catch(() => {});
          }
          throw e;
        }
        return { id, path: pathJoin(root, id), status: "reserved" };
      });
    },
    async materialize(id, { request, plan } = {}) {
      id = assertWriteId(id);
      return queue(id, async () => {
        if (states.get(id) !== "reserved") throw error(`run ${id} is not awaiting materialization`, "EALREADY");
        await writeSnapshot(pathJoin(root, id, "request.json"), request);
        await writeSnapshot(pathJoin(root, id, "plan.json"), plan);
        return { id, path: pathJoin(root, id), status: "reserved" };
      });
    },

    async start(id) {
      id = assertWriteId(id);
      return queue(id, async () => {
        if (states.get(id) !== "reserved") throw error(`run ${id} cannot start from ${states.get(id)}`, "EALREADY");
        await appendEvent(id, "started");
        await writeStatus(id, { status: "started" });
        states.set(id, "started");
        return { id, path: pathJoin(root, id), status: "started" };
      });
    },

    async finish(id, response, toolCalls = undefined) {
      id = assertWriteId(id);
      return queue(id, async () => {
        if (states.get(id) !== "started") throw error(`run ${id} cannot finish from ${states.get(id)}`, "EALREADY");
        await writeSnapshot(pathJoin(root, id, "response.json"), response);
        await appendEvent(id, "completed", toolCalls === undefined ? {} : { toolCalls });
        const status = toolCalls?.length ? "completed_with_tool_calls" : "completed";
        await writeStatus(id, { status });
        states.set(id, status);
        return { id, path: pathJoin(root, id), status };
      });
    },

    async fail(id, state, cause) {
      id = assertWriteId(id);
      if (!TERMINAL.has(state) || state === "completed" || state === "completed_with_tool_calls") throw error(`invalid failure state: ${state}`, "EINVAL");
      return queue(id, async () => {
        const current = states.get(id);
        if (TERMINAL.has(current)) throw error(`run ${id} is already terminal: ${current}`, "EALREADY");
        return terminalFailure(id, state, cause);
      });
    },

    async readStatus(id) {
      id = validateId(id);
      return JSON.parse(await vfs.read(pathJoin(root, id, "status.json")));
    },

    lastError(id) { return lastErrors.get(validateId(id)) ?? null; },
    isReserved(id) { return owned.has(validateId(id)); },
  };
  return Object.freeze(store);
}

export { ID as RUN_ID_PATTERN };
