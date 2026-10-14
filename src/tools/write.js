// write — write a whole file.
//
// deliberately conservative: it will not create a file unless --create says so. a mistyped
// path that silently produces an empty file is a worse outcome than an error, because the
// error is the only thing that tells you the path was wrong.

import { defineTool } from "../core/tools.js";
import { VfsError } from "../kernel/errors.js";
import { countLines } from "../core/fileio.js";

export default defineTool({
  name: "write",
  description:
    "Write a whole file, replacing anything already there. Does not create a new file " +
    "unless create=true, so a mistyped path cannot quietly make an empty one. " +
    "To change part of a file, use edit. Writing to a device returns its reply.",
  params: {
    path: { type: "string", positional: 0, required: true, description: "path to write" },
    content: {
      type: "string",
      positional: 1,
      required: true,
      description: "the whole file contents",
      input: true,
    },
    create: {
      type: "boolean",
      flag: "create",
      description: "allow creating a file that does not exist yet",
    },
  },

  async run({ vfs, cwd, input }) {
    const path = vfs.abs(input.path, cwd);
    const existed = await vfs.exists(path);

    if (!existed && !input.create) {
      // if the parent is missing too, say that instead — it is the more actionable fact,
      // and "pass create=true" would not fix it
      const parent = path.slice(0, path.lastIndexOf("/")) || "/";
      if (!(await vfs.exists(parent))) {
        throw new VfsError("ENOENT", "the directory does not exist", {
          path: parent,
          operation: "write",
          hint: "mkdir it first, or mount something there",
        });
      }
      throw new VfsError("ENOENT", "file not found", {
        path,
        operation: "write",
        hint: "pass create=true to make a new one",
      });
    }

    const r = await vfs.write(path, input.content, { create: input.create });

    // ── a device answers, and the answer is the point ──
    // writing to /dev/providers/… is a request, and its return value is the model's reply.
    // reporting "overwrote 84 bytes" instead would be technically true and would throw away
    // the only thing the caller wanted — which is exactly the mistake this checks for: the
    // reply is a *value*, and a byte count means the write went to a file.
    if (r.value !== undefined) {
      return typeof r.value === "string" ? r.value : JSON.stringify(r.value, null, 2);
    }

    const bytes = r.bytes ?? new TextEncoder().encode(input.content).byteLength;
    const verb = existed ? "overwrote" : "created";
    return `${verb} ${path}, ${countLines(input.content)} lines, ${bytes} bytes`;
  },
});
