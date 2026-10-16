// agent.js — the loop: request, stream, run tools, feed results back, until it stops.
//
// ── this is the port ──
// everything else in this repository is either a piece this drives or the boundary it runs
// behind. the loop itself is nu-agent's, and the parts worth stating are the ones that were
// learned rather than designed:
//
//   · **`canonical` is append-only and folding never touches it.** `messages` is the working
//     copy and fold placeholders accumulate in it. only `canonical` is persisted, so a
//     resumed run gets its real history and does not fold placeholders a second time.
//
//   · **context is context's job.** rounds are unlimited by default: truncating on a round
//     cap confuses "the task needs more rounds" with "the context blew up". the real
//     `usage.input_tokens` from each round drives a proactive fold, and an overflow error
//     carries the real window, so the fold after it is computed from the number the API
//     actually said rather than from the budget that was already known to be too small.
//
//   · **an assistant turn is carried back verbatim**, thinking blocks and all. dropping the
//     signature gets the whole request rejected.
//
//   · **the run is written at the end of every round**, not when it finishes. a run that
//     dies at round 30 — a crash, a Ctrl-C, an expired token — should leave something
//     resumable rather than nothing.
//
// ── and the one place this differs ──
// the model is a device, not a client. the loop does not know a base URL, a header, or a
// transport; it opens a path and talks to it. that is what makes "no ambient network" true
// of the loop itself rather than only of the tools around it.

import { VfsError, reason } from "../kernel/errors.js";
import * as contextFolding from "./context.js";
import * as sessions from "./session.js";
import * as events from "./events.js";
import { invokeTool } from "./execute.js";
import { toolDefinition } from "./tools.js";
import { Policy } from "./policy.js";
import { createRunContext } from "./run-context.js";
import { streamStep, streamFlush } from "./markdown.js";
import { style } from "../shell/style.js";

export const DEFAULT_CONTEXT_BUDGET = 890_000;
export const DEFAULT_MAX_OUTPUT = 8000;
/** thinking blocks spend from this budget too, which is why a small one is a trap: a hard
 *  question can consume the whole allowance before any text is emitted, and the turn ends
 *  with `max_tokens` and an empty reply — which reads like a refusal rather than like a
 *  budget that was too small. */
export const DEFAULT_MAX_TOKENS = 32_000;
export const MAX_OUTPUT_TOKENS = 128_000;

const blocksOf = (body, kind) => (body?.content ?? []).filter((b) => b?.type === kind);

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}
const textOf = (body) =>
  blocksOf(body, "text")
    .map((b) => b.text ?? "")
    .join("\n");

/** strip a Claude-Code-style context marker (`deepseek-flash[1M]`).
 *
 *  such a suffix is a CLI-internal alias, and it leaks into whichever model environment
 *  variable happens to be set. sent to an API as-is it 404s — and 404s as "the model does
 *  not exist", which reads like a permissions problem rather than like a stray bracket.
 *
 *  it stays provider-agnostic on purpose: the alias is a convention of the *CLI*, so it is
 *  not a dialect's business to know about it. */
export function stripAlias(name) {
  return String(name ?? "")
    .replace(/\s*\[[^\]]*\]\s*$/, "")
    .trim();
}

/** find the model this run should use, as a path. */
export async function resolveProvider(vfs, { vendor = null, model = null } = {}) {
  const mounts = vfs.mounts().filter((m) => m.driver === "ai");
  if (!mounts.length) {
    throw new VfsError("ENOENT", "no model is mounted", {
      hint:
        "the model is a mount, like everything else here. one command: " +
        "mount ai:/dev/providers/ai,vendor=anthropic,token-file=/dev/secrets/ANTHROPIC_AUTH_TOKEN" +
        " — and it needs a net and a credential mounted too before it can answer.",
    });
  }

  // the mounts in the order they were mounted, so an explicit second one can win
  const candidates = [];
  for (const m of mounts) {
    const res = vfs.resolve(m.at);
    const vendors = res.mount.instance.vendors?.() ?? [];
    for (const v of vendors) candidates.push({ at: m.at, vendor: v });
  }
  if (!candidates.length) {
    throw new VfsError("ENOENT", "the ai mount serves no vendors", { hint: "mount it with vendor=<name>" });
  }

  const pick = vendor ? candidates.find((c) => c.vendor === vendor) : candidates[0];
  if (!pick) {
    throw new VfsError("ENOENT", `no mounted provider named ${vendor}`, {
      hint: `mounted: ${[...new Set(candidates.map((c) => c.vendor))].join(", ")}`,
    });
  }

  const listPath = `${pick.at}/type/api/${pick.vendor}`;
  const apis = await vfs.list(listPath).catch(() => []);
  const api = apis[0]?.name;
  if (!api) throw new VfsError("ENOENT", `${listPath} has no api beneath it`);

  // the model id is a path segment and a path segment is not a model id — see ai.js
  const chosen = stripAlias(model ?? (await defaultModelFor(vfs, `${listPath}/${api}/model`)));
  return {
    path: `${listPath}/${api}/model/${encodeURIComponent(chosen)}`,
    vendor: pick.vendor,
    api,
    model: chosen,
  };
}

