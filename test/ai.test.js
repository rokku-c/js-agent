// ai.test.js — the model as a device, and the two dialects' translation.

import { test } from "node:test";
import assert from "node:assert/strict";
import { namespace } from "./helpers.js";
import * as sse from "../src/drivers/ai/sse.js";
import anthropic from "../src/drivers/ai/dialects/anthropic.js";
import openai from "../src/drivers/ai/dialects/openai.js";

const FAKE = "ai:/dev/providers/ai,vendor=fake";
const MODEL = "/dev/providers/ai/type/api/fake/messages/model/fake-1";

test("sse: frames, not lines — a data field may repeat within one event", () => {
  const reader = sse.makeFrameReader();
  // the split straddles the boundary on purpose: nothing about a chunk is a unit
  assert.deepEqual(reader.push("event: a\ndata: {\"x\""), []);
  assert.deepEqual(reader.push(":1}\n\ndata: [DONE]\n\n"), ['event: a\ndata: {"x":1}', "data: [DONE]"]);

  // a multi-line data field joins with newlines, per the spec — a line-at-a-time reader
  // truncates this and reports a JSON error that names nothing
  const multi = sse.parseFrame("event: x\ndata: one\ndata: two");
  assert.equal(multi.data, "one\ntwo");

  // and the last event usually has no trailing blank line
  const tail = sse.makeFrameReader();
  tail.push("data: {\"a\":1}");
  assert.deepEqual(tail.flush(), ['data: {"a":1}']);
});

test("sse: replaying a stream from canned bytes, with no socket anywhere", async () => {
  const bytes = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","model":"x","usage":{"input_tokens":10}}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n',
    "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
  ];
  const seen = [];
  const acc = await sse.consume(
    (async function* () {
      for (const b of bytes) yield { chunk: b };
    })(),
    anthropic,
    { onEvent: (e) => seen.push(e) }
  );
  const body = sse.assemble(acc);
  assert.equal(body.content[0].text, "Hello");
  assert.equal(body.stop_reason, "end_turn");
  assert.equal(body.id, "m1");
  // usage is merged, not replaced — the input count arrives in message_start and the
  // output count in message_delta, and losing the first is how folding stops firing
  assert.equal(body.usage.input_tokens, 10);
  assert.equal(body.usage.output_tokens, 2);
  assert.ok(seen.some((e) => e.type === "text_delta"), "the renderer sees the deltas as they land");
});

test("sse: a non-SSE body is surfaced, not swallowed", async () => {
  // a gateway answering with plain JSON instead of a stream is the case this exists for:
  // those bytes are the only evidence, and a reader that drops them reports "ended"
  const acc = await sse.consume(
    (async function* () {
      yield { chunk: '{"error":{"message":"rate limited"}}' };
    })(),
    anthropic
  );
  assert.equal(acc.blocks.length, 0);
  assert.match(acc.other.join(" "), /rate limited/);
});

test("anthropic: the pass-through dialect translates nothing, and drops absent fields", () => {
  const body = anthropic.body(
    { max_tokens: 100, messages: [{ role: "user", content: "hi" }], system: "be terse", temperature: undefined, tools: [] },
    { model: "claude-sonnet-5", stream: true }
  );
  assert.equal(body.model, "claude-sonnet-5");
  assert.equal(body.max_tokens, 100);
  assert.equal(body.system, "be terse");
  assert.equal(body.stream, true);
  // absent means absent — `temperature: null` is a 400 on some gateways and means something
  // different from "not set" on all of them
  assert.equal("temperature" in body, false);
  assert.equal("tools" in body, false);
  assert.equal(anthropic.endpoint("https://api.anthropic.com/"), "https://api.anthropic.com/v1/messages");
  // both auth headers, because the API wants one and a gateway in front of it wants the other
  const h = anthropic.headers("sk-1");
  assert.equal(h["x-api-key"], "sk-1");
  assert.equal(h.authorization, "Bearer sk-1");
});

