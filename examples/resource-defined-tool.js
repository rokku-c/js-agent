// Run with: node examples/resource-defined-tool.js
// A resource-defined tool is loaded only by the explicit trusted loader below. The
// resulting binding is consumed by Environment and then by WorkflowGraph.
import { Vfs } from "js-agent/kernel";
import { createView } from "js-agent/runtime";
import { bindToolResource, createEnvironment, createRunStore, createWorkflowGraph } from "js-agent/runtime";

const agent = {
  model: "/models/reviewer",
  tools: ["/tools/prefix-read"],
};

const moduleFromSource = async ({ source }) => {
  // This loader is a host policy decision. A production host can replace it with a
  // sandboxed VM or a separately supervised worker.
  const encoded = Buffer.from(source, "utf8").toString("base64");
  const module = await import(`data:text/javascript;base64,${encoded}`);
  if (typeof module.default !== "function") throw new TypeError("entry.js must export default function");
  return module.default;
};

export async function createResourceToolApp() {
  const storage = new Vfs();
  await storage.mount("mem", "/");
  await storage.mkdirp("/models");
  await storage.mkdirp("/tools/prefix-read");
  await storage.mkdirp("/workspace");
  await storage.write("/tools/prefix-read/definition.json", JSON.stringify({
    name: "prefix-read",
    description: "Read a workspace file and prefix its text.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        prefix: { type: "string" },
      },
      required: ["path", "prefix"],
    },
    entry: "entry.js",
  }), { create: true });
  await storage.write("/tools/prefix-read/entry.js", `
export default async function ({ input, resources }) {
  const value = await resources.read(input.path);
  return input.prefix + value.trim();
}
`, { create: true });
  await storage.write("/workspace/brief.txt", "resource-backed behavior", { create: true });

  const toolView = createView(storage, {
    grants: [
      { path: "/tools/**", operations: ["read"] },
      { path: "/workspace/**", operations: ["read"] },
    ],
  });
  const binding = await bindToolResource(toolView, "/tools/prefix-read", { loader: moduleFromSource });
  const store = createRunStore(storage, { root: "/runs" });
  const model = {
    path: "/models/reviewer",
    async request(request) {
      if (request.messages.length === 1) {
        return {
          content: [{
            type: "tool_use",
            id: "prefix-read-1",
            name: "prefix-read",
            input: { path: "/workspace/brief.txt", prefix: "answer: " },
          }],
          stop_reason: "tool_use",
        };
      }
      return { content: [{ type: "text", text: request.messages.at(-2).content[0].content }] };
    },
  };
  const environment = createEnvironment({
    resources: storage,
    storage,
    store,
    model: { path: model.path, adapter: model },
    tools: { paths: ["/tools/prefix-read"], adapters: [binding] },
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
  return { environment, graph: createWorkflowGraph({ storage, store }), agent, binding };
}

export async function runResourceToolDemo() {
  const app = await createResourceToolApp();
  const workflow = await app.environment.prepareWorkflow({
    agent: app.agent,
    input: "Read the brief through the resource-defined tool.",
  });
  const started = await app.graph.startRoot({ graphId: "resource-tool", ...workflow });
  const finished = await app.graph.continueBranch({
    graphId: "resource-tool",
    branchKey: "answer",
    parent: started.root,
    parentResponse: started.root.response,
    toolResults: started.toolResults,
    agent: workflow.agent,
    model: workflow.model,
    tools: workflow.tools,
    input: "answer",
  });
  const graph = await app.graph.close("resource-tool");
  const report = {
    tool: { path: app.binding.path, entry: app.binding.entryPath, revision: app.binding.entryRevision },
    root: started.root.status,
    answer: finished.result.response.content[0].text,
    graph: graph.status,
  };
  console.log(JSON.stringify(report, null, 2));
  return report;
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  await runResourceToolDemo();
}
