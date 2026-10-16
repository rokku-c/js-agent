import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Vfs } from '../src/kernel/vfs.js';
import { createRunStore, createWorkflowGraph, createRunObserver } from '../src/runtime.js';
const tool = { path: '/tools/read', name: 'read', input_schema: { type: 'object' } };
const agent = { model: '/model', tools: [tool.path] };
const toolModel = { path: '/model', async request() {
  return { content: [{ type: 'tool_use', id: 'read-1', name: 'read', input: {} }] };
} };
const doneModel = { path: '/model', async request() { return { content: [{ type: 'text', text: 'done' }] }; } };
async function open(directory, persistence = 'journal', extra = {}) {
  const storage = new Vfs();
  await storage.mount(directory ? 'hostfs' : 'mem', '/', directory ? { source: directory, mode: 'rw' } : {});
  const store = createRunStore(storage, { mode: directory ? 'durable' : 'volatile' });
  return { storage, store, graph: createWorkflowGraph({ storage, store, persistence, ...extra }) };
}
async function fixture(t, persistence = 'journal') {
  const directory = await mkdtemp(`${tmpdir()}/workflow-journal-`);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, ...await open(directory, persistence) };
}
const start = (graph, graphId = 'shared') => graph.startRoot({ graphId, agent, input: 'start', model: toolModel, tools: [tool], toolAdapters: { read: async () => 'ok' } });
const branch = (started, branchKey, model = doneModel) => ({ graphId: started.graphId, branchKey,
  parent: started.root, parentResponse: started.root.response, toolResults: [{ tool_use_id: 'read-1', content: 'ok' }], agent, model, tools: [tool] });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

for (const persistence of ['snapshot', 'journal']) test(`${persistence}: simultaneous durable processes preserve claims and deduplicate shared edges`, { timeout: 30000 }, async t => {
  const { directory, graph } = await fixture(t, persistence);
  await start(graph);
  const children = ['one', 'two', 'three'].map(name => fork(new URL('./fixtures/workflow-journal-worker.js', import.meta.url), [directory, name], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] }));
  t.after(() => children.forEach(child => child.kill()));
  await Promise.all(children.map(async child => { assert.equal((await once(child, 'message'))[0].ready, true); }));
  const results = children.map(child => once(child, 'message'));
  const exits = children.map(child => once(child, 'exit'));
  children.forEach(child => child.send('go'));
  assert.equal((await Promise.all(results)).reduce((sum, [message]) => sum + message.calls, 0), 28);
  for (const [code] of await Promise.all(exits)) assert.equal(code, 0);
  const restarted = await open(directory); // Persistence is detected from disk.
  const result = await restarted.graph.close('shared');
  assert.equal(result.status, 'completed');
  assert.equal(result.nodes.length, 29);
  assert.equal(result.edges.length, 28);
  assert.equal(new Set(result.nodes.map(node => node.invocationId)).size, 29);
  const observer = createRunObserver(restarted.storage);
  assert.equal((await observer.list()).length, 29);
});

test('journal: branching, multilevel continuation, explicit join and fresh observer', async t => {
  const { directory, graph, storage } = await fixture(t);
  const started = await start(graph);
  const [left, right] = await Promise.all([
    graph.continueBranch(branch(started, 'left', toolModel)),
    graph.continueBranch(branch(started, 'right')),
  ]);
  assert.equal(right.status, 'completed');
  const leaf = await graph.continueBranch({ ...branch(started, 'leaf'), parentKey: left.node.key,
    parent: left.result, parentResponse: left.result.response });
  assert.equal(leaf.status, 'completed');
  assert.equal((await graph.close('shared')).status, 'completed');
  assert.equal(JSON.parse(await storage.read('/workflows/shared/graph.json')).version, 2);
  const restarted = await open(directory, 'snapshot');
  const duplicate = await restarted.graph.continueBranch(branch(await start(restarted.graph), 'left'));
  assert.equal(duplicate.deduplicated, true);
  const view = await restarted.graph.inspect('shared');
  assert.equal(view.nodes.length, 4);
  assert.equal(view.edges.length, 3);
  assert.equal(view.uncertainNodes.length, 0);
  assert.equal((await createRunObserver(restarted.storage).snapshot(leaf.node.invocationId)).status, 'completed');
});