test("openai: the whole translation, in one place", () => {
  const canonical = {
    max_tokens: 100,
    system: "be terse",
    tools: [{ name: "read", description: "read a file", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }],
    messages: [
      { role: "user", content: "look at this" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hmm", signature: "sig" },
          { type: "text", text: "reading" },
          { type: "tool_use", id: "t1", name: "read", input: { path: "/x" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "file contents" },
          { type: "text", text: "and now?" },
        ],
      },
    ],
  };
  const body = openai.body(canonical, { model: "gpt-4o", stream: true });

  assert.equal(body.messages[0].role, "system");
  assert.equal(body.messages[0].content, "be terse");

  const assistant = body.messages.find((m) => m.role === "assistant");
  assert.equal(assistant.content, "reading");
  assert.equal(assistant.tool_calls.length, 1);
  assert.equal(assistant.tool_calls[0].function.name, "read");
  // arguments is a JSON *string*, not an object — every endpoint enforces it
  assert.equal(typeof assistant.tool_calls[0].function.arguments, "string");
  assert.deepEqual(JSON.parse(assistant.tool_calls[0].function.arguments), { path: "/x" });

  // a tool result becomes its own message, and the text that followed it is a separate user
  // message rather than being merged into it
  const toolMsg = body.messages.find((m) => m.role === "tool");
  assert.equal(toolMsg.tool_call_id, "t1");
  assert.equal(toolMsg.content, "file contents");

  // thinking is dropped on the way out — there is no field for it and an unknown key is a 400
  assert.equal(JSON.stringify(body.messages).includes("hmm"), false);

  // input_schema → parameters, wrapped in a function
  assert.equal(body.tools[0].type, "function");
  assert.equal(body.tools[0].function.parameters.required[0], "path");

  // REQUIRED when streaming: without it the stream carries no usage at all, and the loop's
  // token counts stay zero so proactive folding never fires
  assert.deepEqual(body.stream_options, { include_usage: true });
  assert.equal(openai.endpoint("https://api.openai.com/v1/"), "https://api.openai.com/v1/chat/completions");
});

