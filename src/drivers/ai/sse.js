import { applyEvent, consumeModelEvents } from "../../core/model-stream.js";
export { seed, applyEvent, assemble } from "../../core/model-stream.js";

// sse.js — the streaming state machine, provider-independent.
//
// ── the split, and why it is where it is ──
// a dialect turns a raw SSE *frame* into zero or more **normalized events**; this file turns
// normalized events into the running message via core/model-stream.js. Dialects only
// describe their own wire format; trusted connectors can also supply canonical events.
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

/** fold one raw frame into the accumulator. */
export function stepFrame(frame, a, dialect) {
  const { events, state } = dialect.events(frame, a.dialect ?? {});
  let acc = { ...a, dialect: state ?? a.dialect ?? {} };
  for (const ev of events ?? []) acc = applyEvent(acc, ev);
  return acc;
}

/**
 * Read a stream of chunks to completion, folding frames into the accumulator.
 *
 * `onEvent` sees every normalized event as it lands, which is what a live rendering needs —
 * nu-agent threads its markdown renderer through the same place rather than collecting
 * first and printing after, because printing after is not streaming.
 */
export async function consume(chunks, dialect, options = {}) {
  const reader = makeFrameReader();
  let state = dialect.state?.() ?? {};
  function* feed(frame) {
    const result = dialect.events(frame, state);
    state = result.state ?? state;
    yield* result.events ?? [];
  }
  const events = (async function* () {
    for await (const item of chunks) {
      if (item?.chunk == null) continue;
      for (const frame of reader.push(item.chunk)) yield* feed(frame);
    }
    for (const frame of reader.flush()) yield* feed(frame);
  })();
  // Low-level decoding also supports inspecting plain error bodies. Model requests
  // explicitly require a completion event.
  const acc = await consumeModelEvents(events, { requireComplete: false, ...options });
  return { ...acc, dialect: state };
}
