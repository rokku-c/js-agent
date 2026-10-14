// parse.js — a shell line → either a pipeline of commands, or JavaScript.
//
// ── the decision that makes the rest correct ──
// **the mode is decided for the whole line, before anything is split.**
//
// the tempting design splits on `|` and `>` first and classifies each piece. it is wrong,
// and wrong in the silent direction: `|` is also bitwise-or and `>` is also greater-than,
// so `count > 0` becomes a write to a file named `0`, `4 | 1` becomes a two-stage pipeline
// that runs `1`, and a `|` inside a regex literal cuts an expression in half. every one of
// those is valid JS that the splitter destroyed.
//
// so: one classifier, on the line's first token. if it names a command — and the line is
// not an assignment — the line is *command mode* and only then are `|` and `>` looked for.
// otherwise the line is JS and is never split at all. the splitter only ever sees command
// mode, where arguments are brace-balanced and quotes are quotes, so a bracket-and-quote
// aware scan is genuinely sufficient rather than merely convenient.
//
// the escape hatches run both ways, because an escape you can only leave through is not
// an escape: `js <code>` forces JavaScript, `! <cmd>` forces command mode.

import { VfsError } from "../kernel/errors.js";
import { findParam } from "../core/tools.js";

const IDENT = /^([A-Za-z_][A-Za-z0-9_-]*)/;

/**
 * @param {string} line
 * @param {(name: string) => boolean} isCommand
 * @returns {null | {mode: 'js', code: string}
 *                | {mode: 'command', stages: Stage[], redirect: null|{path: string, append: boolean}}}
 *
 * Stage: {name: string, tokens: Token[]}
 * Token: {kind: 'positional'|'flag', name?: string, value: string|boolean|{js: string}}
 */
export function parseLine(line, isCommand) {
  const text = String(line ?? "").trim();
  if (!text || text.startsWith("#")) return null;

  // ── the forced escapes ──
  if (/^js\s+/.test(text)) return { mode: "js", code: text.slice(3).trim() };
  if (/^js$/.test(text)) return { mode: "js", code: "" };
  if (/^!\s+/.test(text)) return parseCommand(text.slice(1).trim(), isCommand);
  if (/^cmd\s+/.test(text)) return parseCommand(text.slice(4).trim(), isCommand);

  const m = IDENT.exec(text);
  if (!m) return { mode: "js", code: text };

  const name = m[1];
  const after = text.slice(name.length);

  // `ident = …` is assignment. no command grammar has a bare `=` argument, and treating
  // one as command mode would turn `read = 5` into a call with a mysterious `=` in it.
  if (/^\s*=(?!=|>)/.test(after)) return { mode: "js", code: text };

  // the command token has to stand alone — `read('/x')` is a JavaScript call of the same
  // function, and it must not be eaten by the command grammar
  if (after !== "" && !/^\s/.test(after)) return { mode: "js", code: text };

  if (!isCommand(name)) return { mode: "js", code: text };
  return parseCommand(text, isCommand);
}

/** command mode: split the pipeline, then find a redirect on the last stage. */
function parseCommand(text, isCommand) {
  const { parts, redirect } = splitPipeline(text);

  const stages = parts.map((part) => {
    const trimmed = part.trim();
    if (!trimmed) throw new VfsError("EINVAL", "empty stage in pipeline");
    const tokens = tokenize(trimmed);
    const name = tokens.shift();
    if (!name || name.kind !== "positional" || typeof name.value !== "string") {
      throw new VfsError("EINVAL", `a pipeline stage has to begin with a command: ${trimmed}`);
    }
    if (!isCommand(name.value)) {
      // the loud version matters: `4 | 1` reaching here would otherwise run `1`
      throw new VfsError("EINVAL", `'${name.value}' is not a command, so this is not a pipeline`, {
        hint: "for bitwise or, write it as JavaScript — parenthesise it, or start the line with `js`",
      });
    }
    return { name: name.value, tokens };
  });

  return { mode: "command", stages, redirect };
}

/**
 * Find the top-level `|` separators and a trailing `>`/`>>` redirect.
 *
 * "top level" means: not inside quotes, not inside brackets. that is exactly the set of
 * places a `|` or `>` in *command* mode can legitimately appear inside an argument — a
 * `{ … }` block argument, or a quoted string. mode was already decided, so a regex
 * literal or a `>=` cannot be here.
 */
