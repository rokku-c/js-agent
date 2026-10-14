// fileio.js — the bits of reading and writing that more than one tool needs.
//
// the three ideas here all come from nu-agent, where each was written twice before it was
// written once:
//
//   · **clamping is a message, not a cut.** a truncated result that does not say it was
//     truncated reads as the whole truth, and a model that believes a clipped file is a
//     complete one will confidently summarise the part it never saw.
//   · **binary is decided by trying to decode, not by sniffing an extension.** the
//     extension lies, the decoder does not.
//   · **line numbers are absolute.** numbering a window 1..N when it is really 400..430
//     makes every downstream `edit --from` wrong.

/** cut at `max` characters, saying so. */
export function clamp(text, max, what = "output") {
  const s = String(text ?? "");
  if (max == null || s.length <= max) return s;
  return `${s.slice(0, max)}\n...(${what} truncated, was ${s.length} chars)`;
}

/** bytes → text, or null when they are not text. the decoder is the test: `fatal` makes
 *  a malformed sequence raise rather than quietly becoming U+FFFD, which is exactly the
 *  difference between "this is not a text file" and "this text file has a weird byte". */
export function decodeText(bytes) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return null;
  }
}

export function looksBinary(bytes) {
  return decodeText(bytes) === null;
}

/**
 * A window of lines, with a note naming what was left out.
 * @returns {string}
 */
export function window(text, { offset = 1, limit = null, numbers = false } = {}) {
  const lines = text.split("\n");
  // a trailing newline produces a final empty element; it is not a line of the file, and
  // counting it makes every "showing 1-40 of 40" off by one
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const total = lines.length;

  if (total === 0) return "(empty file)";
  if (offset < 1) throw new RangeError("offset is 1-based");
  if (offset > total) {
    throw new RangeError(`offset ${offset} is past the end of the file (${total} lines)`);
  }

  const start = offset - 1;
  const end = limit == null ? total : Math.min(total, start + limit);
  const picked = lines.slice(start, end);

  const body = numbers
    ? picked.map((l, i) => `${start + i + 1}\t${l}`).join("\n")
    : picked.join("\n");

  const left = total - end;
  if (limit == null || (start === 0 && left === 0)) return body;
  const where = `showing ${start + 1}-${end} of ${total}`;
  return `${body}\n...(${where}${left > 0 ? `, ${left} more` : ""})`;
}

/** how a path is named in a message: the namespace path, since that is the only one a
 *  reader can act on. */
export function whereLabel(path) {
  return String(path);
}

export function countLines(text) {
  const s = String(text ?? "");
  if (s === "") return 0;
  const n = s.split("\n").length;
  return s.endsWith("\n") ? n - 1 : n;
}

/** the line ending a file already uses, so an edit does not introduce a second kind. */
export function lineEnding(text) {
  return String(text).includes("\r\n") ? "\r\n" : "\n";
}

export function normalizeEndings(text, eol) {
  return String(text).replace(/\r\n|\n/g, eol);
}
