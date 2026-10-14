// read — read a text file out of the namespace.
//
// text only, on purpose: a binary file read into a model's context is a page of U+FFFD
// that costs tokens and teaches nothing. the decoder is what decides, not the extension.

import { defineTool } from "../core/tools.js";
import { VfsError } from "../kernel/errors.js";
import { decodeText, window, clamp } from "../core/fileio.js";

export default defineTool({
  name: "read",
  description:
    "Read a text file from the namespace. Returns the contents, optionally a window of lines. " +
    "Binary files are refused rather than decoded into noise.",
  params: {
    path: {
      type: "string",
      positional: 0,
      required: true,
      description: "path to the file, absolute in the namespace or relative to the working directory",
    },
    offset: { type: "integer", flag: "offset", short: "o", default: 1, description: "first line to read (1-based)" },
    // no short form on `limit` or `numbers`: `-n` is the obvious candidate for both, and a
    // short name that means two things is worse than one that is simply absent
    limit: { type: "integer", flag: "limit", description: "how many lines to read" },
    numbers: { type: "boolean", flag: "numbers", description: "prefix each line with its line number" },
    maxBytes: {
      type: "integer",
      flag: "max-bytes",
      default: 200000,
      description: "refuse files larger than this",
    },
  },

  async run({ vfs, cwd, input }) {
    const path = vfs.abs(input.path, cwd);
    const st = await vfs.stat(path);

    if (st.type === "dir") {
      throw new VfsError("EISDIR", "is a directory", {
        path,
        operation: "read",
        hint: "use ls to list a directory",
      });
    }

    if (st.size != null && st.size > input.maxBytes) {
      throw new VfsError("EOVERFLOW", `file is ${st.size} bytes, over the ${input.maxBytes} limit`, {
        path,
        operation: "read",
        hint: "raise it with --max-bytes, or read a window with --offset/--limit",
      });
    }

    const bytes = await vfs.read(path, { encoding: "binary" });
    const text = decodeText(bytes);
    if (text === null) {
      throw new VfsError("EIO", "this file is not text, so reading it would only produce noise", {
        path,
        operation: "read",
        hint: "for a binary, run `shell file <path>` — or the tool that understands the format",
      });
    }

    try {
      return clamp(
        window(text, { offset: input.offset, limit: input.limit, numbers: input.numbers }),
        input.maxBytes
      );
    } catch (e) {
      if (e instanceof RangeError) {
        throw new VfsError("EINVAL", e.message, { path, operation: "read" });
      }
      throw e;
    }
  },
});
