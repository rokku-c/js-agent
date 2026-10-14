// unit.test.js — the pure parts, which is to say the parts that are cheap to get wrong.

import { test } from "node:test";
import assert from "node:assert/strict";

import { normalize, join, relativeTo, isUnder, segments, basename, dirname } from "../src/kernel/paths.js";
import { VfsError, reason } from "../src/kernel/errors.js";
import { defineTool, validateInput, inputSchema, nearest } from "../src/core/tools.js";
import { parseSpec, formatSpec } from "../src/kernel/mounts.js";
import { clamp, window as lineWindow, decodeText, countLines, lineEnding } from "../src/core/fileio.js";
import { render as mdRender, streamStep, streamFlush } from "../src/core/markdown.js";
import calc from "../src/tools/calc.js";

test("paths: normalization", () => {
  assert.equal(normalize("a/b/../c"), "/a/c");
  assert.equal(normalize("/a//b/"), "/a/b");
  assert.equal(normalize("/a/./b"), "/a/b");
  assert.equal(normalize("/.."), "/", ".. above the root is the root, not an error");
  assert.equal(normalize(""), "/");
  assert.equal(join("/host", "a", "b"), "/host/a/b");
  assert.equal(basename("/a/b/c.txt"), "c.txt");
  assert.equal(dirname("/a/b/c.txt"), "/a/b");
  assert.deepEqual(segments("a/b/c"), ["a", "b", "c"]);
  assert.deepEqual(segments(""), []);
});

test("paths: containment is segment-wise, not string-wise", () => {
  // the bug this exists for: `/ab` starts with `/a` as a string and is not inside it
  assert.equal(isUnder("/a", "/a/b"), true);
  assert.equal(isUnder("/a", "/ab"), false);
  assert.equal(isUnder("/host", "/hostile"), false);
  assert.equal(isUnder("/", "/anything"), true);
  assert.equal(relativeTo("/host", "/host/a/b"), "a/b");
  assert.equal(relativeTo("/host", "/host"), "");
  assert.throws(() => relativeTo("/host", "/etc"));
});

test("errors: the message carries everything a model needs", () => {
  const e = new VfsError("ENETDOWN", "the driver has no transport", {
    path: "/dev/net/request",
    operation: "request",
    hint: "mount net:/dev/net",
  });
  assert.equal(e.code, "ENETDOWN");
  assert.equal(e.errno, 100);
  assert.match(e.message, /ENETDOWN: network is not mounted/);
  assert.match(e.message, /path=\/dev\/net\/request/);
  assert.match(e.message, /→ mount net:\/dev\/net/);
  // re-path on the way out of the kernel, so a caller never sees a driver's own relative
  // idea of where it was
  assert.equal(e.at("/dev/providers/x").path, "/dev/providers/x");
  assert.equal(reason(e).startsWith("ENETDOWN"), true);
});

test("tool declaration → JSON Schema, and the two readers agree", () => {
  const tool = defineTool({
    name: "demo",
    description: "does a thing",
    params: {
      path: { type: "string", positional: 0, required: true, description: "where" },
      count: { type: "integer", flag: "count", default: 3 },
      all: { type: "boolean", flag: "all" },
      body: { type: "string", flag: "body", input: true },
    },
    run: () => null,
  });
  const schema = inputSchema(tool);
  assert.equal(schema.type, "object");
  assert.deepEqual(schema.required, ["path"]);
  assert.equal(schema.properties.count.type, "integer");
  assert.equal(schema.properties.count.default, 3);
  assert.equal(schema.properties.all.type, "boolean");
  // a parameter the pipe may also fill is still shown to the model — hiding it would make
  // `cat f | write out` invisible
  assert.ok(schema.properties.body, "an input slot is still a declared parameter");
});

test("validateInput: flags are checked, never silently ignored", () => {
  const tool = defineTool({
    name: "demo",
    params: {
      path: { type: "string", positional: 0, required: true },
      limit: { type: "integer", flag: "limit", default: 10 },
      maxOutput: { type: "integer", flag: "max-output" },
    },
    run: () => null,
  });

  // spread, because the record is deliberately prototype-less — deepEqual from
  // node:assert/strict compares prototypes and would report a difference that is the point
  assert.deepEqual({ ...validateInput(tool, { path: "/x" }) }, { path: "/x", limit: 10 });

  // a typo is an error with a suggestion, not an ignored argument
  assert.throws(() => validateInput(tool, { path: "/x", limmit: 5 }), /unknown argument 'limmit'/);
  assert.throws(() => validateInput(tool, { path: "/x", limmit: 5 }), /did you mean --limit/);

  // the type comes from the declaration, so `1.0` stays the string it was typed as
  assert.equal(validateInput(tool, { path: "/x", limit: "7" }).limit, 7);
  assert.throws(() => validateInput(tool, { path: "/x", limit: "seven" }), /--limit takes a number/);

  // and a required argument says which position it was
  assert.throws(() => validateInput(tool, {}), /missing required argument 'path' \(the 1st argument\)/);
});

test("validateInput: the options object cannot be poisoned by a flag name", () => {
  const tool = defineTool({ name: "demo", params: { a: { type: "string", flag: "a" } }, run: () => null });
  // `--__proto__={…}` is an unknown argument, and it is unknown because the record it is
  // written into has no prototype to reach through
  assert.throws(() => validateInput(tool, JSON.parse('{"__proto__":{"polluted":1}}')), /unknown argument/);
  assert.equal({}.polluted, undefined);
  const built = validateInput(tool, { a: "ok" });
  assert.equal(Object.getPrototypeOf(built), null);
});

