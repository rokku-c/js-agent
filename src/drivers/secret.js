// secret.js — a credential, as a file.
//
// ── why this is a mount and not an environment variable ──
// the process environment is the most ambient inheritance there is: every child gets it,
// nothing records that it was handed over, and a runtime that reads it for a token has no
// way to say what it can reach. making the credential a *file in the namespace* fixes all
// three at once — a subagent that is not given /dev/secrets cannot use the model even if it
// is given /dev/providers, because the token is not in the environment it inherited, it is
// behind a mount it was not handed.
//
// ── what is exposed ──
// only the names the mount lists. not the whole environment: `mount secret /dev/secrets
// env=ANTHROPIC_AUTH_TOKEN` publishes one file, named for the variable it came from, and
// nothing else in the environment becomes readable by the fact that this driver exists.

import { VfsError } from "../kernel/errors.js";
import { defineDriver, dirStat, fileStat, entry } from "../kernel/driver.js";

export default defineDriver({
  name: "secret",
  description: "credentials as readable files — options: env=A,B values=K=V file=<path>",

  async mount(options, ctx) {
    /** name → the value. built at mount time, from wherever the caller said. */
    const values = new Map();

    // from the process environment — the pragmatic path, and the one that has to be named
    for (const name of String(options.env ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)) {
      const v = process.env[name];
      if (v == null || v === "") {
        throw new VfsError("ENOENT", `the environment has no ${name}`, {
          operation: "mount",
          hint: `mount secret /dev/secrets env=${name} needs ${name} set in the process environment`,
        });
      }
      values.set(name, v);
    }

    // literal values — for a test, or a throwaway key that should not be in the environment
    for (const pair of String(options.values ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)) {
      const eq = pair.indexOf("=");
      if (eq < 0) {
        throw new VfsError("EINVAL", `values must be NAME=value pairs, got ${JSON.stringify(pair)}`);
      }
      values.set(pair.slice(0, eq), pair.slice(eq + 1));
    }

    // from a file *in the namespace* — which lets a credential come from another mount,
    // and is how a keyfile on a mounted disk becomes usable without ever entering the
    // process environment
    if (options.file) {
      const path = String(options.file);
      const raw = await ctx.vfs.read(path).catch((e) => {
        throw new VfsError("ENOENT", `cannot read ${path}: ${e.message}`, { operation: "mount" });
      });
      for (const line of String(raw).split("\n")) {
        const t = line.trim();
        if (!t || t.startsWith("#")) continue;
        const eq = t.indexOf("=");
        if (eq < 0) continue;
        values.set(t.slice(0, eq).trim(), t.slice(eq + 1).trim().replace(/^["']|["']$/g, ""));
      }
    }

    if (values.size === 0) {
      throw new VfsError("EINVAL", "nothing to expose", {
        operation: "mount",
        hint: "give it something: env=NAME, values=NAME=value, or file=<path>",
      });
    }

    const statOf = (name) =>
      fileStat({
        // the size is the one fact that would leak the secret's length, so it is not
        // reported. `auth: "set (48 chars)"` in the ai descriptor is deliberately a
        // separate, opt-in thing rather than something anything can read off the file.
        size: null,
        mode: 0o400,
        secret: true,
      });

    return {
      names: () => [...values.keys()],

      async stat(rel) {
        if (rel === "") return dirStat({ mode: 0o500 });
        if (!values.has(rel)) throw new VfsError("ENOENT", "no such secret", { path: "/" + rel });
        return statOf(rel);
      },

      async list(rel) {
        if (rel !== "") throw new VfsError("ENOTDIR", "not a directory", { path: "/" + rel });
        return [...values.keys()].map((n) => entry(n, statOf(n)));
      },

      async read(rel) {
        if (!values.has(rel)) throw new VfsError("ENOENT", "no such secret", { path: "/" + rel });
        return values.get(rel);
      },

      async write(rel) {
        throw new VfsError("EACCES", "secrets are read-only", {
          path: "/" + rel,
          operation: "write",
          hint: "re-mount with a different source to change one",
        });
      },
    };
  },
});
