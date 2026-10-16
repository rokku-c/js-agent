// Run with: node examples/one-request.js
// The core APIs receive their IO and model from the host; this example uses memory only.
import { Vfs } from '../src/kernel/vfs.js';
import { createView, createRunStore, invokeOnce } from '../src/runtime.js';

const storage = new Vfs();
await storage.mount('mem', '/');
await storage.mkdirp('/agents/reviewer');
await storage.mkdirp('/workspace');
await storage.write('/agents/reviewer/system.md', 'Explain the provided source briefly.', { create: true });
await storage.write('/workspace/main.js', 'export const answer = 42;\n', { create: true });
await storage.write('/agents/reviewer/agent.json', JSON.stringify({
  model: '/models/offline',
  system: ['/agents/reviewer/system.md'],
  context: [{ $ref: '/workspace/main.js', selector: { lines: [1, 1] } }],
  tools: [],
}), { create: true });

const resources = createView(storage, { grants: [
  { path: '/agents/reviewer/**', operations: ['read'] },
  { path: '/workspace/**', operations: ['read'] },
] });
const model = {
  path: '/models/offline',
  async request(request) {
    // A deterministic adapter demonstrates plumbing, not model reasoning.
    return {
      content: [{ type: 'text', text: `Observed source: ${request.messages[0].content}` }],
      stop_reason: 'end_turn',
    };
  },
};
const result = await invokeOnce({
  resources, agent: '/agents/reviewer/agent.json', input: 'Describe this module.',
  model, store: createRunStore(storage),
});
console.log(JSON.stringify({ path: result.path, status: result.status, response: result.response }, null, 2));
console.log(await storage.read(`${result.path}/status.json`));
