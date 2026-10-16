// node examples/journal-release-service.js
// Public APIs only. A real writer is killed after a separately persisted service
// effect, while two review branches overlap. Recovery never replays that effect.
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, open, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Vfs } from 'js-agent/kernel';
import { createEnvironment, createRunStore } from 'js-agent/runtime';

const graphId = 'release';
const root = '/state/runs';
const ids = ['release-root', 'release-check', 'release-publish'];
const agent = { model: '/models/reviewer', context: ['/workspace/brief.md'], tools: ['/tools/evidence'] };
const never = () => new Promise(() => {});

async function openApplication(directory, request, services = {}, beforeReserve) {
  const storage = new Vfs();
  await storage.mount('hostfs', '/', { source: join(directory, 'state'), mode: 'rw' });
  // Fault injection at a resource-adapter boundary, used only by the second crash case.
  if (beforeReserve) {
    const mkdir = storage.mkdir.bind(storage);
    storage.mkdir = async (path, options) => {
      if (path === `${root}/release-publish`) await beforeReserve();
      return mkdir(path, options);
    };
  }
  const environment = createEnvironment({
    resources: storage, storage,
    store: createRunStore(storage, { root, mode: 'durable' }),
    graphRoot: '/state/workflows',
    model: { path: agent.model, adapter: request, serviceGrants: ['release.publish'] },
    services,
    tools: {
      paths: ['/tools/evidence'],
      adapters: [{ path: '/tools/evidence', invoke: async ({ resources }) => resources.read('/workspace/brief.md') }],
    },
    permissions: {
      agent: [{ path: '/workspace/**', operations: ['read'] }],
      tools: [{ path: '/tools/**', operations: ['read'] }, { path: '/workspace/**', operations: ['read'] }],
      observer: [
        { path: root, operations: ['list'] },
        ...ids.flatMap(id => [
          { path: `${root}/${id}`, operations: ['stat'] },
          { path: `${root}/${id}/status.json`, operations: ['read'] },
          { path: `${root}/${id}/events.jsonl`, operations: ['read'] },
        ]),
      ],
    },
  });
  return { storage, environment, graph: environment.createWorkflowGraph({ persistence: 'journal' }) };
}

async function seed(storage) {
  await storage.mkdirp('/workspace');
  await storage.mkdirp('/tools/evidence');
  await storage.write('/workspace/brief.md', 'Private release brief: verify rollback before publishing.', { create: true });
  await storage.write('/tools/evidence/definition.json', JSON.stringify({
    name: 'evidence', description: 'Read the release brief', input_schema: { type: 'object' },
  }), { create: true });
}

// A local stand-in for an external provider. The receipt is outside the mounted
// runtime tree and fsynced before returning; it is NOT part of either journal.
async function publish(directory, input) {
  const receipt = await open(join(directory, 'provider-receipts.jsonl'), 'a');
  try { await receipt.writeFile(JSON.stringify(input) + '\n'); await receipt.sync(); }
  finally { await receipt.close(); }
}

function summary(graph) {
  return { status: graph.status, nodes: graph.nodes.map(({ key, status, invocationId, recovery }) => ({ key, status, invocationId, recovery })) };
}

async function writer(directory, crashAt) {
  const checkEntered = Promise.withResolvers();
  const publishEntered = Promise.withResolvers();
  const effectWritten = Promise.withResolvers();
  let dispatches = 0;
  const model = async (request, { services }) => {
    dispatches++;
    if (request.messages.length === 1) return {
      content: [{ type: 'tool_use', id: 'evidence-1', name: 'evidence', input: {} }],
      stop_reason: 'tool_use',
    };
    if (request.messages.at(-1).content === 'check') {
      checkEntered.resolve();
      await publishEntered.promise; // Proves simultaneous branch execution, without sleeps.
      return { content: [{ type: 'text', text: 'Rollback verified.' }], stop_reason: 'end_turn' };
    }
    publishEntered.resolve();
    await checkEntered.promise;
    await services.call('release.publish', { release: 'release-2026-10', action: 'publish' });
    effectWritten.resolve();
    return never(); // Provider acted; model response has not been committed.
  };
  const beforeReserve = crashAt === 'reservation' ? async () => {
    publishEntered.resolve();
    effectWritten.resolve();
    await never();
  } : undefined;
  const { storage, environment, graph } = await openApplication(directory, model, {
    'release.publish': input => publish(directory, input),
  }, beforeReserve);
  await seed(storage);
  const prepared = await environment.prepareWorkflow({ agent, input: 'Review and publish the release.' });
  const started = await graph.startRoot({ ...prepared, graphId });
  const branch = name => graph.continueBranch({
    ...prepared, graphId, branchKey: name, input: name,
    parent: started.root, parentResponse: started.root.response, toolResults: started.toolResults,
  });
  const check = branch('check');
  const publishing = branch('publish');
  // Consume errors immediately, including before reaching the readiness message.
  publishing.catch(error => { console.error(error); process.exitCode = 1; process.disconnect(); });
  await Promise.all([check, effectWritten.promise]);
  process.send({ phase: 'ready', dispatches, graph: summary(await graph.inspect(graphId)), runs: await environment.observer.list() });
  await publishing;
}

