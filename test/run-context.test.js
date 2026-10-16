import { test } from "node:test";
import assert from "node:assert/strict";
import { namespace, fakeScript, calls, says } from "./helpers.js";
import { defineTool } from "../src/core/tools.js";
import { invokeTool } from "../src/core/execute.js";
import { Policy } from "../src/core/policy.js";
import { createRunContext, deriveChildContext } from "../src/core/run-context.js";
import { run } from "../src/core/agent.js";
import task from "../src/tools/task.js";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const probe = defineTool({
  name: "probe",
  description: "test tool",
  params: {},
  async run({ context, signal }) {
    await wait(context.session === "a" ? 15 : 1);
    return {
      session: context.session,
      depth: context.depth,
      maxDepth: context.maxDepth,
      tools: context.tools,
      signalMatches: signal === context.signal,
    };
  },
});

test("overlapping tool calls keep context and policy isolated", async () => {
  const vfs = await namespace();
  const controllerA = new AbortController();
  const controllerB = new AbortController();
  const denied = new Policy({
    version: 1,
    default: "allow",
    rules: [{ match: { tool: "probe" }, action: "deny", reason: "run A" }],
  });
  const allowed = new Policy({ version: 1, default: "allow", rules: [] });
  const contextA = createRunContext({
    tools: ["probe"], policy: denied, session: "a", depth: 4, maxDepth: 5, signal: controllerA.signal,
  });
  const contextB = createRunContext({
    tools: ["probe"], policy: allowed, session: "b", depth: 1, maxDepth: 2, signal: controllerB.signal,
  });

  const [a, b] = await Promise.all([
    invokeTool({ vfs, tool: probe, input: {}, context: contextA }),
    invokeTool({ vfs, tool: probe, input: {}, context: contextB }),
  ]);

  assert.equal(a.ok, false);
  assert.match(a.block.content, /policy denied/);
  assert.equal(b.ok, true);
  assert.deepEqual(b.value, {
    session: "b",
    depth: 1,
    maxDepth: 2,
    tools: ["probe"],
    signalMatches: true,
  });
  assert.equal(Object.isFrozen(contextB), true);
  assert.equal(Object.isFrozen(contextB.tools), true);
});

test("overlapping run calls keep nested task authority separate", async () => {
  const vfs = await namespace({
    tools: ["read", "task"],
    mounts: [
      fakeScript(
        calls("task", { prompt: "A", tools: ["read"] }),
        calls("task", { prompt: "B", tools: ["read"] }),
        says("child B completed"),
      ),
    ],
  });
  const denyTask = new Policy({
    version: 1,
    default: "allow",
    rules: [{ match: { tool: "task" }, action: "deny", reason: "run A" }],
  });
  const allow = new Policy({ version: 1, default: "allow", rules: [] });
  const contextA = createRunContext({ tools: ["task"], policy: denyTask, session: "a", maxDepth: 2 });
  const contextB = createRunContext({ tools: ["task", "read"], policy: allow, session: "b", maxDepth: 2 });
  const options = { stream: false, maxRounds: 1, noSave: true, onNote: () => {} };

  const [a, b] = await Promise.all([
    run(vfs, { ...options, context: contextA, prompt: "outer A" }),
    run(vfs, { ...options, context: contextB, prompt: "outer B" }),
  ]);

  assert.match(a.canonical[2].content[0].content, /policy denied/);
  assert.match(b.canonical[2].content[0].content, /child B completed/);
  assert.equal(a.session, null);
  assert.equal(b.session, null);
});

test("in-process tools receive the run signal", async () => {
  const vfs = await namespace();
  const controller = new AbortController();
  let received;
  const tool = defineTool({
    name: "signal-probe",
    description: "test tool",
    params: {},
    async run({ context, signal }) {
      received = { context, signal };
      return "ok";
    },
  });
  const context = createRunContext({ tools: ["signal-probe"], signal: controller.signal });
  const result = await invokeTool({ vfs, tool, input: {}, context, inProcess: true });
  assert.equal(result.ok, true);
  assert.equal(received.context, context);
  assert.equal(received.signal, controller.signal);
});

test("nested tasks inherit the ceiling and cannot raise max depth", async () => {
  const vfs = await namespace({
    tools: ["read", "ls", "js", "task"],
    mounts: [
      fakeScript(
        calls("task", { prompt: "nested", tools: ["task", "read", "ls", "js"], maxDepth: 99 }),
        says("child handled the refusal"),
      ),
    ],
  });
  const context = createRunContext({
    tools: ["task", "read", "ls", "js"],
    maxDepth: 1,
    depth: 0,
    session: "parent",
  });

  const result = await task.run({
    vfs,
    cwd: "/",
    context,
    input: {
      prompt: "delegate",
      tools: ["task", "read", "ls", "js"],
      maxDepth: 99,
      maxRounds: 3,
      json: true,
    },
  });

  assert.match(result.text, /child handled the refusal/);
  assert.equal(result.rounds, 2, "the child called task and then handled its error");
  const child = deriveChildContext(context, { tools: ["task"], maxDepth: 99 });
  assert.equal(child.maxDepth, 1);
  assert.throws(() => deriveChildContext(child, { tools: ["task"], maxDepth: 99 }), /depth 1/);
});
