// edit — change part of a file.
//
// two ways to say where, one tool, and the mode is **named rather than positional**:
// `edit path a b` could be a range or a replacement, and a wrong guess edits the wrong
// thing in a file the caller cannot see. naming the mode makes the call self-describing,
// which is the whole job of a tool schema.

import { defineTool } from "../core/tools.js";
import { VfsError } from "../kernel/errors.js";
import { decodeText, lineEnding, normalizeEndings, countLines } from "../core/fileio.js";

export default defineTool({
  name: "edit",
  description:
    "Change part of a file. Text mode: pass old and new to replace text literally " +
    "(first occurrence unless all=true). Range mode: pass from, to and content to replace " +
    "a span of lines. The two modes are not mixed.",
  params: {
    path: { type: "string", positional: 0, required: true, description: "path to the file" },
    old: { type: "string", flag: "old", description: "text to find (matched literally, not as a regex)" },
    new: { type: "string", flag: "new", description: "text to replace it with" },
    all: { type: "boolean", flag: "all", description: "replace every occurrence, not just the first" },
    from: { type: "integer", flag: "from", description: "first line of the range to replace (1-based)" },
    to: { type: "integer", flag: "to", description: "last line of the range, inclusive" },
    content: { type: "string", flag: "content", description: "what the range becomes", input: true },
  },

  async run({ vfs, cwd, input }) {
    const path = vfs.abs(input.path, cwd);
    const hasText = input.old !== undefined || input.new !== undefined;
    const hasRange = input.from !== undefined || input.to !== undefined || input.content !== undefined;

    if (hasText && hasRange) {
      throw new VfsError("EINVAL", "both modes given at once", {
        path,
        operation: "edit",
        hint: "use --old/--new to replace text, or --from/--to/--content to replace lines",
      });
    }
    if (!hasText && !hasRange) {
      throw new VfsError("EINVAL", "nothing to do: no mode given", {
        path,
        operation: "edit",
        hint: "pass --old and --new, or --from/--to/--content",
      });
    }

    const st = await vfs.stat(path);
    if (st.type === "dir") throw new VfsError("EISDIR", "is a directory", { path, operation: "edit" });

    const text = decodeText(await vfs.read(path, { encoding: "binary" }));
    if (text === null) {
      throw new VfsError("EIO", "this file is not text", { path, operation: "edit" });
    }
    const eol = lineEnding(text);

    const next = hasText
      ? replaceText(path, text, input, eol)
      : replaceRange(path, text, input, eol);

    await vfs.write(path, next.text);
    return next.summary;
  },
});

/** literal replacement. `--old` is not a regex — a caller who wants a regex has `js`. */
function replaceText(path, text, input, eol) {
  const { old: find } = input;
  if (!find) {
    throw new VfsError("EINVAL", "--old must not be empty", { path, operation: "edit" });
  }
  if (input.new === undefined) {
    throw new VfsError("EINVAL", "--old given without --new", {
      path,
      operation: "edit",
      hint: "pass --new with the replacement text (it may be empty)",
    });
  }

  const parts = text.split(find);
  const found = parts.length - 1;
  if (found === 0) {
    throw new VfsError("ENOENT", `cannot find this text in ${path}`, {
      path,
      operation: "edit",
      hint: `looked for: ${JSON.stringify(find.slice(0, 80))} — read the file first if the exact text is uncertain`,
    });
  }

  const replacement = normalizeEndings(input.new, eol);
  const take = input.all ? found : 1;
  let out = "";
  for (let i = 0; i < parts.length; i++) {
    out += parts[i];
    if (i < parts.length - 1) out += i < take ? replacement : find;
  }

  const left = found - take;
  return {
    text: out,
    summary:
      `replaced ${take} occurrence${take === 1 ? "" : "s"} in ${path}, ${countLines(out)} lines` +
      (left > 0 ? ` (${left} more left — pass all=true for those)` : ""),
  };
}

function replaceRange(path, text, input, eol) {
  const { from, to } = input;
  if (from === undefined || to === undefined || input.content === undefined) {
    throw new VfsError("EINVAL", "range mode needs all three of --from, --to and --content", {
      path,
      operation: "edit",
    });
  }

  const trailing = text.endsWith(eol);
  const lines = text.split(eol);
  if (trailing) lines.pop();
  const total = lines.length;

  if (from < 1) throw new VfsError("EINVAL", "--from is 1-based", { path, operation: "edit" });
  if (to < from) throw new VfsError("EINVAL", `--to (${to}) is before --from (${from})`, { path });
  if (to > total) {
    throw new VfsError("EINVAL", `--to (${to}) is past the end of the file (${total} lines)`, { path });
  }

  const replacement = input.content === "" ? [] : normalizeEndings(input.content, eol).split(eol);
  // the trailing-newline state is preserved, so an LF file and a CRLF file both come back
  // byte-identical apart from the edit itself
  if (replacement.length && replacement[replacement.length - 1] === "") replacement.pop();

  const out = [...lines.slice(0, from - 1), ...replacement, ...lines.slice(to)];
  const joined = out.join(eol) + (trailing ? eol : "");

  return {
    text: joined,
    summary: `replaced lines ${from}-${to} in ${path} with ${replacement.length}, now ${out.length} lines`,
  };
}
