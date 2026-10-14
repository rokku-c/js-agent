// core.test.js — folding, persistence and the gate. the three places a run can lie to
// itself about what it did.

import { test } from "node:test";
import assert from "node:assert/strict";
import { namespace, fakeScript, says, calls } from "./helpers.js";
import * as contextFolding from "../src/core/context.js";
import * as sessions from "../src/core/session.js";
import { Policy, refuseMessage, deferMessage } from "../src/core/policy.js";
import { run } from "../src/core/agent.js";

const big = (n, chars = 4000) => ({ role: "user", content: `${n}:` + "x".repeat(chars) });

// ── context ───────────────────────────────────────────────────────────────────────

test("context: a tool turn folds as a pair, because half of one is a rejected request", async () => {
  const vfs = await namespace();
  await vfs.mount("mem", "/agent", {});
  const messages = [
    { role: "user", content: "the task" },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "x".repeat(4000) }] },
    { role: "assistant", content: [{ type: "text", text: "done" }] },
    { role: "user", content: "and now something else entirely" },
  ];

  const f = await contextFolding.apply(vfs, messages, { budget: 100, keepRecent: 0 });
  assert.equal(f.changed, true);
  assert.deepEqual(f.folded, [1, 2], "the call and its result go together or not at all");
  // message 0 — the task — is never folded by default
  assert.equal(f.messages[0].content, "the task");
  assert.match(f.messages[1].content, /\[folded\] item 1/);
});

test("context: a message smaller than the placeholder is not worth folding", async () => {
  const vfs = await namespace();
  await vfs.mount("mem", "/agent", {});
  // the placeholder is ~100 characters itself, so folding a smaller message *grows* the
  // context — which is how "folding constantly, never within budget" happens
  const small = Array.from({ length: 40 }, (_, i) => ({ role: "user", content: `m${i}` }));
  const f = await contextFolding.apply(vfs, small, { budget: 1, keepRecent: 0 });
  assert.equal(f.changed, false, "nothing was big enough to be worth it");
});

test("context: the original is kept, and the entry can be read back", async () => {
  const vfs = await namespace();
  await vfs.mount("mem", "/agent", {});
  const messages = [{ role: "user", content: "task" }, big("a"), big("b")];
  const f = await contextFolding.apply(vfs, messages, { budget: 1, keepRecent: 0 });

  assert.ok(f.entry);
  const stored = await contextFolding.loadEntry(vfs, f.entry);
  assert.equal(stored.messages.length, 3, "the full body is in the store, untouched");
  assert.equal(stored.messages[1].content.length, 4002);
  // and the folded indexes are recorded against it
  assert.deepEqual(stored.folded, f.folded);
});

test("context: a manual fold index is still completed into a legal unit", async () => {
  const vfs = await namespace();
  await vfs.mount("mem", "/agent", {});
  const messages = [
    { role: "user", content: "task" },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "x".repeat(1000) }] },
  ];
  // asking for the call alone would split the turn; the pairing is done for the caller
  const f = await contextFolding.apply(vfs, messages, { fold: [1], keepRecent: 0, budget: 10_000_000 });
  assert.deepEqual(f.folded, [1, 2]);
});

// ── sessions ──────────────────────────────────────────────────────────────────────

test("sessions: a stored run resumes with its real history, not its fold placeholders", async () => {
  const vfs = await namespace({ mounts: [fakeScript(says("first"))] });
  await vfs.mount("mem", "/agent", {});

  const first = await run(vfs, {
    prompt: "remember the number 7",
    tools: ["ls"],
    sessionId: "conv",
    stream: false,
    onText: null,
  });
  assert.equal(first.session, "conv");

  const stored = await sessions.load(vfs, "conv");
  assert.deepEqual(stored.messages.map((m) => m.role), ["user", "assistant"]);
  assert.equal(stored.messages[0].content, "remember the number 7");
  assert.equal(stored.status, "done");
  assert.equal(stored.counters.rounds, 1);
  // provenance, not value: the tool list is stored as names so it re-resolves
  assert.deepEqual(stored.tools.from, ["ls"]);
});

test("sessions: appending without --resume is refused", async () => {
  const vfs = await namespace({ mounts: [fakeScript(says("hi"))] });
  await vfs.mount("mem", "/agent", {});
  await run(vfs, { prompt: "one", tools: ["ls"], sessionId: "s", stream: false, onText: null });
  await assert.rejects(
    () => run(vfs, { prompt: "two", tools: ["ls"], sessionId: "s", stream: false, onText: null }),
    (e) => {
      assert.equal(e.code, "EEXIST");
      assert.match(e.message, /pass --resume to continue it/);
      return true;
    }
  );
});

