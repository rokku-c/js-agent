// net.js — the network, and the only module in this repository that touches one.
//
// ── the claim this file is load-bearing for ──
// "no network by default" is not a policy here, it is a fact about the process. this module
// is reachable only through the registry, the registry loads it only when someone mounts
// it, and the `airgap` test suite refuses a `fetch(` anywhere else in the tree. an agent
// whose namespace has no /dev/net has no network because there is no code to have one with.
//
// ── and the capability has a scope ──
// a network you can reach anything through is ambient network access wearing a path, which
// is the thing this whole design exists to avoid. so the mount carries the scope: which
// hosts, which methods, how many bytes, whether redirects may be followed. `allow` is
// required, and mounting without it is an error rather than an open gate — passing
// `allow=*` is how you say "anything", and saying it is the point.
//
// ── why the transport is pluggable ──
// the design must not depend on `fetch` existing. a relay, a CLI, a unix socket to a proxy
// — somewhere without fetch, or behind a CORS wall, or with a mandatory egress point, is
// still somewhere this should work. so `fetch` is one of three transports, chosen at mount
// time, and nothing above this file knows which one ran.

import { VfsError } from "../kernel/errors.js";
import { defineDriver, dirStat, fileStat, deviceStat, entry } from "../kernel/driver.js";
import { networkHandle } from "../kernel/airgap.js";
import { spawn } from "node:child_process";

const DEFAULT_METHODS = ["GET", "POST", "HEAD"];

/** `a.com,b.com` → a Set; `*` → null, meaning "no restriction", which is a thing you have
 *  to have said out loud. */
function parseList(v) {
  if (v == null || v === "" || v === true) return null;
  const s = String(v).trim();
  if (s === "*") return null;
  return new Set(
    s
      .split(",")
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean)
  );
}

