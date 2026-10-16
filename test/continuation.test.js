import { test } from "node:test";
import assert from "node:assert/strict";
import { buildContinuation, continuationPlan } from "../src/core/continuation.js";

function response() {
  return {
    content: [
      { type: "thinking", thinking: "reasoning", signature: "sig-1" },
      { type: "provider_block", provider_payload: { trace: [1, 2] } },
      { type: "tool_use", id: "t1", name: "read", input: { path: "/tmp/a" } },
      { type: "tool_use", id: "t2", name: "search", input: { query: "needle" } },
    ],
    id: "response-1",
  };
}

test("continuation preserves provider blocks and assembles ordered messages", () => {
  const request = buildContinuation({
    parentResponse: response(),
    toolResults: [
      { tool_use_id: "t2", content: [{ type: "text", text: "second" }] },
      { tool_use_id: "t1", content: "first", is_error: true },
    ],
    input: "continue with the findings",
  });

  assert.deepEqual(request, {
    messages: [
      { role: "assistant", content: response().content },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "second" }] },
          { type: "tool_result", tool_use_id: "t1", content: "first", is_error: true },
        ],
      },
      { role: "user", content: "continue with the findings" },
    ],
  });
});

test("continuation validates complete, unique tool result batches", () => {
  const cases = [
    {
      name: "missing result",
      results: [{ tool_use_id: "t1", content: "only one" }],
      code: "EINVAL",
    },
    {
      name: "unknown result",
      results: [
        { tool_use_id: "t1", content: "one" },
        { tool_use_id: "other", content: "unknown" },
      ],
      code: "EINVAL",
    },
    {
      name: "duplicate result",
      results: [
        { tool_use_id: "t1", content: "one" },
        { tool_use_id: "t1", content: "again" },
        { tool_use_id: "t2", content: "two" },
      ],
      code: "EEXIST",
    },
    {
      name: "bad result content",
      results: [
        { tool_use_id: "t1", content: { value: "not canonical content" } },
        { tool_use_id: "t2", content: "two" },
      ],
      code: "EINVAL",
    },
  ];

  for (const item of cases) {
    assert.throws(
      () => buildContinuation({ parentResponse: response(), toolResults: item.results }),
      (error) => error.code === item.code,
      item.name,
    );
  }

  assert.throws(
    () => buildContinuation({
      parentResponse: { content: [{ type: "tool_use", id: "t1" }, { type: "tool_use", id: "t1" }] },
      toolResults: [{ tool_use_id: "t1", content: "one" }],
    }),
    (error) => error.code === "EEXIST",
  );
});

test("continuation rejects malformed parent and result shapes", () => {
  assert.throws(() => buildContinuation({ parentResponse: {}, toolResults: [] }), (error) => error.code === "EINVAL");
  assert.throws(() => buildContinuation({ parentResponse: { content: [] }, toolResults: [{}] }), (error) => error.code === "EINVAL");
  assert.throws(() => buildContinuation({ parentResponse: { content: [] }, toolResults: [], input: null }), (error) => error.code === "EINVAL");
  assert.throws(() => buildContinuation({ parentResponse: { content: [{ type: "tool_use" }] }, toolResults: [] }), (error) => error.code === "EINVAL");
});

test("returned request is deeply immutable and detached from caller arrays", () => {
  const parent = response();
  const results = [
    { tool_use_id: "t1", content: [{ type: "text", text: "one" }] },
    { tool_use_id: "t2", content: "two" },
  ];
  const request = buildContinuation({ parentResponse: parent, toolResults: results, input: "next" });

  parent.content[0].thinking = "mutated";
  parent.content.push({ type: "text", text: "caller mutation" });
  results[0].content[0].text = "mutated";
  results.push({ tool_use_id: "t3", content: "caller mutation" });

  assert.equal(request.messages[0].content[0].thinking, "reasoning");
  assert.equal(request.messages[0].content.length, 4);
  assert.equal(request.messages[1].content[0].content[0].text, "one");
  assert.equal(request.messages[1].content.length, 2);
  assert.ok(Object.isFrozen(request));
  assert.ok(Object.isFrozen(request.messages));
  assert.ok(Object.isFrozen(request.messages[0].content));
  assert.ok(Object.isFrozen(request.messages[0].content[0]));
  assert.ok(Object.isFrozen(request.messages[1].content[0].content[0]));
  assert.throws(() => { request.messages[0].content[0].thinking = "nope"; }, TypeError);
});

test("continuationPlan returns frozen workflow metadata with the request", () => {
  const plan = continuationPlan({
    parentInvocation: { id: "inv-0" },
    parentResponse: { content: [{ type: "tool_use", id: "t1", name: "read", input: {} }] },
    toolResults: [{ tool_use_id: "t1", content: "done" }],
    nextAgent: "/agents/reviewer",
    nextInput: "continue",
  });

  assert.deepEqual(plan, {
    parent: { id: "inv-0" },
    agent: "/agents/reviewer",
    input: "continue",
    request: {
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "done" }] },
        { role: "user", content: "continue" },
      ],
    },
  });
  assert.ok(Object.isFrozen(plan));
  assert.ok(Object.isFrozen(plan.request.messages[1].content[0]));
});
