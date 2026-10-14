// events.js — one run, one append-only stream.
//
// ── what this replaces ──
// nu-agent kept four different readers of the same run: a `--json` final record, the
// session's message list, an HTML trace page that *rebuilt* the rounds by walking the
// messages and pairing tool_use with tool_result, and a chat bridge that printed its own
// progress. each saw a different subset. a fold was invisible to the trace page; a tool's
// wall-clock time existed nowhere at all; a run that died mid-round left no record of what
// killed it.
//
// the stream is the one record, and everything above it is a projection. that is the whole
// idea, and it is worth the file even without the trace page it was built for: a run you
// cannot read afterwards is a run you cannot debug.
//
// ── the two rules ──
//   · append-only and **flat** — one JSON object per line, a `kind` and its fields, nothing
//     nested that a reader has to know the shape of. a partial last line is dropped, because
//     a process that died mid-write still leaves a readable stream.
//   · emitted by whoever **owns the fact**. the loop emits rounds and tool calls because it
//     waits on them; a tool subprocess emits its own if it has something to say.

import { VfsError } from "../kernel/errors.js";

/** the kinds this runtime emits, with what each carries. a stream may carry kinds that are
 *  not listed here — the emitter is lenient on purpose, because losing an event is worse
 *  than an unfamiliar one. */
export const KINDS = {
  "run.start": "task, model, provider, tools, session, budget",
  "run.end": "status, rounds, tool_calls, input_tokens, output_tokens, ms, text_bytes",
  "run.error": "where, reason",
  "round.start": "n, messages, est_tokens",
  "round.end": "n, ms, input_tokens, output_tokens, stop_reason, text_bytes",
  "tool.call": "round, id, name, input",
  "tool.result": "round, id, name, ok, ms, bytes, error",
  fold: "when (proactive|overflow), round, count, before, after, entry",
  gate: "tool, decision, reason",
  note: "free-form marker",
};

const DIR = "/agent/events";

export function runId() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `run-${stamp}-${Math.floor(1000 + Math.random() * 9000)}`;
}

const ts = () => new Date().toISOString();

/**
 * Open a stream. It is created — touched — immediately, so a run that dies before its first
 * event is still a run on disk, and "exists and is empty" stays distinguishable from "there
 * was no run".
 *
 * @param {import('../kernel/vfs.js').Vfs} vfs
 * @param {{label?: string, dir?: string}} [opts]
 */
export async function open(vfs, { label = "", dir = DIR } = {}) {
  const id = runId();
  const path = `${dir}/${id}.jsonl`;
  // same rule as sessions: somewhere to *keep* the record is a mount, not a directory that
  // happens to be creatable
  if (!vfs.isMountPoint("/agent")) return inactive(id);
  try {
    await vfs.mkdirp(dir);
    await vfs.write(path, "", { create: true });
  } catch (e) {
    // no /agent mounted means there is nowhere to keep a record, and that is not an error —
    // it is the same opt-in that makes sessions opt-in. a run without a record still runs.
    if (e instanceof VfsError && (e.code === "ENOENT" || e.code === "EACCES")) {
      return inactive(id);
    }
    throw e;
  }
  return active(vfs, id, path, label);
}

function inactive(id) {
  return {
    id,
    path: null,
    label: "",
    active: false,
    async emit() {
      return false;
    },
  };
}

function active(vfs, id, path, label) {
  let queue = Promise.resolve();
  return {
    id,
    path,
    label,
    active: true,

    /** append one event. the trailing newline is load-bearing: an append concatenates with
     *  no separator, so without it two events land on one line and the reader sees one
     *  malformed object. (nu-agent measured this the hard way.) */
    async emit(kind, data = {}) {
      const line = JSON.stringify({ run: id, ts: ts(), kind, ...data }) + "\n";
      // serialised: two emits racing would otherwise interleave their bytes
      queue = queue.then(() =>
        vfs.write(path, line, { create: true, append: true }).catch(() => null)
      );
      await queue;
      return true;
    },
  };
}

/** read a stream back — oldest first, unparseable lines dropped rather than raised on. */
export async function read(vfs, path) {
  const text = await vfs.read(path);
  const out = [];
  for (const line of String(text).split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // a torn last line, which is what a killed run leaves behind
    }
  }
  return out;
}

/** the counters a run's stream adds up to. */
export function summary(events) {
  const of = (kind) => events.filter((e) => e.kind === kind);
  const end = of("run.end").at(-1);
  const start = of("run.start").at(-1);
  const folds = of("fold");
  const results = of("tool.result");

  const byTool = new Map();
  for (const e of results) {
    const row = byTool.get(e.name) ?? { name: e.name, calls: 0, errors: 0, total_ms: 0 };
    row.calls++;
    if (!e.ok) row.errors++;
    row.total_ms += e.ms ?? 0;
    byTool.set(e.name, row);
  }

  const first = events[0]?.ts;
  const last = events.at(-1)?.ts;

  return {
    run: start?.run ?? events[0]?.run ?? null,
    events: events.length,
    rounds: of("round.end").length,
    tool_calls: results.length,
    tool_errors: results.filter((e) => !e.ok).length,
    folds: folds.length,
    input_tokens: end?.input_tokens ?? 0,
    output_tokens: end?.output_tokens ?? 0,
    ms: first && last ? new Date(last) - new Date(first) : 0,
    status: end?.status ?? (of("run.error").length ? "error" : "running"),
    task: start?.task ?? null,
    model: start?.model ?? null,
    tools: [...byTool.values()].sort((a, b) => b.total_ms - a.total_ms),
  };
}

/**
 * The rounds, rebuilt — the shape a trace page wants.
 *
 * A round is built from `round.start`, so a round that never finished still appears. A tool
 * call with no recorded result is marked as an error rather than omitted: "we never learned
 * how this call went" is not the same claim as "it worked", and a reader who is told the
 * second when the first was true will trust the wrong thing.
 */
export function model(events) {
  const start = events.find((e) => e.kind === "run.start");
  const rounds = [];
  let current = null;

  for (const e of events) {
    if (e.kind === "round.start") {
      current = { n: e.n, text: "", tools: [], folds: [], ms: 0, stop_reason: null, started: e.ts };
      rounds.push(current);
    } else if (current) {
      if (e.kind === "round.end") {
        current.ms = new Date(e.ts) - new Date(current.started);
        current.stop_reason = e.stop_reason;
      } else if (e.kind === "tool.call") {
        current.tools.push({ id: e.id, name: e.name, input: e.input, ms: 0 });
      } else if (e.kind === "tool.result") {
        const call = current.tools.find((t) => t.id === e.id) ?? { name: e.name, input: null };
        Object.assign(call, {
          result: e.result ?? null,
          is_error: !e.ok,
          ms: e.ms ?? 0,
          bytes: e.bytes ?? 0,
        });
        if (!current.tools.includes(call)) current.tools.push(call);
      } else if (e.kind === "fold") {
        current.folds.push(e);
      }
    }
  }

  for (const r of rounds) {
    for (const t of r.tools) {
      if (t.result === undefined) {
        t.is_error = true;
        t.result = "(no result recorded — the run ended before this call returned)";
      }
    }
  }

  return {
    title: "Agent Trace",
    task: start?.task ?? null,
    stats: {
      rounds: rounds.length,
      tool_calls: rounds.reduce((n, r) => n + r.tools.length, 0),
      stop_reason: rounds.at(-1)?.stop_reason ?? null,
      ms: events.length ? new Date(events.at(-1).ts) - new Date(events[0].ts) : 0,
    },
    rounds,
  };
}
