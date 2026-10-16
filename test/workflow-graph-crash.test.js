import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import { Vfs } from '../src/kernel/vfs.js';
import { createRunStore, createRunObserver, createWorkflowGraph } from '../src/runtime.js';

const tools = [{ path: '/tools/read', name: 'read', description: 'Read', input_schema: { type: 'object' } }];
const agent = { model: '/models/fake', tools: ['/tools/read'] };
const response = { content: [{ type: 'tool_use', id: 'read-1', name: 'read', input: {} }] };
const toolResults = [{ tool_use_id: 'read-1', content: 'value' }];
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function open(directory) {
  const storage = new Vfs();
  await storage.mount('hostfs', '/', { source: directory, mode: 'rw' });
  const store = createRunStore(storage, { mode: 'durable' });
  return { storage, store, graph: createWorkflowGraph({ storage, store }) };
}
async function fixture(t) {
  const directory = await mkdtemp(`${os.tmpdir()}/js-agent-graph-crash-`);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, ...await open(directory) };
}
async function start(graph, graphId = 'graph', model = { path: agent.model, request: async () => response }) {
  return graph.startRoot({ graphId, agent, input: 'start', model, tools, toolAdapters: { read: async () => 'value' } });
}
function branch(started, branchKey, model, extra = {}) {
  return { graphId: started.graphId, branchKey, parent: started.root, parentResponse: started.root.response, toolResults: started.toolResults ?? toolResults, agent, model, tools, ...extra };
}

test('SIGKILL: durable branches, duplicate claims, explicit join and observer survive fresh remount', { timeout: 15000 }, async t => {
  const { directory } = await fixture(t);
  const child = fork(new URL('./fixtures/workflow-crash-child.js', import.meta.url), [directory], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
  });
  const exited = once(child, 'exit');
  const message = await Promise.race([
    once(child, 'message').then(([value]) => value),
    exited.then(() => { throw new Error(`fixture exited before crash point: ${stderr}`); }),
  ]);
  assert.equal(message.calls, 3);
  child.kill('SIGKILL');
  assert.equal((await exited)[1], 'SIGKILL');
  const { storage, store, graph } = await open(directory);
  const observer = createRunObserver(storage);
  const before = await graph.inspect('crashed');
  assert.deepEqual(before.uncertainNodes.map(node => node.invocationId), ['interrupted']);
  assert.equal((await observer.snapshot('interrupted')).status, 'started');
  await assert.rejects(graph.close('crashed'), { code: 'EBUSY' });
  let dispatches = 0;
  const model = { path: agent.model, request: async () => { dispatches++; return response; } };
  const root = await start(graph, 'crashed', model);
  assert.equal(root.deduplicated, true);
  const duplicate = await graph.continueBranch(branch(root, 'interrupted', model, { id: 'retry-must-not-exist' }));
  assert.equal(duplicate.deduplicated, true);
  assert.equal(dispatches, 0);
  assert.equal(await storage.exists('/runs/retry-must-not-exist'), false);
  assert.equal((await store.recover('interrupted')).status, 'unknown');
  const recovered = await graph.recover('crashed');
  assert.equal(recovered.status, 'unknown');
  assert.deepEqual(recovered.edges.map(edge => edge.status), ['completed', 'unknown']);
  assert.equal((await graph.close('crashed')).status, 'unknown');
  const snapshots = await observer.list();
  assert.equal(snapshots.length, 3);
  for (const snapshot of snapshots) {
    assert.equal(snapshot.storage, 'durable');
    assert.equal(snapshot.redacted, true);
    assert.equal(snapshot.partial, false);
    assert.equal('request' in snapshot || 'response' in snapshot, false);
  }
  const third = await open(directory);
  assert.deepEqual((await third.graph.inspect('crashed')).nodes, recovered.nodes);
});

