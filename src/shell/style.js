// style.js — colour, off automatically when nobody is looking.
//
// the rule nu-agent settled on, kept: whether to colour is decided by whether stdout is a
// terminal, because the alternative is a captured log full of escape codes. and a second
// rule that is easy to miss — an *explicit* override has to exist, because
// `node -e … | less -R` is a real thing people do.

const on = (() => {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== "0") return true;
  return process.stdout.isTTY === true;
})();

const wrap = (code) => (s) => (on ? `\x1b[${code}m${s}\x1b[0m` : String(s));

export const style = {
  enabled: on,
  dim: wrap("2"),
  bold: wrap("1"),
  red: wrap("31"),
  green: wrap("32"),
  yellow: wrap("33"),
  blue: wrap("34"),
  magenta: wrap("35"),
  cyan: wrap("36"),
  grey: wrap("90"),
  /** the prompt, which is the one thing that should look like a prompt */
  prompt: (s) => (on ? `\x1b[36m${s}\x1b[0m` : s),
};

/** a marker line: ✓ / ✗ / ! / ·, coloured, with the text after it. */
export function mark(kind, text) {
  const glyph = { ok: "✓", err: "✗", warn: "!", info: "·", run: "→", out: "│" }[kind] ?? "·";
  const paint = { ok: style.green, err: style.red, warn: style.yellow, info: style.dim, run: style.cyan, out: style.grey }[kind] ?? style.dim;
  return `${paint(glyph)} ${text}`;
}
