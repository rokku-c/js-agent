// Run with: node examples/getting-started.js
// A small, offline end-to-end application using only the public package exports.
import { Vfs } from "js-agent/kernel";
import { createEnvironment, createRunObserver } from "js-agent/runtime";

const resources = new Vfs();
await resources.mount("mem", "/");
await resources.mkdirp("/models");
await resources.mkdirp("/tools/read");
await resources.mkdirp("/workspace");
await resources.write("/models/reviewer.json", "{}", { create: true });
await resources.write("/tools/read/definition.json", JSON.stringify({
  name: "read",
  description: "Read a workspace file.",
  input_schema: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  },
  entry: "entry.js",
}), { create: true });
await resources.write("/workspace/brief.txt", "Use explicit resource permissions.\n", { create: true });

const environment = createEnvironment({
  resources,
  model: {
    path: "/models/reviewer",
    adapter: {
      async request(request) {
        if (request.messages.length === 1) {
          return {
            content: [{ type: "tool_use", id: "read-1", name: "read", input: { path: "/workspace/brief.txt" } }],
            stop_reason: "tool_use",
          };
        }
        return {
          content: [{ type: "text", text: request.messages.at(-1).content[0].content }],
          stop_reason: "end_turn",
        };
      },
    },
  },
  tools: {
    paths: ["/tools/read"],
    adapters: [{
      path: "/tools/read",
      async invoke({ input, resources: toolResources }) {
        return toolResources.read(input.path);
      },
    }],
  },
  permissions: {
    agent: [{ path: "/workspace/**", operations: ["read"] }],
    model: [],
    tools: [
      { path: "/tools/**", operations: ["read"] },
      { path: "/workspace/**", operations: ["read"] },
    ],
    observer: [{ path: "/runs/**", operations: ["stat", "list", "read"] }],
  },
});

const result = await environment.run({
  agent: {
    model: "/models/reviewer",
    context: ["/workspace/brief.txt"],
    tools: ["/tools/read"],
  },
  input: "Read the brief and repeat it.",
  id: "getting-started-root",
  continuationId: "getting-started-continuation",
});

const observer = createRunObserver(resources, { interval: 1 });
const snapshot = await observer.snapshot(result.root.id);
console.log(JSON.stringify({
  status: result.status,
  answer: result.continuation.response.content[0].text,
  observed: { status: snapshot.status, events: snapshot.events.map(({ kind }) => kind) },
}, null, 2));
