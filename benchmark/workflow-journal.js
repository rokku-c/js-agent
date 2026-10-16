// Compare identical graph APIs; counters exclude RunStore invocation writes.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Vfs } from '../src/kernel/vfs.js';
import { createRunStore, createWorkflowGraph, inspectWorkflowGraph } from '../src/runtime.js';
const sizes = (process.env.BRANCHES ?? '32,128,512').split(',').map(Number);
const modes = (process.env.PERSISTENCE ?? 'snapshot,journal').split(',');
for (const persistence of modes) for (const size of sizes) {
  const storage = new Vfs();
  const directory = process.env.GRAPH_DURABLE ? await mkdtemp(`${tmpdir()}/graph-bench-`) : null;
  await storage.mount(directory ? 'hostfs' : 'mem', '/', directory ? { source: directory, mode: 'rw' } : {});
  let bytes = 0, writes = 0, requests = 0;
  const write = storage.write.bind(storage);
  storage.write = async (path, data, options) => {
    if (path.startsWith('/workflows/')) { bytes += Buffer.byteLength(data); writes++; }
    return write(path, data, options);
  };
  const store = createRunStore(storage, { mode: directory ? 'durable' : 'volatile' });
  const graph = createWorkflowGraph({ storage, store, persistence });
  const tool = { path: '/tools/read', name: 'read', input_schema: { type: 'object' } };
  const model = { path: '/model', async request(request) {
    requests++;
    await new Promise(resolve => setImmediate(resolve));
    return { content: request.messages.length === 1
      ? [{ type: 'tool_use', id: 'read-1', name: 'read', input: {} }]
      : [{ type: 'text', text: 'done' }] };
  } };
  const start = performance.now();
  const result = await graph.run({ id: 'bench', root: {
    agent: { model: model.path, tools: [tool.path] }, input: 'start', model,
    tools: [tool], toolAdapters: { read: async () => 'ok' },
  }, branches: Array.from({ length: size }, (_, i) => ({ branchKey: `b-${i}` })) });
  assert.equal(result.status, 'completed');
  assert.equal(requests, size + 1);
  const elapsedMs = +(performance.now() - start).toFixed(1);
  const restart = performance.now();
  // A distinct facade defeats the per-storage cache and measures full replay.
  const inspected = await inspectWorkflowGraph({ read: storage.read.bind(storage) }, 'bench');
  assert.equal(inspected.nodes.length, size + 1);
  console.log(JSON.stringify({ storage: directory ? 'durable' : 'memory', persistence, branches: size, elapsedMs, bytes, writes,
    coldInspectMs: +(performance.now() - restart).toFixed(1) }));
  if (directory) await rm(directory, { recursive: true, force: true });
}
