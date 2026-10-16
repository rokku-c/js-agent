// Storage for one-request runs.
//
// volatile mode is the compatibility default. durable mode is deliberately narrower: it only
// accepts a storage mount that declares exclusive mkdir, atomic rename, append and flush. The
// store can then make a restart/recovery claim about committed local records, while external
// effects remain unknown after an interrupted dispatch.

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const TERMINAL = new Set(["completed", "completed_with_tool_calls", "failed", "unknown", "cancelled"]);
const DURABLE_TERMINAL = new Set(["completed", "failed", "unknown", "cancelled"]);
const STATUSES = new Set(["reserved", "started", ...TERMINAL]);
const reservationLocks = new WeakMap();

function error(message, code = "EINVAL", fields = {}) {
  const e = new Error(message);
  e.code = code;
  Object.assign(e, fields);
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

function parentPath(path) {
  const slash = path.lastIndexOf("/");
  return slash <= 0 ? "/" : path.slice(0, slash);
}

function failureRecord(e) {
  return { name: e?.name ?? "Error", message: e?.message ?? String(e), code: e?.code ?? null };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomToken(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function terminalForEvent(event, status) {
  if (event?.kind === "completed") {
    return status === "completed_with_tool_calls" ? status : "completed";
  }
  return DURABLE_TERMINAL.has(event?.kind) ? event.kind : null;
}

/**
 * @param {{mkdir(path:string,opts?:object):Promise<any>,mkdirp(path:string):Promise<any>,write(path:string,data:any,opts?:object):Promise<any>}} vfs
 * @param {{root?:string,mode?:string,lockTimeoutMs?:number}} opts
 */
export function createRunStore(vfs, { root = "/runs", mode = "volatile", lockTimeoutMs = 2_000 } = {}) {
  if (!vfs || typeof vfs.mkdirp !== "function" || typeof vfs.mkdir !== "function" || typeof vfs.write !== "function") {
    throw new TypeError("createRunStore requires a VFS-like storage adapter");
  }
  if (typeof root !== "string" || !root.startsWith("/") || root.includes("//") || root.split("/").includes("..")) {
    throw error("run store root must be an absolute path", "EINVAL");
  }
  if (mode !== "volatile" && mode !== "durable") throw error(`unsupported run store mode: ${mode}`, "ENOTSUP");
  if (!Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs < 1) {
    throw error("run store lockTimeoutMs must be a positive safe integer", "EINVAL");
  }

  const capabilities = typeof vfs.capabilities === "function" ? vfs.capabilities(root) : {};
  if (mode === "durable" && !(capabilities.durable && capabilities.exclusiveMkdir && capabilities.atomicRename && capabilities.append && capabilities.flush)) {
    throw error("durable run store requires a storage mount with exclusive mkdir, atomic rename, append, and flush", "ENOTSUP");
  }
  for (const method of ["read", "rename", "remove", "exists"]) {
    if (mode === "durable" && typeof vfs[method] !== "function") {
      throw error(`durable run store requires storage.${method}()`, "ENOTSUP");
    }
  }

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
    const tracked = current.then(() => undefined, () => undefined).finally(() => {
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

  async function flush(path) {
    if (mode === "durable") await vfs.sync(path);
  }

  async function writeSnapshot(path, value) {
    const text = json(value, path);
    const temp = `${path}.tmp-${randomToken("write")}`;
    let renamed = false;
    try {
      await vfs.write(temp, text, { create: true });
      if (mode === "durable") {
        await flush(temp);
        await vfs.rename(temp, path);
        renamed = true;
        await flush(path);
        await flush(parentPath(path));
      } else if (typeof vfs.rename !== "function") {
        await vfs.write(path, text, { create: true });
        renamed = true;
      } else {
        try {
          await vfs.rename(temp, path);
          renamed = true;
        } catch (e) {
          if (e?.code !== "ENOTSUP") throw e;
          await vfs.write(path, text, { create: true });
          renamed = true;
        }
      }
    } finally {
      if (!renamed) {
        try { await vfs.remove?.(temp); } catch { /* preserve the initiating error */ }
      }
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

  async function readJournal(id) {
    const path = pathJoin(root, id, "events.jsonl");
    let text;
    try {
      text = await vfs.read(path);
    } catch (cause) {
      if (cause?.code === "ENOENT") return { path, text: "", events: [], sequence: 0, partial: false };
      throw cause;
    }
    if (typeof text !== "string") text = String(text);
    const events = [];
    let partial = false;
    const lines = text.split("\n");
    if (lines.at(-1) === "") lines.pop();
    for (const line of lines) {
      if (!line) { partial = true; break; }
      let value;
      try { value = JSON.parse(line); } catch { partial = true; break; }
      if (!value || typeof value !== "object" || !Number.isSafeInteger(value.seq) || value.seq <= (events.at(-1)?.seq ?? 0)) {
        partial = true;
        break;
      }
      events.push(value);
    }
    return { path, text, events, sequence: events.at(-1)?.seq ?? 0, partial };
  }

  async function repairJournal(id, journal) {
    if (!journal.partial || mode !== "durable") return journal;
    const corrupt = `${journal.path}.corrupt-${randomToken("tail")}`;
    const temp = `${journal.path}.tmp-${randomToken("repair")}`;
    const prefix = journal.events.length ? `${journal.events.map((event) => JSON.stringify(event)).join("\n")}\n` : "";
    let replaced = false;
    try {
      // Preserve the unreadable bytes for forensics, but make the canonical journal a valid
      // prefix before recovery appends its explicit unknown outcome.
      await vfs.write(corrupt, journal.text, { create: true });
      await flush(corrupt);
      await vfs.write(temp, prefix, { create: true });
      await flush(temp);
      await vfs.rename(temp, journal.path);
      replaced = true;
      await flush(journal.path);
      await flush(parentPath(journal.path));
      return { path: journal.path, text: prefix, events: journal.events, sequence: journal.sequence, partial: false };
    } finally {
      if (!replaced) {
        try { await vfs.remove?.(temp); } catch { /* preserve the initiating error */ }
      }
    }
  }

  async function appendEvent(id, kind, fields = {}) {
    const journal = mode === "durable" ? await readJournal(id) : { sequence: sequence.get(id) ?? 0 };
    if (journal.partial) throw error(`run event journal is malformed: ${id}`, "EILSEQ");
    const seq = journal.sequence + 1;
    const row = { seq, kind, at: new Date().toISOString(), ...fields };
    let text;
    try { text = `${JSON.stringify(row)}\n`; } catch (cause) { throw error(`cannot serialize event: ${cause.message}`, "EIO"); }
    if (new TextEncoder().encode(text).byteLength > MAX_JSON_BYTES) {
      throw error(`event exceeds the ${MAX_JSON_BYTES} byte limit`, "EFBIG");
    }
    try {
      await vfs.write(pathJoin(root, id, "events.jsonl"), text, { create: true, append: true });
      await flush(pathJoin(root, id, "events.jsonl"));
      sequence.set(id, seq);
    } catch (e) {
      lastErrors.set(id, e);
      throw e;
    }
    return row;
  }

  async function acquireLock(id, { takeover = false } = {}) {
    const lock = pathJoin(root, id, ".writer-lock");
    if (takeover) {
      try { await vfs.remove(lock, { recursive: true }); } catch (cause) {
        if (cause?.code !== "ENOENT") throw cause;
      }
    }
    const started = Date.now();
    for (;;) {
      try {
        await vfs.mkdir(lock, { exclusive: true });
        const owner = pathJoin(root, id, ".writer-lock/owner.json");
        await vfs.write(owner, JSON.stringify({ token: randomToken("writer"), pid: process.pid, at: new Date().toISOString() }), { create: true });
        await flush(owner);
        return async () => {
          try { await vfs.remove(lock, { recursive: true }); } catch (cause) { lastErrors.set(id, cause); }
        };
      } catch (cause) {
        if (cause?.code !== "EEXIST" || Date.now() - started >= lockTimeoutMs) {
          throw error(`run writer is busy: ${id}`, cause?.code === "EEXIST" ? "EBUSY" : (cause?.code ?? "EIO"));
        }
        await sleep(2);
      }
    }
  }

  async function mutate(id, operation, options = {}) {
    if (mode !== "durable") return operation();
    const release = await acquireLock(id, options);
    try { return await operation(); } finally { await release(); }
  }

  async function readPersistedStatus(id) {
    try {
      const value = JSON.parse(await vfs.read(pathJoin(root, id, "status.json")));
      return value && typeof value === "object" && STATUSES.has(value.status) ? value : null;
    } catch {
      return null;
    }
  }

  async function currentDurableState(id) {
    let journal = await readJournal(id);
    if (journal.partial) throw error(`run event journal is malformed: ${id}`, "EILSEQ");
    const status = await readPersistedStatus(id);
    const last = journal.events.at(-1);
    const terminal = terminalForEvent(last, status?.status);
    const state = terminal ?? (last?.kind === "started" ? "started" : status?.status ?? "reserved");
    sequence.set(id, journal.sequence);
    states.set(id, state);
    return state;
  }

  async function terminalFailure(id, state, cause) {
    const details = cause ? { error: failureRecord(cause) } : {};
    if (mode === "durable") {
      await appendEvent(id, state, details);
      try {
        await writeStatus(id, { status: state, ...details });
      } catch (statusError) {
        lastErrors.set(id, statusError);
        throw error(`terminal outcome was journaled but status could not be committed for ${id}`, statusError.code ?? "EIO", {
          outcome: "unknown",
          intendedStatus: state,
          eventCommitted: true,
          cause: statusError,
        });
      }
      states.set(id, state);
      return { id, path: pathJoin(root, id), status: state };
    }
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
          // The directory is the cross-instance reservation. exists()+mkdir() is a TOCTOU
          // check and is intentionally not used here.
          await vfs.mkdir(runPath, { exclusive: true });
          created = true;
          await flush(root);
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
          if (e?.code === "EEXIST") throw error(`run id already exists: ${id}`, "EEXIST");
          throw e;
        }
        return { id, path: pathJoin(root, id), status: "reserved" };
      });
    },

    async recover(requestedId, { takeover = false } = {}) {
      if (mode !== "durable") throw error("run recovery requires durable mode", "ENOTSUP");
      const id = validateId(requestedId);
      if (owned.has(id)) return { id, path: pathJoin(root, id), status: states.get(id), recovered: false, partial: false };
      if (!(await vfs.exists(pathJoin(root, id)))) throw error(`run does not exist: ${id}`, "ENOENT");
      return mutate(id, async () => {
        let journal = await readJournal(id);
        const hadPartial = journal.partial;
        if (journal.partial) journal = await repairJournal(id, journal);
        const status = await readPersistedStatus(id);
        const last = journal.events.at(-1);
        let state = terminalForEvent(last, status?.status) ?? (last?.kind === "started" ? "started" : status?.status ?? "unknown");
        sequence.set(id, journal.sequence);
        owned.add(id);
        states.set(id, state);

        // A committed started record without a committed terminal record means that a model
        // request or external effect may have happened. Recovery never turns that into success.
        if (state === "started") {
          await appendEvent(id, "unknown", { recovery: "process_restart" });
          await writeStatus(id, { status: "unknown", recovery: "process_restart" });
          state = "unknown";
          states.set(id, state);
        } else if (state === "completed" && status?.status === "completed_with_tool_calls") {
          state = "completed_with_tool_calls";
          states.set(id, state);
        } else if (state !== status?.status && state !== "unknown") {
          await writeStatus(id, { status: state, recovery: "journal_reconciliation" });
        }
        return { id, path: pathJoin(root, id), status: state, recovered: true, partial: hadPartial };
      }, { takeover });
    },

    async materialize(id, { request, plan } = {}) {
      id = assertWriteId(id);
      return queue(id, () => mutate(id, async () => {
        if (mode === "durable") await currentDurableState(id);
        if (states.get(id) !== "reserved") throw error(`run ${id} is not awaiting materialization`, "EALREADY");
        await writeSnapshot(pathJoin(root, id, "request.json"), request);
        await writeSnapshot(pathJoin(root, id, "plan.json"), plan);
        return { id, path: pathJoin(root, id), status: "reserved" };
      }));
    },

    async start(id) {
      id = assertWriteId(id);
      return queue(id, () => mutate(id, async () => {
        if (mode === "durable") await currentDurableState(id);
        if (states.get(id) !== "reserved") throw error(`run ${id} cannot start from ${states.get(id)}`, "EALREADY");
        await appendEvent(id, "started");
        await writeStatus(id, { status: "started" });
        states.set(id, "started");
        return { id, path: pathJoin(root, id), status: "started" };
      }));
    },

    async finish(id, response, toolCalls = undefined) {
      id = assertWriteId(id);
      return queue(id, () => mutate(id, async () => {
        if (mode === "durable") await currentDurableState(id);
        if (states.get(id) !== "started") throw error(`run ${id} cannot finish from ${states.get(id)}`, "EALREADY");
        await writeSnapshot(pathJoin(root, id, "response.json"), response);
        await appendEvent(id, "completed", toolCalls === undefined ? {} : { toolCalls });
        const status = toolCalls?.length ? "completed_with_tool_calls" : "completed";
        await writeStatus(id, { status });
        states.set(id, status);
        return { id, path: pathJoin(root, id), status };
      }));
    },

    async fail(id, state, cause) {
      id = assertWriteId(id);
      if (!TERMINAL.has(state) || state === "completed" || state === "completed_with_tool_calls") throw error(`invalid failure state: ${state}`, "EINVAL");
      return queue(id, () => mutate(id, async () => {
        if (mode === "durable") await currentDurableState(id);
        const current = states.get(id);
        if (TERMINAL.has(current)) throw error(`run ${id} is already terminal: ${current}`, "EALREADY");
        return terminalFailure(id, state, cause);
      }));
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