test('journal: recovery fences late completion and cancellation survives a fresh mount', async t => {
  const { directory, graph } = await fixture(t);
  const started = await start(graph);
  const entered = deferred(), gate = deferred();
  const running = graph.continueBranch(branch(started, 'held', { path: '/model', async request() {
    entered.resolve(); await gate.promise; return { content: [{ type: 'text', text: 'late' }] };
  } }));
  await entered.promise;
  await assert.rejects(graph.close('shared'), { code: 'EBUSY' });
  const restarted = await open(directory);
  const recovered = await restarted.graph.recover('shared');
  assert.equal(recovered.status, 'unknown');
  gate.resolve();
  assert.equal((await running).status, 'unknown');
  assert.equal((await restarted.graph.inspect('shared')).nodes[1].recovery, 'process_restart');

  const second = await start(graph, 'cancel');
  const entered2 = deferred(), gate2 = deferred();
  const pending = graph.continueBranch(branch(second, 'held', { path: '/model', async request() {
    entered2.resolve(); await gate2.promise; return { content: [{ type: 'text', text: 'late' }] };
  } }));
  await entered2.promise;
  await restarted.graph.cancel('cancel');
  gate2.resolve();
  const cancelled = await pending;
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.node.invocationStatus, 'completed');
  assert.equal((await restarted.graph.inspect('cancel')).edges[0].status, 'cancelled');
});

test('journal: failed commit pointer ignores orphan delta and recovery uses invocation evidence', async () => {
  const { storage, store, graph } = await open();
  const started = await start(graph);
  const rename = storage.rename.bind(storage);
  let fail = true;
  storage.rename = async (from, to) => {
    if (fail && to === '/workflows/shared/graph.json') {
      const head = JSON.parse(await storage.read(from));
      const record = JSON.parse(await storage.read(`/workflows/shared/journal/${String(head.sequence).padStart(12, '0')}.json`));
      if (record.nodes.some(node => node.kind === 'continuation' && node.status === 'completed')) {
        fail = false; throw Object.assign(new Error('lost commit'), { code: 'EIO' });
      }
    }
    return rename(from, to);
  };
  await assert.rejects(graph.continueBranch(branch(started, 'child')), { code: 'EIO' });
  const fresh = createWorkflowGraph({ storage, store });
  const before = await fresh.inspect('shared');
  assert.equal(before.nodes[1].status, 'running');
  assert.equal(before.reconciliation[1].persistedStatus, 'completed');
  assert.equal((await fresh.recover('shared')).nodes[1].status, 'completed');
});

test('journal: malformed/missing published records fail closed on cold read', async () => {
  const { storage, store, graph } = await open();
  await start(graph);
  const path = '/workflows/shared/graph.json';
  const original = JSON.parse(await storage.read(path));
  await storage.write(path, JSON.stringify({ ...original, sequence: original.sequence + 1 }));
  const fresh = createWorkflowGraph({ storage: { read: storage.read.bind(storage), write: storage.write.bind(storage) }, store });
  await assert.rejects(fresh.inspect('shared'), { code: 'EPROTO' });
  await storage.write(path, JSON.stringify(original));
  await storage.write('/workflows/shared/journal/000000000001.json', '{broken');
  await assert.rejects(fresh.inspect('shared'), { code: 'EPROTO' });
});

test('journal: malformed published deltas fail closed before graph validation', async () => {
  const { storage, store, graph } = await open();
  await start(graph);
  const headPath = '/workflows/shared/graph.json';
  const head = JSON.parse(await storage.read(headPath));
  const recordPath = `/workflows/shared/journal/${String(head.sequence).padStart(12, '0')}.json`;
  const original = await storage.read(recordPath);
  const malformed = [
    { sequence: head.sequence, fields: {}, nodes: [{ key: 'root' }, { key: 'root' }], edges: [] },
    { sequence: head.sequence, fields: { nodes: [] }, nodes: [], edges: [] },
    { sequence: head.sequence, fields: {}, nodes: [{ key: 1 }], edges: [] },
  ];
  for (const delta of malformed) {
    await storage.write(recordPath, JSON.stringify(delta));
    const facade = { read: storage.read.bind(storage), write: storage.write.bind(storage) };
    const fresh = createWorkflowGraph({ storage: facade, store, persistence: 'journal' });
    await assert.rejects(fresh.inspect('shared'), { code: 'EPROTO' });
  }
  await storage.write(recordPath, original);
  assert.equal((await graph.inspect('shared')).nodes.length, 1);
});

