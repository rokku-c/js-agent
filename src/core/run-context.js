// Per-run authority. Only the AbortSignal is intentionally live; capability data is
// copied and frozen so neither callers nor another run can change it underneath us.
import { Policy } from "./policy.js";
import { VfsError } from "../kernel/errors.js";

export const DEFAULT_MAX_DEPTH = 2;

function freeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export function createRunContext({
  tools = [], policy = null, session = null, depth = 0,
  maxDepth = DEFAULT_MAX_DEPTH, parent = null, signal = null,
  cwd = "/", inProcess = false,
} = {}) {
  for (const [name, value] of Object.entries({ depth, maxDepth })) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new VfsError("EINVAL", `${name} must be a non-negative safe integer`);
    }
  }
  const sourceRules = policy instanceof Policy
    ? policy.rules
    : policy?.default !== undefined && Array.isArray(policy?.rules)
      ? policy
      : { version: 1, default: "allow", rules: [] };
  const rules = freeze(structuredClone(sourceRules));
  return Object.freeze({
    tools: Object.freeze([...tools]),
    policy: Object.freeze(new Policy(rules, policy?.source ?? "none")),
    session, depth, maxDepth, parent, signal, cwd, inProcess,
  });
}

export function deriveChildContext(context, { tools, maxDepth = context.maxDepth }) {
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 0) {
    throw new VfsError("EINVAL", "maxDepth must be a non-negative safe integer");
  }
  const limit = Math.min(context.maxDepth, maxDepth);
  if (context.depth >= limit) {
    throw new VfsError("EPERM", `refusing to recurse past depth ${limit}`, { operation: "task" });
  }
  const rogue = tools.filter((name) => !context.tools.includes(name));
  if (rogue.length) {
    throw new VfsError("EPERM", `refusing to give the subagent tool(s) this run does not have: ${rogue.join(", ")}`, {
      operation: "task",
      hint: `this run has: ${context.tools.join(", ")}. a subagent may narrow the parent's capabilities, never widen them.`,
    });
  }
  return createRunContext({
    ...context, tools, depth: context.depth + 1, maxDepth: limit,
    parent: context.session, session: null,
  });
}
