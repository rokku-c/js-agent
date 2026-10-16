// task — hand a subtask to a nested run.
//
// ── why this is a wrapper and not a loop ──
// in nu-agent a tool call already executes in a spawned process, so `task` *is* a nested run
// with its own context and its own crash boundary, for free. here a tool call runs in the
// current process, so `task` calls the loop directly — same idea, one less process.
//
// ── what the child sees: the prompt, and nothing else ──
// it never sees the parent's messages. handing them over would defeat the point of
// delegating and spend the child's budget re-reading a conversation it cannot act on.
//
// ── what it inherits: everything the parent could reach ──
// the same namespace, and therefore the same mounts — including the model. what it may then
// *use* is narrower by default, and it can never be wider than the parent:
//
//   · **tools**: the child's tool names must be a subset of the parent's. a child that could
//     name a tool its parent never had would make the parent's restrictions decorative.
//   · **policy**: the parent's *compiled* rules are passed down, not a path. a child handed
//     a path could point it at an empty file and escape — passing the rules is the mechanism,
//     not the convenience.
//   · **depth**: capped, so a task that calls a task that calls a task stops.

import { defineTool } from "../core/tools.js";
import { Policy } from "../core/policy.js";
import { createRunContext, deriveChildContext, DEFAULT_MAX_DEPTH } from "../core/run-context.js";
import { run } from "../core/agent.js";
import { clamp } from "../core/fileio.js";

export const DEFAULT_TASK_TOOLS = ["read", "ls", "js"];
export { DEFAULT_MAX_DEPTH };

export default defineTool({
  name: "task",
  description:
    "Delegate a subtask to a nested agent run. The subagent sees only the prompt you give " +
    "it — not this conversation — and can use only a subset of the tools you have. Use it " +
    "when a job can be described completely in a paragraph.",
  params: {
    prompt: { type: "string", positional: 0, required: true, input: true, description: "the whole task, stated completely" },
    tools: {
      type: "array",
      flag: "tools",
      description: `which tools the subagent may use; must be a subset of this run's. default: ${DEFAULT_TASK_TOOLS.join(",")}`,
    },
    system: { type: "string", flag: "system", description: "override the subagent's standing instructions" },
    model: { type: "string", flag: "model" },
    maxRounds: { type: "integer", flag: "max-rounds", default: 12 },
    maxDepth: { type: "integer", flag: "max-depth", description: "narrow the inherited recursion limit (default: 2 for a standalone task)" },
    json: { type: "boolean", flag: "json" },
  },

  async run({ vfs, cwd, input, context = null, signal = null }) {
    // A shell invocation has no parent run; its ceiling is the mounted catalog.
    const parentContext = context ?? createRunContext({
      tools: (await vfs.list("/bin")).map((entry) => entry.name),
      policy: await Policy.load(vfs),
      maxDepth: input.maxDepth ?? DEFAULT_MAX_DEPTH,
      cwd,
      signal,
    });
    const requested = (input.tools ?? DEFAULT_TASK_TOOLS).map(String);
    const childContext = deriveChildContext(parentContext, {
      tools: requested,
      maxDepth: input.maxDepth ?? parentContext.maxDepth,
    });

    const result = await run(vfs, {
      prompt: input.prompt,
      system:
        input.system ??
        "You are a subagent. You have been given one task by another agent and no access to " +
          "its conversation. Do the task, and answer with the result — not with a description " +
          "of what you would do.",
      context: childContext,
      model: input.model ?? null,
      maxRounds: input.maxRounds,
      cwd,
      // no streaming: the text is the tool result, and a stream would go to the wrong place
      stream: false,
      // The child transcript returns as the caller's tool result; no separate session.
      noSave: true,
      sessionId: null,
      onNote: () => {},
    });

    const text = clamp(result.text, 8000, "subagent output");
    if (input.json) {
      return {
        text,
        rounds: result.rounds,
        tool_calls: result.tool_calls,
        input_tokens: result.total_input,
        session: result.session,
      };
    }
    // the footer exists so the parent's model can self-limit: without it, delegation looks
    // free, and it is not
    return (
      `${text}\n\n[subagent · ${result.rounds} rounds · ${result.tool_calls} tool calls · ` +
      `${result.total_input} input tokens${result.session ? ` · transcript stored as session ${result.session}` : ""}]`
    );
  },
});
