// Run with: node examples/workflow-harness.js
// A deterministic, offline multi-step workflow: two model tool calls, one continuation,
// and two independent workflows sharing the same RunStore.
import { Vfs } from "../src/kernel/vfs.js";
import { createRunStore } from "../src/core/run-store.js";
import { inspectInvocation, runWorkflow } from "../src/core/workflow-harness.js";

const storage = new Vfs();
await storage.mount("mem", "/");
const store = createRunStore(storage);
const tools = [
  { path: "/tools/read", name: "read", description: "Read a fixture", input_schema: { type: "object" } },
  { path: "/tools/count", name: "count", description: "Count a fixture", input_schema: { type: "object" } },
];
const agent = { model: "/models/fake", tools: tools.map((tool) => tool.path) };
const transcript = [];
const trace = [];

const model = {
  path: "/models/fake",
  async request(request) {
    const prompt = request.messages[0].content;
    const key = prompt.includes("alpha") ? "alpha" : "beta";
    transcript.push({ key, messages: request.messages });
    if (request.messages.length === 1) {
      return {
        id: `response-${key}-tools`,
        content: [
          { type: "tool_use", id: `${key}-read`, name: "read", input: { path: `/fixtures/${key}.txt` } },
          { type: "tool_use", id: `${key}-count`, name: "count", input: { path: `/fixtures/${key}.txt` } },
        ],
      };
    }
    const results = request.messages.at(-1).content;
    return {
      id: `response-${key}-done`,
      content: [{ type: "text", text: `${key} complete: ${results.map((result) => result.content).join(" | ")}` }],
    };
  },
};

const toolAdapters = {
  async read({ input }) {
    await new Promise((resolve) => setTimeout(resolve, 12));
    return `read:${input.path}`;
  },
  async count({ input }) {
    await new Promise((resolve) => setTimeout(resolve, 2));
    return `count:${input.path}`;
  },
};

const [alpha, beta] = await Promise.all(["alpha", "beta"].map((key) => runWorkflow({
  storage,
  resources: {},
  agent,
  input: `investigate ${key}`,
  model,
  tools,
  store,
  toolAdapters,
  id: `${key}-root`,
  continuationId: `${key}-child`,
  trace,
})));

function transcriptFor(key) {
  return transcript
    .filter((turn) => turn.key === key)
    .map((turn) => turn.messages.map(({ role, content }) => ({ role, content })));
}

function stateFor(rootId, childId) {
  return Promise.all([inspectInvocation(storage, rootId), inspectInvocation(storage, childId)]).then(([root, child]) => ({
    root: {
      id: root.id,
      status: root.status.status,
      events: root.events.map(({ seq, kind }) => ({ seq, kind })),
      response: root.response,
    },
    child: {
      id: child.id,
      status: child.status.status,
      parent: child.plan.parent,
      events: child.events.map(({ seq, kind }) => ({ seq, kind })),
      response: child.response,
    },
  }));
}

console.log(JSON.stringify({
  workflows: [
    { id: "alpha", status: alpha.status, transcript: transcriptFor("alpha"), state: await stateFor("alpha-root", "alpha-child") },
    { id: "beta", status: beta.status, transcript: transcriptFor("beta"), state: await stateFor("beta-root", "beta-child") },
  ],
  toolTrace: trace.map(({ event, runId, toolUseId, name, ok }) => ({ event, runId, toolUseId, name, ...(ok === undefined ? {} : { ok }) })),
}, null, 2));
