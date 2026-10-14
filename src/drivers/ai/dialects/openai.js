// openai.js — the OpenAI chat-completions dialect.
//
// this file carries every byte of translation between the canonical shape (Anthropic
// content blocks) and a different wire. the canonical shape was chosen once, in one
// direction, so that exactly one file has to know two formats — and this is that file.
//
// ── the translation ──
//   canonical                                  openai
//   ─────────────────────────────────────────  ────────────────────────────────────────
//   the request's `system` field               a {role:"system"} message, first
//   {type:"text"}                              message.content
//   {type:"tool_use", id, name, input}         message.tool_calls[].function
//   {type:"tool_result", tool_use_id}          its own {role:"tool"} message
//   {type:"image", source:{base64}}            a content part {type:"image_url"}
//   {name, description, input_schema}          {type:"function", function:{…}}
//
// thinking blocks are **dropped on the way out** — there is no field for them and an
// unknown key is a 400 on most endpoints — but `reasoning_content` is read on the way in,
// because a DeepSeek-shaped endpoint sends it and losing the model's reasoning when it is
// offered would be a waste.
//
// ── the one piece of stream state ──
// Anthropic's stream says which content block a delta belongs to. OpenAI's tool-call
// fragments do not: fragment 2 of the first tool call carries no id and no name, only
// `index: 0`, and that index is a position in *its* array, not in the canonical block list.
// so the dialect carries a map between them, and it is why `events` takes and returns a
// state at all.

import { parseFrame } from "../sse.js";

export const DEFAULT_URL = "https://api.openai.com/v1";

const EMPTY_STATE = () => ({ started: false, next: 0, text: null, thinking: null, tools: {} });

/** one level, explicitly. `flat()` recurses by default and that is exactly the bug
 *  nu-agent documented: it collapses a single-element nested array into the element, which
 *  turns a `tool_calls` array of one into a bare object that every endpoint rejects. */
const concat = (...lists) => lists.reduce((acc, l) => (Array.isArray(l) ? [...acc, ...l] : [...acc, l]), []);

const asBlocks = (content) => (Array.isArray(content) ? content : [{ type: "text", text: String(content ?? "") }]);

function imagePart(b) {
  const src = b?.source ?? {};
  const data = src.data ?? "";
  const mt = src.media_type ?? "image/png";
  return { type: "image_url", image_url: { url: `data:${mt};base64,${data}` } };
}

/** a canonical user message → one or more openai messages. tool results each become
 *  their own `role: "tool"` message, which is why the return is a list. */
function userMessages(m) {
  const blocks = asBlocks(m.content);
  const out = [];
  const parts = [];
  for (const b of blocks) {
    if (b?.type === "tool_result") {
      const text = Array.isArray(b.content)
        ? b.content.map((c) => (c?.type === "text" ? c.text : `[${c?.type ?? "?"} block]`)).join("\n")
        : typeof b.content === "string"
          ? b.content
          : JSON.stringify(b.content ?? "");
      out.push({ role: "tool", tool_call_id: b.tool_use_id ?? "", content: text });
    } else if (b?.type === "image") {
      parts.push(imagePart(b));
    } else if (b?.type === "text") {
      parts.push({ type: "text", text: b.text ?? "" });
    }
  }
  if (parts.length) {
    // a single text part collapses back to a plain string — the shape every endpoint
    // expects for the ordinary case, and the one that keeps a request readable in a log
    const only = parts.length === 1 && parts[0].type === "text" ? parts[0].text : parts;
    out.unshift({ role: "user", content: only });
  }
  return out;
}

function assistantMessage(m) {
  const blocks = asBlocks(m.content);
  const text = blocks.filter((b) => b?.type === "text").map((b) => b.text ?? "").join("\n");
  const calls = blocks
    .filter((b) => b?.type === "tool_use")
    .map((b) => ({
      id: b.id ?? "",
      type: "function",
      // arguments is a JSON *string*, not an object — the wire says so and every
      // endpoint enforces it
      function: { name: b.name ?? "", arguments: JSON.stringify(b.input ?? {}) },
    }));
  const msg = { role: "assistant" };
  if (text) msg.content = text;
  if (calls.length) msg.tool_calls = calls;
  if (!text && !calls.length) msg.content = "";
  return msg;
}

