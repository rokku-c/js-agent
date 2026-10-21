// ai.js — the model, as a device file.
//
// ── the path, segment by segment ──
//
//     /dev/providers/ai/type/api/anthropic/messages/model/claude-opus-5
//                      │    │   │  │         │        │     │
//                      │    │   │  │         │        │     └─ the model id (percent-decoded)
//                      │    │   │  │         │        └─ the literal directory of model ids
//                      │    │   │  │         └─ the wire API: messages | chat
//                      │    │   │  └─ the vendor
//                      │    │   └─ which API family
//                      │    └─ the kind of device — a model today, an embedding later
//                      └─ the ai driver's mount root
//
// `type` earns its place by being the segment that would otherwise be missing: it is what
// lets a second kind of device live beside this one without the path becoming
// `/dev/providers/ai/api/…` for some vendors and something else for others.
//
// ── what the file does ──
//
//   read    a descriptor. free, offline, never the token. answers "is this usable?"
//   list    the model ids this mount knows about — also free, also offline
//   write   one request → one response. costs tokens and seconds.
//   open    a conversation handle: send, stream, the accumulated transcript
//
// the asymmetry between read and write is the whole design of the node. finding out what a
// model *is* must never require calling it, or the answer costs money and a round trip.
//
// ── three mounts, and none of them implies another ──
// this driver needs a **network** to reach the wire, and a **credential** to be let in, and
// both are separate mounts. so an agent can be given the model and not the network (it will
// say so, precisely), or the model and the network and not the token, and a subagent given
// only /dev/providers cannot use it at all — because the token is not in an environment it
// inherited, it is behind a mount it was not handed.

import { VfsError } from "../kernel/errors.js";
import { defineDriver, dirStat, fileStat, deviceStat, entry } from "../kernel/driver.js";
import * as sse from "./ai/sse.js";
import anthropic from "./ai/dialects/anthropic.js";

const DIALECTS = {
  anthropic: () => import("./ai/dialects/anthropic.js"),
  openai: () => import("./ai/dialects/openai.js"),
  fake: () => import("./ai/dialects/fake.js"),
};

const DEFAULT_MODELS = {
  anthropic: ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"],
  openai: ["gpt-4o", "gpt-4o-mini"],
  fake: ["fake-1"],
};

/** the model segment is percent-decoded and never validated against a list.
 *
 *  model ids are not path-safe — `meta-llama/Llama-3-70B` has a slash, `@cf/meta/llama` has
 *  an at-sign, a Bedrock id has a colon — so a namespace that only accepts ids it already
 *  knows about would refuse to address models the API would happily serve. `%2F` spells the
 *  slash, and an unknown id is passed through to the endpoint, which is the only thing that
 *  actually knows what it serves. */
function parseInput(input) {
  if (typeof input === "string") {
    try {
      return JSON.parse(input);
    } catch (cause) {
      throw new VfsError("EINVAL", "model invocation input is not valid JSON", {
        operation: "invoke",
        cause,
      });
    }
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new VfsError("EINVAL", "model invocation input must be an object", { operation: "invoke" });
  }
  return input;
}

function decodeModel(seg) {
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg; // a bare `%` is a legal character in an id and not an encoding
  }
}

