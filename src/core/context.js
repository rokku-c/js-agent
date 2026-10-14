// context.js — capture and folding.
//
// ── the invariant everything else depends on ──
// folding alters only the copy that goes *out*. the full body stays in the store, readable
// at any time. session.js owns the consequence: the loop carries an append-only `canonical`
// list that folding never touches, and only *that* is persisted. save the working copy and a
// resumed run hands the model `[folded] item 7` placeholders and then folds them again.
//
// ── the three rules that are not obvious ──
//   · **a tool turn folds as a pair.** Anthropic requires every tool_result to match a
//     tool_use on an earlier assistant message; folding half of one produces a request the
//     API rejects outright.
//   · **message 0 is protected.** it is the original task, and folding it removes the
//     question. nu-agent learned this the hard way: with keep-recent set, message 0 lost its
//     protection, so the task got folded while the 3MB tool result that actually ate the
//     space was protected as "recent" — exactly backwards.
//   · **a small message is not worth folding.** the placeholder is ~100 characters itself,
//     so folding something smaller *grows* the context. without a floor you get "folding
//     constantly, never within budget", and end up with the whole context folded away for
//     nothing.

import { VfsError } from "../kernel/errors.js";

const DIR = "/agent/context";

/** the model window behind the gateway nu-agent was measured against is 1048576 tokens, so
 *  leave ~15% headroom. overridable, and only ever used as a *target*. */
export const DEFAULT_BUDGET = 890_000;
export const MIN_FOLD_CHARS = 300;

const est = (chars) => Math.ceil(chars / 3);
const sizeOf = (m) => JSON.stringify(m).length;

const isBlocks = (c) => Array.isArray(c);
const hasBlock = (m, kind) => isBlocks(m?.content) && m.content.some((b) => b?.type === kind);

export function newEntryId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `ctx-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${Math.floor(1000 + Math.random() * 9000)}`;
}

export async function capture(vfs, messages, note = "") {
  const id = newEntryId();
  await vfs.mkdirp(DIR);
  await vfs.write(
    `${DIR}/${id}.json`,
    JSON.stringify({ id, created: new Date().toISOString(), note, messages, folded: [], kept: [] }, null, 2),
    { create: true }
  );
  return id;
}

export async function loadEntry(vfs, id) {
  try {
    return JSON.parse(await vfs.read(`${DIR}/${id}.json`));
  } catch {
    throw new VfsError("ENOENT", `no context entry ${id}`, { path: `${DIR}/${id}.json` });
  }
}

async function markFolded(vfs, id, indexes) {
  const e = await loadEntry(vfs, id).catch(() => null);
  if (!e) return;
  e.folded = [...new Set([...(e.folded ?? []), ...indexes])].sort((a, b) => a - b);
  await vfs.write(`${DIR}/${id}.json`, JSON.stringify(e, null, 2), { create: true }).catch(() => {});
}

function placeholder(m, idx, entry, chars, kind) {
  const what =
    kind === "tool_pair"
      ? "tool turn (call + result)"
      : kind === "tool_use"
        ? "assistant message (with tool call)"
        : kind === "tool_result"
          ? "tool result"
          : "message";
  return `[folded] item ${idx} (${m?.role ?? "?"}) (${what}) — original ${chars} chars, full content in entry ${entry}`;
}

/** oldest to newest, folding whatever can be folded until the estimate fits the budget. */
function planFold(messages, keep, keepRecent, budget) {
  const n = messages.length;
  const sizes = messages.map(sizeOf);
  let chars = sizes.reduce((a, b) => a + b, 0);
  const plan = [];
  const recentStart = n - keepRecent;

  for (let i = 0; i < n; i++) {
    if (chars <= budget * 3) break;
    if (keep.includes(i)) continue;
    if (i >= recentStart) continue;
    if (plan.includes(i)) continue;

    const m = messages[i];
    if (hasBlock(m, "tool_use") && i + 1 < n) {
      const nxt = messages[i + 1];
      if (keep.includes(i + 1) || plan.includes(i + 1)) continue;
      if (!hasBlock(nxt, "tool_result")) continue;
      const pair = sizes[i] + sizes[i + 1];
      if (pair < MIN_FOLD_CHARS) continue;
      plan.push(i, i + 1);
      chars -= pair;
    } else {
      if (sizes[i] < MIN_FOLD_CHARS) continue;
      plan.push(i);
      chars -= sizes[i];
    }
  }
  return plan.sort((a, b) => a - b);
}

