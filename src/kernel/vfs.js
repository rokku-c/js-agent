// vfs.js — the kernel. mount table, path resolution, syscall dispatch.
//
// this file knows nothing about agents, models, or shells. it knows mount points, and it
// knows the driver interface in driver.js. everything the runtime can reach, it reaches
// through here — which is the whole design in one sentence: an agent whose namespace has
// no /dev/net cannot reach a network, because there is no path from this file to a socket.

import { VfsError } from "./errors.js";
import { normalize, relativeTo, join } from "./paths.js";
import { loadDriver } from "./registry.js";
import { validateInvokeOptions } from "./invoke-options.js";

const REDACTED = "[redacted]";
const SENSITIVE_MOUNT_OPTIONS = new Set([
  "token",
  "values",
  "password",
  "secret",
  "credential",
  "authorization",
  "api-key",
  "api_key",
  "apikey",
]);

function publicMountOptions(options) {
  return Object.fromEntries(Object.entries(options).map(([key, value]) => [
    key, SENSITIVE_MOUNT_OPTIONS.has(key.toLowerCase()) ? REDACTED : value,
  ]));
}

/** the options a driver gets beyond its own mount options. `vfs` is here so a driver can
 *  reach *another* mount — which is how the model driver reaches the network, and how a
 *  credential mounted as a file is read. a driver that reaches around this is reaching
 *  outside the namespace, and there is no API for that on purpose. */
function makeContext(vfs, entry, extra = {}) {
  return {
    vfs,
    at: entry.at,
    options: entry.options,
    log: extra.log ?? vfs.log,
    signal: extra.signal ?? null,
  };
}

export class Vfs {
  /** @type {Array<{at: string, driver: any, instance: any, options: object}>} */
  #mounts = [];
  /** @type {Array<(ev: {kind: string, at: string, driver: string}) => void>} */
  #watchers = [];
  #mounting = new Set();
  #canMount;

  constructor({ log, allowMount = true } = {}) {
    this.log = log ?? (() => {});
    this.#canMount = allowMount;
  }

  // ── the mount table ────────────────────────────────────────────────────────────

  /**
   * @param {string} driverName  a name the registry knows ('mem', 'hostfs', 'net', …)
   * @param {string} at          where in the namespace it appears
   * @param {object} [options]   driver-specific; see each driver's own header
   */
  async mount(driverName, at, options = {}) {
    if (!this.#canMount) {
      throw new VfsError("EACCES", "this namespace cannot add mounts", {
        path: normalize(at),
        operation: "mount",
      });
    }
    const where = normalize(at);
    if (this.#mounts.some((m) => m.at === where) || this.#mounting.has(where)) {
      throw new VfsError("EBUSY", `something is already mounted at ${where}`, {
        path: where,
        operation: "mount",
        hint: `umount ${where} first`,
      });
    }

    // Reserve the mount point before either await below. Otherwise two concurrent mounts
    // can both pass the duplicate check and leave two authorities at the same path.
    this.#mounting.add(where);
    try {
    // the registry is the only place a driver module is loaded, and it loads on demand.
    // that is what makes "the network is not reachable unless mounted" a structural fact
    // rather than a promise: nothing imports the net driver until someone mounts it.
    const driver = await loadDriver(driverName);

    const entry = {
      at: where,
      driver: driver.name,
      options: { ...options },
      instance: null,
    };
    entry.instance = await driver.mount(entry.options, makeContext(this, entry));

    // longest mount point first, so resolution is a linear scan that cannot pick a
    // shorter prefix. a mount at /a and one at /a/b both work; /a/b wins for /a/b/c.
    this.#mounts.push(entry);
    this.#mounts.sort((a, b) => b.at.length - a.at.length);
    this.#notify("mount", entry);
    return entry;
    } finally {
      this.#mounting.delete(where);
    }
  }

