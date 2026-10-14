// bin.js — /bin. the tool catalog, as a mount.
//
// ── the tool set IS a mount ──
// nu-agent narrows what an agent can do with `--tools-from [read edit]`, and a subagent
// narrows further by naming fewer modules. here that is not a separate mechanism at all:
// /bin is mounted with the tools listed, and the agent is offered exactly the entries in
// its /bin. capability narrowing is the same operation as being given a filesystem.
//
// each entry reads as its own definition — `cat /bin/read` prints the schema the model is
// shown — which makes the one rule ("a file's name is its tool name") checkable by hand.
//
// /bin is a catalog, not a launcher: nothing is executed by writing to it. execution goes
// through core/execute.js, which is where the policy gate and the deadline live. a
// writable /bin would be a second way in that skips both.

import { VfsError } from "../kernel/errors.js";
import { defineDriver, dirStat, fileStat, entry } from "../kernel/driver.js";
import { loadTools, catalogEntry } from "../core/tools.js";

export default defineDriver({
  name: "bin",
  description: "/bin — the tool catalog; mount with tools=read,write,… to choose what exists",

  async mount(options) {
    const names = String(options.tools ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const tools = await loadTools(names);
    const byName = new Map(tools.map((t) => [t.name, t]));

    const json = (name) => JSON.stringify(catalogEntry(byName.get(name)), null, 2) + "\n";

    const statOf = (name) =>
      fileStat({
        size: json(name).length,
        // `executable` is informational: /bin tells you what exists and what it takes.
        // the bit that would let you *run* it lives in the executor, not here.
        executable: true,
        isolated: byName.get(name).isolated === false ? null : byName.get(name).isolated,
      });

    return {
      /** the loaded tools, so the runtime does not have to re-read the catalog it just
       *  built — /bin is the single source of truth for what exists. */
      tools: () => tools,
      has: (name) => byName.has(name),
      get: (name) => byName.get(name),

      async stat(rel) {
        if (rel === "") return dirStat();
        if (!byName.has(rel)) {
          throw new VfsError("ENOENT", "no such tool", {
            path: "/bin/" + rel,
            hint: byName.size ? `this namespace has: ${[...byName.keys()].join(", ")}` : "no tools are mounted",
          });
        }
        return statOf(rel);
      },

      async list(rel) {
        if (rel !== "") throw new VfsError("ENOTDIR", "not a directory", { path: "/bin/" + rel });
        return [...byName.keys()].sort().map((n) => entry(n, statOf(n)));
      },

      async read(rel) {
        if (!byName.has(rel)) {
          throw new VfsError("ENOENT", "no such tool", { path: "/bin/" + rel });
        }
        return json(rel);
      },

      async write(rel) {
        throw new VfsError("EACCES", "permission denied", {
          path: "/bin/" + rel,
          operation: "write",
          hint: "/bin is the catalog; a tool is run by asking the agent, and re-mounted by changing tools=",
        });
      },
    };
  },
});
