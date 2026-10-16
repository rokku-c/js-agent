import { test } from "node:test";
import assert from "node:assert/strict";
import { runInWorker } from "../src/core/worker.js";
import { invokeTool } from "../src/core/execute.js";
import { defineTool } from "../src/core/tools.js";
import { namespace, calls, fakeScript, says } from "./helpers.js";
import { run } from "../src/core/agent.js";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("worker cancellation before startup does no work", async () => {
  const controller = new AbortController();
  controller.abort();
  let touched = false;
  const result = await runInWorker({
    vfs: { open: async () => { touched = true; } },
    toolName: "js",
    input: {},
    cwd: "/",
    timeoutMs: 1000,
    source: "for (;;) {}",
    signal: controller.signal,
  });
  assert.equal(touched, false);
  assert.equal(result.cancelled, true);
});

test("worker cancellation stops a tight loop and suppresses late callbacks", async () => {
  const controller = new AbortController();
  const output = [];
  const run = runInWorker({
    vfs: {},
    toolName: "js",
    input: {},
    cwd: "/",
    timeoutMs: 5000,
    source: "for (;;) {}",
    onOutput: (message) => output.push(message),
    signal: controller.signal,
  });
  await wait(20);
  controller.abort();
  const result = await run;
  const callbacksAtFinish = output.length;
  assert.equal(result.cancelled, true);
  await wait(30);
  assert.equal(output.length, callbacksAtFinish);
});

test("worker cancellation suppresses a late syscall reply and callback", async () => {
  const controller = new AbortController();
  let markRead;
  let releaseRead;
  const readStarted = new Promise((resolve) => { markRead = resolve; });
  const readGate = new Promise((resolve) => { releaseRead = resolve; });
  const output = [];
  const run = runInWorker({
    vfs: {
      async read() {
        markRead();
        await readGate;
        return "late";
      },
    },
    toolName: "js",
    input: {},
    cwd: "/",
    timeoutMs: 5000,
    source: "await vfs.read('/late'); console.log('late reply');",
    onOutput: (message) => output.push(message),
    signal: controller.signal,
  });
  await readStarted;
  controller.abort();
  releaseRead();
  const result = await run;
  assert.equal(result.cancelled, true);
  assert.deepEqual(output, []);
});

test("a handle opened after cancellation is closed and cleanup survives close throws", async () => {
  const controller = new AbortController();
  let openStarted;
  let releaseOpen;
  let closed = 0;
  const opened = new Promise((resolve) => { openStarted = resolve; });
  const openGate = new Promise((resolve) => { releaseOpen = resolve; });
  const vfs = {
    async open() {
      openStarted();
      await openGate;
      return {
        close() {
          closed++;
          throw new Error("close failed");
        },
      };
    },
  };
  const run = runInWorker({
    vfs,
    toolName: "js",
    input: {},
    cwd: "/",
    timeoutMs: 5000,
    source: "await vfs.open('/model', 'r+'); for (;;) {}",
    signal: controller.signal,
  });
  await opened;
  controller.abort();
  releaseOpen();
  const result = await run;
  assert.equal(result.cancelled, true);
  assert.equal(closed, 1);
});

test("invokeTool treats cancellation as control flow", async () => {
  const controller = new AbortController();
  controller.abort();
  const tool = defineTool({
    name: "probe",
    description: "probe",
    params: {},
    async run() { throw new Error("must not run"); },
  });
  await assert.rejects(
    () => invokeTool({ vfs: {}, tool, input: {}, signal: controller.signal, inProcess: true }),
    (error) => error === controller.signal.reason,
  );
});


test("agent cancellation before a tool prevents another model round", async () => {
  const vfs = await namespace({
    mounts: [fakeScript(calls("read", { path: "/missing" }), says("must not be requested"))],
  });
  const controller = new AbortController();
  await assert.rejects(
    () => run(vfs, {
      prompt: "go",
      tools: ["read"],
      signal: controller.signal,
      stream: false,
      onText: null,
      onTool: () => controller.abort(),
    }),
    (error) => error === controller.signal.reason,
  );
});
