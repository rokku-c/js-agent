// Run with: node examples/workflow-graph.js
// A deterministic persisted graph: one root request, two keyed branches, and a join.
import { Vfs } from "../src/kernel/vfs.js";
import { createRunStore } from "../src/core/run-store.js";
import { createWorkflowGraph } from "../src/core/workflow-graph.js";

const storage = new Vfs();
await storage.mount("mem", "/");
const store = createRunStore(storage);
const agent = { model: "/models/fake", system: [], context: [], tools: [] };
const model = {
  path: "/models/fake",
  async request(request) {
    if (request.messages.length === 1) {
      return {
        id: "root-response",
        content: ["left", "right"].map((branch) => ({
          type: "tool_use", id: `tool-${branch}`, name: "branch", input: { branch },
        })),
      };
    }
    return { content: [{ type: "text", text: `completed:${request.messages.at(-1).content[0].tool_use_id}` }] };
  },
};
const graph = createWorkflowGraph({ storage, store });
const result = await graph.run({
  id: "example-graph",
  root: { agent, input: "fan out", model, toolAdapters: {
    branch: async ({ input }) => `prepared:${input.branch}`,
  } },
  branches: [
    { branchKey: "left", agent, model },
    { branchKey: "right", agent, model },
  ],
});
console.log(JSON.stringify({
  graphId: result.graphId,
  status: result.status,
  nodes: result.graph.nodes.map(({ key, kind, status, parents, children }) => ({ key, kind, status, parents, children })),
  edges: result.graph.edges.map(({ key, status }) => ({ key, status })),
}, null, 2));
