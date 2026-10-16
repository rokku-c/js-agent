import { test } from "node:test";
import assert from "node:assert/strict";
import { Vfs } from "../src/kernel/vfs.js";
import { createView } from "../src/kernel/view.js";
import { resolveReference } from "../src/core/references.js";
import { createRunStore } from "../src/core/run-store.js";
import { createRunObserver } from "../src/core/run-observer.js";
import { invokeOnce } from "../src/core/invocation.js";

const encoder = new TextEncoder();

async function digest(value) {
  const bytes = encoder.encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function error(message, code) {
  const cause = new Error(message);
  cause.code = code;
  return cause;
}

test("adversarial View keeps remote shell and credential paths behind operation grants", async () => {
  const calls = [];
  const resource = {
    async stat(path) {
      calls.push(["stat", path]);
      return { type: "file", size: 999, target: "credential-value" };
    },
    async list(path) {
      calls.push(["list", path]);
      return [{ name: "TOKEN", size: 48, mode: 0o400, target: "credential-value" }];
    },
    async read(path) {
      calls.push(["read", path]);
      return path === "/dev/secrets/TOKEN" ? "opaque-token" : "remote file";
    },
    async write(path) {
      calls.push(["write", path]);
    },
    async open() {
      throw new Error("must never be exposed or reached");
    },
    async exec() {
      throw new Error("must never be exposed or reached");
    },
  };
  const view = createView(resource, {
    grants: [
      { path: "/remote/workspace/**", operations: ["read"] },
      { path: "/dev/secrets", operations: ["list"] },
      { path: "/dev/secrets/TOKEN", operations: ["read"] },
    ],
  });

  await assert.rejects(() => view.read("/remote/../dev/secrets/OTHER"), { code: "EACCES" });
  await assert.rejects(() => view.read({ toString: () => "/remote/workspace/file" }), { code: "EINVAL" });
  await assert.rejects(() => view.read("/remote/bin/sh -c id"), { code: "EACCES" });
  assert.deepEqual(calls, [], "denied and type-confused paths must not reach the remote adapter");

  assert.deepEqual(await view.list("/dev/secrets"), [{ name: "TOKEN" }]);
  await assert.rejects(() => view.stat("/dev/secrets/TOKEN"), { code: "EACCES" });
  assert.equal(await view.read("/dev/secrets/TOKEN"), "opaque-token");
  assert.deepEqual(calls, [["list", "/dev/secrets"], ["read", "/dev/secrets/TOKEN"]]);
  assert.equal(view.open, undefined);
  assert.equal(view.exec, undefined);
});

test("adversarial View forwards cancellation to a delayed remote read", async () => {
  const controller = new AbortController();
  const reason = new Error("remote read cancelled");
  let started;
  let rejectRead;
  const resource = {
    async read(path, options) {
      started?.();
      return new Promise((resolve, reject) => {
        rejectRead = reject;
        options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
      });
    },
  };
  const view = createView(resource, { grants: [{ path: "/remote/**", operations: ["read"] }] });
  const began = new Promise((resolve) => { started = resolve; });
  const pending = view.read("/remote/workspace/file", { signal: controller.signal });
  await began;
  controller.abort(reason);
  await assert.rejects(pending, (cause) => cause === reason);
  assert.ok(rejectRead, "the hostile adapter was actually waiting on the read");
});

test("adversarial references reject bad bounds before a delayed read and reject stale pins", async () => {
  const oldRevision = await digest("old revision");
  let reads = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const resources = {
    async read(path, options) {
      reads++;
      assert.equal(path, "/remote/document");
      assert.equal(options.encoding, "binary");
      await gate;
      return encoder.encode("new revision");
    },
  };

  await assert.rejects(
    () => resolveReference(resources, "/remote/document", { maxBytes: -1 }),
    (cause) => cause.code === "EINVAL",
  );
  assert.equal(reads, 0, "invalid bounds must not wait on a remote read");

  const pending = resolveReference(resources, {
    $ref: "/remote/document",
    mode: "pinned",
    revision: oldRevision,
  });
  release();
  await assert.rejects(pending, (cause) => cause.code === "ESTALE");
  assert.equal(reads, 1);
});

test("adversarial references copy returned bytes and bound selected UTF-8 bytes", async () => {
  const bytes = encoder.encode("stable");
  const raw = bytes.buffer;
  raw.slice = (start, end) => {
    const copy = ArrayBuffer.prototype.slice.call(raw, start, end);
    bytes[0] = encoder.encode("X")[0];
    return copy;
  };
  const resources = {
    async read() { return raw; },
  };
  const result = await resolveReference(resources, "/remote/document", { maxBytes: 6 });
  assert.equal(result.value, "stable");
  assert.equal(result.provenance.bytes, 6);

  const largeSource = "unselected\nsmall\n" + "x".repeat(1024 * 1024);
  const selected = await resolveReference(
    { async read() { return largeSource; } },
    { $ref: "/remote/document", selector: { lines: [2, 2] } },
    { maxBytes: 6 },
  );
  assert.equal(selected.value, "small\n");
});

test("adversarial reference cancellation wins after a delayed remote read", async () => {
  const controller = new AbortController();
  const reason = new Error("reference cancelled");
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const resources = {
    async read() {
      await gate;
      return "late content";
    },
  };
  const pending = resolveReference(resources, "/remote/document", { signal: controller.signal });
  controller.abort(reason);
  release();
  await assert.rejects(pending, (cause) => cause === reason);
});

test("adversarial RunState uses canonical root paths and marks an external side effect unknown", async () => {
  const vfs = new Vfs();
  await vfs.mount("mem", "/");
  const store = createRunStore(vfs, { root: "/" });
  const reservation = await store.reserve("root-run", { request: {}, plan: {} });
  assert.equal(reservation.path, "/root-run");
  assert.equal((await store.readStatus("root-run")).status, "reserved");

  let externallyCommitted = false;
  const failure = new Error("remote disconnected after commit");
  await assert.rejects(
    () => invokeOnce({
      resources: { async read() { return "{}"; } },
      agent: { model: "/models/remote" },
      input: "send",
      model: {
        path: "/models/remote",
        async request() {
          externallyCommitted = true;
          throw failure;
        },
      },
      store: createRunStore(vfs),
      id: "remote-effect",
    }),
    (cause) => cause === failure,
  );
  assert.equal(externallyCommitted, true);
  assert.equal((await store.readStatus("root-run")).status, "reserved");
});

test("adversarial RunState records cancellation after a late admission read", async () => {
  const vfs = new Vfs();
  await vfs.mount("mem", "/");
  const controller = new AbortController();
  const gate = new Promise((resolve) => setTimeout(resolve, 5));
  let modelCalls = 0;
  const result = await invokeOnce({
    resources: {
      async read(path) {
        await gate;
        controller.abort(new Error("admission cancelled"));
        return path === "/agent.json" ? JSON.stringify({ model: "/models/remote", context: ["/remote/context"] }) : "late";
      },
    },
    agent: "/agent.json",
    input: "inspect",
    model: { path: "/models/remote", async request() { modelCalls++; } },
    store: createRunStore(vfs),
    signal: controller.signal,
    id: "late-admission",
  });
  assert.equal(result.status, "cancelled");
  assert.equal(modelCalls, 0);
  assert.equal((await createRunStore(vfs).readStatus("late-admission")).status, "cancelled");
});

test("adversarial RunState exposes a partial terminal write as an error", async () => {
  const vfs = new Vfs();
  await vfs.mount("mem", "/");
  const originalWrite = vfs.write.bind(vfs);
  let failTerminalStatus = false;
  const flaky = {
    mkdirp: vfs.mkdirp.bind(vfs),
    mkdir: vfs.mkdir.bind(vfs),
    rename: vfs.rename.bind(vfs),
    read: vfs.read.bind(vfs),
    async write(path, data, options) {
      if (failTerminalStatus && path.includes("/status.json.tmp-")) {
        failTerminalStatus = false;
        throw error("status store unavailable", "EIO");
      }
      return originalWrite(path, data, options);
    },
  };
  const store = createRunStore(flaky);
  await store.reserve("partial-status", { request: {}, plan: {} });
  await store.start("partial-status");
  failTerminalStatus = true;
  const result = await store.fail("partial-status", "unknown", error("remote uncertain", "EIO"));
  assert.equal(result.status, "unknown");
  assert.equal(store.lastError("partial-status").code, "EIO");
  assert.equal((await store.readStatus("partial-status")).status, "started", "volatile storage cannot promise a terminal snapshot after a failed write");
});

test("adversarial RunState observer consumes concurrent terminal outcomes without payload leakage", async () => {
  const vfs = new Vfs();
  await vfs.mount("mem", "/");
  const store = createRunStore(vfs);
  const observer = createRunObserver(vfs, { interval: 1 });
  const secret = "observer-secret-should-never-cross";
  for (const id of ["failed-run", "unknown-run", "cancelled-run"]) {
    await store.reserve(id, {
      request: { messages: [{ content: secret }] },
      plan: { credentials: secret },
    });
    await store.start(id);
  }

  const streams = ["failed-run", "unknown-run", "cancelled-run"].map((id) => observer.watch(id));
  const initial = await Promise.all(streams.map((stream) => stream.next()));
  assert.deepEqual(initial.map((step) => step.value.status), ["started", "started", "started"]);

  await Promise.all([
    store.fail("failed-run", "failed", error(`failure contains ${secret}`, "EIO")),
    store.fail("unknown-run", "unknown", error(`disconnect contains ${secret}`, "EIO")),
    store.fail("cancelled-run", "cancelled", error(`cancel contains ${secret}`, "ABORT_ERR")),
  ]);

  const terminal = await Promise.all(streams.map(async (stream) => {
    let step;
    do step = await stream.next(); while (!step.done && !step.value.terminal);
    return step.value;
  }));
  assert.deepEqual(terminal.map((snapshot) => snapshot.status), ["failed", "unknown", "cancelled"]);
  for (const snapshot of terminal) {
    assert.equal(snapshot.partial, false);
    assert.deepEqual(snapshot.events.map(({ seq, kind, at }) => ({ seq, kind, at })), [
      { seq: 1, kind: "started", at: snapshot.events[0].at },
      { seq: 2, kind: snapshot.status, at: snapshot.events[1].at },
    ]);
    const serialized = JSON.stringify(snapshot);
    assert.doesNotMatch(serialized, /observer-secret-should-never-cross/);
    assert.doesNotMatch(serialized, /error|message|credentials|toolCalls|request|plan|response/i);
    assert.equal("request" in snapshot, false);
    assert.equal("plan" in snapshot, false);
    assert.equal("response" in snapshot, false);
  }

  const listed = await observer.list();
  assert.deepEqual(listed.map(({ id }) => id), ["cancelled-run", "failed-run", "unknown-run"]);
});

test("adversarial RunState observer reports partial volatile persistence and redacts malformed tails", async () => {
  const vfs = new Vfs();
  await vfs.mount("mem", "/");
  const originalWrite = vfs.write.bind(vfs);
  let failTerminalStatus = false;
  const flaky = {
    mkdirp: vfs.mkdirp.bind(vfs),
    mkdir: vfs.mkdir.bind(vfs),
    rename: vfs.rename.bind(vfs),
    read: vfs.read.bind(vfs),
    stat: vfs.stat.bind(vfs),
    list: vfs.list.bind(vfs),
    async write(path, data, options) {
      if (failTerminalStatus && path.includes("/status.json.tmp-")) {
        failTerminalStatus = false;
        throw error("status persistence contains a secret backend detail", "EIO");
      }
      return originalWrite(path, data, options);
    },
  };
  const store = createRunStore(flaky);
  const observer = createRunObserver(flaky, { interval: 1 });
  await store.reserve("partial-observed", { request: { secret: "hidden" }, plan: {} });
  await store.start("partial-observed");
  failTerminalStatus = true;
  await store.fail("partial-observed", "unknown", error("provider token hidden", "EIO"));

  const partial = await observer.snapshot("partial-observed");
  assert.equal(partial.status, "started", "volatile observers see the last persisted status");
  assert.equal(partial.terminal, false);
  assert.equal(partial.partial, true, "the event/status mismatch is observable as partial state");
  assert.deepEqual(partial.events.map(({ seq, kind }) => ({ seq, kind })), [
    { seq: 1, kind: "started" },
    { seq: 2, kind: "unknown" },
  ]);
  assert.doesNotMatch(JSON.stringify(partial), /provider token|status persistence|secret|error|message/i);

  await vfs.write("/runs/partial-observed/events.jsonl", '{"seq":3,"kind":"unknown","at":"2030-01-01T00:00:00.000Z","error":{"message":"tail-secret"', { append: true });
  const malformed = await observer.snapshot("partial-observed");
  assert.equal(malformed.partial, true);
  assert.equal(malformed.sequence, 2, "an incomplete JSONL tail is not consumed as an event");
  assert.deepEqual(malformed.events.map(({ seq }) => seq), [1, 2]);
  assert.doesNotMatch(JSON.stringify(malformed), /tail-secret|error|message/i);
  assert.equal(malformed.volatile, true);
  assert.equal(malformed.redacted, true);
});

test("adversarial RunState observer accepts a terminal admission outcome without inventing partial state", async () => {
  const vfs = new Vfs();
  await vfs.mount("mem", "/");
  const store = createRunStore(vfs);
  const observer = createRunObserver(vfs);
  await store.reserve("admission-cancelled", { request: {}, plan: {} });
  await store.fail("admission-cancelled", "cancelled", error("cancelled before dispatch", "ABORT_ERR"));
  const snapshot = await observer.snapshot("admission-cancelled");
  assert.equal(snapshot.status, "cancelled");
  assert.equal(snapshot.terminal, true);
  assert.equal(snapshot.partial, false);
  assert.deepEqual(snapshot.events.map(({ seq, kind }) => ({ seq, kind })), [{ seq: 1, kind: "cancelled" }]);
});
