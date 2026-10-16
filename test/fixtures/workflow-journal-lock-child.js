import { Vfs } from '../../src/kernel/vfs.js';
import { createRunStore, createWorkflowGraph } from '../../src/runtime.js';

const storage = new Vfs();
await storage.mount('hostfs', '/', { source: process.argv[2], mode: 'rw' });
const store = createRunStore(storage, { mode: 'durable' });
const graph = createWorkflowGraph({ storage, store, persistence: 'journal', lockTimeoutMs: 10000 });
const originalRename = storage.rename.bind(storage);
storage.rename = async (from, to) => {
  if (to === '/workflows/locked/graph.json') {
    process.send?.({ entered: true });
    await new Promise(() => {});
  }
  return originalRename(from, to);
};
process.send?.({ ready: true });
setInterval(() => {}, 1000);
await graph.startRoot({
  graphId: 'locked',
  agent: { model: '/model', tools: [] },
  model: { path: '/model', async request() { return { content: [{ type: 'text', text: 'held' }] }; } },
});
