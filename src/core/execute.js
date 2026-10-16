// execute.js — run one tool call, and turn every failure into something the model can read.
//
// ── the contract ──
// a returned value is a success; a thrown value is an `is_error` tool_result. that is the
// whole interface, and it is why nothing in this runtime returns an errno-shaped object —
// a caller that forgets to branch would hand the model a normal-looking result containing a
// fake answer, and the model has no way to tell.
//
// ── where the policy gate sits, and why exactly there ──
// *after* the argument record is assembled, because `command` and `path` patterns match on
// the assembled call and gating earlier would have nothing to match; and *inside* the try,
// so a denial becomes an `is_error` result rather than propagating out and killing the run.

import { VfsError, reason } from "../kernel/errors.js";
import { validateInput } from "./tools.js";
import { runInWorker } from "./worker.js";

/** the call as a line, for policy patterns and for a log a person can read. */
export function describeCall(tool, input) {
  const parts = [tool.name];
  for (const p of tool.positional) {
    const v = input[p.name];
    if (v === undefined) continue;
    parts.push(typeof v === "string" ? v : JSON.stringify(v));
  }
  for (const [name, spec] of Object.entries(tool.params)) {
    if (spec.positional !== undefined) continue;
    const v = input[name];
    if (v === undefined || v === false) continue;
    const flag = `--${spec.flag ?? name}`;
    parts.push(v === true ? flag : `${flag}=${typeof v === "string" ? v : JSON.stringify(v)}`);
  }
  return parts.join(" ");
}

/**
 * @param {object} opts
 * @param {import('../kernel/vfs.js').Vfs} opts.vfs
 * @param {object} opts.tool            a defineTool result
 * @param {object} opts.input           raw arguments (not yet validated)
 * @param {string} opts.cwd
 * @param {number} opts.timeoutMs
 * @param {object} [opts.context]       immutable per-run authority
 * @param {AbortSignal} [opts.signal]  cancellation for in-process tools
 * @param {object} opts.policy
 * @param {number} opts.maxOutput
 * @param {string} [opts.id]            the tool_use id this answers
 * @param {(m: {kind: string, text: string}) => void} [opts.onOutput]
 * @param {(m: string) => void} [opts.log]
 * @param {boolean} [opts.inProcess]    skip the worker — for tests, and for debugging
 */
function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

export async function invokeTool({
  vfs,
  tool,
  input,
  context = null,
  signal = context?.signal ?? null,
  cwd = context?.cwd ?? "/",
  timeoutMs = 120_000,
  policy = null,
  maxOutput = 8000,
  id = "",
  onOutput,
  log = () => {},
  inProcess = false,
}) {
  const started = Date.now();
  let outcome;

  // Cancellation is control flow for the enclosing run, not a tool error for the model.
  throwIfAborted(signal);
  try {
    const validated = validateInput(tool, input ?? {});
    const command = describeCall(tool, validated);

    if (context && !context.tools.includes(tool.name)) {
      throw new VfsError("EPERM", `this run does not have tool ${tool.name}`);
    }
    const effectivePolicy = context?.policy ?? policy;
    if (effectivePolicy) {
      const { gate } = await import("./policy.js");
      await gate(effectivePolicy, vfs, { tool: tool.name, command, input: validated });
    }

    if (tool.name === "js" && validated.code !== undefined) {
      // the `js` tool's argument *is* the source; the executor carries it to the worker
      // rather than a module path
    }

    if (tool.isolated && !inProcess) {
      const r = await runInWorker({
        vfs,
        toolName: tool.name,
        input: validated,
        cwd,
        timeoutMs,
        source: tool.name === "js" ? validated.code : undefined,
        onOutput,
        signal,
      });
      outcome = r.ok ? { ok: true, value: r.value } : { ok: false, raw: r.error };
    } else {
      const value = await tool.run({
        vfs,
        cwd,
        input: validated,
        log,
        context,
        signal,
        source: tool.name === "js" ? validated.code : undefined,
      });
      outcome = { ok: true, value };
    }
  } catch (e) {
    if (signal?.aborted) throwIfAborted(signal);
    outcome = { ok: false, raw: reason(e) };
  }

  throwIfAborted(signal);
  const text = outcome.ok ? renderValue(outcome.value) : String(outcome.raw ?? "the tool failed");
  const clamped =
    text.length > maxOutput
      ? `${text.slice(0, maxOutput)}\n...\(output truncated, original length ${text.length} chars\)`
      : text;

  return {
    block: {
      type: "tool_result",
      tool_use_id: id,
      content: clamped.trim() === "" ? "(no output)" : clamped,
      is_error: !outcome.ok,
    },
    ok: outcome.ok,
    ms: Date.now() - started,
    bytes: clamped.length,
    value: outcome.ok ? outcome.value : undefined,
  };
}

/** a tool's return value → the text the model sees. a string is itself; a record is JSON,
 *  because a record rendered as a table gets its multi-line fields wrapped into cells and
 *  arrives shredded. */
export function renderValue(v) {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v);
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
