import { test } from "node:test";
import assert from "node:assert/strict";

import { loadToolDefinition, loadToolResource, toolCatalog } from "../src/core/tool-resource.js";

function resources(definitions, { revisions = {}, onRead } = {}) {
  const reads = [];
  return {
    reads,
    async read(path, options) {
      reads.push({ path, options });
      onRead?.(path, options);
      if (!Object.hasOwn(definitions, path)) {
        const error = new Error(`missing ${path}`);
        error.code = "ENOENT";
        throw error;
      }
      return definitions[path];
    },
    async stat(path) {
      return { revision: revisions[path] };
    },
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

test("loads a normalized tool directory and forwards resource options", async () => {
  const store = resources({ "/tools/echo/definition.json": valid }, { revisions: { "/tools/echo": "rev-1" } });
  const definition = await loadToolDefinition(store, "/tools/./echo/", {
    view: "view-1",
    revision: "rev-1",
    maxBytes: 4096,
    signal: null,
  });

  assert.equal(definition.path, "/tools/echo");
  assert.equal(definition.revision, "rev-1");
  assert.equal(definition.entry, "entry.js");
  assert.deepEqual(store.reads[0], {
    path: "/tools/echo/definition.json",
    options: { encoding: "utf8", maxBytes: 4096, signal: null, view: "view-1", revision: "rev-1" },
  });
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

test("requires absolute canonical tool paths", async () => {
  const store = resources({ "/tools/echo/definition.json": valid });
  await assert.rejects(() => loadToolDefinition(store, "tools/echo"), /absolute path/);
  await assert.rejects(() => loadToolDefinition(store, "/tools"), /\/tools\/<name>/);
  await assert.rejects(() => loadToolDefinition(store, "/other/echo"), /\/tools\/<name>/);
});

test("deep-freezes the descriptor and its schema", async () => {
  const definition = await loadToolDefinition(resources({ "/tools/echo/definition.json": valid }), "/tools/echo");
  assert.equal(Object.isFrozen(definition), true);
  assert.equal(Object.isFrozen(definition.input_schema), true);
  assert.equal(Object.isFrozen(definition.input_schema.properties), true);
  assert.throws(() => { definition.name = "changed"; }, TypeError);
  assert.throws(() => { definition.input_schema.properties.value.type = "number"; }, TypeError);
});

test("does not read or execute entry.js without a trusted adapter", async () => {
  const store = resources({ "/tools/echo/definition.json": valid, "/tools/echo/entry.js": "throw new Error('must not run')" });
  const definition = await loadToolResource(store, "/tools/echo");
  assert.equal(definition.invoke, undefined);
  assert.equal(Object.hasOwn(definition, "entry"), false);
  assert.deepEqual(store.reads.map(({ path }) => path), ["/tools/echo/definition.json"]);
});

test("binds only an explicit trusted invoke adapter", async () => {
  const calls = [];
  const adapter = async (input, context) => {
    calls.push({ input, context });
    return input.value;
  };
  const definition = await loadToolResource(
    resources({ "/tools/echo/definition.json": valid }, { revisions: { "/tools/echo": "r" } }),
    "/tools/echo",
    { invokeAdapters: { echo: adapter }, revision: "r" },
  );
  assert.equal(await definition.invoke({ value: "ok" }, { signal: "s" }), "ok");
  assert.deepEqual(calls[0].context, { signal: "s", path: "/tools/echo", revision: "r", view: undefined });
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