export default {
  vendor: "openai",
  api: "chat",
  defaultModel: "gpt-4o",
  defaultUrl: DEFAULT_URL,

  endpoint(base) {
    // the base URL includes its version segment, the way every OpenAI SDK treats it
    return String(base).replace(/\/+$/, "") + "/chat/completions";
  },

  headers(token) {
    return { "content-type": "application/json", authorization: `Bearer ${token}` };
  },

  body(canonical, { model, stream }) {
    const messages = [];
    if (canonical.system != null && canonical.system !== "") {
      messages.push({ role: "system", content: canonical.system });
    }
    for (const m of canonical.messages ?? []) {
      if (m.role === "assistant") messages.push(assistantMessage(m));
      else messages.push(...userMessages(m));
    }

    const body = { model, messages };
    if (canonical.max_tokens != null) body.max_tokens = canonical.max_tokens;
    if (canonical.temperature != null) body.temperature = canonical.temperature;
    if (canonical.tools?.length) {
      body.tools = canonical.tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description ?? "",
          parameters: t.input_schema ?? { type: "object", properties: {} },
        },
      }));
    }
    if (stream) {
      body.stream = true;
      // REQUIRED, and the failure it prevents is quiet: without it the stream carries no
      // usage at all, so the loop's token counts stay 0 and proactive folding never fires.
      // the symptom is a mysterious context overflow on a long run, not a provider error.
      body.stream_options = { include_usage: true };
    }
    return body;
  },

  state: EMPTY_STATE,

  // ── streaming ──

  events(frame, state) {
    const s = { ...EMPTY_STATE(), ...(state ?? {}) };
    const { data, hasData, raw } = parseFrame(frame);

    if (!hasData) return { events: [], state: s };
    if (data === "[DONE]") return { events: [], state: s };

    let p;
    try {
      p = JSON.parse(data);
    } catch {
      return { events: [{ type: "raw", text: frame }], state: s };
    }

    const out = [];

    if (!s.started) {
      // this wire has no message_start; it is synthesised from the first frame so that
      // everything downstream can treat the two dialects identically
      s.started = true;
      out.push({ type: "message_start", id: p.id, model: p.model, usage: {} });
    }

    const choice = p.choices?.[0];
    const delta = choice?.delta ?? {};

    if (typeof delta.content === "string" && delta.content !== "") {
      if (s.text == null) {
        s.text = s.next++;
        out.push({ type: "block_start", index: s.text, kind: "text" });
      }
      out.push({ type: "text_delta", index: s.text, text: delta.content });
    }

    if (typeof delta.reasoning_content === "string" && delta.reasoning_content !== "") {
      if (s.thinking == null) {
        s.thinking = s.next++;
        out.push({ type: "block_start", index: s.thinking, kind: "thinking" });
      }
      out.push({ type: "thinking_delta", index: s.thinking, text: delta.reasoning_content });
    }

    for (const call of delta.tool_calls ?? []) {
      const key = call.index ?? 0;
      if (s.tools[key] == null) {
        s.tools[key] = s.next++;
        out.push({
          type: "block_start",
          index: s.tools[key],
          kind: "tool_use",
          id: call.id,
          name: call.function?.name,
        });
      }
      const args = call.function?.arguments;
      if (typeof args === "string" && args !== "") {
        out.push({ type: "tool_input_delta", index: s.tools[key], json: args });
      }
    }

    if (choice?.finish_reason != null) {
      // every open block has to be closed, or the accumulator never parses a tool_use
      // block's accumulated JSON and the loop hands the model a raw string where it
      // expects a record
      for (let i = 0; i < s.next; i++) out.push({ type: "block_stop", index: i });
      out.push({
        type: "message_delta",
        stop_reason: finishToStop(choice.finish_reason),
        usage: usageToCanonical(p.usage),
      });
      out.push({ type: "message_stop" });
    } else if (p.usage) {
      // a usage-bearing frame has an EMPTY choices array — it is not malformed, and
      // treating it as such is how the token counts get lost
      out.push({ type: "message_delta", stop_reason: null, usage: usageToCanonical(p.usage) });
    }

    return { events: out, state: s };
  },

  // ── non-streaming ──

  response(body) {
    const choice = body?.choices?.[0];
    if (!choice) {
      // an error body arriving with a 200 must not be handed on as "an empty reply" — the
      // loop would read that as the model having finished
      throw new Error(`no choices in the response: ${JSON.stringify(body).slice(0, 500)}`);
    }
    const m = choice.message ?? {};
    const blocks = [];
    // thinking first: the canonical order, and the one the loop renders in
    if (typeof m.reasoning_content === "string" && m.reasoning_content !== "") {
      // an empty signature is honest — this wire has none, and the canonical shape carries
      // the field, so "" says "present and empty" rather than inventing one
      blocks.push({ type: "thinking", thinking: m.reasoning_content, signature: "" });
    }
    if (typeof m.content === "string" && m.content !== "") {
      blocks.push({ type: "text", text: m.content });
    }
    for (const call of m.tool_calls ?? []) {
      blocks.push({
        type: "tool_use",
        id: call.id ?? "",
        name: call.function?.name ?? "",
        input: parseArgs(call.function?.arguments),
      });
    }
    return {
      id: body.id,
      model: body.model,
      role: "assistant",
      content: blocks,
      stop_reason: finishToStop(choice.finish_reason),
      usage: usageToCanonical(body.usage),
    };
  },
};

function parseArgs(text) {
  const s = String(text ?? "").trim();
  if (!s) return {};
  try {
    return JSON.parse(s);
  } catch {
    // a truncated argument string is a thing models do; it must not take the response down
    return { __unparsed: s };
  }
}

function finishToStop(reason) {
  switch (reason) {
    case "tool_calls":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "stop":
      return "end_turn";
    case "content_filter":
      return "refusal";
    case null:
    case undefined:
      return "unknown";
    default:
      return reason;
  }
}

function usageToCanonical(usage) {
  if (!usage) return {};
  return {
    input_tokens: usage.prompt_tokens ?? 0,
    output_tokens: usage.completion_tokens ?? 0,
    ...(usage.prompt_tokens_details?.cached_tokens
      ? { cache_read_input_tokens: usage.prompt_tokens_details.cached_tokens }
      : {}),
  };
}
