// tools.js — what a tool is, and the one declaration that serves both masters
//
// ── a file's name is its tool name ──
// nu-agent's rule, kept exactly: src/tools/read.js exports a tool called `read`, so the
// module is `read` and the tool the model is offered is `read`. that makes the filename
// API surface rather than a file label.
//
// ── one declaration, two readers ──
// nu-agent derives tool definitions from nushell's own command signatures — `expose` reads
// them out of the parser. JavaScript has no signature introspection, so the honest
// substitute is that the tool states its parameters. the payoff is that a single `params`
// block serves:
//
//   · the model, as `input_schema`           (expose.nu's job)
//   · the shell, as its argument validator   (which flags exist, and of what type)
//
// and that second job is not decoration. validating flags against the declaration is what
// stops `--__proto__={…}` from inventing a flag that was never passed, what keeps
// `--version 1.0` the string `"1.0"` instead of the number `1`, and what makes a mistyped
// flag an error rather than a silently ignored argument.

import { VfsError } from "../kernel/errors.js";

/** JSON Schema type for a declared parameter type. */
const JSON_TYPE = {
  string: "string",
  number: "number",
  integer: "integer",
  boolean: "boolean",
  array: "array",
  object: "object",
  any: null,
};

/**
 * @param {{
 *   name: string,
 *   description: string,
 *   params?: Record<string, ParamSpec>,
 *   isolated?: false|'worker'|'process',
 *   run: (ctx: ToolContext) => any,
 * }} spec
 *
 * ParamSpec: {
 *   type, description,
 *   positional?: number,   // the nth positional argument
 *   flag?: string,         // the --flag spelling; defaults to the param name
 *   required?: boolean,
 *   default?: any,
 *   input?: true,          // receives the value piped in from the left of a `|`
 *   enum?: any[],
 * }
 */
export function defineTool(spec) {
  if (!spec?.name) throw new TypeError("defineTool: a tool needs a name");
  if (typeof spec.run !== "function") {
    throw new TypeError(`defineTool(${spec.name}): needs a run(ctx)`);
  }
  const params = spec.params ?? {};
  const positional = Object.entries(params)
    .filter(([, p]) => typeof p.positional === "number")
    .map(([name, p]) => ({ name, ...p }))
    .sort((a, b) => a.positional - b.positional);

  // a gap in the positional numbering is almost always a mistake that would otherwise
  // show up as an argument silently landing in the wrong slot
  positional.forEach((p, i) => {
    if (p.positional !== i) {
      throw new TypeError(
        `defineTool(${spec.name}): positional parameters must be 0,1,2… — ${p.name} is ${p.positional}`
      );
    }
  });

  // a `rest` parameter swallows everything after it, so nothing may follow one
  const restAt = positional.findIndex((p) => p.rest);
  if (restAt >= 0 && restAt !== positional.length - 1) {
    throw new TypeError(`defineTool(${spec.name}): a rest parameter has to be the last positional`);
  }

  // ── every spelling a parameter answers to must be claimed by exactly one parameter ──
  // a name that resolves to two parameters resolves to whichever happens to come first in
  // the object — a silent wrong argument, and precisely the class of bug the declaration
  // exists to make impossible. `read` briefly had `-n` on both `limit` and `numbers`, and it
  // read `-n` as "limit" while looking like "numbers".
  const flagNames = new Map();
  const claim = (spelling, name) => {
    const held = flagNames.get(spelling);
    // a parameter whose flag is its own name claims one spelling, not a collision with itself
    if (held !== undefined && held !== name) {
      throw new TypeError(
        `defineTool(${spec.name}): '${spelling}' names both '${held}' and '${name}'`
      );
    }
    flagNames.set(spelling, name);
  };
  for (const [name, p] of Object.entries(params)) {
    claim(name, name);
    if (p.flag) claim(p.flag, name);
  }
  // shorts go through the same claim, so a `-n` that means two things reports itself in the
  // same words as a `--flag` that does
  for (const [name, p] of Object.entries(params)) {
    if (p.short) claim(p.short, name);
  }

  return {
    isolated: false,
    params,
    positional,
    ...spec,
  };
}

/** the parameters the model is told about. every declared parameter, including one that
 *  a pipe may also fill: `--content` and `cat f | write out.txt` are two ways to reach the
 *  same slot, and hiding it from the model would make the second one invisible. */
function exposedParams(tool) {
  return Object.entries(tool.params);
}

