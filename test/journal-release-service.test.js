import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runJournalReleaseService } from '../examples/journal-release-service.js';

const byId = (runs, id) => runs.find(run => run.id === id);
function common(report) {
  assert.equal(report.signal, 'SIGKILL');
  assert.equal(report.remounted, true);
  assert.equal(report.runStoreMode, 'durable');
  assert.equal(report.graphFormat, 2);
  assert.equal(report.recovery.graph.status, 'unknown');
  assert.equal(report.closedStatus, 'unknown');
  assert.equal(report.repeatedRecoveryRuns, 0);
  assert.deepEqual(report.duplicate, { status: 'unknown', deduplicated: true });
  assert.equal(report.dispatchesAfterRestart, 0);
  assert.equal(report.payloadReadCode, 'EACCES');
  assert.equal(byId(report.after, 'release-check').status, 'completed');
  assert.equal(byId(report.after, 'release-root').status, 'completed_with_tool_calls');
  assert.deepEqual(report.observedBeforeRecovery, report.before.runs);
  for (const run of [...report.before.runs, ...report.after]) {
    assert.equal(run.storage, 'durable');
    assert.equal(run.redacted, true);
    assert.equal(run.partial, false);
    for (const field of ['request', 'plan', 'response']) assert.equal(field in run, false);
  }
  assert.equal(JSON.stringify(report.after).includes('Private release brief'), false);
}

test('journal Environment survives a killed process with overlapping branches and an unknown external effect', { timeout: 25000 }, async () => {
  const report = await runJournalReleaseService({ log: () => {} });
  common(report);
  assert.equal(report.before.dispatches, 3);
  assert.equal(byId(report.before.runs, 'release-publish').status, 'started');
  const published = byId(report.after, 'release-publish');
  assert.equal(published.status, 'unknown');
  assert.deepEqual(published.events.map(event => event.kind), ['started', 'unknown']);
  assert.equal(published.sequence, 2);
  assert.deepEqual(report.providerReceipts, [{ release: 'release-2026-10', action: 'publish' }]);
  assert.equal(report.recovery.runs[0].recovered, true);
  assert.equal(report.recovery.graph.nodes.find(node => node.invocationId === 'release-publish').recovery, 'process_restart');
});

test('recovery handles a killed writer between its journal graph claim and run reservation', { timeout: 25000 }, async () => {
  const report = await runJournalReleaseService({ crashAt: 'reservation', log: () => {} });
  common(report);
  assert.equal(report.before.dispatches, 2);
  assert.deepEqual(report.providerReceipts, []);
  assert.equal(byId(report.before.runs, 'release-publish'), undefined);
  assert.equal(byId(report.after, 'release-publish'), undefined);
  assert.deepEqual(report.recovery.runs, [{
    id: 'release-publish', path: '/state/runs/release-publish', status: 'unknown', recovered: false, missing: true,
  }]);
});

test('missing status still recovers a committed run journal; storage denial never becomes a missing run', async t => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { Vfs } = await import('js-agent/kernel');
  const { createEnvironment, createRunStore } = await import('js-agent/runtime');
  const directory = await mkdtemp(join(tmpdir(), 'journal-status-recovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  async function mount() {
    const storage = new Vfs();
    await storage.mount('hostfs', '/', { source: directory, mode: 'rw' });
    const environment = createEnvironment({
      resources: storage, storage, store: createRunStore(storage, { mode: 'durable' }),
      model: { path: '/model', adapter: async () => ({ content: [{ type: 'text', text: 'committed' }] }) },
    });
    return { storage, environment, graph: environment.createWorkflowGraph({ persistence: 'journal' }) };
  }
  const first = await mount();
  const rename = first.storage.rename.bind(first.storage);
  let completed = false;
  first.storage.rename = async (from, to) => {
    if (to === '/workflows/review/graph.json' && completed) throw Object.assign(new Error('crash before graph completion'), { code: 'EIO' });
    await rename(from, to);
    if (to === '/runs/review-root/status.json') completed = JSON.parse(await first.storage.read(to)).status === 'completed';
  };
  await assert.rejects(first.graph.startRoot({
    graphId: 'review', ...await first.environment.prepareWorkflow({ agent: { model: '/model', tools: [] }, input: 'review' }),
  }), { code: 'EIO' });
  await first.storage.remove('/runs/review-root/status.json');
  const fresh = await mount();
  const stat = fresh.storage.stat.bind(fresh.storage);
  fresh.storage.stat = async path => {
    if (path === '/runs/review-root') throw Object.assign(new Error('storage denied'), { code: 'EACCES' });
    return stat(path);
  };
  await assert.rejects(fresh.environment.recoverWorkflow(fresh.graph, 'review'), { code: 'EACCES' });
  assert.equal((await fresh.graph.inspect('review')).nodes[0].status, 'running');
  fresh.storage.stat = stat;
  const recovered = await fresh.environment.recoverWorkflow(fresh.graph, 'review');
  assert.equal(recovered.runs[0].recovered, true);
  assert.equal(recovered.runs[0].status, 'completed');
  assert.equal(recovered.runs[0].missing, undefined);
  assert.equal(recovered.graph.status, 'completed');
});
