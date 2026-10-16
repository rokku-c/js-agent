// An in-memory external connector for exercising the resource protocol.
//
// It deliberately looks like a connector, rather than a filesystem driver: paths carry
// provider-shaped resources, stat exposes external metadata, status is a normal resource,
// writes use an explicit revision token, and changes are observable through watch().
import { VfsError } from "../kernel/errors.js";
import { entry, fileStat, dirStat, toBytes } from "../kernel/driver.js";
import { normalize, isUnder } from "../kernel/paths.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const DEFAULT_STATUS_PATH = "/status.json";

function clone(value) {
  if (value === undefined) return undefined;
  return structuredClone(value);
}

function fail(code, message, path, operation) {
  throw new VfsError(code, message, { path, operation });
}

async function revisionOf(bytes) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function copyBytes(value) {
  const bytes = toBytes(value);
  return new Uint8Array(bytes);
}

function pathOf(path, operation) {
  if (typeof path !== "string" || path.includes("\0")) {
    fail("EINVAL", "connector paths must be strings without NUL", path, operation);
  }
  return normalize(path);
}

function jsonBytes(value) {
  return encoder.encode(JSON.stringify(value, null, 2) + "\n");
}

function nowValue(clock) {
  const value = clock();
  return value instanceof Date ? value.getTime() : Number(value);
}

function publicMetadata(metadata) {
  return metadata && typeof metadata === "object" ? clone(metadata) : {};
}

/**
 * A connector-shaped ResourceStore backed by memory.
 *
 * `resources` is a map of absolute paths to either a value or
 * `{ value, metadata, readonly, mode }`. Values may be text, bytes, or JSON-like data.
 * Metadata is returned from stat/list under `resource`; it is never needed to resolve a
 * reference, which keeps external identity separate from local path identity.
 */
export class InMemoryConnector {
  #files = new Map();
  #directories = new Set(["/"]);
  #watchers = new Set();
  #clock;
  #statusPath;
  #status;
  #source;

  constructor({ resources = {}, status = {}, statusPath = DEFAULT_STATUS_PATH, source = "memory", clock = () => Date.now() } = {}) {
    if (!resources || typeof resources !== "object" || Array.isArray(resources)) {
      throw new TypeError("resources must be an object map");
    }
    this.#clock = clock;
    this.#statusPath = pathOf(statusPath, "constructor");
    this.#source = String(source);
    this.#status = clone(status) ?? {};
    this.#addDirectories(this.#statusPath);
    for (const [path, value] of Object.entries(resources)) this.define(path, value);
    if (this.#files.has(this.#statusPath)) {
      throw new TypeError(`status path is reserved: ${this.#statusPath}`);
    }
  }

  /** Add or replace a file before using it through the resource facade. */
  define(path, input) {
    const abs = pathOf(path, "define");
    if (abs === "/" || abs === this.#statusPath) throw new TypeError(`file path is reserved: ${abs}`);
    const spec = input && typeof input === "object" && !(input instanceof Uint8Array) &&
      !(input instanceof ArrayBuffer) && !ArrayBuffer.isView(input) && Object.hasOwn(input, "value")
      ? input
      : { value: input };
    const bytes = copyBytes(spec.value);
    this.#files.set(abs, {
      bytes,
      metadata: publicMetadata(spec.metadata),
      readonly: spec.readonly === true,
      mode: spec.mode ?? 0o644,
      mtime: nowValue(this.#clock),
    });
    this.#addDirectories(abs);
    return this;
  }