async function defaultModelFor(vfs, dir) {
  const entries = await vfs.list(dir).catch(() => []);
  if (!entries.length) {
    throw new VfsError("ENOENT", `no models are configured beneath ${dir}`, {
      hint: "pass models=<id,…> when mounting the ai driver, or name one with --model",
    });
  }
  return decodeURIComponent(entries[0].name);
}

/** is this error a context overflow? substring matching only, and on purpose: the gateway
 *  nu-agent was measured against wraps the real message inside another layer of JSON, so
 *  parsing the structure is not worth the fragility. */
export function isOverflow(err) {
  const patterns = [
    "maximum context length",
    "context_length_exceeded",
    "context length",
    "context limit",
    "prompt is too long",
    "too many tokens",
    "reduce the length",
    "tokens in the messages",
  ];
  const low = String(err).toLowerCase();
  return patterns.some((p) => low.includes(p));
}

/** pull the real window out of an overflow error. deriving it from --context-budget is
 *  wrong: that value may be set *above* the window, so the fold is still too small and the
 *  retry fails the same way. */
export function parseWindow(err) {
  const m = /maximum context length is (\d+) tokens/.exec(String(err));
  return m ? Number(m[1]) : null;
}

/** the tools this run may use — the objects, and the definitions the model is shown.
 *
 *  both come out of `/bin`, which is the point: the agent is offered exactly what its
 *  namespace contains. a run mounted with `tools=read,edit` cannot be handed `write` by a
 *  prompt, a session, or a stale tool list, because there is no `write` to hand. */
export async function loadToolsFromBin(vfs, names) {
  const res = vfs.resolve("/bin");
  const all = res.mount.instance.tools?.() ?? [];
  const byName = new Map(all.map((t) => [t.name, t]));

  const objects = [];
  const definitions = [];
  for (const name of names) {
    const tool = byName.get(name);
    if (!tool) {
      const mounted = all.map((t) => t.name).join(", ") || "(none)";
      throw new VfsError("ENOENT", `no tool named ${name} in this namespace`, {
        hint: `/bin contains: ${mounted}. the tool set is a mount — remount with tools=${[...names, name].join(",")}`,
      });
    }
    objects.push(tool);
    definitions.push(toolDefinition(tool));
  }
  return { objects, definitions };
}

/**
 * The loop.
 *
 * @param {import('../kernel/vfs.js').Vfs} vfs
 * @param {object} opts
 */
export async function run(vfs, opts) {
  // Legacy options still describe a root run. A delegated run supplies its already
  // narrowed context explicitly; it never consults mutable state on the namespace.
  const supplied = opts.context ?? opts;
  const authority = { ...supplied, tools: [...(supplied.tools ?? ["read", "write", "edit"])] };
  const policy = authority.policy ?? await Policy.load(vfs, {
    file: opts.policyFile ?? null,
    compiled: opts.compiledPolicy == null ? null : structuredClone(opts.compiledPolicy),
  });
  const initialContext = createRunContext({
    ...authority,
    tools: authority.tools ?? ["read", "write", "edit"],
    policy,
  });
  return loop(vfs, opts, initialContext);
}