test("openai: streaming tool-call fragments carry only an array index", () => {
  // fragment 2 of the first call has no id and no name — the map between its array position
  // and the canonical block index is the one piece of state this dialect needs
  // the state is threaded, exactly as sse.consume threads it — that threading *is* the
  // mechanism, so a test that starts fresh each frame is testing nothing
  let state = openai.state();
  const feed = (data) => {
    const r = openai.events(`data: ${JSON.stringify(data)}`, state);
    state = r.state;
    return r;
  };

  const first = feed({ id: "c1", model: "gpt-4o", choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read", arguments: '{"pa' } }] } }] });
  assert.deepEqual(first.events.map((e) => e.type), ["message_start", "block_start", "tool_input_delta"]);
  assert.equal(first.events[1].name, "read");

  const second = feed({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"/x"}' } }] } }] });
  assert.deepEqual(second.events.map((e) => e.type), ["tool_input_delta"], "no second block is opened");
  assert.equal(second.events[0].index, first.events[1].index, "the fragment lands in the block the index map points at");

  const done = feed({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });
  const kinds = done.events.map((e) => e.type);
  assert.deepEqual(kinds, ["block_stop", "message_delta", "message_stop"]);
  assert.equal(done.events[1].stop_reason, "tool_use");

  // a usage-bearing frame has an EMPTY choices array, and that is not malformed
  const usage = feed({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 3 } });
  assert.equal(usage.events[0].type, "message_delta");
  assert.deepEqual(usage.events[0].usage, { input_tokens: 7, output_tokens: 3 });
});

test("openai: a 200 with an error body is not an empty reply", () => {
  assert.throws(() => openai.response({ error: { message: "nope" } }), /no choices in the response/);
  const ok = openai.response({
    id: "c1",
    model: "gpt-4o",
    choices: [{ message: { role: "assistant", content: "hi", reasoning_content: "thought" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 5, completion_tokens: 2 },
  });
  assert.deepEqual(ok.content.map((b) => b.type), ["thinking", "text"]);
  assert.equal(ok.stop_reason, "end_turn");
  assert.equal(ok.usage.input_tokens, 5);
});

test("ai: the tree is the path the design promised", async () => {
  const vfs = await namespace({ mounts: [`${FAKE},models=fake-1`] });
  assert.deepEqual((await vfs.list("/dev/providers/ai")).map((e) => e.name), ["type"]);
  assert.deepEqual((await vfs.list("/dev/providers/ai/type/api")).map((e) => e.name), ["fake"]);
  assert.deepEqual((await vfs.list("/dev/providers/ai/type/api/fake")).map((e) => e.name), ["messages"]);
  assert.deepEqual((await vfs.list("/dev/providers/ai/type/api/fake/messages")).map((e) => e.name), ["model"]);
  assert.deepEqual((await vfs.list("/dev/providers/ai/type/api/fake/messages/model")).map((e) => e.name), ["fake-1"]);
});

test("ai: a narrowed namespace cannot borrow credential or network mounts", async () => {
  const vfs = await namespace({
    mounts: [
      "secret:/dev/secrets,values=API_TOKEN=private",
      "net:/dev/net,allow=api.anthropic.com",
      "ai:/dev/providers/ai,vendor=anthropic,token-file=/dev/secrets/API_TOKEN",
    ],
  });
  const child = vfs.narrow(["/dev/providers/ai"]);
  const descriptor = JSON.parse(await child.read(
    "/dev/providers/ai/type/api/anthropic/messages/model/claude-opus-5"
  ));
  assert.equal(descriptor.auth_present, false);
  assert.equal(descriptor.net_mounted, false);
  await assert.rejects(
    () => child.invoke("/dev/providers/ai/type/api/anthropic/messages/model/claude-opus-5", { messages: [] }),
    { code: "EACCES" },
  );
});

test("ai: a model is also a generic one-request callable resource", async () => {
  const vfs = await namespace({ mounts: [FAKE] });
  const result = await vfs.invoke(MODEL, { messages: [{ role: "user", content: "call" }] });
  assert.equal(result.content[0].type, "text");
  assert.match(result.content[0].text, /heard 1 messages/);
});

test("ai: reading a model is free and offline, and never the token", async () => {
  const vfs = await namespace({ mounts: [FAKE] });
  const d = JSON.parse(await vfs.read(MODEL));
  assert.equal(d.vendor, "fake");
  assert.equal(d.model, "fake-1");
  assert.equal(d.kind, "device");
  assert.equal(d.callable, true);
  assert.equal(d.append, false);
  // presence checks, never probes: a read that could block would defeat the whole
  // read-is-cheap / write-expensive split
  assert.equal(d.net_mounted, false);
  assert.equal(d.auth_present, false);

  const st = await vfs.stat(MODEL);
  assert.equal(st.device, true);
  assert.equal(st.appendable, false);
});

test("ai: a model id is percent-decoded, and any segment is accepted", async () => {
  const vfs = await namespace({ mounts: [FAKE] });
  // `meta-llama/Llama-3-70B` has a slash and is not a path
  const id = "meta-llama/Llama-3-70B";
  const d = JSON.parse(await vfs.read(`${MODEL.replace("fake-1", encodeURIComponent(id))}`));
  assert.equal(d.model, id, "the descriptor reports what will actually be sent");
  // and it is not gated on being in the configured list — the endpoint is the only thing
  // that knows what it serves
  assert.equal(d.known_here_includes_this, false);
});

test("ai: write is one shot, and streaming is the handle's job", async () => {
  const vfs = await namespace({ mounts: [FAKE] });
  const res = await vfs.write(MODEL, { max_tokens: 50, messages: [{ role: "user", content: "hello" }] });
  const body = res.value;
  assert.equal(body.content[0].text.includes("hello"), true);

  await assert.rejects(() => vfs.write(MODEL, { stream: true, messages: [] }), (e) => {
    assert.equal(e.code, "EINVAL");
    assert.match(e.message, /one-shot write cannot carry a stream/);
    assert.match(e.message, /open the node instead/);
    return true;
  });
});

test("ai: a handle does not send a transcript twice", async () => {
  const vfs = await namespace({ mounts: [FAKE] });
  const handle = await vfs.open(MODEL, "r+");

  // the caller passes the whole conversation, as the loop does — the handle must use it
  // rather than prepending its own copy
  await handle.send({ max_tokens: 50, messages: [{ role: "user", content: "one" }] });
  await handle.send({
    max_tokens: 50,
    messages: [
      { role: "user", content: "one" },
      { role: "assistant", content: [{ type: "text", text: "[fake] heard 1 messages; last said: one" }] },
      { role: "user", content: "two" },
    ],
  });

  const asked = handle.asked();
  const second = asked[1].canonical.messages;
  assert.deepEqual(second.map((m) => m.role), ["user", "assistant", "user"], "three messages in, three messages asked");
  assert.equal(second[0].content, "one");
  assert.equal(second[2].content, "two");

  await handle.close();
});

test("ai: a conversation handle is single-flight and remembers the turn", async () => {
  const vfs = await namespace({ mounts: [FAKE] });
  const handle = await vfs.open(MODEL, "r+");
  await handle.send({ max_tokens: 50, messages: [{ role: "user", content: "one" }] });
  assert.equal(handle.messages.length, 2, "the user turn and the assistant turn");
  assert.equal(handle.messages[0].content, "one");
  await handle.close();
  assert.equal(handle.messages.length, 0);
});

test("ai: the three mounts a model needs, and each refusal names its own fix", async () => {
  // 1. no credential
  const noToken = await namespace({ mounts: [FAKE.replace("vendor=fake", "vendor=anthropic")] });
  await assert.rejects(() => noToken.write(MODEL.replace("fake/messages", "anthropic/messages").replace("fake-1", "claude-opus-5"), { messages: [] }), (e) => {
    assert.equal(e.code, "EACCES");
    assert.match(e.message, /no credential is configured/);
    return true;
  });

  // 2. a credential, but no network
  const noNet = await namespace({
    mounts: [
      "secret:/dev/secrets,values=K=sk-test-1234",
      "ai:/dev/providers/ai,vendor=anthropic,token-file=/dev/secrets/K",
    ],
  });
  await assert.rejects(
    () => noNet.write("/dev/providers/ai/type/api/anthropic/messages/model/claude-opus-5", { messages: [] }),
    (e) => {
      assert.equal(e.code, "ENETDOWN");
      assert.match(e.message, /has no transport at \/dev\/net\/request/);
      assert.match(e.message, /mount one: mount net:\/dev\/net/);
      return true;
    }
  );

  // 3. both, but the host is not on the allowlist — a capability with no scope is ambient
  //    network access wearing a path
  const notAllowed = await namespace({
    mounts: [
      "secret:/dev/secrets,values=K=sk-test-1234",
      "net:/dev/net,allow=example.com",
      "ai:/dev/providers/ai,vendor=anthropic,token-file=/dev/secrets/K",
    ],
  });
  await assert.rejects(
    () => notAllowed.write("/dev/providers/ai/type/api/anthropic/messages/model/claude-opus-5", { messages: [] }),
    (e) => {
      assert.equal(e.code, "EACCES");
      assert.match(e.message, /not on this mount's allowlist: api\.anthropic\.com/);
      assert.match(e.message, /mounted allowlist: example\.com/);
      return true;
    }
  );
});

test("ai: the net device itself refuses an unlisted host, method, and schema", async () => {
  const vfs = await namespace({ mounts: ["net:/dev/net,allow=example.com,methods=GET"] });
  const req = (r) => vfs.write("/dev/net/request", r).then(() => null, (e) => e);

  assert.match((await req({ method: "GET", url: "https://other.com/x" })).message, /not on this mount's allowlist: other\.com/);
  assert.match((await req({ method: "POST", url: "https://example.com/x" })).message, /method is not on this mount's allowlist: POST/);
  assert.match((await req({ method: "GET", url: "ftp://example.com/x" })).message, /refusing to speak ftp:/);
  assert.match((await req({ method: "GET", url: "not a url" })).message, /not a URL/);
  // mounting without an allowlist is an error rather than an open gate
  await assert.rejects(() => namespace({ mounts: ["net:/dev/net"] }), /allow=|is required/);
});
