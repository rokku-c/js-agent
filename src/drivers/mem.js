// mem.js — the root filesystem. a tmpfs: real files, real directories, gone with the
// process.
//
// this is what `/` is, and it is deliberately the only thing a booted namespace has at the
// top besides /dev, /proc and /bin — so `write /etc/passwd` fails ENOENT because nothing
// is mounted at /etc, rather than silently touching a host that was never offered.

import { VfsError } from "../kernel/errors.js";
import { defineDriver, dirStat, fileStat, entry, toBytes } from "../kernel/driver.js";
import { segments, basename } from "../kernel/paths.js";

const now = () => Date.now();

/** the parent's path, as a relative path — "" when the node sits at the mount root. */
const parentRel = (rel) => {
  const segs = segments(rel);
  segs.pop();
  return segs.join("/");
};

export default defineDriver({
  name: "mem",
  description: "an in-memory tree — the root filesystem; writable, dies with the process",

  async mount() {
    /** a node is a dir (children: Map) or a file (data: Uint8Array) */
    const mkdirNode = (mode = 0o755) => ({ type: "dir", children: new Map(), mtime: now(), mode });
    const mkfileNode = (data, mode = 0o644) => ({ type: "file", data, mtime: now(), mode });

    const root = mkdirNode();
    let totalBytes = 0;

    const at = (rel) => (rel === "" ? "/" : "/" + rel);

    /** walk to a node, or null if the path does not resolve. never creates. */
    const walk = (rel) => {
      const segs = segments(rel);
      let node = root;
      for (let i = 0; i < segs.length; i++) {
        if (node.type !== "dir") {
          throw new VfsError("ENOTDIR", "not a directory", {
            path: "/" + segs.slice(0, i).join("/"),
          });
        }
        node = node.children.get(segs[i]);
        if (!node) return null;
      }
      return node;
    };

    const needNode = (rel) => {
      const n = walk(rel);
      if (!n) throw new VfsError("ENOENT", "no such file or directory", { path: at(rel) });
      return n;
    };

    const needDir = (rel) => {
      const n = needNode(rel);
      if (n.type !== "dir") throw new VfsError("ENOTDIR", "not a directory", { path: at(rel) });
      return n;
    };

    const statOf = (node) =>
      node.type === "dir"
        ? dirStat({ mtime: node.mtime, mode: node.mode })
        : fileStat({ mtime: node.mtime, mode: node.mode, size: node.data.byteLength });

    return {
      capabilities: {
        durable: false,
        exclusiveMkdir: true,
        atomicRename: true,
        append: true,
        flush: false,
      },

      async stat(rel) {
        return statOf(needNode(rel));
      },

      async list(rel) {
        const dir = needDir(rel);
        return [...dir.children.entries()].map(([name, node]) => entry(name, statOf(node)));
      },

      async read(rel) {
        const node = needNode(rel);
        if (node.type === "dir") throw new VfsError("EISDIR", "is a directory", { path: at(rel) });
        return node.data;
      },

      async write(rel, data, _ctx, opts = {}) {
        // the parent has to exist: `write /a/b/c` where /a does not is a mistake worth
        // reporting, not a request to invent a directory tree
        const parent = needDir(parentRel(rel));
        const name = basename(rel);
        if (name === "/" || name === "") {
          throw new VfsError("EISDIR", "is a directory", { path: at(rel) });
        }
        const incoming = toBytes(data);
        const existing = parent.children.get(name);
        if (existing?.type === "dir") {
          throw new VfsError("EISDIR", "is a directory", { path: at(rel) });
        }

        // append concatenates. mem is a real filesystem and `>>` is a real operation —
        // ignoring the flag turns `echo more >> f` into a silent overwrite, which is the
        // kind of wrong that only shows up when someone reads the file back.
        if (opts.append && existing) {
          const joined = new Uint8Array(existing.data.byteLength + incoming.byteLength);
          joined.set(existing.data, 0);
          joined.set(incoming, existing.data.byteLength);
          existing.data = joined;
          existing.mtime = now();
          totalBytes += incoming.byteLength;
          return { bytes: incoming.byteLength };
        }

        if (existing) totalBytes -= existing.data.byteLength;
        parent.children.set(name, mkfileNode(incoming));
        totalBytes += incoming.byteLength;
        return { bytes: incoming.byteLength };
      },

      async mkdir(rel, _ctx, opts = {}) {
        if (rel === "") return;
        const parent = needDir(parentRel(rel));
        const name = basename(rel);
        if (parent.children.has(name)) {
          // An exclusive mkdir is the reservation primitive used by durable stores.
          if (opts.exclusive) throw new VfsError("EEXIST", "file exists", { path: at(rel) });
          // mkdir -p is the common case and mkdir -p is not an error on an existing dir
          if (parent.children.get(name).type === "dir") return;
          throw new VfsError("EEXIST", "file exists", { path: at(rel) });
        }
        parent.children.set(name, mkdirNode(opts.mode));
      },

      async sync() {
        // Memory has no crash boundary. This method exists only so tests can exercise the
        // durable protocol with an explicitly non-physical adapter.
      },

      async remove(rel, _ctx, opts = {}) {
        if (rel === "") throw new VfsError("EPERM", "cannot remove the root", { path: "/" });
        const parent = needDir(parentRel(rel));
        const name = basename(rel);
        const node = parent.children.get(name);
        if (!node) throw new VfsError("ENOENT", "no such file or directory", { path: at(rel) });
        if (node.type === "dir" && node.children.size > 0 && !opts.recursive) {
          throw new VfsError("ENOTEMPTY", "directory not empty", {
            path: at(rel),
            hint: "pass recursive=true",
          });
        }
        if (node.type === "file") totalBytes -= node.data.byteLength;
        parent.children.delete(name);
      },

      async rename(from, to) {
        const node = needNode(from);
        const src = needDir(parentRel(from));
        const dst = needDir(parentRel(to));
        src.children.delete(basename(from));
        dst.children.set(basename(to), node);
      },

      /** how much this filesystem is holding — read by `ps`, and by the tests. */
      usage() {
        return { bytes: totalBytes, mounts: 1 };
      },
    };
  },
});