test('remounted graph cancellation aborts its new branch and preserves unknown invocation evidence', async t => {
  const { directory, graph } = await fixture(t);
  await start(graph);
  const restarted = await open(directory);
  const root = await start(restarted.graph);
  const gate = deferred(); const entered = deferred();
  const model = { path: agent.model, async request() { entered.resolve(); await gate.promise; return { content: [{ type: 'text', text: 'late' }] }; } };
  const running = restarted.graph.continueBranch(branch(root, 'child', model));
  await entered.promise;
  await restarted.graph.cancel('graph');
  gate.resolve();
  const result = await running;
  assert.equal(result.status, 'cancelled');
  assert.equal(result.node.status, 'cancelled');
  assert.equal(result.node.invocationStatus, 'unknown');
  assert.equal((await restarted.graph.inspect('graph')).edges[0].status, 'cancelled');
});

test('cancel does not rewrite a completed or recovered-unknown graph', async t => {
  const { graph } = await fixture(t);
  await start(graph);
  await graph.close('graph');
  assert.equal((await graph.cancel('graph')).status, 'completed');
  assert.equal((await graph.inspect('graph')).cancelRequested, false);
});

test('same branch key under distinct parents produces unique nodes and invocation IDs', async t => {
  const { graph } = await fixture(t);
  const started = await start(graph);
  const model = { path: agent.model, request: async () => response };
  const parents = await Promise.all(['left', 'right'].map(key => graph.continueBranch(branch(started, key, model))));
  const children = await Promise.all(parents.map(parent => graph.continueBranch(branch(started, 'shared', model, {
    parent: parent.result, parentResponse: parent.result.response, parentKey: parent.node.key, toolResults,
  }))));
  assert.notEqual(children[0].node.key, children[1].node.key);
  assert.notEqual(children[0].node.invocationId, children[1].node.invocationId);
  const snapshot = await graph.close('graph');
  assert.equal(snapshot.status, 'completed');
  assert.equal(new Set(snapshot.nodes.map(node => node.key)).size, 5);
});

test('normalization-equivalent branch names still dispatch distinct durable runs', async t => {
  const { graph } = await fixture(t);
  const started = await start(graph);
  const model = { path: agent.model, request: async () => ({ content: [{ type: 'text', text: 'done' }] }) };
  const results = await Promise.all(['a b', 'a-b'].map(key => graph.continueBranch(branch(started, key, model))));
  assert.notEqual(results[0].node.invocationId, results[1].node.invocationId);
  assert.equal((await graph.close('graph')).status, 'completed');
});

test('recovered child reports recovered status to late caller, not its late provider success', async t => {
  const { directory, graph } = await fixture(t);
  const started = await start(graph);
  const gate = deferred(); const entered = deferred();
  const model = { path: agent.model, async request() { entered.resolve(); await gate.promise; return { content: [{ type: 'text', text: 'late' }] }; } };
  const running = graph.continueBranch(branch(started, 'late', model));
  await entered.promise;
  const restarted = await open(directory);
  await restarted.graph.recover('graph');
  gate.resolve();
  const late = await running;
  assert.equal(late.status, 'unknown');
  assert.equal(late.node.status, 'unknown');
  assert.equal(late.result.status, 'completed');
  assert.equal((await restarted.graph.cancel('graph')).status, 'unknown');
});

test('a separate coordinator cancellation wins late success without falsifying the run status', async t => {
  const { directory, graph, store } = await fixture(t);
  const started = await start(graph);
  const gate = deferred(); const entered = deferred();
  const model = { path: agent.model, async request() { entered.resolve(); await gate.promise; return { content: [{ type: 'text', text: 'done' }] }; } };
  const running = graph.continueBranch(branch(started, 'child', model, { id: 'external-cancel-child' }));
  await entered.promise;
  const restarted = await open(directory);
  await restarted.graph.cancel('graph');
  gate.resolve();
  const result = await running;
  assert.equal(result.status, 'cancelled');
  assert.equal(result.node.invocationStatus, 'completed');
  assert.equal((await store.readStatus('external-cancel-child')).status, 'completed');
  assert.equal((await restarted.graph.inspect('graph')).edges[0].status, 'cancelled');
});

