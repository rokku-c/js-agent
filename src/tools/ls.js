// ls — list a directory.
//
// the listing is the namespace, mount points included: `ls /dev` shows `net` when
// something is mounted there even though the driver behind /dev has never heard of it.
// what a shell shows should be what is *there*, not what one driver remembers writing.

import { defineTool } from "../core/tools.js";

const human = (n) => {
  if (n == null) return "";
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
  return `${(n / 1024 / 1024).toFixed(1)}M`;
};

export default defineTool({
  name: "ls",
  description: "List a directory in the namespace. Shows mount points, which is how you find out what is reachable.",
  params: {
    path: { type: "string", positional: 0, default: ".", description: "directory to list" },
    long: { type: "boolean", flag: "long", description: "one entry per line, with type and size" },
  },

  async run({ vfs, cwd, input }) {
    const path = vfs.abs(input.path, cwd);
    const entries = await vfs.list(path);

    if (entries.length === 0) return "(empty directory)";

    if (input.long) {
      return entries
        .map((e) => {
          const kind = e.type === "dir" ? "d" : e.device ? "c" : "-";
          const size = e.type === "dir" ? "-" : human(e.size) || "?";
          const notes = [];
          if (e.mountpoint) notes.push(`mount (${e.driver})`);
          if (e.device) notes.push("device");
          if (e.callable) notes.push("callable");
          if (e.target) notes.push(`→ ${e.target}`);
          return `${kind} ${size.padStart(7)}  ${e.name}${notes.length ? "  " + notes.join(", ") : ""}`;
        })
        .join("\n");
    }

    return entries
      .map((e) => (e.type === "dir" ? e.name + "/" : e.name))
      .join("\n");
  },
});
