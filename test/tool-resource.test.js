import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createView } from "../src/kernel/view.js";
import * as toolResources from "../src/core/tool-resource.js";

const { bindToolResource, loadToolDefinition, toolCatalog } = toolResources;

function resources(definitions, { onRead } = {}) {
  const reads = [];
  return {
    reads,
    async read(path, options) {
      reads.push({ path, options });
      await onRead?.(path, options);
      if (!Object.hasOwn(definitions, path)) {
        const error = new Error(`missing ${path}`);
        error.code = "ENOENT";
        throw error;
      }
      return definitions[path];
    },
    stat() { assert.fail("metadata loading must not stat resources"); },
  };
}

const valid = JSON.stringify({
  name: "echo",
  description: "Echo input",
  input_schema: {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
  },
  entry: "entry.js",
});
const hash = (body) => `sha256:${createHash("sha256").update(body).digest("hex")}`;

test("loads normalized absolute directories in any mount, including root", async () => {
  for (const [path, base] of [
    ["/custom//tools/../Echo/./", "/custom/Echo"],
    ["/tools", "/tools"],
    ["/../", "/"],
  ]) {
    const file = `${base === "/" ? "" : base}/definition.json`;
    const store = resources({ [file]: valid });
    const definition = await loadToolDefinition(store, path);
    assert.equal(definition.path, base);
    assert.equal(definition.revision, hash(valid));
    assert.equal(definition.entry, "entry.js");
    assert.deepEqual(store.reads.map(({ path }) => path), [file]);
  }
  const store = resources({});
  for (const path of ["tools/echo", "", null, 42]) {
    await assert.rejects(() => loadToolDefinition(store, path), /absolute path/);
  }
  assert.equal(store.reads.length, 0);
});

test("uses an exact read-only View grant without requiring stat authority", async () => {
  const store = resources({ "/mounted/echo/definition.json": valid });
  const view = createView(store, {
    grants: [{ path: "/mounted/echo/definition.json", operations: ["read"] }],
  });
  const definition = await loadToolDefinition(view, "/mounted/echo/");
  assert.equal(definition.revision, hash(valid));
  await assert.rejects(() => loadToolDefinition(view, "/outside"), { code: "EACCES" });
  assert.equal(store.reads.length, 1);
});

test("pins definition bytes by SHA-256 even when the provider ignores options", async () => {
  const files = { "/echo/definition.json": valid };
  const store = resources(files);
  const revision = hash(valid);
  assert.equal((await loadToolDefinition(store, "/echo", { revision })).revision, revision);
  files["/echo/definition.json"] = valid + "\n";
  await assert.rejects(() => loadToolDefinition(store, "/echo", { revision }), { code: "ESTALE" });
  assert.equal((await loadToolDefinition(store, "/echo")).revision, hash(valid + "\n"));
  for (const revision of ["git:abc", "sha256:abc", null, 42]) {
    await assert.rejects(() => loadToolDefinition(store, "/echo", { revision }), /sha256/);
  }
});

test("rejects malformed JSON and invalid definition fields", async () => {
  const cases = [
    ["{", /not valid JSON/],
    [JSON.stringify({ name: "echo", description: "x", input_schema: null }), /input_schema must be an object/],
    [JSON.stringify({ name: "echo", description: "x", input_schema: { type: "string" } }), /input_schema\.type/],
    [JSON.stringify({ name: "echo", description: "x", input_schema: { type: "object", properties: { value: "string" } } }), /properties\.value must be an object/],
    [JSON.stringify({ name: "echo", description: "x", input_schema: { type: "object", properties: [] } }), /properties must be an object/],
    [JSON.stringify({ name: "echo", description: "x", input_schema: { type: "object" }, extra: true }), /unknown tool definition field/],
  ];
  for (const [body, message] of cases) {
    const store = resources({ "/tools/echo/definition.json": body });
    await assert.rejects(() => loadToolDefinition(store, "/tools/echo"), message);
  }
});

test("deep-freezes the descriptor and its schema", async () => {
  const definition = await loadToolDefinition(resources({ "/tools/echo/definition.json": valid }), "/tools/echo");
  assert.equal(Object.isFrozen(definition), true);
  assert.equal(Object.isFrozen(definition.input_schema), true);
  assert.equal(Object.isFrozen(definition.input_schema.properties), true);
  assert.throws(() => { definition.name = "changed"; }, TypeError);
  assert.throws(() => { definition.input_schema.properties.value.type = "number"; }, TypeError);
});

test("exports metadata loaders only and never reads an entrypoint", async () => {
  assert.deepEqual(Object.keys(toolResources).sort(), ["bindToolResource", "loadToolDefinition", "toolCatalog"]);
  const store = resources({
    "/tools/echo/definition.json": valid,
    "/tools/echo/entry.js": "throw new Error('must not run')",
  });
  const definition = await loadToolDefinition(store, "/tools/echo");
  assert.equal(Object.hasOwn(definition, "invoke"), false);
  assert.equal(definition.entry, "entry.js");
  assert.deepEqual(store.reads.map(({ path }) => path), ["/tools/echo/definition.json"]);
});

