import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { readFile } from "node:fs/promises";
import { Vfs } from "js-agent/kernel";
import * as runtime from "js-agent/runtime";

const publicFunctions = [
  "InMemoryConnector",
  "assembleContinuationRequest",
  "bindToolResource",
  "buildContinuation",
  "consumeModelStream",
  "continueOnce",
  "createEnvironment",
  "createGitRevisionConnector",
  "createInMemoryConnector",
  "createRunObserver",
  "createRunStore",
  "createServiceAuthority",
  "createView",
  "createWorkflowGraph",
  "executeToolCalls",
  "inspectInvocation",
  "inspectWorkflowGraph",
  "invokeOnce",
  "loadToolDefinition",
  "resolveArguments",
  "resolveReference",
  "runWorkflow",
  "toolCatalog",
];

async function durableStorage() {
  const directory = await mkdtemp(`${tmpdir()}/js-agent-public-contract-`);
  const storage = new Vfs();
  await storage.mount("hostfs", "/", { source: directory, mode: "rw" });
  return { directory, storage };
}

async function* stream(text) {
  yield { type: "message_start", id: "fixture", model: "offline" };
  yield { type: "block_start", index: 0, kind: "text" };
  yield { type: "text_delta", index: 0, text };
  yield { type: "block_stop", index: 0 };
  yield { type: "message_delta", usage: { output_tokens: 1 }, stop_reason: "end_turn" };
  yield { type: "message_stop" };
}

test("runtime exports have matching typed declarations", async () => {
  const declaration = await readFile(new URL("../docs/runtime-api.d.ts", import.meta.url), "utf8");
  const declared = new Set([...declaration.matchAll(/export declare (?:function|class) (\w+)/g)].map((match) => match[1]));
  assert.deepEqual([...declared].sort(), publicFunctions.sort());
  for (const name of publicFunctions) assert.equal(typeof runtime[name], "function", name);
});

test("public contract runs a durable streamed model through separate resource views", async () => {
  const resources = new Vfs();
  await resources.mount("mem", "/");
  await resources.mkdirp("/workspace");
  await resources.write("/workspace/brief.txt", "keep this private\n", { create: true });

  const { directory, storage } = await durableStorage();
  try {
    const store = runtime.createRunStore(storage, { root: "/runs", mode: "durable" });
    const environment = runtime.createEnvironment({
      resources,
      storage,
      store,
      model: {
        path: "/models/offline",
        adapter: {
          async request(request, { signal }) {
          assert.match(request.messages[0].content, /private prompt/);
            return runtime.consumeModelStream(stream("streamed answer\n"), { signal });
          },
        },
      },
      permissions: {
        agent: [{ path: "/workspace/**", operations: ["read"] }],
        observer: [{ path: "/runs/**", operations: ["stat", "list", "read"] }],
      },
    });

    const result = await environment.run({
      agent: { model: "/models/offline", context: ["/workspace/brief.txt"] },
      input: "private prompt",
      id: "public-contract-run",
    });
    assert.equal(result.status, "completed");
    assert.equal(result.root.response.content[0].text, "streamed answer\n");
    assert.deepEqual(environment.describe().runs, {
      root: "/runs",
      storage: "run-store",
      mode: "durable",
      recovery: true,
      observer: { redacted: true, volatile: true },
    });

    const snapshot = await environment.observer.snapshot("public-contract-run");
    assert.equal(snapshot.status, "completed");
    assert.equal(snapshot.storage, "durable");
    assert.equal(snapshot.redacted, true);
    assert.equal(snapshot.volatile, true);
    assert.equal("request" in snapshot, false);
    assert.equal("response" in snapshot, false);
    assert.deepEqual(snapshot.events.map(({ kind }) => kind), ["started", "completed"]);

    const persistedRequest = await storage.read("/runs/public-contract-run/request.json");
    assert.match(persistedRequest, /private prompt/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("resource and stream contracts fail closed", async () => {
  const resources = new Vfs();
  await resources.mount("mem", "/");
  await resources.write("/secret", "hidden", { create: true });
  const reader = runtime.createView(resources, { grants: [{ path: "/secret", operations: ["read"] }] });
  assert.equal(await reader.read("/secret"), "hidden");
  await assert.rejects(() => reader.write("/secret", "changed"), { code: "EACCES" });
  async function* truncated() {
    yield { type: "message_start" };
    yield { type: "block_start", index: 0, kind: "text" };
    yield { type: "text_delta", index: 0, text: "truncated" };
  }
  await assert.rejects(() => runtime.consumeModelStream(truncated()), { code: "EINCOMPLETE", outcome: "unknown" });
});