/**
 * The Anthropic-shaped tool definition: `{name, description, input_schema}`.
 * This is the canonical form the whole runtime speaks; the OpenAI dialect wraps it.
 */
export function inputSchema(tool) {
  const properties = {};
  const required = [];
  for (const [name, p] of exposedParams(tool)) {
    const schema = {};
    const t = JSON_TYPE[p.type ?? "any"];
    if (t) schema.type = t;
    if (p.type === "array" && p.items) schema.items = { type: JSON_TYPE[p.items] ?? "string" };
    if (p.enum) schema.enum = [...p.enum];
    // the default is carried along, because a model that sees one is far likelier to pass
    // the argument the caller meant than a model choosing from an empty description
    if (p.default !== undefined) schema.default = p.default;
    if (p.description) schema.description = p.description;
    if (name === "path" && p.type === "string") {
      schema.description = schema.description ?? "a path in the namespace, absolute or relative to the working directory";
    }
    properties[name] = schema;
    if (p.required) required.push(name);
  }
  const out = { type: "object", properties };
  if (required.length) out.required = required;
  return out;
}

export function toolDefinition(tool) {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: inputSchema(tool),
  };
}

/** what `/bin/<name>` reads as: the definition a model sees, plus the facts a person
 *  needs — how it is isolated, and which parameters exist — and nothing that is code. */
export function catalogEntry(tool) {
  return {
    ...toolDefinition(tool),
    isolated: tool.isolated === false ? null : tool.isolated,
    params: Object.fromEntries(
      Object.entries(tool.params).map(([name, p]) => [
        name,
        {
          type: p.type ?? "any",
          ...(p.positional !== undefined ? { positional: p.positional } : {}),
          ...(p.flag !== undefined || p.positional === undefined ? { flag: p.flag ?? name } : {}),
          ...(p.short ? { short: p.short } : {}),
          ...(p.input ? { input: true } : {}),
          ...(p.required ? { required: true } : {}),
          ...(p.default !== undefined ? { default: p.default } : {}),
        },
      ])
    ),
  };
}

// ── calling ────────────────────────────────────────────────────────────────────────

/** find the parameter a flag name refers to, or null.
 *
 *  matched on the declared `flag`, then on an optional one-letter `short`, then on the
 *  parameter's own name — so `--max-output`, `-o` and a param named `maxOutput` can all be
 *  the same thing. the short form is opt-in per parameter rather than guessed from the
 *  first letter, because guessing turns a typo into a different flag that happens to exist.
 */
function paramForFlag(tool, flag) {
  for (const [name, p] of Object.entries(tool.params)) {
    if ((p.flag ?? name) === flag) return { name, spec: p };
  }
  for (const [name, p] of Object.entries(tool.params)) {
    if (p.short === flag) return { name, spec: p };
  }
  // `-` prefix on a one-letter name is the short form; both spellings were normalised by
  // the tokeniser, so nothing more is needed here
  return null;
}

/** the parameter a flag spelling refers to: its declared flag, its one-letter short, or its
 *  own name. exported because the shell's argument binder has to resolve `-o` the same way
 *  the validator does — two lookups that disagree is a bug with no symptom until someone
 *  types a short flag. */
export function findParam(tool, flag) {
  return paramForFlag(tool, flag);
}

/** every way a parameter can be spelled, for an error message that lists them. */
export function spellings(tool) {
  return Object.entries(tool.params).flatMap(([n, p]) => {
    const out = [p.flag ?? n];
    if (p.short) out.push(`-${p.short}`);
    return out;
  });
}

/** the closest declared flag to a typo, for a message that names a fix rather than
 *  just refusing. plain edit distance; the candidate lists here are tiny. */
export function nearest(word, candidates) {
  let best = null;
  let bestD = Infinity;
  for (const c of candidates) {
    const d = editDistance(word, c);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return bestD <= Math.max(2, Math.floor(word.length / 3)) ? best : null;
}

function editDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
  }
  return dp[a.length][b.length];
}

/**
 * Coerce a value to a declared parameter's type, or say why it cannot be.
 *
 * This is where `--version 1.0` stays `"1.0"`: the string arrives, the parameter says
 * `string`, and nothing guesses. The earlier design tried JSON first and took whatever
 * parsed, which made the same input mean different things in different contexts — the
 * kind of rule nobody can hold in their head and therefore nobody can trust.
 */
