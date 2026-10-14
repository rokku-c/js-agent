// driver.js — the contract a driver implements, and the one place it is checked
//
// ── what a driver is ──
// a driver is everything that is *not* the kernel: it knows how to make a tree of paths
// out of something the process cannot otherwise see — the host filesystem, a network, a
// model, the process environment. the kernel knows none of those things. it knows mount
// points and it knows this interface.
//
// ── the shape ──
// a driver module exports a default object: a name, and `mount(options, ctx)` which
// returns an *instance*. an instance per mount, not a singleton, because the same driver
// mounted twice with different options has to be two different things (two hostfs mounts
// with different roots is the ordinary case).
//
//   export default defineDriver({
//     name: 'mem',
//     async mount(options, ctx) {
//       const tree = new Map()
//       return { stat, list, read, write, ... }   // paths are RELATIVE to the mount root
//     },
//   })
//
// ── paths a driver sees ──
// relative to its own mount root, no leading slash, `""` meaning the root itself, and
// never containing `.` or `..`. the kernel normalises and clamps before dispatch, so no
// driver needs to defend against a path escaping upward. that is deliberate: every
// driver would get it wrong slightly differently.

import { VfsError } from "./errors.js";

/** the operations a driver may implement. `stat`, `list` and `read` are the floor
 *  something must stand on to be a filesystem at all; the rest degrade honestly. */
const METHODS = ["stat", "list", "read", "write", "mkdir", "remove", "rename", "open", "unmount"];

/** mark a module as a driver, checking the contract at load time rather than at the
 *  first call. a driver missing `read` should fail when it is imported, not three
 *  commands later inside an agent run. */
export function defineDriver(spec) {
  if (!spec || typeof spec !== "object") {
    throw new TypeError("defineDriver: expected an object");
  }
  if (!spec.name || typeof spec.name !== "string") {
    throw new TypeError("defineDriver: a driver needs a name");
  }
  if (typeof spec.mount !== "function") {
    throw new TypeError(`defineDriver(${spec.name}): needs a mount(options, ctx) method`);
  }
  return {
    description: "",
    ...spec,
    /** the fully-declared set, so callers can ask without probing */
    methods: METHODS,
  };
}

/** the error a driver raises for an operation it does not implement. it names the
 *  operation and the path, because the alternative — `undefined is not a function` —
 *  tells whoever reads it nothing about what they asked for. */
export function unsupported(op, rel, why) {
  return new VfsError("ENOTSUP", `${op} is not supported here${why ? ` (${why})` : ""}`, {
    path: rel === "" ? "/" : `/${rel}`,
    operation: op,
  });
}

/** the shape every `stat` must return, with the fields a driver may omit filled in.
 *  normalising here rather than in the VFS keeps each driver from inventing its own
 *  idea of what "a file" reports. */
export function makeStat(type, fields = {}) {
  const base = {
    type,
    size: null,
    mtime: Date.now(),
    mode: type === "dir" ? 0o755 : 0o644,
    // `device` is the flag that makes byte-oriented operations refuse this node.
    // a device is a request/response channel wearing a path, and `>>` on it does not
    // mean what a reader of POSIX would assume, so it is rejected rather than guessed.
    device: false,
    callable: false,
    appendable: type === "file",
    target: null,
  };
  return { ...base, ...fields };
}

export const dirStat = (fields) => makeStat("dir", fields);
export const fileStat = (fields) => makeStat("file", fields);
export const deviceStat = (fields) =>
  makeStat("device", { device: true, callable: true, appendable: false, ...fields });

/** a directory entry is a stat plus a name; `list` returns these. */
export function entry(name, stat) {
  return { name, ...stat };
}

/** whatever a caller handed to `write` → bytes. a plain filesystem takes strings and
 *  bytes; an object is JSON, because a caller who passes an object to a file is asking
 *  for JSON and the alternative is `[object Object]` on disk. a *device* that wants the
 *  object itself should say so by overriding this — see the ai driver, where the request
 *  is a structure rather than text. */
export function toBytes(data) {
  if (data == null) return new Uint8Array();
  if (typeof data === "string") return new TextEncoder().encode(data);
  if (data instanceof Uint8Array) return data;
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new TextEncoder().encode(JSON.stringify(data, null, 2) + "\n");
}
