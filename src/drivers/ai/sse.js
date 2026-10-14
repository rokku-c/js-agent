// sse.js — the streaming state machine, provider-independent.
//
// ── the split, and why it is where it is ──
// a dialect turns a raw SSE *frame* into zero or more **normalized events**; this file turns
// normalized events into the running message. so the accumulator and the assembling live
// here once, and a dialect only has to describe its own wire format.
//
//   {type: "message_start",  id, model, usage}
//   {type: "block_start",    index, kind: text|thinking|tool_use, id, name}
//   {type: "text_delta",     index, text}
//   {type: "thinking_delta", index, text}
//   {type: "signature_delta",index, sig}
//   {type: "tool_input_delta",index, json}
//   {type: "block_stop",     index}
//   {type: "message_delta",  stop_reason, usage}
//   {type: "message_stop"}
//   {type: "raw",            text}
//
// `index` is the position in the assistant's content-block list. a dialect whose wire
// format has no such concept synthesises it — openai's does, and that is the one piece of
// state it has to carry between frames.
//
// ── frames, not lines ──
// nu-agent's SSE reader is line-at-a-time, which is adequate for Anthropic's own stream and
// is not the spec: `data:` may appear more than once in one event and is joined with
// newlines, and `event:`/`id:` lines precede the data. reading per line quietly truncates a
// multi-line payload. so the unit here is the blank-line-delimited frame, and the splitting
// happens before any dialect sees anything.

/** a chunk→frame reader. feed it decoded text; it yields whole SSE frames. */
export function makeFrameReader() {
  let buf = "";
  return {
    push(chunk) {
      buf += chunk;
      const out = [];
      // SSE delimits events with a blank line; accept CRLF as well as LF, because a
      // proxy that rewrites the stream is not the caller's problem to notice
      let m;
      const re = /\r?\n\r?\n/;
      while ((m = re.exec(buf))) {
        out.push(buf.slice(0, m.index));
        buf = buf.slice(m.index + m[0].length);
      }
      return out;
    },
    /** whatever is left when the stream ends without a final blank line — the last event
     *  usually has none, and dropping it loses the end of every reply. */
    flush() {
      const rest = buf;
      buf = "";
      return rest.trim() ? [rest] : [];
    },
  };
}

/** parse one frame into its fields. `data` lines join with newlines, per the spec. */
export function parseFrame(frame) {
  const data = [];
  let event = null;
  let id = null;
  for (const rawLine of frame.split(/\r?\n/)) {
    if (!rawLine || rawLine.startsWith(":")) continue; // a comment or a keep-alive
    const colon = rawLine.indexOf(":");
    const field = colon < 0 ? rawLine : rawLine.slice(0, colon);
    let value = colon < 0 ? "" : rawLine.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") data.push(value);
    else if (field === "event") event = value;
    else if (field === "id") id = value;
  }
  return { event, id, data: data.join("\n"), hasData: data.length > 0, raw: frame };
}

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
  const bi = a.idx ?? 0;

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
      return { ...a, blocks: [...a.blocks, block], idx: ev.index ?? a.blocks.length };
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

/** fold one raw frame into the accumulator. */
export function stepFrame(frame, a, dialect) {
  const { events, state } = dialect.events(frame, a.dialect ?? {});
  let acc = { ...a, dialect: state ?? a.dialect ?? {} };
  for (const ev of events ?? []) acc = applyEvent(acc, ev);
  return acc;
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

/**
 * Read a stream of chunks to completion, folding frames into the accumulator.
 *
 * `onEvent` sees every normalized event as it lands, which is what a live rendering needs —
 * nu-agent threads its markdown renderer through the same place rather than collecting
 * first and printing after, because printing after is not streaming.
 */
export async function consume(chunks, dialect, { onEvent } = {}) {
  const reader = makeFrameReader();
  let acc = seed();

  const feed = (frame) => {
    const { events, state } = dialect.events(frame, acc.dialect ?? {});
    acc = { ...acc, dialect: state ?? acc.dialect ?? {} };
    for (const ev of events ?? []) {
      // the event is surfaced *before* it is applied, so a renderer sees the same delta
      // the accumulator does rather than a diff of the result
      if (onEvent) onEvent(ev);
      acc = applyEvent(acc, ev);
    }
  };

  for await (const item of chunks) {
    if (item?.chunk == null) continue;
    for (const frame of reader.push(item.chunk)) feed(frame);
  }
  for (const frame of reader.flush()) feed(frame);

  return acc;
}
