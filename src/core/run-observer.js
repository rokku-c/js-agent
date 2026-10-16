// Read-only RunState observation. This deliberately reads only the public status and
// event metadata; request, plan, response, and event payload fields never cross this API.

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TERMINAL = new Set(["completed", "completed_with_tool_calls", "failed", "unknown", "cancelled"]);
const STATUSES = new Set(["reserved", "started", ...TERMINAL]);
const STORAGE_MODES = new Set(["volatile", "durable"]);
const EVENT_KINDS = new Set(["started", "completed", "failed", "unknown", "cancelled"]);
const ISO_TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

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

function validateRoot(root) {
  if (typeof root !== "string" || !root.startsWith("/") || root.includes("//") || root.split("/").includes("..")) {
    throw error("run observer root must be an absolute path", "EINVAL");
  }
  return root;
}

function pathJoin(root, id, file = "") {
  const base = root === "/" ? "" : root;
  return `${base}/${id}${file ? `/${file}` : ""}`;
}

function publicStorageError(operation, cause) {
  const e = error(`run observer ${operation} failed`, cause?.code ?? "EIO");
  return e;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : error("observation cancelled", "ABORT_ERR");
}

function sleep(ms, signal) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    let timer;
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal.reason instanceof Error ? signal.reason : error("observation cancelled", "ABORT_ERR"));
    };
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function safeAt(value) {
  return typeof value === "string" && ISO_TIME.test(value) ? value : null;
}

function safeKind(value) {
  return EVENT_KINDS.has(value) ? value : "other";
}

async function optionalRead(vfs, path) {
  try {
    return { value: await vfs.read(path), state: "present" };
  } catch (cause) {
    if (cause?.code === "ENOENT") return { value: null, state: "missing" };
    return { value: null, state: "unavailable", code: cause?.code ?? "EIO" };
  }
}

function parseStatus(id, result) {
  if (result.state !== "present") return { status: null, partial: true, issue: result.code ?? "ENOENT" };
  let value;
  try {
    value = JSON.parse(typeof result.value === "string" ? result.value : String(result.value));
  } catch {
    return { status: null, partial: true, issue: "EILSEQ" };
  }
  if (!value || typeof value !== "object" || value.id !== id || !STATUSES.has(value.status)) {
    return { status: null, storage: null, partial: true, issue: "EPROTO" };
  }
  return {
    status: value.status,
    storage: STORAGE_MODES.has(value.storage) ? value.storage : null,
    partial: false,
    issue: null,
  };
}

function parseEvents(result) {
  if (result.state === "missing") return { events: [], sequence: 0, partial: false, issue: null };
  if (result.state !== "present") return { events: [], sequence: 0, partial: true, issue: result.code ?? "EIO" };
  if (typeof result.value !== "string") return { events: [], sequence: 0, partial: true, issue: "EILSEQ" };

  const events = [];
  let sequence = 0;
  let partial = false;
  const lines = result.value.split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const line of lines) {
    if (!line) {
      partial = true;
      break;
    }
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      partial = true;
      break;
    }
    if (!value || typeof value !== "object" || !Number.isSafeInteger(value.seq) || value.seq <= sequence) {
      partial = true;
      break;
    }
    sequence = value.seq;
    events.push({ seq: value.seq, kind: safeKind(value.kind), at: safeAt(value.at) });
  }
  return { events, sequence, partial, issue: partial ? "EPROTO" : null };
}

function consistency(status, events, eventState) {
  if (!status) return true;
  if (status === "reserved") return events.length !== 0;
  if (eventState !== "present" || events.length === 0) return true;
  // Admission can fail or be cancelled before start, so a terminal event may be the
  // first event. Once started, terminal states must follow the started observation.
  if (TERMINAL.has(status) && events.length === 1 && events[0].kind === status) return false;
  if (events[0].kind !== "started") return true;
  if (status === "started") return events.at(-1).kind !== "started";
  if (status === "completed" || status === "completed_with_tool_calls") return events.at(-1).kind !== "completed";
  if (TERMINAL.has(status)) return events.at(-1).kind !== status;
  return true;
}