function coerce(value, spec, name) {
  const type = spec.type ?? "any";
  if (type === "any") return value;

  if (type === "boolean") {
    if (typeof value === "boolean") return value;
    if (value === "true") return true;
    if (value === "false") return false;
    throw new VfsError("EINVAL", `--${name} takes true or false, got ${JSON.stringify(value)}`);
  }

  if (type === "number" || type === "integer") {
    const n = typeof value === "number" ? value : Number(String(value).trim());
    if (!Number.isFinite(n)) {
      throw new VfsError("EINVAL", `--${name} takes a number, got ${JSON.stringify(value)}`);
    }
    if (type === "integer" && !Number.isInteger(n)) {
      throw new VfsError("EINVAL", `--${name} takes a whole number, got ${JSON.stringify(value)}`);
    }
    return n;
  }

  if (type === "array") {
    if (Array.isArray(value)) return value;
    const s = String(value).trim();
    if (s === "") return [];
    // a comma-separated list is what a person types; a JSON array is what they paste
    return s.startsWith("[") ? JSON.parse(s) : s.split(",").map((x) => x.trim());
  }

  if (type === "object") {
    if (value && typeof value === "object") return value;
    return JSON.parse(String(value));
  }

  if (type === "string") {
    if (typeof value === "string") return value;
    return String(value);
  }
  return value;
}

/**
 * Validate an argument record against a tool's declaration.
 *
 * Unknown flags are an error, never ignored. A shell that swallows a mistyped flag is a
 * shell whose successful-looking runs did something else — and here the caller is often a
 * model, which will read "ok" as "what I asked for happened".
 */
export function validateInput(tool, input = {}) {
  const out = Object.create(null);
  const known = new Set();

  for (const [name, p] of Object.entries(tool.params)) {
    known.add(name);
    known.add(p.flag ?? name);
    if (p.short) known.add(p.short);
  }

  for (const [key, raw] of Object.entries(input)) {
    // `Object.hasOwn`, never `in`. `in` walks the prototype chain, so `__proto__` — which
    // is an accessor on Object.prototype — is "in" every params object there is. that reads
    // as a declared parameter whose spec is Object.prototype, and the flag it was supposed
    // to reject is accepted instead.
    const hit =
      paramForFlag(tool, key) ??
      (Object.hasOwn(tool.params, key) ? { name: key, spec: tool.params[key] } : null);
    if (!hit) {
      const cands = spellings(tool);
      const hint = nearest(key, cands) ?? nearest(key, cands.map((c) => c.replace(/^-/, "")));
      const show = (c) => (c.startsWith("-") ? c : `--${c}`);
      throw new VfsError("EINVAL", `unknown argument '${key}' for ${tool.name}`, {
        hint: hint
          ? `did you mean ${show(hint)}?`
          : `known arguments: ${cands.map(show).join(", ")}`,
      });
    }
    const { name, spec } = hit;
    if (out[name] !== undefined && out[name] !== raw) {
      throw new VfsError("EINVAL", `${tool.name}: ${name} given twice`);
    }
    out[name] = coerce(raw, spec, name);
  }

  for (const [name, p] of Object.entries(tool.params)) {
    if (out[name] === undefined && p.default !== undefined) out[name] = p.default;
    if (out[name] === undefined && p.required) {
      const how = p.positional !== undefined ? `the ${ordinal(p.positional + 1)} argument` : `--${p.flag ?? name}`;
      throw new VfsError("EINVAL", `${tool.name}: missing required argument '${name}' (${how})`);
    }
  }
  return out;
}

function ordinal(n) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
}

/** load every tool module in this directory, keyed by filename — the naming contract
 *  made executable. only the ones named are imported, so mounting /bin with `tools=read`
 *  does not load the rest. */
export async function loadTools(names, dir = new URL("../tools/", import.meta.url)) {
  const out = [];
  for (const name of names) {
    if (!/^[a-z][a-z0-9_-]*$/.test(name)) {
      throw new VfsError("EINVAL", `bad tool name: ${name}`);
    }
    let mod;
    try {
      mod = await import(new URL(`${name}.js`, dir));
    } catch (e) {
      if (e.code === "ERR_MODULE_NOT_FOUND") {
        throw new VfsError("ENOENT", `no such tool: ${name}`, {
          hint: "tools live in src/tools/ and a file's name is its tool name",
        });
      }
      throw e;
    }
    const tool = mod.default;
    if (!tool?.run) throw new Error(`src/tools/${name}.js does not export a tool`);
    if (tool.name !== name) {
      throw new Error(`src/tools/${name}.js exports a tool named '${tool.name}' — the file's name is the tool's name`);
    }
    out.push(tool);
  }
  return out;
}
