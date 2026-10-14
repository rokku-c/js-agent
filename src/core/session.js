// session.js — persist a run and resume it later.
//
// ── the invariant, restated because everything here follows from it ──
// a session stores the **canonical, unfolded** message list. folding is a derived view and
// is never persisted. the loop reassigns its working `messages` on every trim, so the list a
// run ends with is full of `[folded] item 7 …` placeholders; persisting that is the
// double-fold trap — resume hands the model placeholders, then folds them again.
//
// ── provenance, not value ──
// `tools` and `skills` are stored as *where to get them* (names and paths), never as resolved
// content. an MCP server can be down and a module can be renamed, so freezing yesterday's
// `input_schema` replays a stale tool set; a skill path re-reads an edited file, a stored
// body freezes it. images store paths, not base64 — a 10MB screenshot would make the session
// file 10MB, and `session list` reads every file.
//
// ── opt-in ──
// a session exists when /agent is mounted and `--session`/`--resume` was given. a run with
// neither writes nothing, so the default behaviour is unchanged by this file existing.

import { VfsError } from "../kernel/errors.js";

const DIR = "/agent/sessions";

export function newId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `ses-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${Math.floor(1000 + Math.random() * 9000)}`;
}

const pathOf = (dir, id) => `${dir}/${id}.json`;

async function requireStore(vfs, dir) {
  // a *mount point*, not merely a path. without the distinction, mkdirp happily creates
  // /agent inside whatever is mounted at /, the session is written, and it disappears with
  // the process — a `--session` that appears to work and loses everything is worse than one
  // that refuses.
  if (!vfs.isMountPoint("/agent")) {
    throw new VfsError("ENOENT", "there is no session store in this namespace", {
      path: "/agent",
      hint: "mount one: --state <dir> on the command line, or mount hostfs:/agent,source=<dir>,mode=rw",
    });
  }
  await vfs.mkdirp(dir).catch(() => {});
}

/**
 * Assemble the stored record. Named fields rather than positional arguments, for the reason
 * nu-agent found the hard way: a positional record with this many fields gets one call site
 * passing them in the wrong order, and the failure surfaces as a type error on whichever
 * parameter the shift happened to land on.
 */
export function recordOf({
  id,
  status = "running",
  prompt = "",
  messages = [],
  provider = null,
  model = null,
  system = null,
  skill = [],
  toolsFrom = [],
  images = [],
  budget = {},
  counters = {},
  folds = [],
  contextEntries = [],
  parent = null,
  depth = 0,
  created = null,
}) {
  return {
    id,
    created: created ?? new Date().toISOString(),
    updated: new Date().toISOString(),
    status,
    // the title is derived, never passed — it exists so `session list` is readable
    title: String(prompt).replace(/\s+/g, " ").trim().slice(0, 80),
    provider,
    model,
    system,
    skill,
    tools: { from: toolsFrom },
    images,
    budget,
    counters,
    folds,
    context_entries: contextEntries,
    parent,
    depth,
    messages,
  };
}

export async function store(vfs, record, { dir = DIR } = {}) {
  await requireStore(vfs, dir);
  const existing = await load(vfs, record.id, { dir }).catch(() => null);
  // `created` is preserved across re-stores — a run writes at the end of every round, and
  // restamping would make "when did this start" unanswerable
  const next = { ...record, created: existing?.created ?? record.created, updated: new Date().toISOString() };
  await vfs.write(pathOf(dir, record.id), JSON.stringify(next, null, 2), { create: true });
  return record.id;
}

export async function exists(vfs, id, { dir = DIR } = {}) {
  return vfs.exists(pathOf(dir, id));
}

export async function load(vfs, id, { dir = DIR } = {}) {
  try {
    return JSON.parse(await vfs.read(pathOf(dir, id)));
  } catch (e) {
    throw new VfsError("ENOENT", `no session ${id}`, {
      path: pathOf(dir, id),
      hint: "session list shows what exists",
    });
  }
}

/** the most recently updated session, or null. */
export async function last(vfs, { dir = DIR } = {}) {
  const all = await list(vfs, { dir });
  if (!all.length) return null;
  const newest = all.reduce((a, b) => (String(a.updated) >= String(b.updated) ? a : b));
  return load(vfs, newest.id, { dir });
}

export async function list(vfs, { dir = DIR } = {}) {
  let entries = [];
  try {
    entries = await vfs.list(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.name.endsWith(".json")) continue;
    try {
      const r = JSON.parse(await vfs.read(`${dir}/${e.name}`));
      out.push({
        id: r.id,
        updated: r.updated,
        status: r.status,
        provider: r.provider,
        model: r.model,
        title: String(r.title ?? "").slice(0, 50),
        rounds: r.counters?.rounds ?? 0,
        messages: (r.messages ?? []).length,
        parent: r.parent ?? null,
        depth: r.depth ?? 0,
      });
    } catch {
      // an unparseable file must not take the listing down
    }
  }
  return out.sort((a, b) => String(a.updated).localeCompare(String(b.updated)));
}

/**
 * Split a stored history into the part that is loaded and the part that is not.
 *
 * `prefix` stays in the store and is written back on every save — that asymmetry is the
 * entire point of a tail, and getting it wrong silently truncates a session the first time
 * someone resumes a long one.
 */
export function window(prior, tail = null) {
  if (!prior) return { prefix: [], loaded: [] };
  const stored = prior.messages ?? [];
  const want = tail ?? prior.handoff?.tail ?? null;
  if (want == null || want >= stored.length) return { prefix: [], loaded: stored };
  const n = Math.max(0, Math.min(want, stored.length));
  return { prefix: stored.slice(0, stored.length - n), loaded: stored.slice(stored.length - n) };
}

export async function show(vfs, id, { limit = 40, index = null, full = false, dir = DIR } = {}) {
  const r = await load(vfs, id, { dir });
  if (full) return r;
  if (index !== null) {
    const msgs = r.messages ?? [];
    if (index < 0 || index >= msgs.length) {
      throw new VfsError("EINVAL", `index ${index} is out of range 0..${msgs.length - 1}`);
    }
    return msgs[index];
  }
  return {
    id: r.id,
    status: r.status,
    title: r.title,
    created: r.created,
    updated: r.updated,
    provider: r.provider,
    model: r.model,
    counters: r.counters,
    parent: r.parent,
    depth: r.depth,
    folds: (r.folds ?? []).length,
    total: (r.messages ?? []).length,
    messages: (r.messages ?? []).slice(-limit).map((m, i, arr) => ({
      i: (r.messages.length - arr.length) + i,
      role: m?.role ?? "?",
      kind: Array.isArray(m?.content) ? m.content.map((b) => b?.type).join("+") : "text",
      preview: Array.isArray(m?.content)
        ? (m.content.find((b) => b?.type === "text")?.text ?? `${m.content.length} blocks`).slice(0, 70)
        : String(m?.content ?? "").slice(0, 70),
    })),
  };
}

/** the context entries a session referenced, so `session show` can name the originals. */
export async function entries(vfs, id, { dir = DIR } = {}) {
  const r = await load(vfs, id, { dir });
  return r.context_entries ?? [];
}