  async umount(at) {
    if (!this.#canMount) {
      throw new VfsError("EACCES", "this namespace cannot remove mounts", {
        path: normalize(at),
        operation: "umount",
      });
    }
    const where = normalize(at);
    const i = this.#mounts.findIndex((m) => m.at === where);
    if (i < 0) {
      throw new VfsError("ENOENT", `nothing is mounted at ${where}`, {
        path: where,
        operation: "umount",
      });
    }
    const [entry] = this.#mounts.splice(i, 1);
    await entry.instance.unmount?.();
    this.#notify("umount", entry);
  }

  /** the table, as data. `/proc/mounts` reads this, and so does everything that has to
   *  decide what a subagent gets. */
  mounts() {
    return this.#mounts.map((m) => ({
      at: m.at,
      driver: m.driver,
      options: publicMountOptions(m.options),
    }));
  }

  /** is something *mounted* exactly here?
   *
   *  the difference matters more than it looks: `/agent` can exist as an ordinary directory
   *  in whatever filesystem is mounted at `/`, at which point a session store "works" and
   *  quietly keeps everything in memory. asking the mount table is the only way to tell the
   *  two apart, and the callers that need persistence must ask.
   */
  isMountPoint(path) {
    const abs = normalize(path);
    return this.#mounts.some((m) => m.at === abs);
  }

  get(driverName) {
    return this.#mounts.filter((m) => m.driver === driverName).map((m) => m.at);
  }

  /** Capabilities declared by the resource mounted at a path. The path need not exist. */
  capabilities(path) {
    return { ...(this.resolve(path).mount.instance.capabilities ?? {}) };
  }

  onMount(fn) {
    this.#watchers.push(fn);
    return () => {
      this.#watchers = this.#watchers.filter((f) => f !== fn);
    };
  }

  #notify(kind, entry) {
    for (const fn of this.#watchers) {
      try {
        fn({ kind, at: entry.at, driver: entry.driver });
      } catch {
        // a watcher that throws is a watcher's problem; it must not fail the mount
      }
    }
  }

  // ── a narrowed view, for a subagent ────────────────────────────────────────────
  //
  // a subagent gets the *same* driver instances (so /host is the same /host and a write
  // is visible to the parent) but a filtered mount list. capability narrowing stops
  // being a convention enforced by an environment variable and becomes the same
  // mechanism that gave the parent its filesystem.

  /** keep only the mounts under these prefixes. `["/host"]` gives a child the host
   *  filesystem and nothing else — no /bin, no /dev/providers, no /agent. */
  narrow(keep) {
    const view = new Vfs({ log: this.log, allowMount: false });
    view.#mounts = this.#mounts
      .filter((m) => keep.some((k) => m.at === normalize(k) || m.at.startsWith(normalize(k) + "/")))
      .map((m) => ({ ...m, options: { ...m.options } }));
    return view;
  }

  /** a serialisable description of the table. it is what crosses a process boundary —
   *  into a subagent's bookkeeping, and into a worker, which rebuilds the same view
   *  rather than being handed live objects it cannot see. */
  spec() {
    return this.mounts();
  }

  // ── resolution ─────────────────────────────────────────────────────────────────

  /** the mount a path lands in, and the path *relative to that mount's root*.
   *  `rel === ""` means the caller asked for the mount point itself. */
  resolve(path) {
    const abs = normalize(path);
    for (const m of this.#mounts) {
      if (abs === m.at || abs.startsWith(m.at === "/" ? "/" : m.at + "/")) {
        return { mount: m, rel: relativeTo(m.at, abs), abs };
      }
    }
    throw new VfsError("ENOENT", "nothing is mounted here", {
      path: abs,
      operation: "resolve",
      hint:
        this.#mounts.length === 0
          ? "the namespace is empty — mount something first"
          : `mounted here: ${this.#mounts.map((m) => m.at).join(", ")}`,
    });
  }

  #ctx(res, extra) {
    return makeContext(this, res.mount, extra);
  }

  // ── syscalls ───────────────────────────────────────────────────────────────────
  //
  // every one of these takes an absolute namespace path and hands the driver a relative
  // one. every failure is re-absolutised on the way out, so a caller never sees a
  // driver's internal idea of where it was.

  /**
   * Is this path a strict ancestor of a mount — i.e. a directory that exists only because
   * something is mounted below it?
   *
   * `mount ai:/dev/providers/ai` puts a tree under a path that, until that moment, did not
   * exist: /dev is a driver that has never heard of `providers`, and the mount table is the
   * only thing that knows. a real kernel makes you create the mountpoint first; this one
   * synthesises it, because a namespace where `ls /dev` shows `providers` and
   * `ls /dev/providers` says "no such device" is a namespace that lies.
   */
  #isMountAncestor(abs) {
    const stem = abs === "/" ? "/" : abs + "/";
    return this.#mounts.some((m) => m.at.startsWith(stem));
  }

  async stat(path) {
    const res = this.resolve(path);
    try {
      return await res.mount.instance.stat(res.rel, this.#ctx(res));
    } catch (e) {
      if (this.#isMountAncestor(res.abs)) {
        return {
          type: "dir",
          size: null,
          mtime: Date.now(),
          mode: 0o755,
          device: false,
          callable: false,
          appendable: false,
          target: null,
          mountpoint: false,
          driver: null,
          synthetic: true,
        };
      }
      throw rethrow(e, res.abs, "stat");
    }
  }

  /** `stat` that answers null instead of throwing — for the many places that are asking
   *  a question ("is there something here?") rather than making a demand. */
  async exists(path) {
    try {
      await this.stat(path);
      return true;
    } catch (e) {
      if (e instanceof VfsError && (e.code === "ENOENT" || e.code === "ENOTDIR")) return false;
      throw e;
    }
  }

  async list(path) {
    const res = this.resolve(path);
    const st = await this.stat(res.abs);
    if (st.type !== "dir") {
      throw new VfsError("ENOTDIR", "not a directory", { path: res.abs, operation: "list" });
    }
    let entries;
    try {
      entries = await res.mount.instance.list(res.rel, this.#ctx(res));
    } catch (e) {
      // a path that exists only because something is mounted below it has no driver of
      // its own to ask — its contents are the mount points, and nothing else
      if (this.#isMountAncestor(res.abs)) {
        entries = [];
      } else {
        throw rethrow(e, res.abs, "list");
      }
    }

    // ── mount points are synthesised into the listing ──
    // /dev/net is mounted somewhere else entirely, so the driver behind /dev has no idea it
    // exists — and `ls /dev` would omit it. every real kernel merges mount points into the
    // parent listing, and so does this one: what `ls` shows is what is *there*, not what one
    // driver happens to remember putting there.
    //
    // and it is the *first segment below this directory* that goes in, not the mount point
    // itself. a mount at /dev/providers/ai has to appear in `ls /dev` as `providers`, which
    // is a directory that exists nowhere — the mount table is the only thing that knows it
    // does. without this, `ls /dev` omits the one thing there is to find.
    const here = res.abs === "/" ? "" : res.abs;
    const seen = new Set(entries.map((e) => e.name));
    for (const m of this.#mounts) {
      if (m.at === res.abs) continue;
      const prefix = here === "" ? "/" : here + "/";
      if (!m.at.startsWith(prefix)) continue;
      const name = m.at.slice(prefix.length).split("/")[0];
      if (!name || seen.has(name)) continue;
      seen.add(name);
      const isDirect = m.at.slice(prefix.length) === name;
      entries.push({
        name,
        ...(isDirect ? mountPointStat(m) : syntheticDirStat()),
      });
    }

    return [...entries].sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * @param {string} path
   * @param {{encoding?: 'utf8'|'binary', maxBytes?: number}} [opts]
   */
  async read(path, opts = {}) {
    const res = this.resolve(path);
    const st = await this.stat(res.abs);
    if (st.type === "dir") {
      throw new VfsError("EISDIR", "is a directory", { path: res.abs, operation: "read" });
    }
    let data;
    try {
      data = await res.mount.instance.read(res.rel, this.#ctx(res), opts);
    } catch (e) {
      throw rethrow(e, res.abs, "read");
    }
    const encoding = opts.encoding ?? "utf8";
    if (encoding === "binary") {
      return typeof data === "string" ? new TextEncoder().encode(data) : data;
    }
    return typeof data === "string" ? data : new TextDecoder().decode(data);
  }

  /** Invoke a callable resource exactly once. The driver receives the caller signal through
   * its scoped context and owns any external-effect journal. `invoke` is deliberately kept
   * separate from `write`: a request device may accept structured input without pretending it
   * is a file mutation, and a timeout after dispatch must remain the driver's `unknown`
   * outcome rather than becoming a successful write. */
  async invoke(path, input, opts = {}) {
    validateInvokeOptions(opts);
    const res = this.resolve(path);
    const inst = res.mount.instance;
    let stat;
    try {
      stat = await inst.stat(res.rel, this.#ctx(res));
    } catch (e) {
      throw rethrow(e, res.abs, "invoke");
    }
    if (!stat?.callable) {
      throw new VfsError("ENOTSUP", "resource is not callable", {
        path: res.abs,
        operation: "invoke",
        hint: "invoke a resource whose stat reports callable=true",
      });
    }
    if (typeof inst.invoke !== "function") {
      throw new VfsError("ENOTSUP", "this resource has no invoke operation", {
        path: res.abs,
        operation: "invoke",
      });
    }
    if (opts.signal?.aborted) {
      const error = opts.signal.reason instanceof Error
        ? opts.signal.reason
        : new VfsError("ABORT_ERR", "resource invocation cancelled", { path: res.abs, operation: "invoke" });
      if (!error.code) error.code = "ABORT_ERR";
      throw error;
    }
    try {
      return await inst.invoke(res.rel, input, this.#ctx(res, { signal: opts.signal ?? null }), opts);
    } catch (e) {
      throw rethrow(e, res.abs, "invoke");
    }
  }

  /**
   * @param {string} path
   * @param {string|Uint8Array|object} data
   * @param {{create?: boolean, append?: boolean}} [opts]
   * @returns {Promise<{bytes: number|null, value?: any}>} `value` is a device's reply —
   *   present only when writing to something `stat` reported as `callable`.
   */
  async write(path, data, opts = {}) {
    const res = this.resolve(path);
    let st = null;
    try {
      st = await this.stat(res.abs);
    } catch (e) {
      if (!(e instanceof VfsError && e.code === "ENOENT")) throw e;
      if (!opts.create) {
        throw new VfsError("ENOENT", "file not found", {
          path: res.abs,
          operation: "write",
          hint: "pass create=true to make a new one — a mistyped path must not silently produce a file",
        });
      }
    }

    if (st?.type === "dir") {
      throw new VfsError("EISDIR", "is a directory", { path: res.abs, operation: "write" });
    }
    // a device that cannot be appended to is not a device whose `>>` quietly means `>`.
    // `>>` on a request channel is a mistake, and saying so is cheaper than guessing.
    if (opts.append && st && st.appendable === false) {
      throw new VfsError("EINVAL", `${st.type} does not support append`, {
        path: res.abs,
        operation: "write",
        hint: "use `>` — a device call is a transaction, not a stream of bytes",
      });
    }

    try {
      const r = await res.mount.instance.write(res.rel, data, this.#ctx(res), opts);
      // a driver may return a byte count (a file) or a reply (a device). normalise the
      // former so callers can rely on `.bytes`; leave the latter's `value` intact.
      if (r == null) return { bytes: null, value: undefined };
      if (typeof r === "number") return { bytes: r, value: undefined };
      if (typeof r === "object" && "bytes" in r) return r;
      return { bytes: null, value: r };
    } catch (e) {
      throw rethrow(e, res.abs, "write");
    }
  }

  async mkdir(path, opts = {}) {
    const res = this.resolve(path);
    const inst = res.mount.instance;
    if (typeof inst.mkdir !== "function") {
      throw new VfsError("ENOTSUP", "this filesystem cannot create directories", {
        path: res.abs,
        operation: "mkdir",
      });
    }
    try {
      return await inst.mkdir(res.rel, this.#ctx(res), opts);
    } catch (e) {
      throw rethrow(e, res.abs, "mkdir");
    }
  }

  /** mkdir -p */
  async mkdirp(path) {
    const abs = normalize(path);
    if (abs === "/") return;
    const parts = abs.slice(1).split("/");
    let cur = "";
    for (const seg of parts) {
      cur += "/" + seg;
      if (await this.exists(cur)) continue;
      try {
        await this.mkdir(cur);
      } catch (error) {
        // Another writer may have created this ancestor between exists() and mkdir().
        // mkdirp is idempotent; the leaf reservation still uses exclusive mkdir.
        if (error?.code !== "EEXIST" || !(await this.exists(cur))) throw error;
      }
    }
  }

  async sync(path) {
    const res = this.resolve(path);
    if (typeof res.mount.instance.sync !== "function") {
      throw new VfsError("ENOTSUP", "this filesystem cannot flush changes", {
        path: res.abs,
        operation: "sync",
      });
    }
    try {
      return await res.mount.instance.sync(res.rel, this.#ctx(res));
    } catch (e) {
      throw rethrow(e, res.abs, "sync");
    }
  }

  async remove(path, opts = {}) {
    const res = this.resolve(path);
    const inst = res.mount.instance;
    if (typeof inst.remove !== "function") {
      throw new VfsError("ENOTSUP", "this filesystem is read-only", {
        path: res.abs,
        operation: "remove",
      });
    }
    try {
      return await inst.remove(res.rel, this.#ctx(res), opts);
    } catch (e) {
      throw rethrow(e, res.abs, "remove");
    }
  }

  async rename(from, to) {
    const a = this.resolve(from);
    const b = this.resolve(to);
    if (a.mount !== b.mount) {
      throw new VfsError("EINVAL", "cannot rename across mounts", {
        path: `${a.abs} → ${b.abs}`,
        operation: "rename",
        hint: "read it and write it instead",
      });
    }
    const inst = a.mount.instance;
    if (typeof inst.rename !== "function") {
      throw new VfsError("ENOTSUP", "this filesystem cannot rename", {
        path: a.abs,
        operation: "rename",
      });
    }
    try {
      return await inst.rename(a.rel, b.rel, this.#ctx(a));
    } catch (e) {
      throw rethrow(e, a.abs, "rename");
    }
  }

  /** open a node for a conversation rather than a byte transfer. only devices implement
   *  it; everything else is a file and has no handle worth holding. */
  async open(path, flags = "r") {
    const res = this.resolve(path);
    const inst = res.mount.instance;
    if (typeof inst.open !== "function") {
      throw new VfsError("ENOTSUP", "nothing to open here — this node is a plain file", {
        path: res.abs,
        operation: "open",
        hint: "use read() or write()",
      });
    }
    try {
      return await inst.open(res.rel, flags, this.#ctx(res));
    } catch (e) {
      throw rethrow(e, res.abs, "open");
    }
  }

  /** resolve a path relative to a working directory — sugar the shell and tools share. */
  abs(input, cwd = "/") {
    const p = String(input ?? "");
    if (p.startsWith("/")) return normalize(p);
    return normalize(join(cwd, p));
  }
}

/** keep the driver's error, but always replace the path with the namespace path the
 *  caller asked for.
 *
 *  A driver sees paths relative to its own mount root, so `/tmp/a.txt` reaches the driver
 *  behind /tmp as `a.txt` — and an error carrying that would name a path that exists
 *  nowhere the caller can look. the driver's `detail` still says what it meant; the `path`
 *  is the kernel's to state. */
function rethrow(e, abs, op) {
  if (!(e instanceof VfsError)) return e;
  return e.at(abs);
}

/** a directory that exists only because a mount lives below it. */
function syntheticDirStat() {
  return {
    type: "dir",
    size: null,
    mtime: Date.now(),
    mode: 0o755,
    device: false,
    callable: false,
    appendable: false,
    target: null,
    mountpoint: false,
    synthetic: true,
  };
}

/** a mount point appears in its parent's listing as a directory, whatever lives under it. */
function mountPointStat(m) {
  return {
    type: "dir",
    size: null,
    mtime: Date.now(),
    mode: 0o755,
    device: false,
    callable: false,
    appendable: false,
    target: null,
    mountpoint: true,
    driver: m.driver,
  };
}
