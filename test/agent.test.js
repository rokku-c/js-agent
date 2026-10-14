// agent.test.js — the loop, driven end to end with no network in the process.
//
// this is the suite the whole design is answerable to. it runs request → tool call → result
// → second round → final answer using the scripted dialect, so the claim "the model is a
// device and nothing here needs a socket" is tested rather than asserted.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { namespace, tmpdir, fakeScript, says, calls } from "./helpers.js";
import { run } from "../src/core/agent.js";
import { loadToolsFromBin } from "../src/core/agent.js";
import * as events from "../src/core/events.js";

const quiet = { onText: null, onTool: null, onNote: null, stream: false };

async function runOnce(vfs, opts) {
  return run(vfs, { prompt: "go", tools: ["read", "ls"], ...quiet, ...opts });
}

test("agent: no model mounted is a sentence with the fix in it", async () => {
  const vfs = await namespace();
  await assert.rejects(() => runOnce(vfs, {}), (e) => {
    assert.equal(e.code, "ENOENT");
    assert.match(e.message, /no model is mounted/);
    assert.match(e.message, /mount ai:\/dev\/providers\/ai/);
    return true;
  });
});

test("agent: one round, no tools, and the answer comes back", async () => {
  const vfs = await namespace({ mounts: [fakeScript()] });
  const r = await runOnce(vfs);
  assert.equal(r.rounds, 1);
  assert.equal(r.tool_calls, 0);
  assert.equal(r.done, true);
  assert.equal(r.status, "done");
  assert.match(r.text, /\[fake\] heard 1 messages/);
  assert.equal(r.canonical.length, 2, "the question and the answer");
});

test("agent: the loop runs a tool, feeds the result back, and finishes", async () => {
  const dir = await tmpdir();
  try {
    await fs.writeFile(path.join(dir.path, "note.txt"), "the answer is 42\n");
    const vfs = await namespace({
      host: dir.path,
      mounts: [fakeScript(calls("read", { path: "/host/note.txt" }), says("I read it: 42."))],
    });

    const r = await runOnce(vfs);
    assert.equal(r.rounds, 2, "a tool call means at least a second round");
    assert.equal(r.tool_calls, 1);
    assert.equal(r.text, "I read it: 42.");

    // the transcript: user, assistant(tool_use), user(tool_result), assistant(text)
    assert.deepEqual(r.canonical.map((m) => m.role), ["user", "assistant", "user", "assistant"]);
    const result = r.canonical[2].content[0];
    assert.equal(result.type, "tool_result");
    assert.equal(result.tool_use_id, "t1");
    assert.equal(result.is_error, false);
    assert.match(result.content, /the answer is 42/);
  } finally {
    await dir.cleanup();
  }
});

test("agent: a failing tool is a result the model can read, not a crash", async () => {
  const vfs = await namespace({
    mounts: [fakeScript(calls("read", { path: "/host/does-not-exist" }), says("it was not there"))],
  });
  const r = await runOnce(vfs);
  const result = r.canonical[2].content[0];
  assert.equal(result.is_error, true);
  assert.match(result.content, /ENOENT/);
  assert.match(result.content, /does-not-exist/);
  // the run finished normally — a tool failure is data, not a teardown
  assert.equal(r.status, "done");
});

test("agent: a tool that is not mounted is refused, and the refusal names what is", async () => {
  const vfs = await namespace({ mounts: [fakeScript(calls("write", { path: "/tmp/x", content: "y" }), says("ok"))] });
  const r = await runOnce(vfs, { tools: ["read", "ls"] });
  const result = r.canonical[2].content[0];
  assert.equal(result.is_error, true);
  assert.match(result.content, /no tool named write/);
  assert.match(result.content, /available: read, ls/);
});

test("agent: the tool set is the mount — a run cannot be handed a tool it does not have", async () => {
  const vfs = await namespace({ tools: ["read", "ls"], mounts: [fakeScript()] });
  await assert.rejects(() => runOnce(vfs, { tools: ["read", "shell"] }), (e) => {
    assert.match(e.message, /no tool named shell in this namespace/);
    assert.match(e.message, /the tool set is a mount/);
    return true;
  });
});

test("agent: the js tool runs in a worker, against a proxy, and reaches the namespace", async () => {
  const vfs = await namespace({
    mounts: [fakeScript(calls("js", { code: "(await vfs.read('/proc/version')).trim()" }), says("done"))],
  });
  const r = await runOnce(vfs, { tools: ["js"] });
  const result = r.canonical[2].content[0];
  assert.equal(result.is_error, false, result.content);
  assert.match(result.content, /js-agent 0\.1\.0/);
});