test('root cancellation preserves the interrupted invocation evidence', async t => {
  const { graph, store } = await fixture(t);
  const gate = deferred(); const entered = deferred();
  const model = { path: agent.model, async request() { entered.resolve(); await gate.promise; return { content: [{ type: 'text', text: 'late' }] }; } };
  const running = start(graph, 'root-cancel', model);
  await entered.promise;
  await graph.cancel('root-cancel');
  gate.resolve();
  const result = await running;
  assert.equal(result.status, 'cancelled');
  assert.equal(result.graph.nodes[0].status, 'cancelled');
  assert.equal((await store.readStatus('root-cancel-root')).status, 'unknown');
  assert.equal(result.graph.nodes[0].invocationStatus, 'unknown');
});

test('cancelled restart reconciles node and edge cancellation, retaining terminal evidence', async t => {
  const { graph, storage } = await fixture(t);
  const started = await start(graph);
  const model = { path: agent.model, request: async () => ({ content: [{ type: 'text', text: 'done' }] }) };
  await graph.continueBranch(branch(started, 'child', model));
  const path = '/workflows/graph/graph.json';
  const saved = JSON.parse(await storage.read(path));
  // Crash window: cancellation is durable, child completion exists only in RunStore.
  saved.cancelRequested = true;
  saved.status = 'cancelling';
  saved.nodes[1].status = saved.nodes[1].invocationStatus = 'running';
  saved.edges[0].status = 'running';
  await storage.write(path, JSON.stringify(saved));
  const recovered = await graph.recover('graph');
  assert.equal(recovered.status, 'cancelled');
  assert.equal(recovered.nodes[1].status, 'cancelled');
  assert.equal(recovered.nodes[1].invocationStatus, 'completed');
  assert.equal(recovered.edges[0].status, 'cancelled');
});

test('distinct logical edges cannot claim one explicit invocation ID or leave ghost nodes', async t => {
  const { graph } = await fixture(t);
  const started = await start(graph);
  const model = { path: agent.model, request: async () => ({ content: [{ type: 'text', text: 'done' }] }) };
  await graph.continueBranch(branch(started, 'one', model, { id: 'shared-id' }));
  await assert.rejects(graph.continueBranch(branch(started, 'two', model, { id: 'shared-id' })), { code: 'EEXIST' });
  const snapshot = await graph.inspect('graph');
  assert.equal(snapshot.nodes.length, 2);
  assert.equal(snapshot.edges.length, 1);
  assert.equal((await graph.close('graph')).status, 'completed');
});

test('v1 unescaped edge identity still deduplicates after remount', async t => {
  const { directory, graph, storage } = await fixture(t);
  const started = await start(graph);
  const model = { path: agent.model, request: async () => ({ content: [{ type: 'text', text: 'done' }] }) };
  await graph.continueBranch(branch(started, 'a:b', model, { id: 'legacy-id' }));
  const path = '/workflows/graph/graph.json';
  const saved = JSON.parse(await storage.read(path));
  saved.edges[0].key = 'root:a:b';
  await storage.write(path, JSON.stringify(saved));
  const restarted = await open(directory);
  const root = await start(restarted.graph);
  const result = await restarted.graph.continueBranch(branch(root, 'a:b', { path: agent.model, request() { throw new Error('must not dispatch'); } }));
  assert.equal(result.deduplicated, true);
  assert.equal(result.node.invocationId, 'legacy-id');
});

test('malformed persisted schemas fail closed rather than silently rewriting graph evidence', async t => {
  const { graph, storage } = await fixture(t);
  await start(graph);
  const path = '/workflows/graph/graph.json';
  const valid = JSON.parse(await storage.read(path));
  for (const corrupt of [
    value => { value.version = 999; },
    value => { value.path = '/workflows/another-graph'; },
    value => { value.nodes.push({ ...value.nodes[0] }); },
    value => { value.edges.push({ key: 'orphan', from: 'root', to: 'missing', status: 'running' }); },
  ]) {
    const value = structuredClone(valid);
    corrupt(value);
    const text = JSON.stringify(value);
    await storage.write(path, text);
    await assert.rejects(graph.inspect('graph'), { code: 'EPROTO' });
    await assert.rejects(graph.recover('graph'), { code: 'EPROTO' });
    assert.equal(await storage.read(path), text);
  }
});
