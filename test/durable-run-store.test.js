import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { Vfs } from "../src/kernel/vfs.js";
import { createRunStore } from "../src/core/run-store.js";

async function storage() {
  const directory = await mkdtemp(`${os.tmpdir()}/js-agent-run-store-`);
  const vfs = new Vfs();
  await vfs.mount("hostfs", "/", { source: directory, mode: "rw" });
  return { vfs, directory };
}

async function close(directory) {
  await rm(directory, { recursive: true, force: true });
}

test("durable mode rejects a storage adapter without a crash contract", async () => {
  const vfs = new Vfs();
  await vfs.mount("mem", "/", {});
  assert.throws(() => createRunStore(vfs, { mode: "durable" }), { code: "ENOTSUP" });
});

test("durable reservations reject duplicate IDs across store instances", async () => {
  const { vfs, directory } = await storage();
  try {
    const first = createRunStore(vfs, { mode: "durable" });
    const second = createRunStore(vfs, { mode: "durable" });
    const results = await Promise.allSettled([
      first.reserve("same-id", { request: {}, plan: {} }),
      second.reserve("same-id", { request: {}, plan: {} }),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected" && result.reason.code === "EEXIST").length, 1);
  } finally {
    await close(directory);
  }
});

test("durable restart turns a started run into unknown and repairs a malformed JSONL tail", async () => {
  const { vfs, directory } = await storage();
  try {
    const store = createRunStore(vfs, { mode: "durable" });
    await store.reserve("restart", { request: {}, plan: {} });
    await store.start("restart");
    await vfs.write("/runs/restart/events.jsonl", '{"seq":99,"kind":"unknown"', { append: true });

    const restarted = createRunStore(vfs, { mode: "durable" });
    const recovered = await restarted.recover("restart");
    assert.deepEqual({ status: recovered.status, partial: recovered.partial }, { status: "unknown", partial: true });
    assert.equal((await restarted.readStatus("restart")).status, "unknown");
    const events = (await vfs.read("/runs/restart/events.jsonl")).trim().split("\n").map(JSON.parse);
    assert.deepEqual(events.map(({ seq, kind }) => ({ seq, kind })), [
      { seq: 1, kind: "started" },
      { seq: 2, kind: "unknown" },
    ]);
    assert.ok((await vfs.list("/runs/restart")).some(({ name }) => name.startsWith("events.jsonl.corrupt-")));
  } finally {
    await close(directory);
  }
});

test("durable status failure reports uncertainty and leaves no failed temp file", async () => {
  const { vfs, directory } = await storage();
  try {
    let failStatus = false;
    const flaky = {
      ...vfs,
      capabilities: vfs.capabilities.bind(vfs),
      mkdirp: vfs.mkdirp.bind(vfs), mkdir: vfs.mkdir.bind(vfs), read: vfs.read.bind(vfs),
      exists: vfs.exists.bind(vfs), rename: vfs.rename.bind(vfs), remove: vfs.remove.bind(vfs), sync: vfs.sync.bind(vfs),
      async write(path, data, options) {
        if (failStatus && path.includes("/status.json.tmp-")) {
          failStatus = false;
          const cause = new Error("status unavailable");
          cause.code = "EIO";
          throw cause;
        }
        return vfs.write(path, data, options);
      },
    };
    const store = createRunStore(flaky, { mode: "durable" });
    await store.reserve("status-failure", { request: {}, plan: {} });
    await store.start("status-failure");
    failStatus = true;
    await assert.rejects(
      () => store.fail("status-failure", "unknown", new Error("provider outcome uncertain")),
      (cause) => cause.outcome === "unknown" && cause.eventCommitted === true,
    );
    assert.equal((await vfs.read("/runs/status-failure/status.json")).includes('"started"'), true);
    assert.equal((await vfs.list("/runs/status-failure")).some(({ name }) => name.includes("status.json.tmp-")), false);

    const restarted = createRunStore(vfs, { mode: "durable" });
    assert.equal((await restarted.recover("status-failure")).status, "unknown");
    assert.equal((await restarted.readStatus("status-failure")).status, "unknown");
  } finally {
    await close(directory);
  }
});
