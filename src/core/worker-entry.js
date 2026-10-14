// worker-entry.js — a userland process.
//
// ── what runs here ──
// the tools that can run away: `js`, because a script a model wrote can spin forever, and
// `shell`, because a program can. they run in a worker thread rather than in the kernel
// process, and the reason is not hygiene — it is that the kernel's mount table lives in the
// parent, so a runaway tool cannot reach it. `worker.terminate()` stops a tight `for(;;){}`
// (measured: ~60ms, no yield needed), which a signal cannot.
//
// ── the syscall boundary ──
// this file gets a **proxy** VFS, not the real one. every operation posts a message to the
// parent and waits for the answer, so the only way anything here touches the namespace is by
// asking the kernel — which is exactly the arrangement an operating system has, arrived at
// for the same reason: the thing on this side is not trusted to hold the table itself.
//
// a proxy handle comes back from `open`, so a script here can hold a conversation with a
// model device and stream from it, through the kernel, without ever seeing a mount.

import { parentPort, workerData } from "node:worker_threads";
import * as vm from "node:vm";

let seq = 0;
/** @type {Map<number, {resolve: Function, reject: Function, onChunk?: Function}>} */
const pending = new Map();

parentPort.on("message", (m) => {
  const p = pending.get(m.id);
  if (m.type === "reply") {
    pending.delete(m.id);
    if (m.error) p.reject(rebuild(m.error));
    else p.resolve(m.value);
    return;
  }
  if (m.type === "chunk") {
    p?.onChunk?.(m.value);
    return;
  }
  if (m.type === "end") {
    pending.delete(m.id);
    p?.onEnd?.();
  }
  if (m.type === "fail") {
    pending.delete(m.id);
    p?.onError?.(rebuild(m.error));
  }
});

/** an error that crossed a realm boundary loses its class, so the code is re-attached by
 *  hand — it is the field every caller actually branches on */
function rebuild(e) {
  const err = new Error(e.message);
  err.name = e.name ?? "Error";
  if (e.code) err.code = e.code;
  if (e.hint) err.hint = e.hint;
  if (e.path) err.path = e.path;
  return err;
}

const call = (op, args) => {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    parentPort.postMessage({ type: "syscall", id, op, args });
  });
};

function proxyHandle(handleId, initialMessages) {
  let messages = initialMessages ?? [];
  let streamId = null;
  return {
    get messages() {
      return [...messages];
    },
    async send(request, opts) {
      const r = await call("handle.send", [handleId, request, sanitize(opts)]);
      messages = r.messages;
      return r.value;
    },
    stream(request, opts = {}) {
      streamId = ++seq;
      const listeners = [];
      let ended = false;
      let failure = null;

      const signal = opts.signal;
      if (signal) {
        signal.addEventListener?.("abort", () => {
          parentPort.postMessage({ type: "syscall", id: ++seq, op: "handle.abort", args: [handleId] });
        }, { once: true });
      }

      pending.set(streamId, {
        onChunk: (v) => listeners.forEach((l) => l(v)),
        onEnd: () => {
          ended = true;
          listeners.forEach((l) => l(null, true));
        },
        onError: (e) => {
          failure = e;
          listeners.forEach((l) => l(null, true, e));
        },
      });
      parentPort.postMessage({
        type: "syscall",
        id: streamId,
        op: "handle.stream",
        args: [handleId, request, sanitize(opts)],
      });

      return {
        [Symbol.asyncIterator]() {
          return this;
        },
        next() {
          if (failure) return Promise.reject(failure);
          if (ended) return Promise.resolve({ done: true, value: undefined });
          return new Promise((resolve, reject) => {
            let settled = false;
            const onValue = (v, done, err) => {
              if (settled) return;
              settled = true;
              listeners.splice(listeners.indexOf(onValue), 1);
              if (err) reject(err);
              else if (done) resolve({ done: true, value: undefined });
              else resolve({ done: false, value: v });
            };
            listeners.push(onValue);
          });
        },
        async return() {
          parentPort.postMessage({ type: "syscall", id: ++seq, op: "handle.abort", args: [handleId] });
          return { done: true, value: undefined };
        },
      };
    },
    async close() {
      await call("handle.close", [handleId]);
    },
  };
}

/** a request is passed to the parent as structured-clone data; an AbortSignal is not
 *  cloneable, so only the cheap fields travel */
const sanitize = (opts) => (opts ? { timeoutMs: opts.timeoutMs ?? null } : null);