function splitPipeline(text) {
  const cuts = [];
  let redirect = null;
  let redirectAt = -1;

  let quote = null;
  let depth = 0;
  let esc = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (esc) {
      esc = false;
      continue;
    }
    if (quote) {
      if (ch === "\\" && quote === '"') esc = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      depth++;
      continue;
    }
    if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      continue;
    }
    if (depth > 0) continue;

    if (ch === "|") {
      cuts.push({ at: i, len: 1 });
      continue;
    }
    if (ch === ">") {
      // reject the JS operators outright rather than mis-reading them
      if (text[i + 1] === ">" && text[i + 2] === ">") {
        throw new VfsError("EINVAL", "`>>>` is not a redirect", {
          hint: "JavaScript belongs on a line of its own, or after `js `",
        });
      }
      const append = text[i + 1] === ">";
      const target = text.slice(i + (append ? 2 : 1)).trim();
      if (!target) throw new VfsError("EINVAL", "redirect with no target");
      if (/^\d+$/.test(target)) {
        throw new VfsError("EINVAL", `a redirect to '${target}' looks like a comparison`, {
          hint: "write `> ./" + target + "` if you really mean a file with that name",
        });
      }
      redirect = { path: unquotePath(target), append };
      redirectAt = i;
      break;
    }
  }

  if (quote) throw new VfsError("EINVAL", `unterminated quote (${quote})`);
  if (depth > 0) throw new VfsError("EINVAL", "unbalanced brackets");

  const parts = [];
  let prev = 0;
  for (const c of cuts) {
    if (redirectAt >= 0 && c.at > redirectAt) break;
    parts.push(text.slice(prev, c.at));
    prev = c.at + c.len;
  }
  parts.push(text.slice(prev, redirectAt >= 0 ? redirectAt : undefined));

  return { parts, redirect };
}

function unquotePath(s) {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * One stage's arguments.
 *
 * The rules, all of them:
 *   `--flag`          a switch
 *   `--key=value`     first `=` splits; `--key=` is the empty string
 *   `--`              everything after is positional, so a file named `--x` is reachable
 *   `-3`, `-3.5`      a negative number, never a flag
 *   `-x`              a short flag
 *   `-xy`             an error, naming both readings — POSIX clusters and a flag called
 *                     `xy` are both plausible and guessing picks wrong half the time
 *   `'…'`             literal, no escapes
 *   `"…"`             escapes processed
 *   `{ … }`           JavaScript, evaluated — the only evaluation surface in an argument
 *   `` `…` ``         rejected: every shell reader takes a backtick as command
 *                     substitution, and an argument that can call functions is not a
 *                     restricted literal, it is eval with extra steps
 *   anything else     a string. the tool's declaration decides the type.
 */
function tokenize(stage) {
  const out = [];
  let i = 0;
  let positionalOnly = false;

  const isFlagish = (tok) => /^--?[A-Za-z]/.test(tok);

  const readToken = () => {
    const start = i;
    let quote = null;
    let depth = 0;
    let esc = false;
    while (i < stage.length) {
      const ch = stage[i];
      if (esc) {
        esc = false;
        i++;
        continue;
      }
      if (quote) {
        if (ch === "\\" && quote === '"') esc = true;
        else if (ch === quote) quote = null;
        i++;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === "`") {
        quote = ch;
        i++;
        continue;
      }
      if (ch === "(" || ch === "[" || ch === "{") {
        depth++;
        i++;
        continue;
      }
      if (ch === ")" || ch === "]" || ch === "}") {
        depth--;
        i++;
        continue;
      }
      if (depth === 0 && /\s/.test(ch)) break;
      i++;
    }
    return stage.slice(start, i);
  };

  const valueOf = (raw) => {
    if (raw.startsWith("{") && raw.endsWith("}")) return { js: raw.slice(1, -1) };
    if (raw.startsWith("`")) {
      throw new VfsError("EINVAL", "backticks are not command substitution here", {
        hint: "write { … } for a JavaScript value, or quote it as a string",
      });
    }
    if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
      return unescapeDouble(raw.slice(1, -1));
    }
    if (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2) {
      return raw.slice(1, -1);
    }
    return raw;
  };

  while (i < stage.length) {
    while (i < stage.length && /\s/.test(stage[i])) i++;
    if (i >= stage.length) break;

    const raw = readToken();
    if (raw === "") {
      i++;
      continue;
    }

    if (!positionalOnly && raw === "--") {
      positionalOnly = true;
      continue;
    }

    if (!positionalOnly && raw.startsWith("--")) {
      const body = raw.slice(2);
      const eq = body.indexOf("=");
      if (eq < 0) {
        out.push({ kind: "flag", name: body, value: BARE });
      } else {
        out.push({ kind: "flag", name: body.slice(0, eq), value: valueOf(body.slice(eq + 1)) });
      }
      continue;
    }

    if (!positionalOnly && isFlagish(raw) && !/^-\d|^-\.\d/.test(raw)) {
      const body = raw.slice(1);
      if (body.length > 1) {
        throw new VfsError("EINVAL", `'${raw}' is ambiguous: a cluster of short flags, or one long one?`, {
          hint: `write ${body
            .split("")
            .map((c) => "-" + c)
            .join(" ")} for the cluster, or --${body} for the long form`,
        });
      }
      out.push({ kind: "flag", name: body, value: BARE });
      continue;
    }

    out.push({ kind: "positional", value: valueOf(raw) });
  }

  return out;
}

