// policy.js — a gate consulted before a tool call runs.
//
// ── the default is allow, and the namespace is the reason ──
// nu-agent's gate is opt-in because tightening a default silently changes working
// behaviour. that reasoning holds here, and here it costs less: the *mount table* already
// denies by default — an agent with no /host mount cannot read a file, whatever its policy
// says — so the gate's job is to add rules on top of a boundary that is already restrictive,
// not to be the boundary. with no rules file, `check` returns allow without reading anything.
//
// ── how a denial reaches the model ──
// it arrives as an ordinary tool failure, not a crash. the executor wraps every call in a
// try and turns a throw into an `is_error` tool_result the model can read and correct itself
// from — so a denial raises, and must raise **inside** that try, after the argument record
// has been assembled (the record is what `path` patterns match on).
//
// and the message is written TO the model: it says the rule is hard, and that retrying is
// pointless. a model told only "denied" will try again with a synonym.

import { VfsError } from "../kernel/errors.js";

const DEFAULT_PATH = "/agent/policy.json";

/** glob → regex. only `*` and `?` are special; everything else is literal, which keeps a
 *  pattern like `rm -rf *` meaning what it looks like rather than what a regex would. */
function globToRegex(pat) {
  const escaped = String(pat).replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp("^" + escaped.replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
}

const matches = (pat, s) => globToRegex(pat).test(String(s ?? ""));

/** the path-ish arguments of a call, so `path` patterns have something to match. matched by
 *  name rather than position: tool schemas vary and a wrong guess fails open. */
function pathsOf(input) {
  if (!input || typeof input !== "object") return [];
  return Object.entries(input)
    .filter(([k, v]) => typeof v === "string" && /path|cwd|file|dir|source/i.test(k))
    .map(([, v]) => v);
}

export class Policy {
  #rules;
  #source;

  constructor(rules, source = "none") {
    this.#rules = rules;
    this.#source = source;
  }

  get source() {
    return this.#source;
  }
  get ruleCount() {
    return this.#rules?.rules?.length ?? 0;
  }
  get rules() {
    return this.#rules;
  }

  /**
   * Load the rules in effect.
   *
   * An explicitly compiled ruleset wins over any file, and that is not a convenience: a
   * subagent is handed its parent's *compiled* rules, so a child that could point the
   * policy path somewhere empty would escape the restriction by naming a different file.
   * passing the rules rather than a path is the whole mechanism.
   */
  static async load(vfs, { file = null, compiled = null } = {}) {
    if (compiled) return new Policy(compiled, "inherited");

    const path = file ?? DEFAULT_PATH;
    let text;
    try {
      text = await vfs.read(path);
    } catch {
      // no file means the gate is open, and says so rather than inventing a default
      return new Policy({ version: 1, default: "allow", rules: [] }, "none");
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      throw new VfsError("EINVAL", `${path} is not valid JSON: ${e.message}`, { path });
    }
    const missing = ["default", "rules"].filter((k) => parsed[k] === undefined);
    if (missing.length) {
      throw new VfsError("EINVAL", `${path} is missing ${missing.join(", ")}`, {
        path,
        hint: 'expected {"version":1,"default":"allow","rules":[…]}, where default is allow, deny or ask',
      });
    }
    return new Policy(parsed, path);
  }

  /** first match wins — top to bottom, so the outcome is predictable from reading the file,
   *  which beats a specificity rule nobody can hold in their head. */
  check(call) {
    const tool = call.tool ?? "";
    const command = call.command ?? "";
    const paths = pathsOf(call.input);

    const hit = (this.#rules.rules ?? []).findIndex((rule) => {
      const m = rule.match ?? {};
      const okTool = m.tool === undefined || matches(m.tool, tool);
      const okCmd = m.command === undefined || (command !== "" && matches(m.command, command));
      const okPath = m.path === undefined || paths.some((p) => matches(m.path, p));
      return okTool && okCmd && okPath;
    });

    const rule = hit >= 0 ? this.#rules.rules[hit] : null;
    return {
      decision: rule ? (rule.action ?? "allow") : (this.#rules.default ?? "allow"),
      rule: hit >= 0 ? hit : null,
      reason: rule?.reason ?? "",
      tool,
      command,
      paths,
      source: this.#source,
    };
  }

  /** why a call got its decision — for writing a rules file without guessing. */
  explain(call) {
    const d = this.check(call);
    return {
      ...d,
      matched: d.rule === null ? "no rule — the default applies" : `rule ${d.rule}`,
      rule_body: d.rule === null ? null : this.#rules.rules[d.rule],
      rules_loaded: this.ruleCount,
    };
  }
}

/** the message a denied call produces. written TO the model: it states that this is a hard
 *  rule and that a retry with different wording is not going to work. */
export function refuseMessage(d) {
  const where = d.rule === null ? "the default rule" : `rule ${d.rule}`;
  const why = d.reason ? ` — ${d.reason}` : "";
  const what = d.command ? `\`${d.command}\`` : `tool ${d.tool}`;
  return (
    `policy denied ${what} by ${where}${why}. ` +
    "this is a hard rule in the user's policy file; do not retry the same call. " +
    "if the task genuinely requires it, say so in your reply so the user can amend the policy."
  );
}

export function deferMessage(d) {
  const what = d.command ? `\`${d.command}\`` : `tool ${d.tool}`;
  return (
    `${what} is deferred pending user approval (${d.id}) — the policy asks for confirmation ` +
    "and there is nobody at a terminal here. do not retry it. carry on with anything else, " +
    "and tell the user in your reply that this call is waiting."
  );
}

export function approveMessage(id) {
  return (
    `approved ${id}. it is not re-run for you — the caller has to issue it again now that ` +
    "it is no longer pending."
  );
}

/** how to resolve an `ask` when there may be nobody to ask. `defer` is the only answer that
 *  keeps a human in the loop without blocking a round — and stderr not being a terminal is
 *  how a headless run finds out. */
export function onAskMode() {
  const explicit = process.env.JS_AGENT_ON_ASK;
  if (explicit) return explicit;
  return process.stderr.isTTY ? "prompt" : "defer";
}

export const PENDING_PATH = "/agent/policy-pending.json";

export async function loadPending(vfs) {
  try {
    return JSON.parse(await vfs.read(PENDING_PATH));
  } catch {
    return [];
  }
}

export async function defer(vfs, d) {
  const mode = onAskMode();
  if (mode === "deny") return { ...d, decision: "deny", reason: "the policy asks for confirmation and JS_AGENT_ON_ASK=deny" };
  if (mode === "allow") return { ...d, decision: "allow", reason: "the policy asks for confirmation and JS_AGENT_ON_ASK=allow" };

  if (mode === "prompt") {
    const { createInterface } = await import("node:readline/promises");
    // /dev/tty is not used here the way nu-agent uses it, because this process's stdout is
    // already the terminal in every mode that reaches this branch
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const answer = (await rl.question(`run ${d.command || d.tool}? [y/N] `)).trim().toLowerCase();
    rl.close();
    return answer === "y" || answer === "yes"
      ? { ...d, decision: "allow", reason: "approved at the prompt" }
      : { ...d, decision: "deny", reason: "declined at the prompt" };
  }

  const id = `pol-${Date.now().toString(36)}-${Math.floor(1000 + Math.random() * 9000)}`;
  const all = await loadPending(vfs);
  all.push({
    id,
    when: new Date().toISOString(),
    tool: d.tool,
    command: d.command,
    paths: d.paths,
    reason: d.reason,
  });
  await vfs.mkdirp("/agent").catch(() => {});
  await vfs.write(PENDING_PATH, JSON.stringify(all, null, 2), { create: true }).catch(() => {});
  return { ...d, decision: "defer", id };
}

/**
 * Consult the policy for one call and raise if it is not allowed.
 *
 * Raising rather than returning is the design: the caller sits inside the executor's try,
 * and a raised error becomes an `is_error` tool_result.
 */
export async function gate(policy, vfs, { tool, command = "", input = {} }) {
  const v = policy.check({ tool, command, input });
  if (v.decision === "allow") return v;

  const d = v.decision === "ask" ? await defer(vfs, v) : v;
  if (d.decision === "deny") throw new VfsError("EACCES", refuseMessage(d), { operation: "policy" });
  if (d.decision === "defer") throw new VfsError("EBUSY", deferMessage(d), { operation: "policy" });
  return d;
}
