// paths.js — one place that knows what a namespace path is
//
// Namespace paths are POSIX: always absolute, `/`-separated, no trailing slash, no `.`
// or `..` left unresolved. Drivers never see `.` or `..` — by the time a path reaches a
// driver it has been normalised and clamped to that driver's mount root, which is what
// makes a driver's `..` handling a non-question.

import { VfsError } from "./errors.js";

/** collapse `.`, resolve `..`, drop the trailing slash, force a leading one.
 *  `..` above the root is dropped rather than raising — the root has no parent, which
 *  is the same thing `/..` means to every kernel. */
export function normalize(p) {
  const raw = String(p ?? "");
  const out = [];
  for (const seg of raw.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return "/" + out.join("/");
}

export function join(...parts) {
  return normalize(parts.filter((x) => x != null && x !== "").join("/"));
}

/** the path as segments; `/` → `[]`, `/a/b` → `["a","b"]` */
export function split(p) {
  const n = normalize(p);
  return n === "/" ? [] : n.slice(1).split("/");
}

export function dirname(p) {
  const segs = split(p);
  segs.pop();
  return "/" + segs.join("/");
}

export function basename(p) {
  const segs = split(p);
  return segs.length ? segs[segs.length - 1] : "/";
}

/** is `child` inside `parent` (or equal to it)? segment-wise, so `/ab` is not under `/a`. */
export function isUnder(parent, child) {
  const a = split(parent);
  const b = split(child);
  if (a.length > b.length) return false;
  return a.every((seg, i) => seg === b[i]);
}

/** `child` expressed relative to `parent`; throws if it is not under it.
 *  returns "" when they are equal — the mount root, which is what a driver sees
 *  when the caller asked for the mount point itself. */
export function relativeTo(parent, child) {
  if (!isUnder(parent, child)) {
    throw new VfsError("EINVAL", "path is outside the mount root", {
      path: child,
      hint: `the mount is at ${parent}`,
    });
  }
  const a = split(parent);
  const b = split(child);
  return b.slice(a.length).join("/");
}

/** split a relative driver path into segments: "" → [], "a/b" → ["a","b"] */
export function segments(rel) {
  if (rel === "" || rel == null) return [];
  return String(rel).split("/").filter((s) => s !== "");
}

/** is this path absolute? a namespace path always is; anything else has to be
 *  resolved against the cwd before it means anything. */
export function isAbsolute(p) {
  return typeof p === "string" && p.startsWith("/");
}

/** expand a path the way a shell does, against a working directory.
 *  `~` is deliberately not supported: there is no home directory in the namespace
 *  unless someone mounts one, and inventing it would be exactly the kind of ambient
 *  fact this runtime refuses to have. */
export function resolvePath(input, cwd = "/") {
  const p = String(input ?? "");
  if (p === "") return normalize(cwd);
  if (isAbsolute(p)) return normalize(p);
  return normalize(join(cwd, p));
}

/** the shape the shell and error messages use when they want a short, human path. */
export function display(p) {
  return normalize(p);
}