  /** Return connector health as a value; the same data is also readable at statusPath. */
  status() {
    return clone(this.#status);
  }

  statusPath() {
    return this.#statusPath;
  }

  async setStatus(status, { source = "connector" } = {}) {
    if (!status || typeof status !== "object" || Array.isArray(status)) {
      throw new TypeError("status must be an object");
    }
    this.#status = clone(status);
    this.#emit({
      kind: "status",
      path: this.#statusPath,
      source,
      at: new Date(nowValue(this.#clock)).toISOString(),
      status: clone(this.#status),
      revision: await revisionOf(jsonBytes(this.#status)),
    });
    return this.status();
  }

  async stat(path) {
    const abs = pathOf(path, "stat");
    if (abs === this.#statusPath) return this.#fileStat(abs, jsonBytes(this.#status), {}, 0o444);
    if (this.#directories.has(abs)) {
      return dirStat({
        mtime: nowValue(this.#clock),
        mode: 0o755,
        driver: "memory-connector",
        resource: { source: this.#source, kind: "directory" },
      });
    }
    const file = this.#files.get(abs);
    if (!file) fail("ENOENT", "no such external resource", abs, "stat");
    return this.#fileStat(abs, file.bytes, file.metadata, file.mode, file.mtime, file.readonly);
  }

  async list(path) {
    const abs = pathOf(path, "list");
    if (!this.#directories.has(abs)) {
      if (this.#files.has(abs)) fail("ENOTDIR", "not a directory", abs, "list");
      fail("ENOENT", "no such external resource", abs, "list");
    }
    const prefix = abs === "/" ? "/" : `${abs}/`;
    const names = new Set();
    for (const path of [...this.#directories, ...this.#files.keys(), this.#statusPath]) {
      if (!path.startsWith(prefix) || path === abs) continue;
      const rest = path.slice(prefix.length);
      const name = rest.split("/")[0];
      if (name) names.add(name);
    }
    const result = [];
    for (const name of [...names].sort((a, b) => a.localeCompare(b))) {
      const child = normalize(`${prefix}${name}`);
      result.push(entry(name, await this.stat(child)));
    }
    return result;
  }

  async read(path, { encoding = "utf8" } = {}) {
    const abs = pathOf(path, "read");
    const bytes = abs === this.#statusPath
      ? jsonBytes(this.#status)
      : this.#files.get(abs)?.bytes;
    if (!bytes) {
      if (this.#directories.has(abs)) fail("EISDIR", "is a directory", abs, "read");
      fail("ENOENT", "no such external resource", abs, "read");
    }
    const copy = new Uint8Array(bytes);
    if (encoding === "binary") return copy;
    if (encoding !== "utf8") fail("EINVAL", `unsupported encoding: ${encoding}`, abs, "read");
    try {
      return decoder.decode(copy);
    } catch {
      fail("EILSEQ", "external resource is not valid UTF-8", abs, "read");
    }
  }

  async write(path, value, options = {}) {
    const abs = pathOf(path, "write");
    if (abs === this.#statusPath) {
      fail("EACCES", "connector status is read-only", abs, "write");
    }
    if (this.#directories.has(abs)) fail("EISDIR", "is a directory", abs, "write");
    const current = this.#files.get(abs);
    if (!current && options.create !== true) {
      fail("ENOENT", "no such external resource", abs, "write");
    }
    if (current?.readonly) fail("EACCES", "external resource is read-only", abs, "write");
    if (options.append) fail("ENOTSUP", "external connector does not support append", abs, "write");
    if (options.revision !== undefined) {
      const actual = current ? await revisionOf(current.bytes) : null;
      if (actual !== options.revision) {
        fail("ESTALE", `external resource revision mismatch: expected ${options.revision}, got ${actual ?? "missing"}`, abs, "write");
      }
    }

    const bytes = copyBytes(value);
    const next = {
      bytes,
      metadata: publicMetadata(current?.metadata),
      readonly: current?.readonly ?? false,
      mode: current?.mode ?? 0o644,
      mtime: nowValue(this.#clock),
    };
    this.#files.set(abs, next);
    this.#addDirectories(abs);
    const revision = await revisionOf(bytes);
    this.#emit({
      kind: current ? "write" : "create",
      path: abs,
      source: this.#source,
      at: new Date(next.mtime).toISOString(),
      revision,
    });
    return { bytes: bytes.byteLength, revision };
  }

  /**
   * Watch a path and its descendants. The returned object is an AsyncIterable, so callers
   * can stop it with `return()` or an AbortSignal without a connector-specific callback API.
   *
   * The queue is bounded because connector writes are synchronous from the watcher's point
   * of view. Overflow rejects the pending/future `next()` calls with EOVERFLOW instead of
   * silently dropping remote changes. Abort rejects pending and future reads, matching the
   * observer watch contract; `return()` remains a normal clean close.
   */
  watch(path, { signal = null, includeInitial = false, maxQueue = 256 } = {}) {
    const target = pathOf(path, "watch");
    if (!Number.isSafeInteger(maxQueue) || maxQueue < 1) {
      throw new TypeError("watch maxQueue must be a positive safe integer");
    }
    const queue = [];
    const waiters = [];
    let closed = false;
    let closeError = null;
    let abortListener;

    const abortReason = () => {
      if (signal?.reason instanceof Error) return signal.reason;
      const error = new Error("connector watch cancelled");
      error.name = "AbortError";
      error.code = "ABORT_ERR";
      return error;
    };
    const cleanup = () => {
      this.#watchers.delete(onChange);
      signal?.removeEventListener("abort", abortListener);
    };
    const close = (error = null) => {
      if (closed) return;
      closed = true;
      closeError = error;
      queue.length = 0;
      cleanup();
      while (waiters.length) {
        const waiter = waiters.shift();
        if (error) waiter.reject(error);
        else waiter.resolve({ value: undefined, done: true });
      }
    };
    const enqueue = (change) => {
      if (closed || !isUnder(target, change.path)) return;
      if (waiters.length) {
        waiters.shift().resolve({ value: clone(change), done: false });
        return;
      }
      if (queue.length >= maxQueue) {
        const error = new Error(`connector watch queue exceeded maxQueue (${maxQueue})`);
        error.code = "EOVERFLOW";
        close(error);
        return;
      }
      queue.push(clone(change));
    };
    const onChange = (change) => enqueue(change);

    if (signal?.aborted) {
      close(abortReason());
    } else {
      this.#watchers.add(onChange);
      abortListener = () => close(abortReason());
      signal?.addEventListener("abort", abortListener, { once: true });
      if (includeInitial) enqueue({
        kind: "snapshot",
        path: target,
        source: this.#source,
        at: new Date(nowValue(this.#clock)).toISOString(),
      });
    }

    return {
      next: () => {
        if (closeError) return Promise.reject(closeError);
        if (queue.length) return Promise.resolve({ value: queue.shift(), done: false });
        if (closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve, reject) => { waiters.push({ resolve, reject }); });
      },
      return: async () => { close(); return { value: undefined, done: true }; },
      throw: async (reason) => { close(reason instanceof Error ? reason : new Error(String(reason))); throw reason; },
      [Symbol.asyncIterator]() { return this; },
    };
  }

  #addDirectories(path) {
    let cursor = path;
    while (cursor !== "/") {
      const slash = cursor.lastIndexOf("/");
      cursor = slash <= 0 ? "/" : cursor.slice(0, slash);
      this.#directories.add(cursor);
    }
  }

  async #fileStat(path, bytes, metadata, mode, mtime = nowValue(this.#clock), readonly = false) {
    return fileStat({
      size: bytes.byteLength,
      mtime,
      mode,
      appendable: false,
      driver: "memory-connector",
      revision: await revisionOf(bytes),
      resource: {
        source: this.#source,
        readonly,
        ...publicMetadata(metadata),
      },
    });
  }

  #emit(change) {
    for (const watcher of this.#watchers) {
      try { watcher(change); } catch { /* an observer cannot break the connector */ }
    }
  }
}

export function createInMemoryConnector(options = {}) {
  return new InMemoryConnector(options);
}