test("sessions: a tail loads a window and writes the whole thing back", async () => {
  const vfs = await namespace({ mounts: [fakeScript(says("hi"))] });
  await vfs.mount("mem", "/agent", {});
  await run(vfs, { prompt: "one", tools: ["ls"], sessionId: "s", stream: false, onText: null });
  await run(vfs, { prompt: "two", tools: ["ls"], sessionId: "s", resume: true, stream: false, onText: null });
  await run(vfs, { prompt: "three", tools: ["ls"], sessionId: "s", resume: true, tail: 2, stream: false, onText: null });

  const stored = await sessions.load(vfs, "s");
  // the tail loaded 2 messages, but the run wrote prefix + what it did — so all four
  // earlier messages are still there. getting this asymmetry wrong silently truncates a
  // session the first time someone resumes a long one.
  assert.equal(stored.messages.length, 6);
  assert.equal(stored.messages[0].content, "one");
  assert.equal(stored.messages.at(-1).role, "assistant");
});

test("sessions: no /agent mounted means no session, and the refusal says how", async () => {
  const vfs = await namespace({ mounts: [fakeScript(says("hi"))] });
  await assert.rejects(
    () => run(vfs, { prompt: "x", tools: ["ls"], sessionId: "s", stream: false, onText: null }),
    (e) => {
      assert.equal(e.code, "ENOENT");
      assert.match(e.message, /no session store in this namespace/);
      assert.match(e.message, /--state/);
      return true;
    }
  );
});

// ── policy ────────────────────────────────────────────────────────────────────────

test("policy: with no rules file the gate is open, and says so rather than inventing one", async () => {
  const vfs = await namespace();
  const p = await Policy.load(vfs);
  assert.equal(p.source, "none");
  assert.equal(p.check({ tool: "shell", command: "rm -rf /" }).decision, "allow");
});

test("policy: first match wins, and the message is written to the model", async () => {
  const vfs = await namespace();
  await vfs.mount("mem", "/agent", {});
  await vfs.write(
    "/agent/policy.json",
    JSON.stringify({
      version: 1,
      default: "allow",
      rules: [
        { match: { tool: "write", path: "/host/*" }, action: "deny", reason: "the host is read-only for a reason" },
        { match: { command: "rm -rf *" }, action: "deny", reason: "no" },
      ],
    }),
    { create: true }
  );
  const p = await Policy.load(vfs);
  assert.equal(p.source, "/agent/policy.json");

  const denied = p.check({ tool: "write", input: { path: "/host/x.txt" } });
  assert.equal(denied.decision, "deny");
  assert.equal(denied.rule, 0);
  const msg = refuseMessage(denied);
  assert.match(msg, /policy denied/);
  assert.match(msg, /rule 0/);
  assert.match(msg, /hard rule/);
  assert.match(msg, /do not retry/, "the model is told a retry is pointless, or it will retry");

  // glob matching is literal everywhere except `*` and `?`, so `rm -rf *` means what it looks like
  assert.equal(p.check({ tool: "shell", command: "rm -rf /tmp/x" }).decision, "deny");
  assert.equal(p.check({ tool: "shell", command: "rm -rfx" }).decision, "allow");

  // a call matching nothing takes the default
  assert.equal(p.check({ tool: "read", input: { path: "/host/x" } }).decision, "allow");
});

test("policy: a subagent inherits compiled rules, not a path it could point elsewhere", async () => {
  const vfs = await namespace();
  await vfs.mount("mem", "/agent", {});
  const parent = await Policy.load(vfs, {
    compiled: { version: 1, default: "deny", rules: [] },
  });
  assert.equal(parent.source, "inherited");
  assert.equal(parent.check({ tool: "anything" }).decision, "deny");

  // and the rules decide, not the file: a file saying allow cannot override what was handed down
  await vfs.write("/agent/policy.json", JSON.stringify({ version: 1, default: "allow", rules: [] }), { create: true });
  const child = await Policy.load(vfs, { compiled: parent.rules });
  assert.equal(child.check({ tool: "anything" }).decision, "deny");
});

test("policy: a denial reaches the model as an ordinary tool failure", async () => {
  const vfs = await namespace({ mounts: [fakeScript(calls("write", { path: "/tmp/x", content: "y", create: true }), says("ok"))] });
  await vfs.mount("mem", "/agent", {});
  await vfs.write(
    "/agent/policy.json",
    JSON.stringify({ version: 1, default: "allow", rules: [{ match: { tool: "write" }, action: "deny", reason: "testing" }] }),
    { create: true }
  );

  const r = await run(vfs, {
    prompt: "write something",
    tools: ["write"],
    stream: false,
    onText: null,
  });
  const result = r.canonical[2].content[0];
  assert.equal(result.is_error, true, "a denial must not tear the run down");
  assert.match(result.content, /policy denied/);
  // and the file was never written
  assert.equal(await vfs.exists("/tmp/x"), false);
});

test("policy: an `ask` with nobody to ask becomes a deferral the model is told about", () => {
  const d = { tool: "shell", command: "ls", id: "pol-1", reason: "" };
  const msg = deferMessage(d);
  assert.match(msg, /deferred pending user approval \(pol-1\)/);
  assert.match(msg, /do not retry/);
});