export default defineDriver({
  name: "ai",
  description: "model providers as a file tree — options: vendor, token-file, net, models",

  async mount(options, ctx) {
    const vendors = String(options.vendor ?? "anthropic")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const netPath = String(options.net ?? "/dev/net/request");
    const baseUrl = options.url ? String(options.url) : null;

    // load each dialect once. a vendor with no module is refused at mount time rather than
    // at the first request, so a typo surfaces where it was typed.
    const dialectFor = new Map();
    for (const v of vendors) {
      const load = DIALECTS[v];
      if (!load) {
        throw new VfsError("ENODEV", `unknown vendor: ${v}`, {
          operation: "mount",
          hint: `known vendors: ${Object.keys(DIALECTS).join(", ")}`,
        });
      }
      const mod = await load();
      dialectFor.set(v, mod.default);
    }

    const modelsFor = (v) => {
      if (options.models) {
        return String(options.models)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      }
      return DEFAULT_MODELS[v] ?? [];
    };

    // ── the credential ──
    // resolved at *request* time, not at mount time. that is what makes the mount order
    // free — `mount ai` before `mount secret` works — and what makes a rotated secret take
    // effect without a re-mount.
    const readToken = async (resourceVfs = ctx.vfs) => {
      if (options.token) return String(options.token);
      if (options["token-env"]) {
        const name = String(options["token-env"]);
        const v = process.env[name];
        if (!v) {
          throw new VfsError("EACCES", `${name} is not set in the process environment`, {
            operation: "auth",
            hint: `mount secret /dev/secrets env=${name} and pass token-file=/dev/secrets/${name} instead`,
          });
        }
        return v;
      }
      if (options["token-file"]) {
        const path = String(options["token-file"]);
        try {
          return String(await resourceVfs.read(path)).trim();
        } catch (e) {
          throw new VfsError("EACCES", `cannot read the credential at ${path}`, {
            operation: "auth",
            hint:
              e.code === "ENOENT"
                ? "nothing is mounted there — mount a secret driver, e.g. mount secret:/dev/secrets,env=ANTHROPIC_AUTH_TOKEN"
                : e.message,
          });
        }
      }
      return null;
    };

    const hasToken = async (resourceVfs = ctx.vfs) => (await readToken(resourceVfs).catch(() => null)) != null;

    // ── the transport ──
    // this driver reaches the network the same way anything else does: by writing to a
    // mounted device. there is no shortcut here, and that is the point.
    //
    // the presence check is separate from the use, and deliberately so. without it the
    // failure is genuinely misleading: `/dev/net` unmounted means the request path resolves
    // into whatever *is* mounted at `/dev`, the dev driver answers ENOENT for a node it has
    // never heard of, and that ENOENT travels back out through this driver's own write —
    // where it gets re-labelled with the model file's path. the caller then reads "file not
    // found: /dev/providers/…/claude-opus-5", which is true of nothing and actionable for
    // no one. asking first turns it into the sentence it should have been.
    const requireNet = async (resourceVfs = ctx.vfs, flags) => {
      const missing = new VfsError("ENETDOWN", `the ai driver has no transport at ${netPath}`, {
        operation: "net",
        hint: `mount one: mount net:${netPath.split("/").slice(0, -1).join("/")},allow=<host>`,
      });
      try {
        await resourceVfs.stat(netPath);
      } catch {
        throw missing;
      }
      if (!flags) return null;
      try {
        return await resourceVfs.open(netPath, flags);
      } catch (e) {
        if (e.code === "ENOENT" || e.code === "ENOTDIR" || e.code === "ENOTSUP") throw missing;
        throw e;
      }
    };

    /** the status→throw split, decided in one place.
     *
     *  every non-200 throws. the reason is not tidiness: a 429 or a 500 *returned as a
     *  value* would arrive at the loop as a successful round whose response happens to be
     *  an error body, the model would never learn to retry, and the failure would surface
     *  later as a mysterious empty reply. nu-agent has a scar from exactly this shape — a
     *  killed search reported as a clean empty result — and this is that lesson applied.
     *
     *  a `max_tokens` or `refusal` stop_reason is different: that is a *successful* call
     *  whose whole canonical body matters, so it is returned, not thrown. */
    const classify = (status, body, url) => {
      if (status >= 200 && status < 300) return null;
      let detail = typeof body === "string" ? body : JSON.stringify(body);
      try {
        const parsed = typeof body === "string" ? JSON.parse(body) : body;
        detail = parsed?.error?.message ?? parsed?.message ?? detail;
      } catch {
        // the body was not JSON; the raw text is the detail
      }
      const code =
        status === 401 || status === 403
          ? "EACCES"
          : status === 404
            ? "ENOENT"
            : status === 408 || status === 504
              ? "ETIMEDOUT"
              : status === 429
                ? "EBUSY"
                : status === 400 || status === 422
                  ? "EINVAL"
                  : "EIO";
      const hint =
        status === 401 || status === 403
          ? "the credential was refused — check what is mounted at the token file"
          : status === 429
            ? "rate limited or overloaded; the same request will probably work shortly"
            : status === 400
              ? "the request was rejected as malformed — this is a bug in the caller, not in the model"
              : undefined;
      return new VfsError(code, `the endpoint answered ${status}: ${String(detail).slice(0, 800)}`, {
        operation: "request",
        path: url,
        hint,
      });
    };

    // ── one exchange ──
    //
    // a local dialect's responder is created **once per mount**, not once per call. that is
    // not tidiness: its whole job is to advance through a script, and a fresh one per call
    // resets the script to its first turn every time — which looks exactly like a model that
    // will not stop asking for the same tool, and loops until the round cap.
    const responders = new Map();
    const responderFor = (dialect) => {
      if (!responders.has(dialect.vendor)) responders.set(dialect.vendor, dialect.makeResponder(options));
      return responders.get(dialect.vendor);
    };

    const exchange = async (dialect, vendor, model, canonical, { signal, onEvent, stream, resourceVfs = ctx.vfs }) => {
      signal?.throwIfAborted();
      const token = dialect.local ? null : await readToken(resourceVfs);
      if (!dialect.local && !token) {
        throw new VfsError("EACCES", "no credential is configured for this provider", {
          operation: "auth",
          hint:
            "mount one and point at it: " +
            "mount secret:/dev/secrets,env=ANTHROPIC_AUTH_TOKEN then " +
            "mount ai:/dev/providers/ai,vendor=anthropic,token-file=/dev/secrets/ANTHROPIC_AUTH_TOKEN",
        });
      }

      const base = baseUrl ?? dialect.defaultUrl;
      const url = dialect.endpoint(base);

      // ── local dialect: no wire at all ──
      if (dialect.local) {
        const responder = responderFor(dialect);
        if (!stream) return responder.respond(canonical, { model });
        const frames = responder.stream(canonical, { model });
        // wrapped into the same `{chunk}` shape the net device yields, so the stream
        // machine cannot tell a local dialect from a socket — which is the point of it
        const acc = await sse.consume(
          (async function* () {
            for await (const frame of frames) yield { chunk: frame };
          })(),
          anthropic,
          { onEvent, signal, requireComplete: true }
        );
        return sse.assemble(acc);
      }

      const body = dialect.body(canonical, { model, stream });
      const headers = dialect.headers(token);
      await requireNet(resourceVfs, null);

      if (!stream) {
        const reply = await resourceVfs.write(netPath, { method: "POST", url, headers, body: JSON.stringify(body) }, { signal, generic: true });
        const res = reply.value;
        const err = classify(res.status, res.body, url);
        if (err) throw err;
        let parsed;
        try {
          parsed = JSON.parse(res.body);
        } catch {
          throw new VfsError("EIO", "the endpoint did not answer with JSON", {
            operation: "request",
            path: url,
            hint: String(res.body).slice(0, 300),
          });
        }
        return dialect.response(parsed);
      }

      // ── streaming ──
      const handle = await requireNet(resourceVfs, "r+");
      try {
        const chunks = handle.stream({ method: "POST", url, headers, body: JSON.stringify(body) }, { signal });
        // the first item is the head, because the caller has to know a non-200 arrived
        // before deciding what the body means
        const framed = (async function* () {
          for await (const item of chunks) {
            if (item.head) {
              const error = classify(item.head.status, "stream request rejected", url);
              if (error) throw error;
              continue;
            }
            yield item;
          }
        })();

        const acc = await sse.consume(framed, dialect, { onEvent, signal, requireComplete: true });

        if ((acc.blocks ?? []).length === 0 && acc.stop_reason == null) {
          const hint = (acc.other ?? []).join(" ").trim();
          throw new VfsError("EIO", "the stream ended without a single event", {
            operation: "request",
            path: url,
            hint: hint
              ? `the endpoint said: ${hint.slice(0, 500)}`
              : "no SSE arrived — a plain body where a stream was expected",
          });
        }
        return sse.assemble(acc);
      } finally {
        await handle.close?.();
      }
    };

    // ── the tree ──
    const parse = (rel) => {
      const segs = rel === "" ? [] : rel.split("/");
      // the mount root itself, and then every node is statically placed except the model
      // id, which is whatever is left
      if (segs.length === 0) return { kind: "dir", list: ["type"] };
      if (segs[0] !== "type") return null;
      if (segs.length === 1) return { kind: "dir", list: ["api"] };
      if (segs[1] !== "api") return null;
      if (segs[2] === undefined) return { kind: "dir", list: [...dialectFor.keys()] };

      const vendor = segs[2];
      const dialect = dialectFor.get(vendor);
      if (!dialect) return null;
      if (segs[3] === undefined) return { kind: "dir", list: [dialect.api] };
      if (segs[3] !== dialect.api) return null;
      if (segs[4] === undefined) return { kind: "dir", list: ["model"] };
      if (segs[4] !== "model") return null;
      if (segs[5] === undefined) return { kind: "dir", list: modelsFor(vendor), models: true };

      return { kind: "model", vendor, dialect, model: decodeModel(segs.slice(5).join("/")) };
    };

    const describe = async (node, resourceVfs = ctx.vfs) => {
      const dialect = node.dialect;
      const token = dialect.local ? null : await readToken(resourceVfs).catch(() => null);
      // everything here is a presence check, never a probe. "network available" means the
      // net device is mounted, not that a connection succeeded — a `read` that could block
      // or fail would defeat the whole read-is-cheap/write-expensive split
      const netMounted = await resourceVfs.exists(netPath).catch(() => false);
      const configured = modelsFor(node.vendor);
      return {
        vendor: node.vendor,
        api: dialect.api,
        // the decoded id, so `cat` shows what will actually be sent
        model: node.model,
        endpoint: dialect.local ? "(local — no transport)" : dialect.endpoint(baseUrl ?? dialect.defaultUrl),
        auth_present: token != null,
        auth: token == null ? "not set" : `set (${token.length} chars)`,
        net_mounted: dialect.local ? false : netMounted,
        net: dialect.local ? null : netPath,
        streaming: true,
        known_here: configured,
        known_here_includes_this: configured.includes(node.model),
        // `callable` and `append` so a generic tool can be correct without guessing what
        // kind of node this is
        kind: "device",
        callable: true,
        append: false,
        usage: "write a canonical request {messages, system, tools, max_tokens} → the canonical response; or open it for a conversation and streaming",
      };
    };

    const openHandle = (node, openCtx = {}) => {
      const messages = [];
      let inFlight = false;
      const lifetime = new AbortController();

      const guard = () => {
        if (lifetime.signal.aborted) throw new VfsError("EBADF", "model handle closed");
        if (inFlight) {
          throw new VfsError("EBUSY", "this conversation handle already has a request in flight", {
            path: node.model,
            operation: "send",
            hint: "a handle is single-flight — a second concurrent send would put two user turns in a row, which the API rejects",
          });
        }
        inFlight = true;
        return () => {
          inFlight = false;
        };
      };

      // ── who owns the transcript ──
      // **pass `messages` and you own it; omit them and the handle keeps it for you.**
      //
      // the rule exists because the alternative is silent and only shows up on the *second*
      // round: a handle that always prepends its own accumulated transcript, handed a request
      // that already carries the whole conversation, sends every message twice. against a
      // real endpoint that is a 502 about a `tool_use` with no `tool_result` after it — and
      // against a scripted dialect it is nothing at all, which is exactly why it survived the
      // whole hermetic suite and died on the first live run.
      const build = (canonical) => ({
        max_tokens: canonical.max_tokens ?? 4096,
        system: canonical.system,
        tools: canonical.tools,
        temperature: canonical.temperature,
        messages: canonical.messages?.length ? canonical.messages : messages,
      });

      return {
        vendor: node.vendor,
        api: node.dialect.api,
        model: node.model,
        get messages() {
          return [...messages];
        },
        async send(canonical, opts = {}) {
          const done = guard();
          try {
            const req = build(canonical);
            const res = await exchange(node.dialect, node.vendor, node.model, req, { ...opts, stream: false, resourceVfs: openCtx.vfs ?? ctx.vfs });
            // the whole turn goes in at once — every tool_result for one assistant round
            // belongs in a single user message, and a handle that let them arrive one at a
            // time would build a transcript the API rejects
            messages.push(...(canonical.messages ?? []));
            messages.push({ role: "assistant", content: res.content ?? [] });
            return res;
          } finally {
            done();
          }
        },
        async stream(canonical, opts = {}) {
          const done = guard();
          try {
            const req = build(canonical);
            const signal = opts.signal ? AbortSignal.any([opts.signal, lifetime.signal]) : lifetime.signal;
            const res = await exchange(node.dialect, node.vendor, node.model, req, { ...opts, signal, stream: true, resourceVfs: openCtx.vfs ?? ctx.vfs });
            messages.push(...(canonical.messages ?? []));
            messages.push({ role: "assistant", content: res.content ?? [] });
            return res;
          } finally {
            done();
          }
        },
        /** what this handle was actually asked, for a caller that has to know — and for
         *  a test that has to prove the transcript was not sent twice */
        asked: () => responderFor(node.dialect).seen(),
        async close() {
          lifetime.abort(new Error("model handle closed"));
          messages.length = 0;
        },
        /** so a caller can say `await using handle = await vfs.open(…)` and have the
         *  conversation closed on the way out, including along an exception path */
        async [Symbol.asyncDispose]() {
          await this.close();
        },
      };
    };

    return {
      /** for `ls /dev/providers/ai` and for anything that wants to know what this mount serves */
      vendors: () => [...dialectFor.keys()],

      async stat(rel) {
        if (rel === "") return dirStat();
        const node = parse(rel);
        if (!node) throw new VfsError("ENOENT", "no such node", { path: "/" + rel });
        if (node.kind === "dir") return dirStat();
        return deviceStat({ size: null, description: `${node.vendor}/${node.dialect.api} · ${node.model}` });
      },

      async list(rel) {
        const node = parse(rel);
        if (!node) throw new VfsError("ENOENT", "no such node", { path: "/" + rel });
        if (node.kind !== "dir") throw new VfsError("ENOTDIR", "not a directory", { path: "/" + rel });

        if (node.models) {
          // a model id is a path segment, so it is encoded here for the same reason it is
          // decoded on the way in
          return node.list.map((m) =>
            entry(encodeURIComponent(m), deviceStat({ size: null, description: "a model endpoint" }))
          );
        }
        return node.list.map((n) => entry(n, dirStat()));
      },

      async read(rel, resourceCtx = {}) {
        const node = parse(rel);
        if (!node) throw new VfsError("ENOENT", "no such node", { path: "/" + rel });
        if (node.kind === "dir") throw new VfsError("EISDIR", "is a directory", { path: "/" + rel });
        return JSON.stringify(await describe(node, resourceCtx.vfs ?? ctx.vfs), null, 2) + "\n";
      },

      /** one-shot: the request goes in, the response comes back as the write's value.
       *  a stream cannot be carried by a write, so asking for one here is refused rather
       *  than answered with something the caller cannot read. */
      async write(rel, data, ctx = {}, opts = {}) {
        const node = parse(rel);
        if (!node) throw new VfsError("ENOENT", "no such node", { path: "/" + rel });
        if (node.kind !== "model") throw new VfsError("EISDIR", "is a directory", { path: "/" + rel });

        const canonical = typeof data === "string" ? JSON.parse(data) : data;
        if (canonical?.stream) {
          throw new VfsError("EINVAL", "a one-shot write cannot carry a stream", {
            path: "/" + rel,
            operation: "write",
            hint: "open the node instead: `open(path, 'r+')` then `.stream(request)`. streaming is the handle's job because a write has one return value and a stream has many.",
          });
        }
        return exchange(node.dialect, node.vendor, node.model, canonical, {
          stream: false,
          signal: ctx.signal ?? opts.signal,
          resourceVfs: ctx.vfs,
        });
      },

      /** Generic callable-resource spelling for one model request. */
      async invoke(rel, input, ctx = {}, opts = {}) {
        const node = parse(rel);
        if (!node) throw new VfsError("ENOENT", "no such node", { path: "/" + rel });
        if (node.kind !== "model") throw new VfsError("EISDIR", "a directory is not callable", { path: "/" + rel });
        const canonical = parseInput(input);
        if (canonical?.stream) {
          throw new VfsError("EINVAL", "invoke is one-shot and cannot carry a stream", {
            path: "/" + rel,
            operation: "invoke",
            hint: "use open(path, 'r+') for streaming",
          });
        }
        return exchange(node.dialect, node.vendor, node.model, canonical, {
          stream: false,
          signal: ctx.signal ?? opts.signal,
          resourceVfs: ctx.vfs,
        });
      },

      async open(rel, flags, openCtx = {}) {
        const node = parse(rel);
        if (!node) throw new VfsError("ENOENT", "no such node", { path: "/" + rel });
        if (node.kind !== "model") throw new VfsError("EISDIR", "is a directory", { path: "/" + rel });
        return openHandle(node, openCtx);
      },
    };
  },
});
