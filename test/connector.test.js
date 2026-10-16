import { test } from "node:test";
import assert from "node:assert/strict";
import { createView } from "../src/kernel/view.js";
import { resolveReference } from "../src/core/references.js";
import { loadToolDefinition, toolCatalog } from "../src/core/tool-resource.js";
import { createRunStore } from "../src/core/run-store.js";
import { invokeOnce } from "../src/core/invocation.js";
import { Vfs } from "../src/kernel/vfs.js";
import { createInMemoryConnector } from "../src/connectors/in-memory.js";

const operations = ["stat", "list", "read", "write", "watch"];
const fullView = (connector) => createView(connector, {
  grants: [{ path: "/**", operations }],
});

function connector() {
  return createInMemoryConnector({
    source: "external-fixture",
    status: {
      state: "connected",
      provider: "fixture",
      endpoint: "in-memory://external",
      last_error: null,
    },
    resources: {
      "/ssh/build-server/workspace/src/main.js": {
        value: "export const answer = 42;\nexport const ready = true;\n",
        metadata: {
          provider: "ssh",
          externalId: "ssh://build-server/workspace/src/main.js",
          endpoint: "build-server",
          freshness: "read-through",
        },
      },
      "/notion/team/review-rules.md": {
        value: "Review behavior before style.\nReport reproducible evidence.\n",
        metadata: {
          provider: "notion",
          externalId: "page-review-rules",
          mimeType: "text/markdown",
          freshness: "synced",
        },
      },
      "/cloud/artifacts/build-123.json": {
        value: { build: 123, status: "green", artifact: "s3://bucket/build-123" },
        metadata: {
          provider: "cloud",
          externalId: "cloud://artifacts/build-123",
          region: "us-test-1",
          freshness: "eventual",
        },
      },
      "/cloud/tools/inspect/definition.json": {
        value: {
          name: "inspect-artifact",
          description: "Inspect a cloud artifact summary.",
          input_schema: {
            type: "object",
            properties: { artifact: { type: "string" } },
            required: ["artifact"],
          },
          entry: "entry.js",
        },
        metadata: {
          provider: "cloud",
          externalId: "cloud://tools/inspect",
          freshness: "synced",
        },
      },
      "/agents/reviewer.json": {
        value: {
          model: "/models/default",
          system: ["/notion/team/review-rules.md"],
          context: [
            { $ref: "/ssh/build-server/workspace/src/main.js", selector: { lines: [1, 2] } },
            "/cloud/artifacts/build-123.json",
          ],
          tools: ["/cloud/tools/inspect"],
        },
        metadata: { provider: "notion", externalId: "page-reviewer-agent" },
      },
    },
  });
}

test("external connector exposes files, provider metadata, status, and scoped watch", async () => {
  const source = connector();
  const resources = fullView(source);

  const stat = await resources.stat("/ssh/build-server/workspace/src/main.js");
  assert.equal(stat.type, "file");
  assert.equal(stat.resource.provider, "ssh");
  assert.equal(stat.resource.externalId, "ssh://build-server/workspace/src/main.js");
  assert.match(stat.revision, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(JSON.parse(await resources.read("/status.json")), source.status());
  assert.equal((await resources.list("/notion/team"))[0].name, "review-rules.md");

  const watch = resources.watch("/ssh/build-server/workspace", { includeInitial: true });
  assert.equal((await watch.next()).value.kind, "snapshot");
  await resources.write("/ssh/build-server/workspace/src/main.js", "export const answer = 43;\n", {
    revision: stat.revision,
  });
  const change = (await watch.next()).value;
  assert.deepEqual({ kind: change.kind, path: change.path }, {
    kind: "write",
    path: "/ssh/build-server/workspace/src/main.js",
  });
  await watch.return();

  const statusWatch = resources.watch("/status.json");
  await source.setStatus({ state: "degraded", provider: "fixture", last_error: "rate limited" });
  assert.equal((await statusWatch.next()).value.kind, "status");
  await statusWatch.return();
  assert.equal(JSON.parse(await resources.read("/status.json")).state, "degraded");

  const readOnly = resources.derive({
    grants: [{ path: "/ssh/**", operations: ["read"] }],
  });
  assert.throws(() => readOnly.watch("/ssh/build-server"), { code: "EACCES" });
});

test("live and pinned references work against an external file, with revision conflicts", async () => {
  const source = connector();
  const resources = fullView(source);
  const path = "/notion/team/review-rules.md";
  const initial = await resources.stat(path);
  const pinned = await resolveReference(resources, {
    $ref: path,
    mode: "pinned",
    revision: initial.revision,
  });
  assert.match(pinned.value, /behavior/);
  assert.equal(pinned.provenance.contentHash, initial.revision);

  await resources.write(path, "Changed rule.\n", { revision: initial.revision });
  assert.equal((await resolveReference(resources, path)).value, "Changed rule.\n");
  await assert.rejects(
    () => resolveReference(resources, { $ref: path, mode: "pinned", revision: initial.revision }),
    { code: "ESTALE" },
  );
  await assert.rejects(
    () => resources.write(path, "lost update", { revision: initial.revision }),
    { code: "ESTALE" },
  );
});

test("connector resources feed AgentSpec context and tool metadata through existing runtime", async () => {
  const resources = fullView(connector());
  const tools = await toolCatalog(resources, ["/cloud/tools/inspect"]);
  const definition = await loadToolDefinition(resources, "/cloud/tools/inspect");
  assert.equal(definition.name, "inspect-artifact");
  assert.match(definition.revision, /^sha256:/);

  const vfs = new Vfs();
  await vfs.mount("mem", "/", {});
  const store = createRunStore(vfs);
  let request;
  const model = {
    path: "/models/default",
    async request(value) {
      request = value;
      return { content: [{ type: "text", text: "reviewed" }] };
    },
  };
  const result = await invokeOnce({
    resources,
    agent: "/agents/reviewer.json",
    input: "Review the external build.",
    model,
    tools,
    store,
    id: "external-agent",
  });

  assert.equal(result.status, "completed");
  assert.match(request.system, /Review behavior before style/);
  assert.match(request.messages[0].content, /export const answer = 42/);
  assert.match(request.messages[0].content, /"artifact": "s3:\/\/bucket\/build-123"/);
  assert.deepEqual(request.tools.map(({ name }) => name), ["inspect-artifact"]);
  const plan = JSON.parse(await vfs.read("/runs/external-agent/plan.json"));
  assert.equal(plan.context[0].provenance.requested.$ref, "/ssh/build-server/workspace/src/main.js");
  assert.equal(plan.tools[0].path, "/cloud/tools/inspect");
});