export default defineDriver({
  name: "net",
  description: "the network — a request device, with a host allowlist and a pluggable transport",

  async mount(options) {
    // `allow` is required. a network reachable from anywhere is ambient network access
    // wearing a path, which is the thing this whole design exists to avoid — so the scope
    // has to be stated, and `allow=*` is how you state "anything". mounting without it is
    // an error rather than an open gate, because a default is a decision nobody made.
    if (options.allow === undefined) {
      throw new VfsError("EINVAL", "a net mount needs an allowlist", {
        operation: "mount",
        hint: "mount net:/dev/net,allow=api.anthropic.com — or allow=* to open it, deliberately",
      });
    }
    const allow = parseList(options.allow);
    const methods = parseList(options.methods) ?? new Set(DEFAULT_METHODS.map((m) => m.toLowerCase()));
    const maxBytes = Number(options["max-bytes"] ?? 8 * 1024 * 1024);
    const follow = options.redirects === "1" || options.redirects === true;
    const timeoutMs = Number(options["timeout-ms"] ?? 120000);
    const transportName = String(options.transport ?? "fetch");
    const relayUrl = options.relay ? String(options.relay) : null;

    // ── the gate ──
    const check = (req) => {
      let u;
      try {
        u = new URL(req.url);
      } catch {
        throw new VfsError("EINVAL", `not a URL: ${JSON.stringify(req.url)}`, {
          operation: "net",
          hint: "a request needs {method, url, headers, body} and the url must be absolute",
        });
      }
      if (u.protocol !== "http:" && u.protocol !== "https:") {
        throw new VfsError("EACCES", `refusing to speak ${u.protocol}`, {
          operation: "net",
          hint: "only http and https are carried",
        });
      }
      if (allow && !allow.has(u.hostname.toLowerCase())) {
        throw new VfsError("EACCES", `host is not on this mount's allowlist: ${u.hostname}`, {
          operation: "net",
          hint: `mounted allowlist: ${[...allow].join(", ")}. re-mount with allow=${[...allow, u.hostname].join(",")} if this is intended.`,
        });
      }
      const method = String(req.method ?? "GET").toUpperCase();
      if (methods && !methods.has(method.toLowerCase())) {
        throw new VfsError("EACCES", `method is not on this mount's allowlist: ${method}`, {
          operation: "net",
          hint: `mounted methods: ${[...methods].join(", ")}`,
        });
      }
      if (!follow) {
        // a redirect is the classic way around an allowlist: the permitted host answers
        // 302 to one that was never permitted, and something that follows it has handed
        // over exactly the access it was scoped out of
        req.headers = { ...(req.headers ?? {}) };
      }
      return { url: u, method };
    };

    // ── the transports ──
    // each yields strings (chunks) for the streaming path, and returns {status, headers,
    // body} for the one-shot path. they are equivalent; pick by what the machine has.

    const transports = {
      fetch: {
        description: "globalThis.fetch — the native one, taken back from the airgap",
        available: () => networkHandle() != null,
        async run(req, { signal }) {
          const f = networkHandle();
          if (!f) {
            throw new VfsError("ENETDOWN", "there is no fetch in this process", {
              operation: "net",
              hint: "mount the net driver with transport=exec to go through a CLI instead",
            });
          }
          const res = await f(req.url, {
            method: req.method,
            headers: req.headers,
            body: req.body,
            redirect: follow ? "follow" : "manual",
            signal,
          });
          return res;
        },
        async *chunks(res) {
          if (!res.body) return;
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let complete = false;
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) { complete = true; break; }
              yield decoder.decode(value, { stream: true });
            }
            const tail = decoder.decode();
            if (tail) yield tail;
          } finally {
            if (!complete) await reader.cancel().catch(() => {});
            reader.releaseLock?.();
          }
        },
      },

      exec: {
        description: "a CLI (curl by default) — for a machine where fetch is absent or walled",
        available: () => true,
        async run(req, { signal }) {
          const bin = String(options.curl ?? "curl");
          const argv = ["-sS", "-i", "-X", req.method];
          for (const [k, v] of Object.entries(req.headers ?? {})) argv.push("-H", `${k}: ${v}`);
          if (!follow) argv.push("--max-redirs", "0");
          if (req.body != null) argv.push("--data-binary", String(req.body));
          argv.push("--max-time", String(Math.ceil(timeoutMs / 1000)), req.url);

          const child = spawn(bin, argv, { stdio: ["ignore", "pipe", "pipe"], signal });
          const out = [];
          let err = "";
          child.stderr.on("data", (d) => (err += d));
          for await (const c of child.stdout) out.push(c);
          const code = await new Promise((r) => child.on("close", r));
          if (code !== 0 && out.length === 0 && !/HTTP\//.test(err)) {
            throw new VfsError("EIO", `${bin} exited ${code}: ${err.trim().slice(0, 300)}`, {
              operation: "net",
            });
          }
          // -i gives us the status line and headers inline; split them off
          const raw = Buffer.concat(out).toString("utf8");
          const split = raw.indexOf("\r\n\r\n") >= 0 ? "\r\n\r\n" : "\n\n";
          const at = raw.indexOf(split);
          const head = at < 0 ? "" : raw.slice(0, at);
          const body = at < 0 ? raw : raw.slice(at + split.length);
          const status = Number(/^HTTP\/[\d.]+ (\d+)/m.exec(head)?.[1] ?? 0);
          const headers = {};
          for (const line of head.split(/\r?\n/).slice(1)) {
            const c = line.indexOf(":");
            if (c > 0) headers[line.slice(0, c).trim().toLowerCase()] = line.slice(c + 1).trim();
          }
          return { __raw: true, status, headers, text: body };
        },
        async *chunks(res) {
          yield res.text ?? "";
        },
      },

      relay: {
        description: "POST the request to a relay, which makes it — for a required egress point",
        available: () => relayUrl != null,
        async run(req, { signal }) {
          const f = networkHandle();
          if (!f) {
            throw new VfsError("ENETDOWN", "the relay transport needs fetch to reach the relay");
          }
          if (!relayUrl) {
            throw new VfsError("EINVAL", "the relay transport needs a relay=<url> option");
          }
          const res = await f(relayUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body: req.body }),
            signal,
          });
          const text = await res.text();
          let parsed;
          try {
            parsed = JSON.parse(text);
          } catch {
            throw new VfsError("EIO", "the relay did not answer with JSON", {
              operation: "net",
              hint: text.slice(0, 200),
            });
          }
          return {
            __raw: true,
            status: parsed.status ?? 502,
            headers: parsed.headers ?? {},
            text: typeof parsed.body === "string" ? parsed.body : JSON.stringify(parsed.body ?? ""),
          };
        },
        async *chunks(res) {
          yield res.text ?? "";
        },
      },
    };

    const active = transports[transportName];
    if (!active) {
      throw new VfsError("ENODEV", `unknown transport: ${transportName}`, {
        operation: "net",
        hint: `available: ${Object.keys(transports).join(", ")}`,
      });
    }

    /** normalise whatever a transport produced into {status, headers, body} */
    const normalise = async (res) => {
      if (res.__raw) return { status: res.status, headers: res.headers, body: res.text };
      const text = await res.text();
      const headers = {};
      for (const [k, v] of res.headers ?? []) headers[k] = v;
      return { status: res.status, headers, body: text };
    };

    const run = async (req, { signal, generic = false } = {}) => {
      const { url, method } = check(req);
      const full = { ...req, url: url.toString(), method };
      const signal2 = combineSignals(signal, timeoutSignal(req.timeoutMs ?? timeoutMs));
      let res;
      try {
        res = await active.run(full, { signal: signal2.signal });
      } catch (e) {
        if (e instanceof VfsError) throw e;
        if (signal?.aborted) throw signalError(signal, "network request cancelled");
        if (generic && signal2.signal.aborted) {
          throw new VfsError("ETIMEDOUT", "the network request timed out", {
            operation: "net",
            hint: `${method} ${url.origin}${url.pathname} via transport=${transportName}`,
            cause: e,
          });
        }
        throw new VfsError("EIO", `the request failed: ${e.message}`, {
          operation: "net",
          hint: `${method} ${url.origin}${url.pathname} via transport=${transportName}`,
          cause: e,
        });
      } finally {
        signal2.done();
      }
      const out = await normalise(res);
      if (out.body != null && out.body.length > maxBytes) {
        throw new VfsError("EOVERFLOW", `the response is ${out.body.length} bytes, over the ${maxBytes} limit`, {
          operation: "net",
          hint: "raise it with max-bytes=<n>",
        });
      }
      return out;
    };

    /** the streaming path yields chunks; framing is the caller's business, because only
     *  the caller knows what it is reading (SSE, NDJSON, a plain body). */
    const runStream = async function* (req, { signal } = {}) {
      const { url, method } = check(req);
      const full = { ...req, url: url.toString(), method };
      const timeout = timeoutSignal(req.timeoutMs ?? timeoutMs);
      const combined = combineSignals(signal, timeout);
      let res;
      try {
        combined.signal.throwIfAborted();
        res = await active.run(full, { signal: combined.signal });
        const head = res.__raw
          ? { status: res.status, headers: res.headers }
          : { status: res.status, headers: Object.fromEntries(res.headers ?? []) };
        yield { head };
        let bytes = 0;
        for await (const chunk of active.chunks(res)) {
          combined.signal.throwIfAborted();
          bytes += Buffer.byteLength(chunk);
          if (bytes > maxBytes) throw new VfsError("EOVERFLOW", `the stream exceeds the ${maxBytes} byte limit`, { operation: "net" });
          yield { chunk };
        }
      } catch (cause) {
        if (cause instanceof VfsError) throw cause;
        if (signal?.aborted) throw signalError(signal, "network request cancelled");
        throw new VfsError("EIO", `the request failed: ${cause.message}`, {
          operation: "net", cause,
          hint: `${method} ${url.origin}${url.pathname} via transport=${transportName}`,
        });
      } finally {
        // Covers return() immediately after the head, before chunks() owns a reader.
        if (res?.body && !res.body.locked) await res.body.cancel().catch(() => {});
        timeout.controller.abort();
        combined.done();
      }
    };

    return {
      transports: () =>
        Object.entries(transports).map(([name, t]) => ({
          name,
          available: t.available(),
          active: name === transportName,
          description: t.description,
        })),

      run,
      runStream,

      async stat(rel) {
        if (rel === "") return dirStat();
        if (rel === "request") return deviceStat({ description: "write {method,url,headers,body} → {status,headers,body}" });
        if (rel === "transports") return dirStat();
        if (rel.startsWith("transports/")) {
          const name = rel.slice("transports/".length);
          if (!transports[name]) throw new VfsError("ENOENT", "no such transport", { path: "/transports/" + name });
          return fileStat({ size: null, device: false });
        }
        throw new VfsError("ENOENT", "no such node", { path: "/" + rel });
      },

      async list(rel) {
        if (rel === "") return [entry("request", deviceStat()), entry("transports", dirStat())];
        if (rel === "transports") {
          return Object.keys(transports).map((n) =>
            entry(n, fileStat({ size: null, ...{ available: transports[n].available() } }))
          );
        }
        throw new VfsError("ENOTDIR", "not a directory", { path: "/" + rel });
      },

      async read(rel) {
        if (rel === "request") {
          return JSON.stringify(
            {
              node: "/dev/net/request",
              kind: "device",
              usage: "write {method, url, headers, body} to it; the reply is the write's return value",
              allowlist: allow ? [...allow] : "* (open — this mount was given allow=*)",
              methods: [...methods],
              transport: transportName,
              follow_redirects: follow,
              max_bytes: maxBytes,
              timeout_ms: timeoutMs,
            },
            null,
            2
          );
        }
        if (rel.startsWith("transports/")) {
          const name = rel.slice("transports/".length);
          const t = transports[name];
          if (!t) throw new VfsError("ENOENT", "no such transport", { path: "/" + rel });
          return JSON.stringify({ name, available: t.available(), active: name === transportName, description: t.description }, null, 2);
        }
        throw new VfsError("EISDIR", "is a directory", { path: "/" + rel });
      },

      /** `write /dev/net/request {…}` → the response. this is the legacy one-shot path. */
      async write(rel, data, _ctx = {}, opts = {}) {
        if (rel !== "request") {
          throw new VfsError("EACCES", "permission denied", {
            path: "/" + rel,
            operation: "write",
            hint: "the request device is /dev/net/request",
          });
        }
        const req = typeof data === "string" ? JSON.parse(data) : data;
        return run(req, { signal: opts.signal, generic: !!opts.generic });
      },

      /** Generic callable-resource spelling of the same one-request HTTP operation. */
      async invoke(rel, input, ctx = {}, opts = {}) {
        if (rel !== "request") {
          throw new VfsError("EACCES", "permission denied", {
            path: "/" + rel,
            operation: "invoke",
            hint: "the request device is /dev/net/request",
          });
        }
        const req = parseRequest(input, "invoke");
        return run(req, { signal: ctx.signal ?? opts.signal, generic: true });
      },

      /** `open /dev/net/request r+` → a handle for a conversation, including a streaming
       *  one. a one-shot write cannot carry a stream, which is why this exists. */
      async open(rel, flags) {
        if (rel !== "request") throw new VfsError("ENOTSUP", "only the request device opens");
        if (!flags.includes("+") && !flags.includes("w")) {
          throw new VfsError("EACCES", "the request device opens for r+ or w only", { path: "/request" });
        }
        const lifetime = new AbortController();
        const options = (opts = {}) => ({ ...opts, signal: opts.signal
          ? AbortSignal.any([opts.signal, lifetime.signal]) : lifetime.signal });
        return {
          node: "/dev/net/request",
          request: (req, opts) => run(req, options(opts)),
          stream: (req, opts) => runStream(req, options(opts)),
          async close() { lifetime.abort(new Error("network handle closed")); },
        };
      },
    };
  },
});