/** complete a set of indexes into legal fold units. a manual fold bypasses the planner, so
 *  an explicit index has to be paired up here or it splits a tool turn. */
function closePairs(messages, indexes) {
  const n = messages.length;
  const out = new Set(indexes);
  for (const i of [...indexes]) {
    if (i < 0 || i >= n) continue;
    const blocks = Array.isArray(messages[i]?.content) ? messages[i].content : [];
    if (blocks.some((b) => b?.type === "tool_use") && i + 1 < n) out.add(i + 1);
    if (blocks.some((b) => b?.type === "tool_result") && i > 0) out.add(i - 1);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * Fold to a budget and return the reduced messages plus the entry holding the original.
 *
 * the budget is a **soft target**: protected messages and those under MIN_FOLD_CHARS are
 * left alone, so `after_tokens` may still top the budget. read the numbers rather than
 * assuming.
 */
export async function apply(
  vfs,
  messages,
  { budget = DEFAULT_BUDGET, keep = [], fold = [], keepRecent = 4, note = "", dryRun = false } = {}
) {
  const n = messages.length;
  const chars = JSON.stringify(messages).length;
  const before = est(chars);

  if (n === 0) {
    return { messages, entry: null, folded: [], before_tokens: 0, after_tokens: 0, changed: false };
  }

  // an explicit `fold 0` is the only way to release the original task
  const protectedIdx = fold.includes(0) ? new Set(keep) : new Set([...keep, 0]);

  const forced = closePairs(
    messages,
    fold.filter((i) => i >= 0 && i < n)
  );
  const plan = [
    ...new Set([...forced, ...planFold(messages, [...protectedIdx], keepRecent, budget)]),
  ]
    .filter((i) => !protectedIdx.has(i))
    .sort((a, b) => a - b);

  if (plan.length === 0) {
    return {
      messages,
      entry: null,
      folded: [],
      plan: [],
      before_tokens: before,
      after_tokens: before,
      changed: false,
    };
  }

  const entry = dryRun
    ? null
    : await capture(vfs, messages, note || `auto-fold (original ${n} msgs / ~${before} tokens)`);

  const reduced = messages.map((m, i) => {
    if (!plan.includes(i)) return m;
    const kind = hasBlock(m, "tool_use")
      ? "tool_pair"
      : hasBlock(m, "tool_result")
        ? "tool_result"
        : "msg";
    return {
      role: m.role ?? "user",
      content: placeholder(m, i, entry ?? "dry-run", sizeOf(m), kind),
    };
  });

  if (entry) await markFolded(vfs, entry, plan);

  return {
    messages: reduced,
    entry,
    folded: plan,
    before_tokens: before,
    after_tokens: est(JSON.stringify(reduced).length),
    changed: true,
  };
}

/** list the stored entries, newest last. */
export async function listEntries(vfs) {
  let entries = [];
  try {
    entries = await vfs.list(DIR);
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.name.endsWith(".json")) continue;
    try {
      const rec = JSON.parse(await vfs.read(`${DIR}/${e.name}`));
      out.push({
        entry: rec.id,
        created: rec.created,
        note: rec.note,
        messages: (rec.messages ?? []).length,
        folded: (rec.folded ?? []).length,
      });
    } catch {
      // an unreadable entry is not a reason to fail the listing
    }
  }
  return out.sort((a, b) => String(a.created).localeCompare(String(b.created)));
}

export async function show(vfs, id, { index = null, full = false } = {}) {
  const e = await loadEntry(vfs, id);
  if (full) return e;
  if (index !== null) {
    const msgs = e.messages ?? [];
    if (index < 0 || index >= msgs.length) {
      throw new VfsError("EINVAL", `index ${index} is out of range 0..${msgs.length - 1}`);
    }
    return msgs[index];
  }
  return {
    entry: e.id,
    created: e.created,
    note: e.note,
    total: (e.messages ?? []).length,
    folded: e.folded ?? [],
    kept: e.kept ?? [],
    index: (e.messages ?? []).map((m, i) => ({
      i,
      role: m?.role ?? "?",
      kind: hasBlock(m, "tool_use")
        ? "tool_use"
        : hasBlock(m, "tool_result")
          ? "tool_result"
          : Array.isArray(m?.content)
            ? "blocks"
            : "text",
      chars: sizeOf(m),
      preview: Array.isArray(m?.content)
        ? `${m.content.length} blocks`
        : String(m?.content ?? "").slice(0, 60),
    })),
  };
}