test("validateInput: short flags are opt-in, unambiguous, and resolve like their long form", () => {
  const tool = defineTool({
    name: "demo",
    params: {
      path: { type: "string", positional: 0, required: true },
      long: { type: "boolean", flag: "long", short: "l" },
      offset: { type: "integer", flag: "offset", short: "o" },
    },
    run: () => null,
  });
  assert.equal(validateInput(tool, { path: "/x", l: true }).long, true);
  assert.equal(validateInput(tool, { path: "/x", o: 3 }).offset, 3);

  // a short name that means two things is refused when the tool is *declared*, not when it
  // is called — it happened once, in this repository, and `-n` read as "limit" while
  // looking like "numbers"
  assert.throws(
    () =>
      defineTool({
        name: "clash",
        params: {
          numbers: { type: "boolean", flag: "numbers", short: "n" },
          limit: { type: "integer", flag: "limit", short: "n" },
        },
        run: () => null,
      }),
    /'n' names both 'numbers' and 'limit'/
  );

  // and so is a flag that collides with another parameter's name
  assert.throws(
    () =>
      defineTool({
        name: "clash2",
        params: {
          limit: { type: "integer", flag: "limit" },
          other: { type: "integer", flag: "limit" },
        },
        run: () => null,
      }),
    /'limit' names both/
  );
});

test("nearest: suggests only when it is close", () => {
  assert.equal(nearest("limmit", ["limit", "all"]), "limit");
  assert.equal(nearest("completely-different", ["limit", "all"]), null);
});

test("mount specs round-trip", () => {
  const s = parseSpec("hostfs:/host,source=.,mode=ro");
  assert.equal(s.driver, "hostfs");
  assertEquals(s.at, "/host");
  assert.equal(s.options.mode, "ro");
  assert.equal(formatSpec(s), "hostfs:/host,source=.,mode=ro");

  // a bare word is a switch
  assert.equal(parseSpec("hostfs:/h,ro").options.ro, true);

  // a value full of commas survives, because brackets are tracked as well as quotes —
  // this is what keeps `script=[{…},{…}]` from being shredded into a dozen options
  const withJson = parseSpec('ai:/dev/providers/ai,vendor=fake,script=[{"a":1,"b":2},{"c":3}]');
  assert.equal(withJson.options.script, '[{"a":1,"b":2},{"c":3}]');
  assert.equal(Object.keys(withJson.options).length, 2);
});

function assertEquals(a, b) {
  assert.equal(a, b);
}

test("fileio: clamping says so", () => {
  assert.equal(clamp("hello", 100), "hello");
  assert.match(clamp("hello world", 5), /^hello\n\.\.\.\(output truncated, was 11 chars\)$/);
});

test("fileio: a window names what it left out", () => {
  const text = "a\nb\nc\nd\ne\n";
  assert.equal(lineWindow(text, { offset: 1, limit: 2 }), "a\nb\n...(showing 1-2 of 5, 3 more)");
  assert.equal(lineWindow(text, { offset: 2, limit: 2, numbers: true }), "2\tb\n3\tc\n...(showing 2-3 of 5, 2 more)");
  assert.equal(lineWindow("", {}), "(empty file)");
  // numbering is absolute, because `edit --from` is
  assert.equal(lineWindow(text, { offset: 4, numbers: true }), "4\td\n5\te");
  assert.throws(() => lineWindow(text, { offset: 99 }), RangeError);
});

test("fileio: binary is decided by decoding, not by an extension", () => {
  assert.equal(decodeText(new TextEncoder().encode("hello")), "hello");
  assert.equal(decodeText(new Uint8Array([0xff, 0xfe, 0x00, 0x01])), null);
  assert.equal(countLines("a\nb\n"), 2);
  assert.equal(lineEnding("a\r\nb"), "\r\n");
});

test("calc: arithmetic, and nothing but", async () => {
  const run = async (expression) => (await calc.run({ input: { expression } })).value;
  assert.equal(await run("1 + 2 * 3"), 7);
  assert.equal(await run("(1 + 2) * 3"), 9);
  assert.equal(await run("2 ^ 10"), 1024, "^ binds tightest");
  assert.equal(await run("2 ^ 3 ^ 2"), 512, "^ is right-associative");
  assert.equal(await run("-3 + 1"), -2, "a leading minus is a sign, not an operator with no left side");
  assert.equal(await run("10 % 3"), 1);
  assert.equal(await run("1_000 + 1"), 1001);
  // there is no host object in the parse tree to reach
  await assert.rejects(() => run("process.exit(1)"), /cannot parse/);
  await assert.rejects(() => run("(1 + 2"), /unbalanced/);
});

test("markdown: renders, and never drops", () => {
  const out = mdRender("# Title\n\nsome **bold** and `code`\n\n- one\n- two\n\n```js\nconst a = 1;\n```");
  assert.match(out, /Title/);
  assert.match(out, /some bold and code/);
  // the bullet glyph, and the fence as an obvious block rather than as text
  assert.match(out, /• one/);
  assert.match(out, /const a = 1;/);
});

test("markdown: streaming holds an unfinished line back", () => {
  // a chunk that ends mid-fence must not be rendered and then rendered again
  let state = { buf: "", inFence: false };
  let printed = "";
  for (const chunk of ["## hea", "ding\n", "body ", "text\n"]) {
    const step = streamStep(state, chunk, false);
    state = step.state;
    printed += step.out;
  }
  const flushed = streamFlush(state, false);
  printed += flushed.out;
  assert.equal(printed, "heading\nbody text\n");
});
