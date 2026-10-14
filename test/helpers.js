// helpers.js — booting a namespace inside a test.
//
// every suite gets its own kernel, its own mounts and its own shell. nothing is shared
// between tests, and nothing reaches outside the process except where a test says so —
// which is what makes "runs with no network" a property the suite can assert rather than
// something the reader has to take on faith.

import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs/promises";
import { Vfs } from "../src/kernel/vfs.js";
import { bootMounts } from "../src/kernel/mounts.js";
import { Shell } from "../src/shell/repl.js";

/**
 * @param {{tools?: string[], mounts?: (string|object)[], host?: string|null, state?: string|null}} opts
 */
export async function namespace({ tools = ["read", "write", "edit", "ls", "calc", "js", "shell"], mounts = [], host = null, state = null } = {}) {
  const vfs = new Vfs({ log: () => {} });
  const all = [...mounts];
  if (host) all.push({ driver: "hostfs", at: "/host", options: { source: host, mode: "ro" } });
  await bootMounts(vfs, { tools, mounts: all, state });
  return vfs;
}

/** a shell with its output captured, for asserting on what a line printed. */
export async function shellOf(opts) {
  const vfs = await namespace(opts);
  const out = [];
  const err = [];
  const shell = new Shell(vfs, {
    out: (s) => out.push(s),
    err: (s) => err.push(s),
  });
  return {
    vfs,
    shell,
    out: () => out.join(""),
    err: () => err.join(""),
    reset: () => {
      out.length = 0;
      err.length = 0;
    },
    /** run one line, returning what it printed and the value it produced */
    async run(line) {
      out.length = 0;
      err.length = 0;
      const r = await shell.execute(line);
      return { value: r.value, out: out.join(""), err: err.join("") };
    },
  };
}

/** a temp directory that cleans itself up. */
export async function tmpdir(prefix = "js-agent-test-") {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return {
    path: dir,
    async cleanup() {
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

/** a canonical response body, for scripting the fake dialect. */
export const says = (text) => ({ content: [{ type: "text", text }], stop_reason: "end_turn" });
export const calls = (name, input, id = "t1") => ({
  content: [{ type: "tool_use", id, name, input }],
  stop_reason: "tool_use",
});

/** the fake dialect, mounted with a script. the JSON is escaped for a mount spec. */
export function fakeScript(...turns) {
  return `ai:/dev/providers/ai,vendor=fake,script=${JSON.stringify(turns)}`;
}

export const SCRIPT = "read the file";
