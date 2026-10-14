// anthropic.js — the Anthropic Messages API dialect.
//
// ── why this file is nearly empty, and should stay that way ──
// Anthropic's content-block shape **is** the runtime's canonical form: the loop, the
// context folder, the tool definitions and the session store all speak
// `{type: text|thinking|tool_use|tool_result|image}`. so this dialect translates nothing.
// it builds a request body and renames SSE event types, and that is all it does.
//
// the asymmetry is the useful part. because the canonical shape is one dialect's own, that
// dialect can be pinned byte-for-byte by a test, and every byte of translation lives in the
// other one — where it can be read in one place instead of being spread across the runtime.

import { parseFrame } from "../sse.js";

export const VERSION = "2023-06-01";

export default {
  vendor: "anthropic",
  api: "messages",
  defaultModel: "claude-sonnet-5",
  defaultUrl: "https://api.anthropic.com",

  endpoint(base) {
    return String(base).replace(/\/+$/, "") + "/v1/messages";
  },

  headers(token) {
    return {
      "content-type": "application/json",
      // both spellings on purpose: the official API wants x-api-key and a gateway in front
      // of it usually wants Bearer. sending both costs one header and removes a whole class
      // of "it works here but not there"
      "x-api-key": token,
      authorization: `Bearer ${token}`,
      "anthropic-version": VERSION,
    };
  },

  /** canonical request → the wire body. an absent field is *dropped*, never sent as null:
   *  `temperature: null` is a 400 on some gateways and means something different from
   *  "not set" on all of them. */
  body(canonical, { model, stream }) {
    const body = { model, max_tokens: canonical.max_tokens, messages: canonical.messages };
    if (canonical.system != null && canonical.system !== "") body.system = canonical.system;
    if (canonical.temperature != null) body.temperature = canonical.temperature;
    if (canonical.tools?.length) body.tools = canonical.tools;
    if (stream) body.stream = true;
    return body;
  },

  /** the response *is* canonical — nothing to do, which is the point. */
  response(body) {
    return body;
  },

  state() {
    return {};
  },

  /** one SSE frame → normalized events. the state is threaded through untouched: this
   *  wire has a content-block index of its own, so no dialect scratch is needed. */
  events(frame, state) {
    const { event, data, hasData, raw } = parseFrame(frame);

    // anything that is not SSE at all is surfaced rather than dropped. when a gateway
    // answers an error as plain JSON instead of a stream, those bytes are the only
    // evidence there is, and a reader that swallows them reports "the stream ended"
    if (!hasData && !event) {
      return raw.trim() ? { events: [{ type: "raw", text: raw }], state } : { events: [], state };
    }

    if (data === "[DONE]") return { events: [], state };
    if (!hasData) return { events: [], state };

    let p;
    try {
      p = JSON.parse(data);
    } catch {
      return { events: [{ type: "raw", text: frame }], state };
    }

    const type = p.type ?? event;
    const at = (kind, fields) => ({ events: [{ type: kind, ...fields }], state });

    switch (type) {
      case "message_start":
        return at("message_start", {
          id: p.message?.id,
          model: p.message?.model,
          stop_reason: p.message?.stop_reason ?? null,
          usage: p.message?.usage ?? {},
        });

      case "content_block_start":
        return at("block_start", {
          index: p.index,
          kind: p.content_block?.type ?? "text",
          id: p.content_block?.id,
          name: p.content_block?.name,
        });

      case "content_block_delta": {
        const d = p.delta ?? {};
        switch (d.type) {
          case "text_delta":
            return at("text_delta", { index: p.index, text: d.text ?? "" });
          case "thinking_delta":
            return at("thinking_delta", { index: p.index, text: d.thinking ?? "" });
          case "signature_delta":
            return at("signature_delta", { index: p.index, sig: d.signature ?? "" });
          case "input_json_delta":
            return at("tool_input_delta", { index: p.index, json: d.partial_json ?? "" });
          default:
            return { events: [{ type: "raw", text: frame }], state };
        }
      }

      case "content_block_stop":
        return at("block_stop", { index: p.index });

      case "message_delta":
        return at("message_delta", { stop_reason: p.delta?.stop_reason, usage: p.usage });

      case "message_stop":
        return at("message_stop", {});

      case "ping":
        return { events: [], state };

      case "error":
        // a stream-level error is a *value* the caller has to read, not a transport
        // failure — the connection was fine and the model's side said no
        return { events: [{ type: "raw", text: JSON.stringify(p.error ?? p) }], state };

      default:
        return { events: [{ type: "raw", text: frame }], state };
    }
  },
};
