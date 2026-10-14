// js — run JavaScript against the namespace.
//
// ── the one tool that names the host ──
// nu-agent's rule, kept exactly: every other tool is named for what it does, and exactly one
// is named for the language it runs. a model writing JavaScript has to know it is writing
// JavaScript; nothing else needs to know that `read` was implemented in it.
//
// ── where it runs, and why that matters ──
// in a worker thread, against a **proxy** VFS. the script can read and write the namespace
// and cannot see the mount table, because the table is not in that process — it answers over
// a port. a script that spins forever is `terminate()`d in about 60ms, which is a stop a
// signal could not achieve.
//
// `vm` is used to give the script a clean set of globals. it is **not** a security boundary
// and this file does not claim it is: the boundary is the mount table, and the worker is the
// blast radius if something gets past the context.

import { defineTool } from "../core/tools.js";

/** the in-process path — the same evaluation, against the real VFS. used when isolation is
 *  switched off, which is for tests and for debugging a tool that will not behave. */
async function runInline({ vfs, cwd, input }) {
  const vm = await import("node:vm");
  const sandbox = {
    vfs,
    cwd,
    console: {
      log: (...a) => process.stdout.write(a.map(String).join(" ") + "\n"),
      error: (...a) => process.stderr.write(a.map(String).join(" ") + "\n"),
      warn: (...a) => process.stderr.write(a.map(String).join(" ") + "\n"),
    },
  };
  const context = vm.createContext(sandbox, { name: "js-tool" });
  const code = String(input.code).trim();
  let value;
  try {
    value = vm.runInContext(code, context, { filename: "<js>" });
  } catch (e) {
    if (e?.name !== "SyntaxError" || !/\b(await|using)\b/.test(e.message)) throw e;
    value = vm.runInContext(`(async () => { ${code} })()`, context, { filename: "<js>" });
  }
  return await value;
}

export default defineTool({
  name: "js",
  description:
    "Run JavaScript against the namespace and return the value of the last expression. " +
    "The namespace API is `vfs` (read, write, ls, stat, exists, mkdir, remove, mounts, open) " +
    "and `cwd` is the working directory. Top-level await works. This is the language the " +
    "runtime itself is written in, so anything the shell can do can be done from here.",
  params: {
    code: {
      type: "string",
      positional: 0,
      required: true,
      input: true,
      description: "the script; its last expression is the result",
    },
  },
  isolated: "worker",

  // reached only when isolation is off — the worker path never calls this
  run: runInline,
});
