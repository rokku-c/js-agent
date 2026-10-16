import { Vfs } from '../../src/kernel/vfs.js';
import { createRunStore, createWorkflowGraph } from '../../src/runtime.js';

const storage = new Vfs();
await storage.mount('hostfs', '/', { source: process.argv[2], mode: 'rw' });
const store = createRunStore(storage, { mode: 'durable' });
const graph = createWorkflowGraph({ storage, store });
const tool = { path: '/tools/read', name: 'read', description: 'Read', input_schema: { type: 'object' } };
const agent = { model: '/models/fake', tools: [tool.path] };
let calls = 0;
const model = { path: agent.model, async request(request) {
  calls++;
  if (request.messages.length === 1) return { content: [{ type: 'tool_use', id: 'read-1', name: 'read', input: {} }] };
  if (request.messages.at(-1)?.content === 'hang') {
    process.send({ ready: true, calls });
    await new Promise(() => {});
  }
  return { content: [{ type: 'text', text: 'done' }] };
} };
const started = await graph.startRoot({ graphId: 'crashed', agent, input: 'start', model, tools: [tool], toolAdapters: { read: async () => 'value' } });
const options = { graphId: 'crashed', parent: started.root, parentResponse: started.root.response, toolResults: started.toolResults, agent, model, tools: [tool] };
const attempts = await Promise.all([
  graph.continueBranch({ ...options, branchKey: 'finished', id: 'finished' }),
  graph.continueBranch({ ...options, branchKey: 'finished', id: 'duplicate' }),
]);
if (attempts.filter(result => result.deduplicated).length !== 1) throw new Error('duplicate claim dispatched');
// Hold the process alive even if the model never resolves; the parent terminates it with SIGKILL.
setInterval(() => {}, 1000);
await graph.continueBranch({ ...options, branchKey: 'interrupted', id: 'interrupted', input: 'hang' });
