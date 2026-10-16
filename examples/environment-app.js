// Run with: node examples/environment-app.js
// A complete local application: resource-backed context and tool metadata, explicit
// trusted adapters, and a run observer with a separate permission view.
import { Vfs } from "js-agent/kernel";
import { createEnvironment } from "js-agent/runtime";

const resources = new Vfs();
await resources.mount("mem", "/");
await resources.mkdirp("/models");
await resources.mkdirp("/tools/lookup");
await resources.mkdirp("/workspace");
await resources.write("/models/reviewer.json", JSON.stringify({ provider: "offline-fixture", model: "reviewer" }), { create: true });
await resources.write("/tools/lookup/definition.json", JSON.stringify({
  name: "lookup",
  description: "Read one explicitly named workspace resource.",
  input_schema: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  },
  entry: "entry.js",
}), { create: true });
await resources.write("/workspace/brief.md", "The adapter boundary should be visible.\n", { create: true });

const environment = createEnvironment({
  resources,
  model: {
    path: "/models/reviewer",
    adapter: {
      async request(request, { resources: modelResources }) {
        // The host adapter gets its own resource view. It does not receive the agent view.
        await modelResources.read("/models/reviewer.json");
        if (request.messages.length === 1) {
          return {
            content: [{ type: "tool_use", id: "lookup-1", name: "lookup", input: { path: "/workspace/brief.md" } }],
            stop_reason: "tool_use",
          };
        }
        return { content: [{ type: "text", text: request.messages.at(-1).content[0].content }] };
      },
    },
  },
  tools: {
    // This catalog is the run's complete tool set. Nothing is discovered implicitly.
    paths: ["/tools/lookup"],
    adapters: [{
      path: "/tools/lookup",
      async invoke({ input, resources: toolResources }) {
        return toolResources.read(input.path);
      },
    }],
  },
  permissions: {
    agent: [{ path: "/workspace/**", operations: ["read"] }],
    model: [{ path: "/models/reviewer.json", operations: ["read"] }],
    tools: [
      { path: "/workspace/**", operations: ["read"] },
      { path: "/tools/**", operations: ["read"] },
    ],
    observer: [{ path: "/runs/**", operations: ["stat", "list", "read"] }],
  },
});

const result = await environment.run({
  agent: {
    model: "/models/reviewer",
    context: ["/workspace/brief.md"],
    tools: ["/tools/lookup"],
  },
  input: "Read the brief.",
  id: "environment-demo-root",
  continuationId: "environment-demo-continuation",
});
const observed = await environment.observe.inspect(result.root.id);

console.log(JSON.stringify({
  catalog: (await environment.catalog()).map(({ path, name }) => ({ path, name })),
  status: result.status,
  response: result.continuation.response.content,
  observed: observed.status,
  adapterBoundary: environment.describe().adapterBoundary,
}, null, 2));