test("binds entry source only through an explicit loader and returns the trusted adapter shape", async () => {
  const source = "export default async ({ input }) => `bound:${input.value}`;";
  const store = resources({
    "/tools/echo/definition.json": valid,
    "/tools/echo/entry.js": source,
  });
  await assert.rejects(
    () => bindToolResource(store, "/tools/echo"),
    /requires an explicit loader/,
  );
  assert.deepEqual(store.reads, []);

  let received;
  const binding = await bindToolResource(store, "/tools/echo", {
    loader({ source: entrySource, entryPath, definition, revision }) {
      received = { entrySource, entryPath, name: definition.name, revision };
      return async ({ input }) => `bound:${input.value}`;
    },
  });
  assert.deepEqual(received, {
    entrySource: source,
    entryPath: "/tools/echo/entry.js",
    name: "echo",
    revision: hash(source),
  });
  assert.equal(binding.path, "/tools/echo");
  assert.equal(binding.entryPath, "/tools/echo/entry.js");
  assert.equal(binding.entryRevision, hash(source));
  assert.equal(await binding.invoke({ input: { value: "ok" } }), "bound:ok");
  assert.deepEqual(store.reads.map(({ path }) => path), [
    "/tools/echo/definition.json",
    "/tools/echo/entry.js",
  ]);
});

test("binding never evaluates resource source or accepts a non-callable loader result", async () => {
  const source = "throw new Error('resource code must not run');";
  const store = resources({
    "/tools/unsafe/definition.json": valid.replaceAll("echo", "unsafe"),
    "/tools/unsafe/entry.js": source,
  });
  const binding = await bindToolResource(store, "/tools/unsafe", {
    loader({ source: entrySource }) {
      assert.equal(entrySource, source);
      return async () => "host-selected behavior";
    },
  });
  assert.equal(await binding.invoke({ input: {} }), "host-selected behavior");
  await assert.rejects(
    () => bindToolResource(store, "/tools/unsafe", { loader: () => ({}) }),
    { code: "EINVAL" },
  );
});

test("requires an entrypoint when explicitly binding a resource tool", async () => {
  const store = resources({
    "/tools/no-entry/definition.json": JSON.stringify({
      name: "no-entry",
      description: "Metadata only",
      input_schema: { type: "object" },
    }),
  });
  await assert.rejects(() => bindToolResource(store, "/tools/no-entry", {
    loader: () => async () => "never",
  }), { code: "EINVAL" });
  assert.deepEqual(store.reads.map(({ path }) => path), ["/tools/no-entry/definition.json"]);
});

test("builds an explicit catalog and rejects duplicate names", async () => {
  const body = (name) => JSON.stringify({ name, description: name, input_schema: { type: "object" } });
  const store = resources({
    "/tools/first/definition.json": body("first"),
    "/tools/second/definition.json": body("second"),
    "/tools/alias/definition.json": body("first"),
  });
  const catalog = await toolCatalog(store, ["/tools/first/", "/tools/second"]);
  assert.equal(Object.isFrozen(catalog), true);
  assert.deepEqual(catalog.map(({ name }) => name), ["first", "second"]);
  await assert.rejects(() => toolCatalog(store, ["/tools/first", "/tools/alias"]), { code: "EEXIST" });
});

test("snapshots catalog paths and options before the first awaited read", async () => {
  const second = valid.replace('"echo"', '"second"');
  const controller = new AbortController();
  const paths = ["/first", "/second/./"];
  const options = { maxBytes: 4096, signal: controller.signal };
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const store = resources({
    "/first/definition.json": valid,
    "/second/definition.json": second,
  }, { onRead: (path) => path === "/first/definition.json" ? gate : undefined });
  const pending = toolCatalog(store, paths, options);
  paths[1] = "/unselected";
  paths.push("/extra");
  options.maxBytes = 0;
  options.revision = hash("different content");
  options.signal = AbortSignal.abort();
  release();
  const catalog = await pending;
  assert.deepEqual(catalog.map(({ path }) => path), ["/first", "/second"]);
  assert.deepEqual(catalog.map(({ revision }) => revision), [hash(valid), hash(second)]);
  assert.ok(store.reads.every(({ options }) => options.signal === controller.signal));
});

test("snapshots single-definition options before the awaited read", async () => {
  const options = { revision: hash(valid), maxBytes: 4096 };
  const store = resources({ "/echo/definition.json": valid }, { onRead() {
    options.revision = hash("other");
    options.maxBytes = 0;
    options.signal = AbortSignal.abort();
  } });
  assert.equal((await loadToolDefinition(store, "/echo", options)).revision, hash(valid));
});

test("enforces byte limits and cancellation through the reference resolver", async () => {
  const bytes = new TextEncoder().encode(valid.replace("Echo input", "Echo β"));
  const store = resources({ "/echo/definition.json": bytes });
  assert.equal((await loadToolDefinition(store, "/echo", { maxBytes: bytes.length })).revision, hash(bytes));
  await assert.rejects(() => loadToolDefinition(store, "/echo", { maxBytes: bytes.length - 1 }), { code: "EOVERFLOW" });
  const controller = new AbortController();
  const reason = new Error("cancelled");
  controller.abort(reason);
  await assert.rejects(() => loadToolDefinition(store, "/echo", { signal: controller.signal }), (e) => e === reason);
  const duringRead = new AbortController();
  const cancelling = resources({ "/echo/definition.json": valid }, { onRead() { duringRead.abort(reason); } });
  await assert.rejects(() => loadToolDefinition(cancelling, "/echo", { signal: duringRead.signal }), (e) => e === reason);
});
