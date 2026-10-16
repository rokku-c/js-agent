// hostfs.js — the real filesystem, on purpose and by hand.
//
// ── why this is a mount and not the default ──
// if a runtime gets the host filesystem for free, then "nothing is ambient" is a slogan.
// the whole claim needs the host to be something you asked for, by name, with a root and
// a mode — which is also what makes `--mount hostfs:/host,source=.,mode=ro` a sentence
// someone can read and disagree with.
//
// ── the clamp ──
// every path is re-resolved through realpath and checked against the mount root before the
// operation runs, which is what stops `/host/../../../etc/passwd` *and* a symlink inside
// the mount that points out of it. on macOS /tmp is itself a symlink to /private/tmp, so
// the root's realpath is taken at mount time and compared against — otherwise every path
// under a legitimately-symlinked root would fail the check.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { VfsError } from "../kernel/errors.js";
import { defineDriver, dirStat, fileStat, entry, toBytes } from "../kernel/driver.js";
import { segments, basename } from "../kernel/paths.js";

const parentRel = (rel) => {
  const segs = segments(rel);
  segs.pop();
  return segs.join("/");
};

export default defineDriver({
  name: "hostfs",
  description: "the real filesystem; options: source=<dir> mode=ro|rw create=1",

  async mount(options) {
    const source = String(options.source ?? ".");
    const mode = String(options.mode ?? "ro").toLowerCase();
    const writable = mode === "rw";

    let root;
    try {
      root = await fs.realpath(path.resolve(source));
    } catch (e) {
      if (e.code !== "ENOENT" || !options.create) {
        throw new VfsError("ENOENT", `the source directory does not exist: ${path.resolve(source)}`, {
          path: String(source),
          operation: "mount",
          hint: "pass create=1 to make it, or point source= somewhere that exists",
        });
      }
      await fs.mkdir(path.resolve(source), { recursive: true });
      root = await fs.realpath(path.resolve(source));
    }

    const st = await fs.stat(root).catch(() => null);
    if (!st?.isDirectory()) {
      throw new VfsError("ENOTDIR", `the source is not a directory: ${root}`, {
        path: root,
        operation: "mount",
      });
    }

    const inside = (p) => p === root || p.startsWith(root + path.sep);

    /** the host path for a relative node path. */
    const host = (rel) => (rel === "" ? root : path.join(root, rel));

    /**
     * resolve a path for real and prove it is still under the root. for a path that does
     * not exist yet — a create — the *parent* is what has to be inside, because the thing
     * itself has no realpath to check.
     */
    const guard = async (rel, { forCreate = false } = {}) => {
      const p = host(rel);
      if (forCreate) {
        const parent = await fs.realpath(path.dirname(p)).catch(() => null);
        if (parent == null || !inside(parent)) {
          throw new VfsError("EACCES", "path escapes the mount root", {
            path: "/" + rel,
            operation: "write",
            hint: `this mount is rooted at ${root}`,
          });
        }
        const existing = await fs.realpath(p).catch(() => null);
        if (existing != null && !inside(existing)) {
          throw new VfsError("EACCES", "path escapes the mount root", {
            path: "/" + rel,
            operation: "write",
            hint: "a symlink here points outside the mount",
          });
        }
        return p;
      }
      const real = await fs.realpath(p).catch((e) => {
        if (e.code === "ENOENT") return null;
        throw e;
      });
      if (real == null) {
        throw new VfsError("ENOENT", "no such file or directory", { path: "/" + rel });
      }
      if (!inside(real)) {
        throw new VfsError("EACCES", "path escapes the mount root", {
          path: "/" + rel,
          operation: "resolve",
          hint:
            real !== p
              ? `a symlink resolves to ${real}, outside ${root}`
              : `this mount is rooted at ${root}`,
        });
      }
      return real;
    };

    const denyWrite = (rel, op) => {
      throw new VfsError("EACCES", "this mount is read-only", {
        path: "/" + rel,
        operation: op,
        hint: `mount hostfs again with mode=rw to allow writes (currently ${root})`,
      });
    };

    const statOf = (s) =>
      s.isDirectory()
        ? dirStat({ mtime: s.mtimeMs, mode: s.mode & 0o777 })
        : fileStat({
            mtime: s.mtimeMs,
            mode: s.mode & 0o777,
            size: s.size,
            // a symlink is reported as what it points at, with the target named, because
            // "it is a link" is only useful alongside "to where"
            target: null,
          });

    return {
      capabilities: {
        durable: true,
        exclusiveMkdir: true,
        atomicRename: true,
        append: true,
        flush: true,
      },

      async stat(rel) {
        const p = await guard(rel);
        const s = await fs.stat(p);
        return statOf(s);
      },

      async list(rel) {
        const p = await guard(rel);
        const names = await fs.readdir(p);
        const out = [];
        for (const name of names) {
          const s = await fs.lstat(path.join(p, name)).catch(() => null);
          if (!s) continue;
          if (s.isSymbolicLink()) {
            const real = await fs.realpath(path.join(p, name)).catch(() => null);
            out.push(
              entry(name, fileStat({ size: null, mode: 0o777, target: real ?? "(broken)" }))
            );
            continue;
          }
          out.push(entry(name, statOf(s)));
        }
        return out;
      },

      async read(rel) {
        const p = await guard(rel);
        const s = await fs.stat(p);
        if (s.isDirectory()) {
          throw new VfsError("EISDIR", "is a directory", { path: "/" + rel });
        }
        return await fs.readFile(p);
      },

      async write(rel, data, _ctx, opts = {}) {
        if (!writable) denyWrite(rel, "write");
        if (rel === "") throw new VfsError("EISDIR", "is a directory", { path: "/" });
        const p = await guard(rel, { forCreate: true });
        const flags = opts.append ? "a" : "w";
        await fs.writeFile(p, toBytes(data), { flag: flags });
        return { bytes: toBytes(data).byteLength };
      },

      async mkdir(rel, _ctx, opts = {}) {
        if (!writable) denyWrite(rel, "mkdir");
        if (rel === "") return;
        const p = await guard(rel, { forCreate: true }).catch(async () => host(rel));
        await fs.mkdir(p, { recursive: !!opts.recursive, mode: opts.mode });
      },

      async sync(rel) {
        const p = await guard(rel);
        const handle = await fs.open(p, "r");
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
      },

      async remove(rel, _ctx, opts = {}) {
        if (!writable) denyWrite(rel, "remove");
        if (rel === "") throw new VfsError("EPERM", "cannot remove the mount root", { path: "/" });
        const p = await guard(rel);
        await fs.rm(p, { recursive: !!opts.recursive, force: false });
      },

      async rename(from, to) {
        if (!writable) denyWrite(to, "rename");
        const a = await guard(from);
        const b = await guard(to, { forCreate: true });
        await fs.rename(a, b);
      },

      /** what this mount is, for /proc/mounts and for error messages. */
      rootPath: () => root,
    };
  },
});
