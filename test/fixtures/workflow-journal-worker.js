import { Vfs } from '../../src/kernel/vfs.js';
import { createRunStore, createWorkflowGraph } from '../../src/runtime.js';
const storage = new Vfs();
await storage.mount('hostfs', '/', { source: process.argv[2], mode: 'rw' });
const store = createRunStore(storage, { mode: 'durable' });
const graph = createWorkflowGraph({ storage, store, lockTimeoutMs: 10000 });
const tool = { path: '/tools/read', name: 'read', input_schema: { type: 'object' } };
const agent = { model: '/model', tools: [tool.path] };
let calls = 0;
const model = { path: '/model', async request() {
  calls++;
  return { content: [{ type: 'text', text: 'done' }] };
} };
process.send({ ready: true });
await new Promise(resolve => process.once('message', resolve));
const started = await graph.startRoot({ graphId: 'shared', agent, model });
await Promise.all(Array.from({ length: 12 }, (_, i) => graph.continueBranch({
  graphId: 'shared', branchKey: i < 4 ? `shared-${i}` : `${process.argv[3]}-${i}`,
  parent: started.root, parentResponse: started.root.response,
  toolResults: [{ tool_use_id: 'read-1', content: 'ok' }], agent, model, tools: [tool],
})));
process.send({ calls });
process.disconnect();
