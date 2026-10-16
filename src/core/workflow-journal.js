// A committed prefix of immutable delta records. graph.json is the commit pointer;
// a crash before its rename leaves an unreferenced record that the next writer replaces.
const caches = new WeakMap();
const origins = new WeakMap();
const protocol = () => Object.assign(new Error('invalid workflow graph journal'), { code: 'EPROTO' });
const recordPath = (path, sequence) => `${path}/journal/${String(sequence).padStart(12, '0')}.json`;
const clone = value => JSON.parse(JSON.stringify(value));

function cacheFor(storage) {
  let cache = caches.get(storage);
  if (!cache) caches.set(storage, cache = new Map());
  return cache;
}

function remember(cache, path, value) {
  cache.delete(path);
  cache.set(path, value);
  // Retain only a small working set; inspection must not pin every visited graph.
  if (cache.size > 8) cache.delete(cache.keys().next().value);
}

function apply(state, delta, sequence, indexes) {
  if (!delta || delta.sequence !== sequence || !delta.fields || typeof delta.fields !== 'object'
    || Array.isArray(delta.fields) || !Array.isArray(delta.nodes) || !Array.isArray(delta.edges)
    || 'nodes' in delta.fields || 'edges' in delta.fields || Object.hasOwn(delta.fields, '__proto__')) throw protocol();
  Object.assign(state, delta.fields);
  for (const field of ['nodes', 'edges']) {
    const positions = indexes[field];
    const seen = new Set();
    for (const item of delta[field]) {
      if (!item || typeof item.key !== 'string' || seen.has(item.key)) throw protocol();
      seen.add(item.key);
      const index = positions.get(item.key);
      if (index === undefined) { positions.set(item.key, state[field].length); state[field].push(item); }
      else state[field][index] = item;
    }
  }
}

export async function readGraphDocument(storage, path, graphId) {
  const text = await storage.read(`${path}/graph.json`);
  const head = JSON.parse(text);
  if (head?.version !== 2) return head;
  if (head.id !== graphId || head.path !== path || !Number.isSafeInteger(head.sequence) || head.sequence < 1
    || typeof head.generation !== 'string' || !/^[a-f0-9-]{36}$/.test(head.generation)) throw protocol();
  const cache = cacheFor(storage);
  const previous = cache.get(path);
  // Replay only the newly published suffix. Each returned value is isolated from
  // both the cache and callers holding an earlier inspection result.
  const compatible = previous && previous.generation === head.generation && previous.sequence <= head.sequence;
  if (compatible && previous.sequence === head.sequence) {
    const state = clone(previous.state);
    origins.set(state, previous);
    remember(cache, path, previous);
    return state;
  }
  const state = compatible ? clone(previous.state) : { nodes: [], edges: [] };
  const indexes = Object.fromEntries(['nodes', 'edges'].map(field => [field, new Map(state[field].map((item, i) => [item.key, i]))]));
  for (let seq = compatible ? previous.sequence + 1 : 1; seq <= head.sequence; seq++) {
    let delta;
    try { delta = JSON.parse(await storage.read(recordPath(path, seq))); }
    catch (error) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) throw protocol();
      throw error;
    }
    apply(state, delta, seq, indexes);
  }
  const baseline = clone(state);
  remember(cache, path, { sequence: head.sequence, generation: head.generation, state: baseline });
  origins.set(state, { sequence: head.sequence, generation: head.generation, state: baseline });
  return state;
}

export function hasJournal(state) { return origins.has(state); }

export async function writeGraphJournal(storage, state, writeSnapshot) {
  const previous = origins.get(state);
  const sequence = (previous?.sequence ?? 0) + 1;
  const generation = previous?.generation ?? globalThis.crypto.randomUUID();
  const { nodes, edges, ...fields } = state;
  const changed = (field, values) => {
    const old = new Map((previous?.state[field] ?? []).map(item => [item.key, JSON.stringify(item)]));
    return values.filter(item => old.get(item.key) !== JSON.stringify(item));
  };
  const delta = { sequence, fields, nodes: changed('nodes', nodes), edges: changed('edges', edges) };
  await storage.mkdirp(`${state.path}/journal`);
  await writeSnapshot(recordPath(state.path, sequence), delta);
  await writeSnapshot(`${state.path}/graph.json`, { version: 2, id: state.id, path: state.path, sequence, generation });
  const baseline = clone(state);
  remember(cacheFor(storage), state.path, { sequence, generation, state: baseline });
  origins.set(state, { sequence, generation, state: baseline });
}
