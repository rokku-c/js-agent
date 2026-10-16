import { test } from "node:test";
import assert from "node:assert/strict";
import { Vfs } from "js-agent/kernel";
import { consumeModelStream, createEnvironment, createServiceAuthority } from "js-agent/runtime";
import * as sse from "../src/drivers/ai/sse.js";
import openai from "../src/drivers/ai/dialects/openai.js";

const frame = (data) => `data: ${JSON.stringify(data)}\n\n`;
const start = { type: "message_start", message: { id: "m1", model: "fixture", usage: { input_tokens: 3 } } };
const block = { type: "content_block_start", index: 0, content_block: { type: "text" } };
const delta = (text) => ({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
const frames = [start, block, delta("Hello "), delta("世界"), { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }, { type: "message_stop" }].map(frame);
const events = [
  { type: "message_start", id: "m1" }, { type: "block_start", index: 0, kind: "text" },
  { type: "text_delta", index: 0, text: "partial" }, { type: "block_stop", index: 0 },
  { type: "message_delta", stop_reason: "end_turn" }, { type: "message_stop" },
];
const defer = () => Promise.withResolvers();

async function mounts(options = {}) {
  const vfs = new Vfs();
  await vfs.mount("mem", "/");
  await vfs.mount("net", "/dev/net", { allow: "fixture.invalid", ...options });
  await vfs.mount("ai", "/models", { vendor: "anthropic", token: "fixture-token", url: "https://fixture.invalid" });
  const path = "/models/type/api/anthropic/messages/model/fixture";
  return { vfs, path, handle: await vfs.open(path, "r+") };
}

function wire(t, chunks, { disconnect = false, stall = false, status = 200 } = {}) {
  const state = { requests: 0, pulls: 0, cancelled: 0, aborted: 0 };
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    state.requests++;
    state.request = JSON.parse(options.body ?? "{}");
    let index = 0;
    const body = new ReadableStream({
      start(controller) {
        options.signal.addEventListener("abort", () => {
          state.aborted++;
          try { controller.error(options.signal.reason); } catch { /* already closed */ }
        }, { once: true });
      },
      pull(controller) {
        state.pulls++;
        if (index < chunks.length) {
          const chunk = chunks[index++];
          controller.enqueue(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
        } else if (disconnect) controller.error(new Error("socket disconnected"));
        else if (!stall) controller.close();
      },
      cancel() { state.cancelled++; },
    }, { highWaterMark: 0 });
    return new Response(body, { status });
  });
  return state;
}

test("mounted AI/net/SSE incrementally decode UTF-8 and await a slow consumer", async (t) => {
  // Split within a Chinese UTF-8 codepoint as a socket is permitted to do.
  const bytes = new TextEncoder().encode(frames.join(""));
  const split = bytes.indexOf(0xe4) + 1;
  const state = wire(t, [frames[0], frames[1], frames[2], bytes.slice(new TextEncoder().encode(frames.slice(0, 3).join("")).length, split), bytes.slice(split)]);
  const { handle } = await mounts();
  const entered = defer(), release = defer();
  const seen = [];
  const response = handle.stream({ messages: [{ role: "user", content: "Hi" }] }, {
    async onEvent(ev) {
      if (ev.type === "text_delta") {
        seen.push(ev.text);
        if (seen.length === 1) { entered.resolve(); await release.promise; }
      }
    },
  });
  await entered.promise;
  assert.deepEqual(seen, ["Hello "]);
  const pulls = state.pulls;
  await new Promise(setImmediate);
  assert.equal(state.pulls, pulls, "no more reads while the consumer is blocked");
  await assert.rejects(handle.stream({}), { code: "EBUSY" });
  release.resolve();
  const result = await response;
  assert.equal(result.content[0].text, "Hello 世界");
  assert.deepEqual(result.usage, { input_tokens: 3, output_tokens: 2 });
  assert.equal(state.requests, 1);
  assert.equal(state.request.stream, true);
  assert.equal(handle.messages.length, 2);
  await handle.close();
  await assert.rejects(handle.stream({}), { code: "EBADF" });
});

test("OpenAI interleaved text and two tool argument streams retain their indexes", async () => {
  const chunks = [
    { id: "r1", choices: [{ delta: { content: "Looking ", tool_calls: [
      { index: 0, id: "a", function: { name: "lookup", arguments: '{"q":' } },
      { index: 1, id: "b", function: { name: "lookup", arguments: '{"q":' } },
    ] } }] },
    { choices: [{ delta: { content: "up", tool_calls: [
      { index: 0, function: { arguments: '"A"}' } }, { index: 1, function: { arguments: '"B"}' } },
    ] } }] },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    { choices: [], usage: { prompt_tokens: 8, completion_tokens: 7 } },
  ].map((data) => ({ chunk: frame(data) }));
  const acc = await sse.consume(chunks, openai, { requireComplete: true });
  assert.deepEqual(sse.assemble(acc).content, [
    { type: "text", text: "Looking up" },
    { type: "tool_use", id: "a", name: "lookup", input: { q: "A" } },
    { type: "tool_use", id: "b", name: "lookup", input: { q: "B" } },
  ]);
  assert.deepEqual(acc.usage, { input_tokens: 8, output_tokens: 7 });
});

for (const disconnect of [false, true]) {
  test(`mounted stream ${disconnect ? "disconnect" : "clean premature EOF"} preserves partial output and no transcript`, async (t) => {
    const state = wire(t, frames.slice(0, 3), { disconnect });
    const { handle } = await mounts();
    await assert.rejects(handle.stream({ messages: [{ role: "user", content: "Hi" }] }), (error) => {
      assert.equal(error.code, disconnect ? "EIO" : "EINCOMPLETE");
      assert.equal(error.outcome, "unknown");
      assert.equal(error.partialResponse.content[0].text, "Hello ");
      return true;
    });
    assert.deepEqual(handle.messages, []);
    assert.equal(state.requests, 1, "never retry an uncertain request");
    await handle.close();
  });
}

for (const closeHandle of [false, true]) {
  test(`mounted stream ${closeHandle ? "handle close" : "signal cancellation"} interrupts pending reads`, { timeout: 2000 }, async (t) => {
    const state = wire(t, frames.slice(0, 3), { stall: true });
    const { handle } = await mounts();
    const controller = new AbortController(), entered = defer();
    const pending = handle.stream({}, { signal: controller.signal, onEvent(ev) { if (ev.type === "text_delta") entered.resolve(); } });
    const rejected = assert.rejects(pending, (error) => {
      assert.equal(error.code, "ABORT_ERR");
      assert.equal(error.partialResponse.content[0].text, "Hello ");
      return true;
    });
    await entered.promise;
    await new Promise(setImmediate);
    if (closeHandle) await handle.close(); else controller.abort();
    await rejected;
    assert.equal(state.requests, 1);
    assert.ok(state.aborted > 0);
    assert.deepEqual(handle.messages, []);
  });
}

test("aborted request dispatches nothing", async (t) => {
  const state = wire(t, frames);
  const { handle } = await mounts();
  await assert.rejects(handle.stream({}, { signal: AbortSignal.abort() }));
  assert.equal(state.requests, 0);
});

test("callback failure retains received text and cancels the transport", async (t) => {
  const state = wire(t, frames, { stall: true });
  const { handle } = await mounts();
  await assert.rejects(handle.stream({}, { onEvent(ev) {
    if (ev.type === "text_delta") throw new Error("renderer failed");
  } }), (error) => {
    assert.equal(error.message, "renderer failed");
    assert.equal(error.partialResponse.content[0].text, "Hello ");
    return true;
  });
  assert.equal(state.cancelled, 1);
  assert.deepEqual(handle.messages, []);
});

test("HTTP rejection is classified before any model deltas are delivered", async (t) => {
  const state = wire(t, frames, { status: 429 });
  const { handle } = await mounts();
  const seen = [];
  await assert.rejects(handle.stream({}, { onEvent: (ev) => seen.push(ev) }), { code: "EBUSY" });
  assert.deepEqual(seen, []);
  assert.equal(state.cancelled, 1);
});

test("provider stream error is failure even after text arrived", async (t) => {
  wire(t, [...frames.slice(0, 3), frame({ type: "error", error: { message: "overloaded" } })]);
  const { handle } = await mounts();
  await assert.rejects(handle.stream({}), (error) => {
    assert.equal(error.message, "overloaded");
    assert.equal(error.partialResponse.content[0].text, "Hello ");
    return true;
  });
});

test("net return after headers cancels unread body; byte limit applies to streaming", async (t) => {
  const state = wire(t, ["世界"]);
  const { vfs } = await mounts({ "max-bytes": 5 });
  const handle = await vfs.open("/dev/net/request", "r+");
  const req = { url: "https://fixture.invalid", method: "GET" };
  const early = handle.stream(req);
  assert.equal((await early.next()).value.head.status, 200);
  await early.return();
  assert.equal(state.cancelled, 1);
  await assert.rejects(async () => { for await (const _ of handle.stream(req)) { /* consume */ } }, { code: "EOVERFLOW" });
  assert.equal(state.cancelled, 2);
  await handle.close();
});

test("canonical lifecycle cancels a blocked async consumer without pulling ahead", { timeout: 1000 }, async () => {
  const controller = new AbortController(), entered = defer(), release = defer();
  let returned = false, pulled = 0;
  async function* source() {
    try { for (const ev of events) { pulled++; yield ev; } } finally { returned = true; }
  }
  const pending = consumeModelStream(source(), { signal: controller.signal, async onEvent(ev) {
    if (ev.type === "text_delta") { entered.resolve(); await release.promise; }
  } });
  const rejected = assert.rejects(pending, { code: "ABORT_ERR", outcome: "unknown" });
  await entered.promise;
  controller.abort();
  await rejected;
  release.resolve();
  await new Promise(setImmediate);
  assert.equal(pulled, 3);
  assert.equal(returned, true);
});

async function environment(request) {
  const resources = new Vfs();
  await resources.mount("mem", "/");
  const services = createServiceAuthority({ "model.stream": request, "secret.read": () => "never" }, { grants: ["model.stream", "secret.read"] });
  const env = createEnvironment({
    resources, services,
    model: { path: "/model", serviceGrants: ["model.stream"], adapter: {
      async request(input, { services, resources, signal }) {
        assert.equal(resources.open, undefined, "resource views do not gain executable handles");
        await assert.rejects(services.call("secret.read", {}), { code: "EACCES" });
        return services.call("model.stream", input, { signal });
      },
    } },
    permissions: { observer: [{ path: "/runs/**", operations: ["read", "list", "stat"] }] },
  });
  return { env, resources };
}

test("Environment workflow accepts canonical streaming behind a named trusted service", async () => {
  let requests = 0;
  const { env } = await environment((_input, options) => {
    requests++;
    return consumeModelStream(events, options);
  });
  const result = await env.run({ agent: { model: "/model" }, input: "Hello", id: "stream-complete" });
  assert.equal(result.status, "completed");
  assert.equal(result.root.response.content[0].text, "partial");
  assert.equal(requests, 1);
  assert.equal((await env.observe.inspect("stream-complete")).status.status, "completed");
});

for (const cancelled of [false, true]) {
  test(`Environment records ${cancelled ? "cancelled-after-dispatch" : "truncated tool call"} as unknown without tools or retry`, async () => {
    const controller = new AbortController();
    let requests = 0;
    const { env, resources } = await environment((_input, options) => {
      requests++;
      return consumeModelStream([
        { type: "message_start" }, { type: "block_start", index: 0, kind: "tool_use", id: "t1", name: "danger" },
        { type: "tool_input_delta", index: 0, json: '{"path":' },
      ], { ...options, onEvent(ev) { if (cancelled && ev.type === "tool_input_delta") controller.abort(); } });
    });
    await assert.rejects(env.run({ agent: { model: "/model" }, input: "Hello", id: "stream-unknown", signal: controller.signal }), (error) => {
      assert.equal(error.code, cancelled ? "ABORT_ERR" : "EINCOMPLETE");
      assert.equal(error.partialResponse.content[0].input, '{"path":');
      return true;
    });
    assert.equal(requests, 1);
    assert.equal((await env.observe.inspect("stream-unknown")).status.status, "unknown");
    await assert.rejects(resources.read("/runs/stream-unknown/response.json"), { code: "ENOENT" });
    await assert.rejects(resources.read("/runs/stream-unknown/tool-calls.json"), { code: "ENOENT" });
  });
}

test("terminal marker cannot validate unfinished or malformed tool arguments", async () => {
  const partial = [
    { type: "message_start" }, { type: "block_start", index: 0, kind: "tool_use", id: "t", name: "lookup" },
    { type: "tool_input_delta", index: 0, json: '{"path":' },
  ];
  for (const tail of [
    [{ type: "message_stop" }],
    [{ type: "block_stop", index: 0 }, { type: "message_stop" }],
  ]) {
    await assert.rejects(consumeModelStream([...partial, ...tail]), (error) => {
      assert.equal(error.code, "EPROTO");
      assert.equal(error.partialResponse.content[0].input, '{"path":');
      return true;
    });
  }
  await assert.rejects(consumeModelStream([...events, ...events]), { code: "EPROTO" });
});

test("portable lifecycle cancellation settles even if source next does not cooperate", { timeout: 1000 }, async () => {
  const entered = defer(), controller = new AbortController();
  let returned = false;
  const source = {
    [Symbol.asyncIterator]() { return this; },
    next() { entered.resolve(); return new Promise(() => {}); },
    return() { returned = true; return { done: true }; },
  };
  const result = consumeModelStream(source, { signal: controller.signal });
  const rejected = assert.rejects(result, { code: "ABORT_ERR" });
  await entered.promise;
  controller.abort();
  await rejected;
  assert.equal(returned, true);
});

test("Environment cancellation before dispatch is cancelled with zero requests", async () => {
  let requests = 0;
  const { env } = await environment(() => { requests++; return consumeModelStream(events); });
  const result = await env.run({ agent: { model: "/model" }, input: "Hi", id: "pre-cancelled", signal: AbortSignal.abort() });
  assert.equal(result.status, "cancelled");
  assert.equal(requests, 0);
  assert.equal((await env.observe.inspect("pre-cancelled")).status.status, "cancelled");
});

test("SSE frame reader preserves every delimiter split and an unterminated tail", () => {
  const expected = ['data: α', 'data: first\r\ndata: second', 'data: third', 'data: tail'];
  const wire = `${expected[0]}\r\n\r\n${expected[1]}\n\n${expected[2]}\n\r\n${expected[3]}`;
  const read = (chunks) => {
    const reader = sse.makeFrameReader();
    const frames = chunks.flatMap(chunk => reader.push(chunk));
    frames.push(...reader.flush());
    assert.deepEqual(reader.flush(), []);
    return frames;
  };
  for (let split = 0; split <= wire.length; split++) {
    assert.deepEqual(read([wire.slice(0, split), '', wire.slice(split)]), expected);
  }
  for (let size = 1; size <= 11; size++) {
    const chunks = [];
    for (let i = 0; i < wire.length; i += size) chunks.push(wire.slice(i, i + size));
    assert.deepEqual(read(chunks), expected);
  }
  assert.deepEqual(read(['\n\n', '  ']), ['']);
});

test("large fragmented SSE frames preserve all bytes", () => {
  const reader = sse.makeFrameReader();
  const chunk = 'x'.repeat(64);
  reader.push('data: ');
  for (let i = 0; i < 16384; i++) assert.deepEqual(reader.push(chunk), []);
  assert.deepEqual(reader.push('\r\n\r\n'), ['data: ' + chunk.repeat(16384)]);
});

test("cancellable streams do not retain a promise reaction per consumed event", async () => {
  // Isolate GC accounting from node:test's other tests. No accumulated response
  // content: retained memory here should not grow with the number of events.
  const { execFileSync } = await import('node:child_process');
  const moduleUrl = new URL('../src/core/model-stream.js', import.meta.url).href;
  const retained = Number(execFileSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', `
    import { consumeModelStream } from ${JSON.stringify(moduleUrl)};
    const tick = () => new Promise(setImmediate);
    const controller = new AbortController();
    await tick(); globalThis.gc();
    const before = process.memoryUsage().heapUsed;
    async function* events() {
      yield { type: 'message_start' };
      for (let i = 0; i < 60000; i++) yield { type: 'message_delta', usage: { output_tokens: i } };
      await tick(); globalThis.gc();
      console.log(process.memoryUsage().heapUsed - before);
      yield { type: 'message_stop' };
    }
    await consumeModelStream(events(), { signal: controller.signal, onEvent() {} });
  `], { encoding: 'utf8' }));
  assert.ok(retained < 12 * 1024 * 1024, `retained ${retained} bytes for content-free events`);
});