function signature(snapshot) {
  return JSON.stringify([
    snapshot.status,
    snapshot.partial,
    snapshot.sequence,
    snapshot.events,
    snapshot.files,
  ]);
}

/**
 * Observe RunState without returning invocation payloads.
 *
 * A snapshot is a best-effort point-in-time view. `volatile: true` means it is not a
 * recovery or durability claim, even if `storage: "durable"` is recorded by the writer.
 * That storage label is metadata, not a capability check. The supplied View still controls
 * which run IDs are authorized. `partial: true` means the observer saw missing, malformed,
 * unreadable, or internally inconsistent status/event persistence.
 */
export function createRunObserver(vfs, { root = "/runs", interval = 100 } = {}) {
  if (!vfs || typeof vfs.read !== "function" || typeof vfs.list !== "function" || typeof vfs.stat !== "function") {
    throw new TypeError("createRunObserver requires a VFS-like read/list/stat adapter");
  }
  validateRoot(root);
  if (!Number.isSafeInteger(interval) || interval < 1) throw error("observer interval must be a positive safe integer", "EINVAL");

  async function assertRun(id) {
    id = validateId(id);
    try {
      const stat = await vfs.stat(pathJoin(root, id));
      if (stat?.type && stat.type !== "dir") throw error(`run is not a directory: ${id}`, "ENOTDIR");
    } catch (cause) {
      if (cause?.code === "ENOENT") throw error(`run is not available: ${id}`, "ENOENT");
      if (cause?.code === "ENOTDIR") throw error(`run is not a directory: ${id}`, "ENOTDIR");
      throw publicStorageError("stat", cause);
    }
    return id;
  }

  async function snapshot(requestedId) {
    const id = await assertRun(requestedId);
    const statusResult = await optionalRead(vfs, pathJoin(root, id, "status.json"));
    const eventResult = await optionalRead(vfs, pathJoin(root, id, "events.jsonl"));
    const status = parseStatus(id, statusResult);
    const events = parseEvents(eventResult);
    const partial = status.partial || events.partial || consistency(status.status, events.events, eventResult.state);
    const issue = status.issue ?? events.issue;
    return {
      id,
      status: status.status,
      ...(status.storage ? { storage: status.storage } : {}),
      terminal: status.status != null && TERMINAL.has(status.status),
      sequence: events.sequence,
      events: events.events,
      files: { status: statusResult.state, events: eventResult.state },
      partial,
      ...(issue ? { issue } : {}),
      volatile: true,
      redacted: true,
    };
  }

  async function list() {
    let entries;
    try {
      entries = await vfs.list(root);
    } catch (cause) {
      if (cause?.code === "ENOENT") return [];
      throw publicStorageError("list", cause);
    }
    const ids = entries
      .filter((entry) => entry && typeof entry.name === "string" && ID.test(entry.name) && (!entry.type || entry.type === "dir"))
      .map((entry) => entry.name)
      .sort();
    const results = await Promise.all(ids.map(async (id) => {
      try { return await snapshot(id); } catch (cause) {
        if (cause?.code === "ENOENT") return null;
        throw cause;
      }
    }));
    return results.filter(Boolean);
  }

  function watch(requestedId, { after = 0, includeInitial = true, untilTerminal = true, signal } = {}) {
    const id = validateId(requestedId);
    if (!Number.isSafeInteger(after) || after < 0) throw error("observer cursor must be a non-negative safe integer", "EINVAL");
    return (async function* runWatch() {
      let previous = null;
      let first = true;
      while (true) {
        throwIfAborted(signal);
        const current = await snapshot(id);
        const changed = previous === null || signature(current) !== previous;
        if (changed && (first ? includeInitial : true)) {
          yield {
            ...current,
            events: current.events.filter((event) => event.seq > after),
          };
        }
        previous = signature(current);
        first = false;
        if (untilTerminal && current.terminal) return;
        await sleep(interval, signal);
      }
    })();
  }

  return Object.freeze({ root, interval, snapshot, list, watch });
}
