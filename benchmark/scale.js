// Local fixtures only. Run: node --expose-gc benchmark/scale.js
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { Vfs } from '../src/kernel/vfs.js';
import { createRunStore } from '../src/core/run-store.js';
import { invokeOnce } from '../src/core/invocation.js';
import { createWorkflowGraph } from '../src/core/workflow-graph.js';
import { createRunObserver } from '../src/core/run-observer.js';
import { resolveReference } from '../src/core/references.js';
import { consumeModelStream } from '../src/core/model-stream.js';
import { makeFrameReader } from '../src/drivers/ai/sse.js';

const tick = () => new Promise(setImmediate);
async function measure(name, size, operation) {
  globalThis.gc?.();
  const before = process.memoryUsage().heapUsed;
  const start = performance.now();
  const details = await operation();
  console.log(JSON.stringify({ name, size, ms: +(performance.now() - start).toFixed(2),
    heapDeltaMiB: +((process.memoryUsage().heapUsed - before) / 1048576).toFixed(2), ...details }));
}
console.log(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch, gc: !!globalThis.gc }));
for (const size of [262144, 1048576]) {
  await measure('sse-fragmented-frame', size, () => {
    const reader = makeFrameReader();
    reader.push('data: ');
    for (let i = 0; i < size; i += 64) assert.equal(reader.push('x'.repeat(64)).length, 0);
    assert.equal(reader.push('\r\n\r\n')[0].length, size + 6);
  });
}
for (const size of [20000, 80000]) {
  await measure('stream-cancellable-events', size, async () => {
    const controller = new AbortController();
    const before = process.memoryUsage().heapUsed;
    let retainedMiB;
    async function* events() {
      yield { type: 'message_start' };
      for (let i = 0; i < size; i++) yield { type: 'message_delta', usage: { output_tokens: i } };
      await tick();
      globalThis.gc?.();
      retainedMiB = +((process.memoryUsage().heapUsed - before) / 1048576).toFixed(2);
      yield { type: 'message_stop' };
    }
    const result = await consumeModelStream(events(), { signal: controller.signal, onEvent() {} });
    assert.equal(result.usage.output_tokens, size - 1);
    return { retainedMiB };
  });
}
for (const size of [1048576, 4194304]) {
  await measure('reference-small-line-selection', size, async () => {
    const text = 'x\n'.repeat(size / 2);
    const result = await resolveReference({ read: async () => text }, { $ref: '/large', selector: { lines: [1, 2] } }, { maxBytes: 4 });
    assert.equal(result.value, 'x\nx\n');
  });
}
for (const size of [100, 400, 1000]) {
  const storage = new Vfs();
  await storage.mount('mem', '/');
  const store = createRunStore(storage);
  let requests = 0, active = 0, maxActive = 0;
  const model = { path: '/model', async request() {
    requests++; active++; maxActive = Math.max(active, maxActive);
    await tick(); active--;
    return { content: [{ type: 'text', text: 'done' }] };
  } };
  await measure('concurrent-one-request-runs', size, async () => {
    const results = await Promise.all(Array.from({ length: size }, (_, i) => invokeOnce({
      resources: storage, store, model, agent: { model: '/model' }, input: 'hi', id: `run-${i}`,
    })));
    assert.ok(results.every(result => result.status === 'completed'));
    assert.equal(requests, size);
    return { requests, maxActive };
  });
  let reads = 0, maxReads = 0;
  const observer = createRunObserver({
    list: (...args) => storage.list(...args), stat: (...args) => storage.stat(...args),
    async read(...args) { reads++; maxReads = Math.max(reads, maxReads); await tick();
      try { return await storage.read(...args); } finally { reads--; }
    },
  });
  await measure('observer-list', size, async () => {
    assert.equal((await observer.list()).length, size);
    return { maxConcurrentReads: maxReads };
  });
  await measure('observer-terminal-watches', size, async () => {
    let snapshots = 0;
    await Promise.all(Array.from({ length: size }, async (_, i) => {
      for await (const snapshot of observer.watch(`run-${i}`)) { assert.equal(snapshot.terminal, true); snapshots++; }
    }));
    return { snapshots };
  });
  await measure('observer-live-watch-updates', size, async () => {
    // Persist a running fixture, observe it, then publish a terminal snapshot.
    const writeState = async (i, status) => {
      const id = `run-${i}`;
      await storage.write(`/runs/${id}/status.json`, JSON.stringify({ id, status }));
      await storage.write(`/runs/${id}/events.jsonl`, JSON.stringify({ seq: 1, kind: 'started' }) + '\n' +
        (status === 'completed' ? JSON.stringify({ seq: 2, kind: 'completed' }) + '\n' : ''));
    };
    await Promise.all(Array.from({ length: size }, (_, i) => writeState(i, 'started')));
    const liveObserver = createRunObserver(storage, { interval: 1 });
    const watches = Array.from({ length: size }, (_, i) => liveObserver.watch(`run-${i}`));
    const initial = await Promise.all(watches.map(watch => watch.next()));
    assert.ok(initial.every(item => item.value.status === 'started'));
    await Promise.all(Array.from({ length: size }, (_, i) => writeState(i, 'completed')));
    const final = await Promise.all(watches.map(watch => watch.next()));
    assert.ok(final.every(item => item.value.status === 'completed'));
    assert.ok((await Promise.all(watches.map(watch => watch.next()))).every(item => item.done));
    return { snapshots: size * 2 };
  });
}
for (const size of [32, 128, 512]) {
  const storage = new Vfs();
  await storage.mount('mem', '/');
  const store = createRunStore(storage);
  let graphBytes = 0, graphWrites = 0;
  const write = storage.write.bind(storage);
  storage.write = async (path, data, options) => {
    if (path.includes('/workflows/')) { graphBytes += Buffer.byteLength(data); graphWrites++; }
    return write(path, data, options);
  };
  const graph = createWorkflowGraph({ storage, store });
  let requests = 0;
  const tools = [{ path: '/tools/read', name: 'read', input_schema: { type: 'object' } }];
  const agent = { model: '/model', tools: ['/tools/read'] };
  const model = { path: '/model', async request(request) {
    requests++;
    await tick();
    return { content: request.messages.length === 1
      ? [{ type: 'tool_use', id: 'tool-1', name: 'read', input: {} }]
      : [{ type: 'text', text: 'done' }] };
  } };
  await measure('graph-branches', size, async () => {
    const result = await graph.run({ id: `graph-${size}`, root: {
      agent, input: 'hi', model, tools, toolAdapters: { read: async () => 'ok' },
    }, branches: Array.from({ length: size }, (_, i) => ({ branchKey: `branch-${i}` })) });
    assert.equal(result.status, 'completed');
    assert.equal(requests, size + 1);
    return { requests, graphWrites, graphMiBWritten: +(graphBytes / 1048576).toFixed(2) };
  });
}