async function loop(vfs, opts, initialContext) {
  const {
    prompt,
    system = null,
    vendor = null,
    model: modelName = null,
    maxTokens = null,
    temperature = null,
    maxRounds = null,
    maxOutput = DEFAULT_MAX_OUTPUT,
    toolTimeoutMs = 120_000,
    timeoutMs = 120_000,
    contextBudget = DEFAULT_CONTEXT_BUDGET,
    keepRecent = 4,
    noFold = false,
    stream = false,
    markdown = false,
    showThinking = false,
    sessionId = null,
    resume = false,
    tail = null,
    noSave = false,
    onText = null,
    onThinking = null,
    onTool = null,
    onNote = null,
  } = opts;

  const { tools: toolNames, policy, depth, parent, inProcess, signal, cwd } = initialContext;
  const note = onNote ?? (() => {});
  const provider = await resolveProvider(vfs, { vendor, model: modelName });
  const { objects: toolObjects, definitions: tools } = await loadToolsFromBin(vfs, toolNames);
  const byName = new Map(toolObjects.map((t) => [t.name, t]));
  /** the line-buffered markdown state, which has to survive between stream chunks because
   *  markdown is block-level and a chunk boundary lands mid-fence often */
  let mdState = { buf: "", inFence: false };

  // ── sessions ──
  let prior = null;
  if (resume) {
    prior = sessionId ? await sessions.load(vfs, sessionId) : await sessions.last(vfs);
    if (!prior && !sessionId) {
      throw new VfsError("ENOENT", "--resume given but there is no session to resume");
    }
  }
  if (sessionId && !resume && (await sessions.exists(vfs, sessionId))) {
    throw new VfsError("EEXIST", `session ${sessionId} already exists`, {
      hint: "pass --resume to continue it, or pick another id — appending to it silently is the failure this guards against",
    });
  }

  const w = sessions.window(prior, tail);
  const prefix = w.prefix;
  const loaded = w.loaded;
  const saveIt = !noSave && (sessionId != null || prior != null);
  const id = sessionId ?? prior?.id ?? null;
  const context = createRunContext({ ...initialContext, session: id });
  const effectiveModel = modelName ?? prior?.model ?? provider.model;
  const effectiveSystem = system ?? prior?.system ?? null;

  // the run stream. it is created before anything else so an early crash still leaves a run
  const startedAt = Date.now();
  const streamLog = await events.open(vfs, { label: prompt.slice(0, 60) });
  await streamLog.emit("run.start", {
    task: prompt.slice(0, 500),
    model: effectiveModel,
    provider: provider.vendor,
    tools: toolNames,
    session: id,
    budget: contextBudget,
  });

  const budget = maxTokens ?? (stream ? MAX_OUTPUT_TOKENS : DEFAULT_MAX_TOKENS);

  // ── the two lists ──
  // `messages` is the working copy and folding rewrites it. `canonical` is append-only and
  // is the only thing ever persisted.
  let messages = [...loaded];
  let canonical = [...loaded];
  const opening = { role: "user", content: prompt };
  messages.push(opening);
  canonical.push(opening);

  let rounds = 0;
  let toolCalls = 0;
  let lastInput = 0;
  let lastOutput = 0;
  let totalInput = prior?.counters?.total_input ?? 0;
  let totalOutput = prior?.counters?.total_output ?? 0;
  let estNext = 0;
  let stopReason = "unknown";
  let text = "";
  let done = false;
  let retries = 0;
  const folds = [];
  const entries = [];
  const roundCap = maxRounds ?? 10_000;

  await using handle = await vfs.open(provider.path, "r+");

  while (!done && rounds < roundCap) {
    throwIfAborted(signal);
    // proactive fold: slim down before the request rather than after it fails
    if (!noFold && estNext >= contextBudget) {
      const f = await contextFolding.apply(vfs, messages, {
        budget: contextBudget,
        keepRecent,
        note: `proactive fold before round ${rounds + 1}`,
      });
      if (f.changed) {
        messages = f.messages;
        entries.push(f.entry);
        folds.push({ when: "proactive", round: rounds + 1, count: f.folded.length, before: f.before_tokens, after: f.after_tokens, entry: f.entry });
        await streamLog.emit("fold", folds.at(-1));
        note(`· folded ${f.folded.length} messages → entry ${f.entry} (estimated ${estNext} / budget ${contextBudget} tokens)`);
      }
    }

    await streamLog.emit("round.start", { n: rounds + 1, messages: messages.length, est_tokens: estNext });

    const request = {
      max_tokens: budget,
      system: effectiveSystem,
      tools: tools.length ? tools : undefined,
      temperature,
      messages,
    };

    const roundStart = Date.now();
    let body;
    try {
      body = stream
        ? await handle.stream(request, {
            signal,
            onEvent: (ev) => {
              if (ev.type === "text_delta") {
                text += ev.text ?? "";
                if (markdown) {
                  const step = streamStep(mdState, ev.text ?? "", style.enabled);
                  mdState = step.state;
                  if (step.out) onText?.(step.out);
                } else {
                  onText?.(ev.text ?? "");
                }
              } else if (ev.type === "thinking_delta") {
                onThinking?.(ev.text ?? "");
              }
            },
          })
        : await handle.send(request, { signal });
    } catch (e) {
      // Cancellation belongs to the run owner. It must not become an ordinary model error,
      // trigger overflow recovery, or permit another round.
      if (signal?.aborted) throwIfAborted(signal);
      const msg = reason(e);
      // overflow: fold part of it and retry. capped at 3 globally so a pointless fold
      // cannot spin forever.
      if (!noFold && retries < 3 && isOverflow(msg)) {
        retries++;
        const window = parseWindow(msg);
        const tighter = window == null ? Math.floor((contextBudget * 3) / 4) : Math.floor((window * 6) / 10);
        // keep-recent 0 in an emergency: "the last 2 messages" would protect exactly the
        // bulkiest tool result, which is the thing that has to go
        const f = await contextFolding.apply(vfs, messages, {
          budget: tighter,
          keepRecent: 0,
          note: "fold after overflow",
        });
        if (!f.changed) {
          const why =
            `context overflow (window ${window} tokens), but there is nothing left to fold. ` +
            "the remaining bulk sits in protected places — the original task, or a single " +
            "oversized tool result. lower max-output to cap one tool result, or split the task.";
          await streamLog.emit("run.error", { where: "overflow", reason: why });
          throw new VfsError("EOVERFLOW", why);
        }
        messages = f.messages;
        entries.push(f.entry);
        const rec = { when: "overflow", round: rounds + 1, count: f.folded.length, before: f.before_tokens, after: f.after_tokens, entry: f.entry, window };
        folds.push(rec);
        await streamLog.emit("fold", rec);
        note(`· context overflow, folded ${rec.count} messages → entry ${f.entry}, retrying`);
        estNext = f.after_tokens;
        continue;
      }
      await streamLog.emit("run.error", { where: `round ${rounds + 1}`, reason: msg });
      throw new VfsError("EIO", `round ${rounds + 1} failed: ${msg}`);
    }

    lastInput = body?.usage?.input_tokens ?? 0;
    lastOutput = body?.usage?.output_tokens ?? 0;
    estNext = lastInput;
    stopReason = body?.stop_reason ?? "unknown";
    totalInput += lastInput;
    totalOutput += lastOutput;

    const content = body?.content ?? [];
    const calls = content.filter((b) => b?.type === "tool_use");
    const reply = textOf(body);
    if (markdown && stream) {
      const f = streamFlush(mdState, style.enabled);
      mdState = f.state;
      if (f.out) onText?.(f.out);
    }

    // verbatim, thinking blocks included — dropping the signature is a rejected request
    messages.push({ role: "assistant", content });
    canonical.push({ role: "assistant", content });
    rounds++;
    if (!text && reply) text = reply;

    await streamLog.emit("round.end", {
      n: rounds,
      ms: Date.now() - roundStart,
      input_tokens: lastInput,
      output_tokens: lastOutput,
      stop_reason: stopReason,
      text_bytes: reply.length,
    });

    if (!calls.length) {
      done = true;
    } else {
      const results = [];
      for (const call of calls) {
        throwIfAborted(signal);
        const tool = byName.get(call.name);
        await streamLog.emit("tool.call", { round: rounds, id: call.id, name: call.name, input: call.input });
        onTool?.({ phase: "call", name: call.name, input: call.input });

        if (!tool) {
          const miss = {
            type: "tool_result",
            tool_use_id: call.id,
            content:
              `no tool named ${call.name} exists in this namespace. ` +
              `available: ${toolNames.join(", ")}`,
            is_error: true,
          };
          results.push(miss);
          await streamLog.emit("tool.result", { round: rounds, id: call.id, name: call.name, ok: false, ms: 0, error: "no such tool" });
          continue;
        }

        throwIfAborted(signal);
        const r = await invokeTool({
          vfs,
          tool,
          input: call.input ?? {},
          cwd,
          context,
          signal,
          timeoutMs: toolTimeoutMs,
          policy,
          maxOutput,
          id: call.id,
          inProcess,
          onOutput: (m) => onText?.(m.text),
          log: note,
        });
        results.push(r.block);
        onTool?.({ phase: "result", name: call.name, result: r.block.content, is_error: !r.ok, ms: r.ms });
        await streamLog.emit("tool.result", {
          round: rounds,
          id: call.id,
          name: call.name,
          ok: r.ok,
          ms: r.ms,
          bytes: r.bytes,
          error: r.ok ? null : r.block.content.slice(0, 300),
        });
      }
      messages.push({ role: "user", content: results });
      canonical.push({ role: "user", content: results });
      toolCalls += calls.length;
      // tool results are usually the bulk, so they must count toward the next estimate
      estNext = lastInput + Math.ceil(JSON.stringify(results).length / 3);
    }

    if (saveIt) {
      await sessions.store(
        vfs,
        sessions.recordOf({
          id,
          status: "running",
          prompt,
          messages: [...prefix, ...canonical],
          provider: provider.vendor,
          model: effectiveModel,
          system: effectiveSystem,
          toolsFrom: toolNames,
          budget: { context_budget: contextBudget, keep_recent: keepRecent, max_tokens: budget, max_output: maxOutput },
          counters: {
            rounds,
            tool_calls: toolCalls,
            last_input_tokens: lastInput,
            last_output_tokens: lastOutput,
            total_input: totalInput,
            total_output: totalOutput,
            stop_reason: stopReason,
          },
          folds,
          contextEntries: entries,
          parent,
          depth,
          created: prior?.created,
        })
      );
    }

    if (stream && rounds > 0 && !done) onText?.("\n");
  }

  const status = !done ? "capped" : text.trim() === "" ? "empty" : "done";
  if (!done) note(`warning: hit the round cap (${roundCap}) while the model was still asking for tools`);
  if (done && text.trim() === "" && !stream) {
    note(
      `warning: the model finished with no text reply (stop_reason=${stopReason}). ` +
        "if that is max_tokens, try a larger budget"
    );
  }

  await streamLog.emit("run.end", {
    status,
    rounds,
    tool_calls: toolCalls,
    input_tokens: totalInput,
    output_tokens: totalOutput,
    // a duration, not a timestamp — the two are easy to confuse and a reader who has to
    // subtract an epoch from a number to learn "how long did this take" will not
    ms: Date.now() - startedAt,
    text_bytes: text.length,
  });

  if (saveIt) {
    await sessions.store(
      vfs,
      sessions.recordOf({
        id,
        status,
        prompt,
        messages: [...prefix, ...canonical],
        provider: provider.vendor,
        model: effectiveModel,
        system: effectiveSystem,
        toolsFrom: toolNames,
        budget: { context_budget: contextBudget, keep_recent: keepRecent, max_tokens: budget, max_output: maxOutput },
        counters: {
          rounds,
          tool_calls: toolCalls,
          last_input_tokens: lastInput,
          last_output_tokens: lastOutput,
          total_input: totalInput,
          total_output: totalOutput,
          stop_reason: stopReason,
        },
        folds,
        contextEntries: entries,
        parent,
        depth,
        created: prior?.created,
      })
    );
  }

  return {
    // `messages` may hold fold placeholders; `canonical` is the real history. both are
    // returned so a caller can see the difference, but only `canonical` is safe to persist.
    messages,
    canonical,
    done,
    status,
    text,
    rounds,
    tool_calls: toolCalls,
    input_tokens: lastInput,
    total_input: totalInput,
    total_output: totalOutput,
    stop_reason: stopReason,
    folds,
    context_entries: entries,
    session: saveIt ? id : null,
    events: streamLog.path,
  };
}
