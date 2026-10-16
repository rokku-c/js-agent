// Canonical model events and one-request stream lifecycle. No transport or dispatch authority.

export function seed() {
  return {
    blocks: [],
    idx: -1,
    stop_reason: null,
    usage: {},
    id: null,
    model: null,
    /** events this runtime does not model, kept so an error can be *reported* rather than
     *  silently swallowed — a stream that ends with nothing usually has its reason here */
    other: [],
    /** per-dialect scratch that must survive between frames. it lives in the accumulator
     *  because openai needs it (its tool-call fragments carry an array index and nothing
     *  else) and anthropic ignores it entirely. */
    dialect: {},
  };
}

const replaceBlock = (blocks, i, f) => blocks.map((b, n) => (n === i ? f(b) : b));

/** apply one normalized event. pure: it returns a new accumulator, which is what lets the
 *  whole thing be replayed from canned bytes in a test with no stream at all. */
export function applyEvent(a, ev) {
  const t = ev.type ?? "";
  const bi = ev.index ?? a.idx ?? 0;

  switch (t) {
    case "message_start":
      return {
        ...a,
        blocks: [],
        idx: -1,
        stop_reason: ev.stop_reason ?? null,
        usage: ev.usage ?? {},
        id: ev.id ?? null,
        model: ev.model ?? null,
        other: a.other,
        dialect: a.dialect ?? {},
      };

    case "block_start": {
      const kind = ev.kind ?? "text";
      const block =
        kind === "tool_use"
          ? { type: "tool_use", id: ev.id ?? "", name: ev.name ?? "", input: "" }
          : kind === "thinking"
            ? { type: "thinking", thinking: "", signature: "" }
            : { type: "text", text: "" };
      const blocks = [...a.blocks];
      const index = ev.index ?? blocks.length;
      blocks[index] = block;
      return { ...a, blocks, idx: index };
    }

    case "text_delta":
      return { ...a, blocks: replaceBlock(a.blocks, bi, (b) => ({ ...b, text: (b.text ?? "") + (ev.text ?? "") })) };

    case "thinking_delta":
      return {
        ...a,
        blocks: replaceBlock(a.blocks, bi, (b) => ({ ...b, thinking: (b.thinking ?? "") + (ev.text ?? "") })),
      };

    case "signature_delta":
      return {
        ...a,
        blocks: replaceBlock(a.blocks, bi, (b) => ({ ...b, signature: (b.signature ?? "") + (ev.sig ?? "") })),
      };

    case "tool_input_delta":
      return { ...a, blocks: replaceBlock(a.blocks, bi, (b) => ({ ...b, input: (b.input ?? "") + (ev.json ?? "") })) };

    case "block_stop": {
      const b = a.blocks[bi];
      if (b?.type !== "tool_use") return a;
      // the input is a JSON *string* assembled piece by piece; it only becomes an object
      // here. a malformed tail must not take the whole run down — a model that emitted
      // truncated JSON is a thing the loop has to survive and report.
      const raw = String(b.input ?? "").trim();
      let parsed = {};
      try {
        parsed = raw === "" ? {} : JSON.parse(raw);
      } catch {
        parsed = { __unparsed: raw };
      }
      return { ...a, blocks: replaceBlock(a.blocks, bi, (x) => ({ ...x, input: parsed })) };
    }

    case "message_delta":
      // the usage is **merged, not replaced**, and that is load-bearing: the real wire sends
      // `message_start` with the input token count and then `message_delta` carrying only
      // `output_tokens`. replacing would drop the input count on every streamed round, and
      // the input count is what drives proactive folding — so the symptom would be a
      // mysterious overflow on a long run rather than a missing number.
      return {
        ...a,
        stop_reason: ev.stop_reason ?? a.stop_reason,
        usage: { ...a.usage, ...(ev.usage ?? {}) },
      };

    case "message_stop":
      return a;

    default: {
      // an event we do not model is kept, because a stream that ends with no content and
      // no error usually has its explanation sitting in one of these
      const text = ev.type === "raw" ? ev.text : JSON.stringify(ev);
      return { ...a, other: [...a.other, text] };
    }
  }
}

/** the accumulator → an Anthropic-shaped message body, so a streamed call and a
 *  non-streamed one hand the caller the same shape and nothing downstream can tell. */
export function assemble(a) {
  return {
    id: a.id,
    model: a.model,
    role: "assistant",
    content: a.blocks,
    stop_reason: a.stop_reason,
    usage: a.usage,
  };
}

/** Fold one stream. Awaiting onEvent applies backpressure; no requests or retries occur here.
 * Failure carries partialResponse for display only, never executable tool results.
 * Connectors must cooperate with signal to release their pending IO on cancellation.
 */
export async function consumeModelEvents(events, { onEvent, signal, requireComplete = true } = {}) {
  let acc = seed();
  let complete = false;
  let started = false;
  const openBlocks = new Set();
  let ended = false;
  const iterator = events[Symbol.asyncIterator]?.() ?? events[Symbol.iterator]();
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(Object.assign(new Error("model stream cancelled", { cause: signal?.reason }), { code: "ABORT_ERR" }));
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
  // Attach a handler even if cancellation happens between awaits.
  aborted.catch(() => {});
  const wait = (value) => signal ? Promise.race([aborted, value]) : value;
  try {
    for (;;) {
      if (signal?.aborted) await aborted;
      const next = await wait(iterator.next());
      if (next.done) { ended = true; break; }
      const ev = next.value;
      if (ev.type === "error") throw Object.assign(new Error(ev.message ?? "model stream failed"), { code: "EIO" });
      if (requireComplete) {
        const protocolError = (message) => { throw Object.assign(new Error(message), { code: "EPROTO" }); };
        if (ev.type === "message_start") {
          if (started || complete) protocolError("multiple messages in one model stream");
          started = true;
        }
        if (complete && ev.type !== "message_delta") protocolError("content after message_stop");
        const index = ev.index ?? acc.idx;
        if (ev.type === "block_start") openBlocks.add(index);
        if (ev.type === "block_stop") {
          const block = acc.blocks[index];
          if (block?.type === "tool_use") {
            try { JSON.parse(block.input || "{}"); }
            catch { protocolError("invalid streamed tool arguments"); }
          }
          openBlocks.delete(index);
        }
        if (ev.type === "message_stop" && openBlocks.size) protocolError("message_stop with unfinished blocks");
      }
      // Fold before notifying so callback failures retain the bytes already received.
      acc = applyEvent(acc, ev);
      if (ev.type === "message_stop") complete = true;
      if (onEvent) await wait(onEvent(ev));
    }
    if (requireComplete && !complete) {
      throw Object.assign(new Error("model stream ended before message_stop"), { code: "EINCOMPLETE" });
    }
    return acc;
  } catch (cause) {
    const error = new Error(cause?.message ?? String(cause), { cause });
    error.code = cause?.code ?? "EIO";
    error.outcome = "unknown";
    error.partialResponse = structuredClone(assemble(acc));
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (!ended && iterator.return) {
      // A pending next() on an uncooperative source must not block cancellation.
      const closing = Promise.resolve().then(() => iterator.return());
      if (signal?.aborted) closing.catch(() => {});
      else await closing.catch(() => {});
    }
  }
}

/** Trusted adapters can return this promise from request(); it resolves once, on completion. */
export async function consumeModelStream(events, options) {
  return assemble(await consumeModelEvents(events, { ...options, requireComplete: true }));
}
