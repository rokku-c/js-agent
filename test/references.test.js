import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveArguments, resolveReference } from "../src/core/references.js";

function facade(initial, { deny = false } = {}) {
  const files = new Map(Object.entries(initial));
  return {
    files,
    async read(path) {
      if (deny) {
        const error = new Error("permission denied");
        error.code = "EACCES";
        throw error;
      }
      if (!files.has(path)) throw new Error(`missing ${path}`);
      return new TextEncoder().encode(files.get(path));
    },
  };
}

async function digest(text) {
  const bytes = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

test("resolves exact inclusive UTF-8 line ranges and records hashes", async () => {
  const resources = facade({ "/doc": "zero\nβeta\nthird\n" });
  const result = await resolveReference(resources, { $ref: "/doc", selector: { lines: [2, 3] } });

  assert.equal(result.value, "βeta\nthird\n");
  assert.deepEqual(result.provenance.requested, {
    $ref: "/doc",
    mode: "live",
    selector: { lines: [2, 3] },
  });
  assert.equal(result.provenance.contentHash, await digest("zero\nβeta\nthird\n"));
  assert.equal(result.provenance.selectedHash, await digest("βeta\nthird\n"));
  assert.equal(result.provenance.bytes, new TextEncoder().encode("βeta\nthird\n").byteLength);
  assert.deepEqual(result.provenance.selector, { lines: [2, 3] });
  assert.match(result.provenance.resolvedAt, /^\d{4}-\d\d-\d\dT/);
});

test("enforces materialized UTF-8 byte caps and propagates facade permissions", async () => {
  const resources = facade({ "/unicode": "é" });
  await assert.rejects(() => resolveReference(resources, "/unicode", { maxBytes: 1 }), /maxBytes/);
  await assert.rejects(() => resolveReference(facade({ "/x": "x" }, { deny: true }), "/x"), (error) => {
    assert.equal(error.code, "EACCES");
    return true;
  });
});

test("live reads see mutation while pinned reads reject a changed full source", async () => {
  const resources = facade({ "/mutable": "one" });
  const pinnedRevision = (await resolveReference(resources, "/mutable")).provenance.contentHash;
  resources.files.set("/mutable", "two");

  assert.equal((await resolveReference(resources, "/mutable")).value, "two");
  await assert.rejects(
    () => resolveReference(resources, { $ref: "/mutable", mode: "pinned", revision: pinnedRevision }),
    (error) => error.code === "ESTALE"
  );
  assert.equal(
    (await resolveReference(resources, { $ref: "/mutable", mode: "pinned", revision: await digest("two") })).value,
    "two"
  );
});

test("resolveArguments resolves nested refs, keeps strings literal, and unwraps literal escapes", async () => {
  const resources = facade({ "/name": "Ada", "/rules": "be precise" });
  const input = {
    greeting: "/name",
    nested: [{ $ref: "/name" }, { $literal: { $ref: "/rules", value: "literal" } }],
    rules: { $ref: "/rules" },
  };
  const result = await resolveArguments(resources, input);

  assert.deepEqual(result.value, {
    greeting: "/name",
    nested: ["Ada", { $ref: "/rules", value: "literal" }],
    rules: "be precise",
  });
  assert.equal(result.provenance.length, 2);
  assert.deepEqual(result.provenance.map((entry) => entry.requested.$ref), ["/name", "/rules"]);
});

test("rejects unknown fields, invalid ranges, cycles, and unsafe depth", async () => {
  const resources = facade({ "/x": "x" });
  await assert.rejects(() => resolveReference(resources, { $ref: "/x", query: "anything" }), /unknown reference field/);
  await assert.rejects(() => resolveReference(resources, { $ref: "/x", selector: { lines: [2, 1] } }), /inclusive/);
  await assert.rejects(() => resolveReference(resources, { $ref: "/x", selector: { lines: [2, 2] } }), /outside/);

  const cycle = {};
  cycle.self = cycle;
  await assert.rejects(() => resolveArguments(resources, cycle), /cycle/);
  let deep = "x";
  for (let i = 0; i < 65; i++) deep = { value: deep };
  await assert.rejects(() => resolveArguments(resources, deep), /depth/);
});
