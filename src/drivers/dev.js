// dev.js — /dev. the four nodes every system has, plus the terminal.
//
// these are real devices in the sense this runtime means it: `stat` reports `device: true`,
// which is what makes byte-oriented operations refuse them rather than guess. `/dev/null`
// is the exception that proves the rule — it *is* a byte sink, so it declares itself
// appendable and takes everything.
//
// note what is deliberately absent: there is no /dev/stdin, /dev/stdout, /dev/fd/… yet.
// they would be trivial, but they belong to a story about process descriptors that this
// runtime has not told — and inventing them half-way is how a namespace grows facts
// nobody can rely on.

import { VfsError } from "../kernel/errors.js";
import { defineDriver, dirStat, fileStat, deviceStat, entry, toBytes } from "../kernel/driver.js";

const NODES = {
  null: "discards everything written; reads as empty",
  zero: "reads as an endless run of zero bytes; discards writes",
  random: "reads as random bytes",
  urandom: "reads as random bytes (same as random here — there is no entropy pool to exhaust)",
  tty: "the terminal: writing prints, reading waits for a line",
};

export default defineDriver({
  name: "dev",
  description: "/dev — null, zero, random, tty",

  async mount() {
    const io = {
      write: (s) => process.stdout.write(s),
      error: (s) => process.stderr.write(s),
      readLine: null, // filled in by the shell; a driver cannot own the terminal
    };

    return {
      // the shell installs its own line reader here, so /dev/tty reads the same line
      // editor the prompt uses rather than fighting it for stdin
      setIO(next) {
        Object.assign(io, next);
      },

      async stat(rel) {
        if (rel === "") return dirStat();
        if (!(rel in NODES)) {
          throw new VfsError("ENOENT", "no such device", { path: "/dev/" + rel });
        }
        if (rel === "null") {
          // the one device that is honest to treat as bytes
          return fileStat({ device: false, appendable: true, size: 0 });
        }
        return deviceStat({ size: null, description: NODES[rel] });
      },

      async list(rel) {
        if (rel !== "") throw new VfsError("ENOTDIR", "not a directory", { path: "/dev/" + rel });
        return [
          entry("null", fileStat({ device: false, appendable: true, size: 0 })),
          entry("zero", deviceStat()),
          entry("random", deviceStat()),
          entry("urandom", deviceStat()),
          entry("tty", deviceStat()),
        ];
      },

      async read(rel, _ctx, opts = {}) {
        if (rel === "null") return "";
        if (rel === "zero") return new Uint8Array(opts.maxBytes ?? 0);
        if (rel === "random" || rel === "urandom") {
          // the default is small on purpose: an unbounded read of /dev/random into a
          // namespace whose whole point is bounded capabilities would be a small joke at
          // the caller's expense
          const n = Math.min(opts.maxBytes ?? 32, 1 << 20);
          return crypto.getRandomValues(new Uint8Array(n));
        }
        if (rel === "tty") {
          if (!io.readLine) {
            throw new VfsError("ENODEV", "there is no terminal here", {
              path: "/dev/tty",
              hint: "mount no terminal — this process is not attached to one",
            });
          }
          return await io.readLine();
        }
        throw new VfsError("ENOENT", "no such device", { path: "/dev/" + rel });
      },

      async write(rel, data) {
        if (rel === "null" || rel === "zero") return { bytes: null };
        if (rel === "random" || rel === "urandom") return { bytes: null };
        if (rel === "tty") {
          const text = typeof data === "string" ? data : new TextDecoder().decode(toBytes(data));
          io.write(text);
          return { bytes: text.length };
        }
        throw new VfsError("ENOENT", "no such device", { path: "/dev/" + rel });
      },
    };
  },
});
