import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Vfs } from "../src/kernel/vfs.js";
import { createView } from "../src/kernel/view.js";
import { namespace, tmpdir } from "./helpers.js";

const MODEL = "/models/type/api/anthropic/messages/model/fixture";

async function rejectsCode(operation, code, message) {
  await assert.rejects(operation, (error) => {
    assert.equal(error.code, code);
    if (message) assert.match(error.message, message);
    return true;
  });
}

test("invoke is a clean ENOTSUP across legacy non-callable drivers", async () => {
  const host = await tmpdir("js-agent-callable-compat-");
  try {
    await fs.writeFile(path.join(host.path, "plain.txt"), "plain\n");
    const vfs = await namespace({
      host: host.path,
      mounts: ["secret:/secrets,values=TOKEN=offline"],
    });

    // mem, hostfs, proc, secret and bin retain their old read/write surfaces and do not
    // accidentally become callable merely because Vfs now exposes invoke.
    for (const resource of [
      "/tmp/missing", // mem: missing paths still report ENOENT before invoke dispatch
      "/host/plain.txt",
      "/proc/mounts",
      "/secrets/TOKEN",
      "/bin/read",
    ]) {
      const expected = resource === "/tmp/missing" ? "ENOENT" : "ENOTSUP";
      await rejectsCode(() => vfs.invoke(resource, {}), expected);
    }

    // Device stats historically mark byte devices as devices; only callable resources with
    // an invoke method can use the generic protocol.
    await rejectsCode(() => vfs.invoke("/dev/null", {}), "ENOTSUP", /not callable/);
    await rejectsCode(() => vfs.invoke("/dev/zero", {}), "ENOTSUP", /no invoke operation/);
  } finally {
    await host.cleanup();
  }
});

test("Vfs and View preserve callable authority, forwarding, and pre-abort behavior", async () => {
  const vfs = new Vfs();
  await vfs.mount("mem", "/");
  await vfs.write("/callable", "descriptor", { create: true });
  const instance = vfs.resolve("/callable").mount.instance;
  const seen = [];
  instance.stat = async () => ({ type: "device", callable: true });
  instance.invoke = async (rel, input, ctx, options) => {
    seen.push({ rel, input, ctx, options });
    return { ok: true };
  };

  const controller = new AbortController();
  controller.abort();
  await rejectsCode(() => vfs.invoke("/callable", {}, { signal: controller.signal }), "ABORT_ERR");
  assert.equal(seen.length, 0, "pre-abort must not dispatch the callable");

  const signal = new AbortController().signal;
  const result = await vfs.invoke("/callable", { value: 1 }, { signal, tag: "forwarded" });
  assert.deepEqual(result, { ok: true });
  assert.equal(seen[0].rel, "callable");
  assert.deepEqual(seen[0].input, { value: 1 });
  assert.equal(seen[0].ctx.signal, signal);
  assert.equal(seen[0].options.tag, "forwarded");

  const view = createView(vfs, { grants: [{ path: "/callable", operations: ["stat", "invoke"] }] });
  assert.deepEqual(await view.invoke("/callable", { value: 2 }), { ok: true });
  const readOnly = createView(vfs, { grants: [{ path: "/callable", operations: ["stat", "read"] }] });
  await rejectsCode(() => readOnly.invoke("/callable", {}), "EACCES");
});

test("net and AI callable paths preserve legacy write behavior and cancellation", async (t) => {
  const vfs = new Vfs();
  await vfs.mount("mem", "/");
  await vfs.mount("net", "/dev/net", { allow: "fixture.invalid" });
  await vfs.mount("ai", "/models", { vendor: "anthropic", token: "fixture-token", url: "https://fixture.invalid" });

  await rejectsCode(() => vfs.invoke("/dev/net/request", "not-json"), "EINVAL", /not valid JSON/);
  await rejectsCode(() => vfs.invoke(MODEL, "not-json"), "EINVAL", /not valid JSON/);

  let requestSignal = null;
  let block = false;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    if (!block) return new Response("network-ok", { status: 200 });
    requestSignal = options.signal;
    return await new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
    });
  });

  const network = await vfs.invoke("/dev/net/request", { method: "GET", url: "https://fixture.invalid/ok" });
  assert.equal(network.body, "network-ok");
  block = true;
  const controller = new AbortController();
  const pending = vfs.invoke(MODEL, { messages: [{ role: "user", content: "cancel" }] }, { signal: controller.signal });
  while (!requestSignal) await new Promise((resolve) => setImmediate(resolve));
  controller.abort(Object.assign(new Error("caller cancelled"), { code: "ABORT_ERR" }));
  await rejectsCode(pending, "ABORT_ERR");
  assert.equal(requestSignal.aborted, true);

  // The pre-existing one-shot write remains a response-valued operation.
  const local = await namespace({ mounts: ["ai:/local,vendor=fake"] });
  const write = await local.write("/local/type/api/fake/messages/model/fake-1", {
    messages: [{ role: "user", content: "legacy" }],
  });
  assert.equal(write.value.content[0].type, "text");
});

test("public declarations describe callable resource and service authority APIs", async () => {
  const declaration = await fs.readFile(new URL("../docs/runtime-api.d.ts", import.meta.url), "utf8");
  assert.match(declaration, /interface ResourceAdapter[\s\S]*invoke\?\(/);
  assert.match(declaration, /operations: Array<[^;]*"invoke"/);
  assert.match(declaration, /interface ResourceView[\s\S]*invoke\(/);
  assert.match(declaration, /interface ServiceAuthority[\s\S]*call\(/);
});