test("agent: a runaway script is killed at the deadline, and the run survives", async () => {
  const started = Date.now();
  const vfs = await namespace({
    mounts: [fakeScript(calls("js", { code: "for(;;){}" }), says("recovered"))],
  });
  const r = await runOnce(vfs, { tools: ["js"], toolTimeoutMs: 700 });
  const elapsed = Date.now() - started;

  const result = r.canonical[2].content[0];
  assert.equal(result.is_error, true);
  assert.match(result.content, /ran past its 700ms deadline/);
  // the wording matters: a killed search is not a search that found nothing
  assert.match(result.content, /do NOT read this as 'found nothing'/);
  assert.ok(elapsed < 10_000, `the deadline held (${elapsed}ms)`);
  assert.equal(r.status, "done", "the loop itself is unharmed");

  // and the kernel it could not reach is still standing
  assert.ok((await vfs.read("/proc/mounts")).length > 0);
});

test("agent: events are the one record of a run", async () => {
  const vfs = await namespace({
    mounts: [fakeScript(calls("read", { path: "/proc/version" }), says("ok"))],
    state: null,
  });
  await vfs.mount("mem", "/agent", {});
  const r = await runOnce(vfs);

  assert.ok(r.events, "a run with somewhere to write one leaves a stream");
  const lines = await events.read(vfs, r.events);
  const kinds = lines.map((e) => e.kind);
  assert.deepEqual(kinds, [
    "run.start",
    "round.start",
    "round.end",
    "tool.call",
    "tool.result",
    "round.start",
    "round.end",
    "run.end",
  ]);

  const summary = events.summary(lines);
  assert.equal(summary.rounds, 2);
  assert.equal(summary.tool_calls, 1);
  assert.equal(summary.tool_errors, 0);
  assert.equal(summary.status, "done");
  assert.equal(summary.tools[0].name, "read");

  // the projection a trace page would render
  const model = events.model(lines);
  assert.equal(model.rounds.length, 2);
  assert.equal(model.rounds[0].tools[0].name, "read");
  assert.equal(model.rounds[0].tools[0].is_error, false);
});

test("agent: a call with no recorded result is marked as unknown, not as success", async () => {
  const vfs = await namespace({ mounts: [fakeScript()] });
  await vfs.mount("mem", "/agent", {});
  const log = await events.open(vfs);
  await log.emit("run.start", { task: "x" });
  await log.emit("round.start", { n: 1 });
  await log.emit("tool.call", { round: 1, id: "t1", name: "read", input: {} });
  // …and then the run dies. no tool.result ever lands.
  await log.emit("run.end", { status: "error" });

  const model = events.model(await events.read(vfs, log.path));
  const tool = model.rounds[0].tools[0];
  assert.equal(tool.is_error, true, "'we never learned how this went' is not 'it worked'");
  assert.match(tool.result, /no result recorded/);
});

test("agent: usage is carried, and a streamed round keeps its input count", async () => {
  const vfs = await namespace({ mounts: [fakeScript(says("hi"))] });
  const r = await runOnce(vfs, { stream: true, maxTokens: 64 });
  // 128, not 100: the *streamed* path carries its own usage in message_start, and the test
  // is that the count survives message_delta overwriting it rather than being zero
  assert.equal(r.input_tokens, 128, "a streamed round keeps the input count message_start gave it");
  assert.equal(r.total_output, 64, "and the output count message_delta carried");
  assert.equal(r.text, "hi");
});

test("agent: a capability context is saved and restored around a nested run", async () => {
  const vfs = await namespace({ mounts: [fakeScript(says("outer"))] });
  vfs.agentTools = "outer-only";
  await runOnce(vfs);
  // the run set its own tool list while it ran, and putting it back is what stops a
  // subagent's smaller set from becoming the parent's on the way out
  assert.equal(vfs.agentTools, "outer-only");
});

test("agent: the tool definitions come out of /bin, descriptions and all", async () => {
  const vfs = await namespace({ tools: ["read", "edit", "js"] });
  const { objects, definitions } = await loadToolsFromBin(vfs, ["read", "js"]);
  assert.deepEqual(objects.map((t) => t.name), ["read", "js"]);
  assert.equal(definitions[0].name, "read");
  assert.equal(definitions[0].input_schema.properties.path.type, "string");
  assert.ok(definitions[0].description.length > 20);
  assert.equal(definitions[1].name, "js");
  await assert.rejects(() => loadToolsFromBin(vfs, ["write"]), /no tool named write/);
});
