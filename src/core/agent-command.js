// agent-command.js — the `agent` command.
//
// the loop is a function of the namespace it is given: it reads /bin for its tools, opens a
// model device for its answers, and writes to /agent if there is one. so the shell command
// is thin — it hands the shell's own namespace to the loop and prints what comes back.

import { defineTool } from "./tools.js";
import { run } from "./agent.js";
import { mark, style } from "../shell/style.js";

export const agentCommand = defineTool({
  name: "agent",
  description:
    "Run the agent loop on a task. The model and its tools are whatever this namespace has " +
    "mounted, so a run can only reach what the shell can reach.",
  params: {
    task: { type: "string", positional: 0, required: true, input: true, description: "what to do" },
    tools: {
      type: "string",
      flag: "tools",
      default: "read,write,edit",
      description: "comma-separated names, each of which must be in /bin",
    },
    model: { type: "string", flag: "model" },
    vendor: { type: "string", flag: "vendor", description: "which mounted provider to use" },
    system: { type: "string", flag: "system" },
    maxTokens: { type: "integer", flag: "max-tokens" },
    maxRounds: { type: "integer", flag: "max-rounds" },
    maxOutput: { type: "integer", flag: "max-output", description: "truncation length for one tool result" },
    toolTimeout: {
      type: "integer",
      flag: "tool-timeout-ms",
      default: 120000,
      description: "how long one tool call may run before it is killed and the model is told",
    },
    contextBudget: { type: "integer", flag: "context-budget" },
    policy: { type: "string", flag: "policy", description: "a rules file inside the namespace" },
    session: { type: "string", flag: "session" },
    resume: { type: "boolean", flag: "resume" },
    stream: { type: "boolean", flag: "stream", default: true },
    md: { type: "boolean", flag: "md", description: "render the reply as markdown while it streams" },
    verbose: { type: "boolean", flag: "verbose", description: "show each tool call and its result" },
    showThinking: { type: "boolean", flag: "show-thinking" },
    json: { type: "boolean", flag: "json" },
  },

  async run(ctx) {
    const { vfs, input, shell } = ctx;
    const out = (s) => shell.out(s);
    const err = (s) => shell.err(s);

    const result = await run(vfs, {
      prompt: input.task,
      system: input.system ?? null,
      tools: String(input.tools).split(",").map((s) => s.trim()).filter(Boolean),
      vendor: input.vendor ?? null,
      model: input.model ?? null,
      maxTokens: input.maxTokens ?? null,
      maxRounds: input.maxRounds ?? null,
      maxOutput: input.maxOutput ?? 8000,
      toolTimeoutMs: input.toolTimeout,
      contextBudget: input.contextBudget ?? 890000,
      policyFile: input.policy ?? null,
      stream: input.stream,
      markdown: input.md,
      showThinking: input.showThinking,
      sessionId: input.session ?? null,
      resume: input.resume ?? false,
      cwd: ctx.cwd,
      onText: (chunk) => out(chunk),
      onThinking: (chunk) => err(style.grey(chunk)),
      onTool: input.verbose
        ? ({ phase, name, input: args, result: res, is_error, ms }) => {
            if (phase === "call") {
              err(mark("run", `${style.bold(name)} ${style.dim(JSON.stringify(args ?? {}).slice(0, 160))}`) + "\n");
              return;
            }
            const lines = String(res ?? "").split("\n");
            const head = lines.slice(0, 5).join("\n");
            const more = lines.length > 5 ? `\n  …(${lines.length - 5} more lines)` : "";
            err(mark(is_error ? "warn" : "info", `${style.dim(`${ms}ms`)}`) + "\n");
            // four backticks so a result containing a fence cannot end the block early
            err(style.dim("````") + "\n" + head + more + "\n" + style.dim("````") + "\n");
          }
        : null,
      onNote: (m) => err(style.dim(m) + "\n"),
    });

    if (input.json) return result;

    // the text already streamed; the caller wants a summary line, not the reply again
    if (input.stream) {
      const bits = [
        `${result.rounds} round${result.rounds === 1 ? "" : "s"}`,
        `${result.tool_calls} tool call${result.tool_calls === 1 ? "" : "s"}`,
        `${result.total_input} in · ${result.total_output} out`,
      ];
      if (result.folds.length) bits.push(`${result.folds.length} fold${result.folds.length === 1 ? "" : "s"}`);
      if (result.session) bits.push(`session ${result.session}`);
      err(style.dim("  " + bits.join(" · ")) + "\n");
      return null;
    }
    return result.text;
  },
});
