// node examples/connector-service-authority.js — offline; no credentials or network required.
import { pathToFileURL } from "node:url";
import { Vfs } from "js-agent/kernel";
import { createEnvironment } from "js-agent/runtime";

async function offlineTransport(_url, options) {
  const request = JSON.parse(options.body);
  return request.messages.length === 1
    ? { content: [{ type: "tool_use", id: "lookup-1", name: "lookup", input: { path: "/workspace/brief.md" } }], stop_reason: "tool_use" }
    : { content: [{ type: "text", text: request.messages.at(-1).content[0].content }] };
}

export async function createConnectorDemo({ transport = offlineTransport } = {}) {
  const resources = new Vfs();
  await resources.mount("mem", "/");
  for (const path of ["/models", "/tools/lookup", "/workspace", "/secrets"]) await resources.mkdirp(path);
  for (const [path, value] of Object.entries({
    "/models/default.json": JSON.stringify({ provider: "offline", operation: "model.request" }),
    "/tools/lookup/definition.json": JSON.stringify({
      name: "lookup", description: "Read the public brief.",
      input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    }),
    "/workspace/brief.md": "Only the brief is delegated to lookup.",
    "/workspace/internal.md": "Visible to the agent, but outside lookup's authority.",
    "/secrets/provider": "offline-test-credential",
  })) await resources.write(path, value, { create: true });

  return createEnvironment({
    resources,
    // These handlers and the injected transport are trusted host code. The
    // adapter can call the operation, but never receives this registry or Vfs.
    services: {
      "model.request": async (request, { signal } = {}) => {
        try {
          const credential = await resources.read("/secrets/provider");
          return await transport("https://model.example.invalid/v1/messages", {
            method: "POST", redirect: "error", signal,
            headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
            body: JSON.stringify(request),
          });
        } catch {
          // Transport errors can contain headers; do not propagate them to runs.
          throw Object.assign(new Error("Model service request failed"), { code: "ESERVICE" });
        }
      },
      "network.health": async () => ({ status: "offline" }),
    },
    model: {
      path: "/models/default",
      serviceGrants: ["model.request"],
      async adapter(request, { resources: view, services, signal }) {
        await view.read("/models/default.json");
        return services.call("model.request", request, { signal });
      },
    },
    tools: {
      paths: ["/tools/lookup"],
      adapters: [{
        path: "/tools/lookup",
        resourceGrants: [{ path: "/workspace/brief.md", operations: ["read"] }],
        serviceGrants: [],
        invoke: ({ input, resources: view }) => view.read(input.path),
      }],
    },
    permissions: {
      agent: [{ path: "/workspace/**", operations: ["read"] }],
      model: [{ path: "/models/default.json", operations: ["read"] }],
      tools: [
        { path: "/tools/**", operations: ["read"] },
        { path: "/workspace/**", operations: ["read"] },
      ],
      observer: [{ path: "/runs/**", operations: ["read", "stat", "list"] }],
    },
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const environment = await createConnectorDemo();
  const result = await environment.run({
    agent: { model: "/models/default", tools: ["/tools/lookup"] },
    input: "Read the public brief.",
    id: "service-demo", continuationId: "service-demo-continuation",
  });
  console.log(JSON.stringify({
    status: result.status,
    response: result.continuation.response.content,
    delegation: environment.describe().delegation,
  }, null, 2));
}
