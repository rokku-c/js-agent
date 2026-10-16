// Run: node examples/streaming-model.js
// Offline, real SSE through a mounted fake model. The service owns the executable
// handle; Environment's resource views never receive open() or transport authority.
import { Vfs } from "js-agent/kernel";
import { consumeModelStream, createEnvironment, createServiceAuthority } from "js-agent/runtime";

const resources = new Vfs();
await resources.mount("mem", "/");
await resources.mount("ai", "/models", { vendor: "fake", script: JSON.stringify([
  { content: [
    { type: "text", text: "Looking up the brief. " },
    { type: "tool_use", id: "lookup-1", name: "lookup", input: { path: "/workspace/brief.md" } },
  ], stop_reason: "tool_use" },
  { content: [{ type: "text", text: "Streams complete explicitly; partial output stays provisional." }], stop_reason: "end_turn" },
]) });
const modelPath = "/models/type/api/fake/messages/model/fake-1";
await resources.mkdirp("/tools/lookup");
await resources.mkdirp("/workspace");
await resources.write("/workspace/brief.md", "A partial tool call must never run.", { create: true });
await resources.write("/tools/lookup/definition.json", JSON.stringify({
  name: "lookup", description: "Read the brief", entry: "entry.js",
  input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
}), { create: true });

let requests = 0, toolCalls = 0;
const seen = [];
const services = createServiceAuthority({
  async "model.stream"(request, { signal }) {
    requests++;
    const handle = await resources.open(modelPath, "r+");
    try {
      return await handle.stream(request, { signal, async onEvent(event) {
        seen.push(event.type);
        if (event.type === "text_delta") process.stdout.write(event.text);
        // An async UI renderer can await its work here; reads respect its pace.
        await Promise.resolve();
      } });
    } finally { await handle.close(); }
  },
  async "model.partial"(_request, { signal }) {
    requests++;
    return consumeModelStream((async function* () {
      yield { type: "message_start" };
      yield { type: "block_start", index: 0, kind: "tool_use", id: "unfinished", name: "lookup" };
      yield { type: "tool_input_delta", index: 0, json: '{"path":' };
      // Clean EOF is still an incomplete response: no message_stop arrived.
    })(), { signal });
  },
}, { grants: ["model.stream", "model.partial"] });

const environment = (service) => createEnvironment({
  resources, services,
  model: { path: modelPath, serviceGrants: [service], adapter: {
    request: (request, { services, signal }) => services.call(service, request, { signal }),
  } },
  tools: { paths: ["/tools/lookup"], adapters: [{ path: "/tools/lookup", async invoke({ input, resources }) {
    toolCalls++;
    return resources.read(input.path);
  } }] },
  permissions: {
    tools: [{ path: "/tools/**", operations: ["read"] }, { path: "/workspace/**", operations: ["read"] }],
    observer: [{ path: "/runs/**", operations: ["read", "list", "stat"] }],
  },
});
const complete = environment("model.stream");
const result = await complete.run({
  agent: { model: modelPath, tools: ["/tools/lookup"] }, input: "Read the brief.",
  id: "stream-root", continuationId: "stream-continuation",
});
const partial = environment("model.partial");
let failure;
try {
  await partial.run({ agent: { model: modelPath, tools: ["/tools/lookup"] }, input: "Partial request", id: "stream-partial" });
} catch (error) {
  failure = { code: error.code, outcome: error.outcome, partialResponse: error.partialResponse };
}
console.log("\n" + JSON.stringify({
  completed: result.status,
  requests, toolCalls,
  incrementalTextEvents: seen.filter((type) => type === "text_delta").length,
  toolArgumentEvents: seen.filter((type) => type === "tool_input_delta").length,
  partialStatus: (await partial.observe.inspect("stream-partial")).status.status,
  failure,
}, null, 2));