function parseRequest(input, operation) {
  let request = input;
  if (typeof input === "string") {
    try {
      request = JSON.parse(input);
    } catch (cause) {
      throw new VfsError("EINVAL", "request input is not valid JSON", { operation, cause });
    }
  }
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new VfsError("EINVAL", "request input must be an object", { operation });
  }
  return request;
}

function signalError(signal, detail) {
  const reason = signal.reason;
  if (reason instanceof Error && !(reason.name === "AbortError" && typeof reason.code !== "string")) {
    if (!reason.code) reason.code = "ABORT_ERR";
    return reason;
  }
  const error = new Error(reason?.message ?? detail, { cause: reason });
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

/** an AbortSignal that fires after `ms`. `AbortSignal.timeout` is the ES2024 spelling and
 *  does exactly this; it is wrapped so a caller that passes its own signal can compose. */
function timeoutSignal(ms) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(new Error(`timed out after ${ms}ms`)), ms);
  t.unref?.();
  return { signal: c.signal, done: () => clearTimeout(t), controller: c };
}

/** two signals, one — whichever aborts first. `AbortSignal.any` exists but composes only
 *  signals, and the timeout above also wants a `done()`. */
function combineSignals(a, b) {
  if (!a) return b;
  const c = new AbortController();
  const onAbort = (e) => c.abort(e?.target?.reason ?? e);
  a.addEventListener?.("abort", onAbort, { once: true });
  b.signal.addEventListener?.("abort", onAbort, { once: true });
  if (a.aborted) c.abort(a.reason);
  if (b.signal.aborted) c.abort(b.signal.reason);
  return { signal: c.signal, done: () => { b.done(); a.removeEventListener?.("abort", onAbort); b.signal.removeEventListener?.("abort", onAbort); } };
}