const vfs = {
  stat: (p) => call("stat", [p]),
  exists: (p) => call("exists", [p]),
  list: (p) => call("list", [p]),
  read: (p, opts) => call("read", [p, opts ?? null]),
  write: (p, data, opts) => call("write", [p, data, opts ?? null]),
  mkdir: (p) => call("mkdir", [p]),
  mkdirp: (p) => call("mkdirp", [p]),
  remove: (p, opts) => call("remove", [p, opts ?? null]),
  rename: (a, b) => call("rename", [a, b]),
  mounts: () => call("mounts", []),
  abs: (p, cwd) => call("abs", [p, cwd ?? null]),
  async open(p, flags) {
    const id = await call("open", [p, flags ?? "r"]);
    return proxyHandle(id, []);
  },
};

const { tool: toolName, input, cwd, source } = workerData;

const ctx = {
  vfs,
  cwd,
  input,
  source,
  log: (m) => parentPort.postMessage({ type: "log", message: String(m) }),
  signal: null,
};

try {
  if (source !== undefined && source !== null) {
    // the `js` tool: evaluate a script against the namespace, here, where a runaway is
    // stoppable. `vm` is NOT a security boundary and this file does not pretend it is —
    // the boundary is the mount table, which lives in the parent, and this process is the
    // blast radius if a script gets past the context.
    const sandbox = {
      vfs,
      cwd,
      console: {
        log: (...a) => parentPort.postMessage({ type: "out", text: a.map(fmt).join(" ") }),
        error: (...a) => parentPort.postMessage({ type: "err", text: a.map(fmt).join(" ") }),
        warn: (...a) => parentPort.postMessage({ type: "err", text: a.map(fmt).join(" ") }),
      },
    };
    const context = vm.createContext(sandbox, { name: "js-tool" });
    const code = String(source).trim();
    const value = await evaluate(code, context);
    parentPort.postMessage({ type: "done", value: serialise(value) });
  } else {
    const mod = await import(toolName);
    const result = await mod.default.run(ctx);
    parentPort.postMessage({ type: "done", value: serialise(result) });
  }
} catch (e) {
  parentPort.postMessage({
    type: "failed",
    error: { name: e?.name, message: e?.message ?? String(e), code: e?.code, hint: e?.hint, path: e?.path },
  });
}

/**
 * Evaluate a script the way a shell should: declarations persist, and top-level `await`
 * works.
 *
 * `vm.runInContext(code)` gives the persistence — top-level `let`/`const`/`using` land in the
 * context's own lexical scope, which is exactly the lifetime a REPL wants. the async wrapper
 * is for the one thing a plain script cannot do.
 *
 * ── choosing between them, and the trap ──
 * the obvious test is "did it fail with a SyntaxError mentioning await", and it is wrong. in
 * a *script* — unlike a module — `await` is a legal identifier, so `await vfs.read(p)` does
 * not fail to parse as a syntax error about await: it parses cleanly as a call to something
 * named `await`, and V8 reports `Unexpected identifier 'vfs'`. a heuristic keyed on the word
 * "await" therefore never fires, the fallback never runs, and every awaited line reports a
 * parse error about an identifier the user never wrote.
 *
 * so: any SyntaxError retries as async, and if *that* fails the original error is what
 * surfaces — it is the one that points at the text the caller actually typed.
 */
async function evaluate(code, context) {
  let first;
  try {
    return await vm.runInContext(code, context, { filename: "<js>" });
  } catch (e) {
    if (e?.name !== "SyntaxError") throw e;
    first = e;
  }

  try {
    return await vm.runInContext(`(async () => (${code}))()`, context, { filename: "<js>" });
  } catch (e) {
    if (e?.name !== "SyntaxError") throw e;
  }
  try {
    return await vm.runInContext(`(async () => { ${code} })()`, context, { filename: "<js>" });
  } catch (e) {
    throw first ?? e;
  }
}

function fmt(v) {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

/** whatever the tool produced, in a form that survives structured clone. a value the port
 *  cannot carry becomes its JSON, and a value that cannot even be that becomes a marker —
 *  dropping the result entirely would be worse than describing it. */
function serialise(v) {
  if (v === undefined) return undefined;
  try {
    structuredClone(v);
    return v;
  } catch {
    try {
      return JSON.parse(JSON.stringify(v));
    } catch {
      return `[unserialisable result: ${Object.prototype.toString.call(v)}]`;
    }
  }
}