test('durable stale graph lock fails closed without stealing ownership', async t => {
  const { directory, storage, graph } = await fixture(t);
  await start(graph);
  await storage.mkdir('/workflows/.lock-shared', { exclusive: true });
  const restarted = await open(directory, 'journal', { lockTimeoutMs: 10 });
  await assert.rejects(restarted.graph.cancel('shared'), { code: 'EBUSY' });
  assert.equal(await storage.exists('/workflows/.lock-shared'), true);
  assert.equal((await restarted.graph.inspect('shared')).cancelRequested, false);
});

test('journal: SIGKILL while publishing leaves an operator-owned stale lock', { timeout: 15000 }, async t => {
  const { directory } = await fixture(t);
  const child = fork(new URL('./fixtures/workflow-journal-lock-child.js', import.meta.url), [directory], {
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  t.after(() => child.kill());
  assert.equal((await once(child, 'message'))[0].ready, true);
  assert.equal((await once(child, 'message'))[0].entered, true);
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  assert.equal((await exited)[1], 'SIGKILL');

  const restarted = await open(directory, 'journal', { lockTimeoutMs: 10 });
  assert.equal(await restarted.storage.exists('/workflows/.lock-locked'), true);
  await assert.rejects(restarted.graph.inspect('locked'), { code: 'ENOENT' });
  await assert.rejects(restarted.graph.cancel('locked'), { code: 'EBUSY' });
  assert.equal(await restarted.storage.exists('/workflows/.lock-locked'), true);
});

test('journal: SIGKILL during dispatch leaves a recoverable claim, not a held graph lock', { timeout: 15000 }, async t => {
  const { directory } = await fixture(t);
  const child = fork(new URL('./fixtures/workflow-crash-child.js', import.meta.url), [directory], {
    env: { ...process.env, GRAPH_PERSISTENCE: 'journal' }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  t.after(() => child.kill());
  assert.equal((await once(child, 'message'))[0].ready, true);
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  assert.equal((await exited)[1], 'SIGKILL');
  const restarted = await open(directory);
  const before = await restarted.graph.inspect('crashed');
  assert.equal(before.nodes.length, 3);
  assert.equal(before.uncertainNodes.length, 1);
  assert.equal((await restarted.graph.recover('crashed')).status, 'unknown');
  const after = await restarted.graph.inspect('crashed');
  assert.equal(after.nodes.find(node => node.invocationId === 'interrupted').recovery, 'process_restart');
  assert.equal((await createRunObserver(restarted.storage).snapshot('finished')).status, 'completed');
});

test('journal cache cannot reuse an old generation after graph replacement', async () => {
  const { storage, store, graph } = await open();
  await start(graph);
  const old = await graph.inspect('shared');
  await storage.remove('/workflows/shared', { recursive: true });
  const facade = Object.fromEntries(['read', 'write', 'mkdirp', 'mkdir', 'rename', 'remove', 'exists'].map(method => [method, storage[method].bind(storage)]));
  const replacement = createWorkflowGraph({ storage: facade, store, persistence: 'journal' });
  await replacement.startRoot({ graphId: 'shared', rootId: 'replacement-root', agent, input: 'new', model: toolModel, tools: [tool], toolAdapters: { read: async () => 'ok' } });
  assert.equal((await graph.inspect('shared')).nodes[0].invocationId, 'replacement-root');
  assert.equal(old.nodes[0].invocationId, 'shared-root');
});

test('journal write volume grows linearly with branch count', async () => {
  const volumes = [];
  for (const size of [32, 128]) {
    const { storage, graph } = await open();
    let bytes = 0;
    const write = storage.write.bind(storage);
    storage.write = async (path, text, options) => {
      if (path.startsWith('/workflows/')) bytes += Buffer.byteLength(text);
      return write(path, text, options);
    };
    const started = await start(graph);
    await Promise.all(Array.from({ length: size }, (_, i) => graph.continueBranch(branch(started, `b-${i}`))));
    assert.equal((await graph.close('shared')).nodes.length, size + 1);
    volumes.push(bytes);
  }
  assert.ok(volumes[1] < volumes[0] * 5, `expected linear write growth: ${volumes}`);
});
