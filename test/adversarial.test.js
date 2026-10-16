import { test } from "node:test";
import assert from "node:assert/strict";
import { Vfs } from "../src/kernel/vfs.js";
import { createView } from "../src/kernel/view.js";
import { resolveReference } from "../src/core/references.js";
import { createRunStore } from "../src/core/run-store.js";
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
