// fake.js — a model that answers from a script, with no socket anywhere.
//
// ── what this is for ──
// the claim this whole runtime rests on is that a model is a *device*, not a network call.
// asserting that in prose is worth nothing; being able to run the entire loop — request,
// stream, tool call, tool result, second round, final answer — with no network in the
// process is worth a great deal. so this dialect answers locally, and it does it by
// emitting **real Anthropic SSE frames** that go through the real streaming machine. the
// only thing missing is the socket.
//
// that is also why it is not a mock of the driver: it is a model behind the same interface,
// exercised by the same code, and the `agent` test suite drives the loop through it.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** a canonical response body → the SSE frames Anthropic would have sent for it. */
function* framesFor(body) {
  const id = body.id ?? `msg_fake_${Math.random().toString(36).slice(2, 10)}`;
  const send = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

  yield send("message_start", {
    type: "message_start",
    message: {
      id,
      model: body.model ?? "fake-1",
      role: "assistant",
      content: [],
      stop_reason: null,
      usage: { input_tokens: body.usage?.input_tokens ?? 128, output_tokens: 0 },
    },
  });

  // a for..of, not a forEach: `yield` is only legal in the generator's own body, and a
  // callback passed to forEach is a different function
  for (const [index, block] of body.content.entries()) {
    if (block.type === "text") {
      yield send("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
      // split into pieces so the streaming path is actually exercised: a stream delivered
      // in one chunk would pass a test that a real stream would fail
      for (const piece of chunk(block.text ?? "")) {
        yield send("content_block_delta", {
          type: "content_block_delta",
          index,
          delta: { type: "text_delta", text: piece },
        });
      }
      yield send("content_block_stop", { type: "content_block_stop", index });
      continue;
    }

    if (block.type === "thinking") {
      yield send("content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "thinking", thinking: "" },
      });
      for (const piece of chunk(block.thinking ?? "")) {
        yield send("content_block_delta", {
          type: "content_block_delta",
          index,
          delta: { type: "thinking_delta", thinking: piece },
        });
      }
      yield send("content_block_stop", { type: "content_block_stop", index });
      continue;
    }

    if (block.type === "tool_use") {
      yield send("content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "tool_use", id: block.id, name: block.name },
      });
      // the arguments arrive as JSON fragments, one piece at a time, exactly as the real
      // wire does it — including the case where the JSON only becomes parseable at the end
      for (const piece of chunk(JSON.stringify(block.input ?? {}), 7)) {
        yield send("content_block_delta", {
          type: "content_block_delta",
          index,
          delta: { type: "input_json_delta", partial_json: piece },
        });
      }
      yield send("content_block_stop", { type: "content_block_stop", index });
    }
  }

  yield send("message_delta", {
    type: "message_delta",
    delta: { stop_reason: body.stop_reason ?? "end_turn" },
    usage: { output_tokens: body.usage?.output_tokens ?? 64 },
  });
  yield send("message_stop", { type: "message_stop" });
}

function chunk(text, size = 24) {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out.length ? out : [""];
}

export default {
  vendor: "fake",
  api: "messages",
  defaultModel: "fake-1",
  defaultUrl: "local:",
  local: true,

  /** no transport at all — this is the point */
  endpoint() {
    return "(local)";
  },
  headers() {
    return {};
  },

  /**
   * options.script — a JSON list of canonical response bodies, consumed one per call.
   *   [{content:[{type:"tool_use",name:"read",input:{path:"/x"}}],stop_reason:"tool_use"},
   *    {content:[{type:"text",text:"done"}],stop_reason:"end_turn"}]
   *
   * with no script it echoes, which is enough to prove a round trip happened.
   */
  makeResponder(options = {}) {
    let script = [];
    if (options.script) {
      script = typeof options.script === "string" ? JSON.parse(options.script) : options.script;
    }
    let turn = 0;
    // every request the fake ever saw, so a test can assert what the loop actually sent
    const seen = [];

    const reply = (canonical) => {
      const next = script[turn++];
      if (next) return next;

      if (script.length > 0) {
        // a script that ran out is a test bug, and saying so is better than echoing
        return {
          content: [{ type: "text", text: `[fake: script exhausted after ${script.length} turns]` }],
          stop_reason: "end_turn",
        };
      }

      const last = [...(canonical.messages ?? [])].reverse().find((m) => m.role !== "assistant");
      const text =
        typeof last?.content === "string"
          ? last.content
          : (last?.content ?? [])
              .map((b) => b.text ?? (b.type === "tool_result" ? String(b.content ?? "").slice(0, 200) : ""))
              .filter(Boolean)
              .join(" ");
      return {
        content: [
          {
            type: "text",
            text: `[fake] heard ${canonical.messages?.length ?? 0} messages; last said: ${text.slice(0, 300)}`,
          },
        ],
        stop_reason: "end_turn",
        usage: { input_tokens: 100, output_tokens: 20 },
      };
    };

    return {
      seen: () => seen,
      async respond(canonical, { model } = {}) {
        seen.push({ model, canonical: structuredClone(canonical) });
        const body = reply(canonical);
        return { id: `msg_fake_${seen.length}`, model: model ?? "fake-1", role: "assistant", usage: {}, ...body };
      },
      /** the streaming path: real frames, paced a little, through the real parser */
      async *stream(canonical, { model, delayMs = 0 } = {}) {
        seen.push({ model, canonical: structuredClone(canonical) });
        const body = reply(canonical);
        if (delayMs) await sleep(delayMs);
        yield* framesFor({ id: `msg_fake_${seen.length}`, model: model ?? "fake-1", usage: {}, ...body });
      },
    };
  },
};
