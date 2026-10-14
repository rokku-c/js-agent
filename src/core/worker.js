// worker.js — the host side of an isolated tool call.
//
// the kernel's VFS never leaves this process. the worker asks, this answers. everything the
// worker can reach, it reaches through the syscall table below — which is a statement with
// teeth, because it means the mount table is not merely unmodifiable from there, it is
// *unreachable* from there.

import { Worker } from "node:worker_threads";
import { VfsError } from "../kernel/errors.js";

const ENTRY = new URL("./worker-entry.js", import.meta.url);

/**
 * Run one tool in a worker thread, with a deadline that actually holds.
 *
 * @param {object} opts
 * @param {import('../kernel/vfs.js').Vfs} opts.vfs
 * @param {string} opts.toolName
 * @param {object} opts.input
 * @param {string} opts.cwd
 * @param {number} opts.timeoutMs
 * @param {string} [opts.source]  for the `js` tool: the script, instead of a tool module
 * @param {(msg: {kind: string, text: string}) => void} [opts.onOutput]
 * @returns {Promise<{ok: boolean, value?: any, error?: string, timedOut?: boolean}>}
 */
export function runInWorker({ vfs, toolName, input, cwd, timeoutMs, source, onOutput }) {
  return new Promise((resolve) => {
    const worker = new Worker(ENTRY, {
      workerData: { tool: toolName, input, cwd, source },
      // no stdin/stdout/stderr inheritance: the worker talks over the port, and a stray
      // write to fd 1 would corrupt whatever the caller is piping
      stdout: false,
      stderr: false,
    });

    // handles the worker opened, so a killed worker's conversations are closed here
    const handles = new Map();
    let settled = false;
    let timedOut = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      resolve(result);
    };

    const timer = setTimeout(async () => {
      timedOut = true;
      // terminate, not a signal: a tight loop takes no signal, and this does stop it
      await worker.terminate().catch(() => {});
      finish({
        ok: false,
        timedOut: true,
        error:
          `the tool ran past its ${timeoutMs}ms deadline and was killed. ` +
          "it produced no result — do NOT read this as 'found nothing'. " +
          "a search that was cut off is not a search that came back empty. " +
          "retry with a narrower or faster command, or raise the deadline.",
      });
    }, timeoutMs);
    timer.unref?.();

    worker.on("message", async (m) => {
      if (m.type === "done") return finish({ ok: true, value: m.value });
      if (m.type === "failed") {
        return finish({ ok: false, error: formatError(m.error) });
      }
      if (m.type === "log") return onOutput?.({ kind: "log", text: m.message });
      if (m.type === "out") return onOutput?.({ kind: "out", text: m.text });
      if (m.type === "err") return onOutput?.({ kind: "err", text: m.text });

      if (m.type === "syscall") return handleSyscall(m);
    });

    worker.on("error", (e) => finish({ ok: false, error: `the tool process crashed: ${e.message}` }));
    worker.on("exit", (code) => {
      if (!settled && !timedOut) {
        finish({ ok: false, error: `the tool process exited (${code}) without a result` });
      }
    });

    // ── the syscall table ──
    // every operation the worker may perform. it is short on purpose, and it is the whole
    // of what crosses the boundary.
    const reply = (id, promise) => {
      promise.then(
        (value) => worker.postMessage({ type: "reply", id, value }),
        (e) =>
          worker.postMessage({
            type: "reply",
            id,
            error: { name: e?.name, message: e?.message ?? String(e), code: e?.code, hint: e?.hint, path: e?.path },
          })
      );
    };

    const handleSyscall = (m) => {
      const { id, op, args } = m;
      try {
        switch (op) {
          case "stat":
            return reply(id, vfs.stat(args[0]));
          case "exists":
            return reply(id, vfs.exists(args[0]));
          case "list":
            return reply(id, vfs.list(args[0]));
          case "read":
            return reply(id, vfs.read(args[0], args[1] ?? {}));
          case "write":
            return reply(id, vfs.write(args[0], args[1], args[2] ?? {}));
          case "mkdir":
            return reply(id, vfs.mkdir(args[0]));
          case "mkdirp":
            return reply(id, vfs.mkdirp(args[0]));
          case "remove":
            return reply(id, vfs.remove(args[0], args[1] ?? {}));
          case "rename":
            return reply(id, vfs.rename(args[0], args[1]));
          case "mounts":
            return reply(id, vfs.mounts());
          case "abs":
            return reply(id, vfs.abs(args[0], args[1] ?? cwd));

          case "open": {
            return reply(
              id,
              (async () => {
                const handle = await vfs.open(args[0], args[1]);
                const handleId = handles.size + 1;
                handles.set(handleId, handle);
                return handleId;
              })()
            );
          }

          case "handle.send": {
            const handle = handles.get(args[0]);
            if (!handle) throw new VfsError("EBADF", "the handle was closed");
            return reply(
              id,
              (async () => {
                const value = await handle.send(args[1], args[2] ?? {});
                return { value, messages: handle.messages ?? [] };
              })()
            );
          }

          case "handle.stream": {
            const handle = handles.get(args[0]);
            if (!handle) throw new VfsError("EBADF", "the handle was closed");
            // pumped rather than awaited: the worker's iterator consumes messages as they
            // arrive, and the reply that ends it is sent when the stream does
            (async () => {
              try {
                for await (const item of handle.stream(args[1], args[2] ?? {})) {
                  if (settled) break;
                  worker.postMessage({ type: "chunk", id, value: item });
                }
                worker.postMessage({ type: "end", id });
              } catch (e) {
                worker.postMessage({
                  type: "fail",
                  id,
                  error: { message: e?.message ?? String(e), code: e?.code },
                });
              }
            })();
            return undefined;
          }

          case "handle.abort":
          case "handle.close": {
            const handle = handles.get(args[0]);
            handles.delete(args[0]);
            return reply(id, Promise.resolve(handle?.close?.()).then(() => null));
          }

          default:
            return reply(id, Promise.reject(new VfsError("ENOSYS", `no such syscall: ${op}`)));
        }
      } catch (e) {
        reply(id, Promise.reject(e));
      }
    };
  });
}

function formatError(e) {
  if (!e) return "the tool failed";
  const parts = [];
  if (e.code) parts.push(`${e.code}: `);
  parts.push(e.message ?? "failed");
  if (e.path && !String(e.message).includes(e.path)) parts.push(` (path=${e.path})`);
  if (e.hint) parts.push(`\n→ ${e.hint}`);
  return parts.join("");
}
