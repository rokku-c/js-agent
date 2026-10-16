import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vfs } from '../src/kernel/vfs.js';
import { createView, createRunStore, invokeOnce } from 'js-agent/runtime';

async function fixture() {
  const vfs = new Vfs();
  await vfs.mount('mem', '/');
  await vfs.mkdir('/workspace');
  await vfs.write('/workspace/public', 'public context', { create: true });
  await vfs.write('/workspace/private', 'private context', { create: true });
  const view = createView(vfs, { grants: [
    { path: '/workspace/public', operations: ['read'] },
  ] });
  return { vfs, view, store: createRunStore(vfs) };
}

test('runtime: View, references and one-request state compose across concurrent invocations', async () => {
  const { vfs, view, store } = await fixture();
  const received = [];
  const model = {
    path: '/models/local',
    async request(request) {
      received.push(request);
      return { content: [{ type: 'text', text: request.messages[0].content }] };
    },
  };
  const [first, second] = await Promise.all(['first', 'second'].map(input => invokeOnce({
    resources: view, agent: { model: '/models/local', context: ['/workspace/public'] },
    input, model, store,
  })));
  assert.notEqual(first.id, second.id);
  assert.equal(received.length, 2);
  assert.match(first.response.content[0].text, /^first/);
  assert.match(second.response.content[0].text, /^second/);
  const plan = JSON.parse(await vfs.read(`${first.path}/plan.json`));
  assert.equal(plan.context[0].value, 'public context');
  assert.match(plan.context[0].provenance.contentHash, /^sha256:/);
  // State inspection is a separate capability from source-reading/model invocation.
  await assert.rejects(() => view.read(`${first.path}/status.json`), { code: 'EACCES' });
  const observer = createView(vfs, { grants: [{ path: '/runs/**', operations: ['read'] }] });
  assert.equal(JSON.parse(await observer.read(`${first.path}/status.json`)).status, 'completed');
});

test('runtime: inaccessible context fails without releasing any input to a model', async () => {
  const { view, store } = await fixture();
  let called = false;
  await assert.rejects(() => invokeOnce({
    resources: view,
    agent: { model: '/models/local', context: ['/workspace/private'] },
    input: 'inspect', store,
    model: { path: '/models/local', request() { called = true; } },
  }), { code: 'EACCES' });
  assert.equal(called, false);
});