function unescapeDouble(s) {
  return s.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (_, e) => {
    switch (e[0]) {
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      case "0":
        return "\0";
      case "\\":
        return "\\";
      case '"':
        return '"';
      case "u":
      case "x":
        return JSON.parse(`"\\${e}"`);
      default:
        return e;
    }
  });
}

/** a flag written without a value. whether that means `true` or "the next token is my
 *  value" depends on the tool's declaration, which only `bindArguments` knows — so the
 *  token carries the question forward rather than guessing at it here. */
export const BARE = Symbol("bare-flag");

/**
 * Turn a stage's tokens into a raw argument record for `validateInput`.
 *
 * Positionals fill by index, flags by name. Nothing is typed here — every value arrives
 * as a string or a boolean or a `{js}` marker, and the tool's own declaration coerces it.
 * that is what keeps `--version 1.0` the string "1.0".
 *
 * `--flag value` and `--flag=value` both work, and a valueless `--flag` is resolved by the
 * declaration: a boolean takes it as `true`, anything else consumes the next token. a flag
 * that would consume a token which itself looks like a flag does not — `--verbose --old x`
 * would otherwise swallow `--old` — and says so instead of building a silent mess.
 */
export async function bindArguments(tool, tokens, evaluate) {
  const input = Object.create(null);
  let positionalIndex = 0;

  // awaited, and that is load-bearing: evaluating a `{ … }` argument is asynchronous (it
  // goes through the same evaluator the rest of the shell uses), and a missing `await` here
  // passes the *promise* into the command. `count { 1 + 1 }` then counts the keys of a
  // Promise — which is zero, silently, and looks like an arithmetic bug.
  const unwrap = async (v) => (v && typeof v === "object" && "js" in v ? await evaluate(v.js) : v);

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];

    if (tok.kind === "flag") {
      if (tok.value !== BARE) {
        input[tok.name] = await unwrap(tok.value);
        continue;
      }
      const declared = findParam(tool, tok.name);
      const type = declared?.spec?.type ?? "any";
      if (type === "boolean" || type === "any") {
        input[tok.name] = true;
        continue;
      }
      const next = tokens[i + 1];
      if (!next || next.kind !== "positional") {
        throw new VfsError("EINVAL", `--${tok.name} needs a value`, {
          hint: `it takes a ${type} — write --${tok.name}=<${type}> or \`--${tok.name} <${type}>\``,
        });
      }
      input[tok.name] = await unwrap(next.value);
      i++;
      continue;
    }

    const declared = tool.positional[positionalIndex];
    if (!declared) {
      const takes = tool.positional.length;
      throw new VfsError(
        "EINVAL",
        `${tool.name} takes ${takes} argument${takes === 1 ? "" : "s"}, got ${positionalIndex + 1}`,
        {
          hint: takes
            ? `positional arguments: ${tool.positional.map((p) => p.name).join(", ")}`
            : `everything ${tool.name} takes is a flag`,
        }
      );
    }

    // a rest parameter collects the remainder — `echo a b c` is one argument, not a
    // mistake, and a shell that refuses it is not a shell
    if (declared.rest) {
      const rest = [];
      for (; i < tokens.length; i++) {
        if (tokens[i].kind !== "positional") continue;
        rest.push(await unwrap(tokens[i].value));
      }
      input[declared.name] = rest;
      positionalIndex++;
      break;
    }

    input[declared.name] = await unwrap(tok.value);
    positionalIndex++;
  }

  return input;
}


/** the piped value's landing slot: the declared parameter marked `input`. */
export function inputSlot(tool) {
  for (const [name, p] of Object.entries(tool.params)) {
    if (p.input) return name;
  }
  return null;
}