function waitReady(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('writer did not reach crash boundary in 15s')), 15_000);
    const onMessage = message => { if (message?.phase === 'ready') finish(null, message); };
    const onExit = () => finish(new Error('writer exited before reaching crash boundary'));
    const onError = error => finish(error);
    function finish(error, value) {
      clearTimeout(timer);
      child.off('message', onMessage); child.off('exit', onExit); child.off('error', onError);
      if (error) reject(error); else resolve(value);
    }
    child.on('message', onMessage); child.once('exit', onExit); child.once('error', onError);
  });
}

export async function runJournalReleaseService({ log = console.log, crashAt = 'external-effect' } = {}) {
  if (!['external-effect', 'reservation'].includes(crashAt)) throw new TypeError('unsupported crash boundary');
  const directory = await mkdtemp(join(tmpdir(), 'js-agent-journal-service-'));
  let child, exited;
  try {
    await mkdir(join(directory, 'state'));
    // Create and sync the provider's ledger before the writer starts.
    const receipt = await open(join(directory, 'provider-receipts.jsonl'), 'w');
    await receipt.sync(); await receipt.close();
    child = fork(fileURLToPath(import.meta.url), ['--writer', directory, crashAt], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    exited = once(child, 'exit'); exited.catch(() => {});
    const before = await waitReady(child);
    child.kill('SIGKILL');
    const [, signal] = await exited; // Stop the old writer before any recovery write.

    let dispatchesAfterRestart = 0;
    const { storage, environment, graph } = await openApplication(directory, async () => {
      dispatchesAfterRestart++;
      throw new Error('recovery must not dispatch');
    });
    const observedBeforeRecovery = await environment.observer.list();
    const recovery = await environment.recoverWorkflow(graph, graphId);
    const after = await environment.observer.list();
    // Repeated recovery and repeated branch submissions must not replay the effect.
    const repeatedRecovery = await environment.recoverWorkflow(graph, graphId);
    const duplicate = await graph.continueBranch({ graphId, branchKey: 'publish' });
    const closed = await graph.close(graphId);
    let payloadReadCode;
    try { await environment.observe.read(`${root}/release-root/request.json`); }
    catch (error) { payloadReadCode = error.code; }
    const head = JSON.parse(await storage.read('/state/workflows/release/graph.json'));
    const providerReceipts = (await readFile(join(directory, 'provider-receipts.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
    const report = {
      crashAt, signal, remounted: true, runStoreMode: environment.store.mode, graphFormat: head.version,
      before: { dispatches: before.dispatches, graph: before.graph, runs: before.runs },
      observedBeforeRecovery,
      recoveryOrder: ['stop writer', 'remount', 'inspect graph', 'recover uncertain run journals', 'recover graph index'],
      recovery: { runs: recovery.runs, graph: summary(recovery.graph) },
      after, repeatedRecoveryRuns: repeatedRecovery.runs.length,
      duplicate: { status: duplicate.status, deduplicated: duplicate.deduplicated },
      closedStatus: closed.status, dispatchesAfterRestart, payloadReadCode, providerReceipts,
      limits: {
        externalEffect: 'unknown to the runtime; provider evidence requires application reconciliation',
        exactlyOnce: false, distributedTransactions: false,
        observer: 'redacted best-effort snapshots; not an atomic graph/run transaction',
        recovery: 'old writer must be stopped or fenced; stale graph locks require operator handling',
        durability: 'hostfs process-crash exercise; not a power-loss or remote-filesystem certification',
      },
    };
    log(JSON.stringify(report, null, 2));
    return report;
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited?.catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--writer') {
    const keepAlive = setInterval(() => {}, 1_000);
    try { await writer(process.argv[3], process.argv[4]); }
    finally { clearInterval(keepAlive); }
  } else await runJournalReleaseService();
}
