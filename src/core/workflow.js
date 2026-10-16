import { buildContinuation } from "./continuation.js";

const MAX_PLAN_BYTES = 4 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

function fail(message, code = "EINVAL") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function clone(value, label = "value", seen = new WeakSet(), depth = 0) {
  if (depth > 64) throw fail(`${label} exceeds clone depth 64`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw fail(`${label} contains a non-finite number`);
    return value;
  }
  if (value === undefined || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
    throw fail(`${label} is not JSON materializable`);
  }
  if (seen.has(value)) throw fail(`${label} contains a cycle`);
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item, index) => clone(item, `${label}[${index}]`, seen, depth + 1));
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw fail(`${label} must contain plain objects`);
    for (const symbol of Object.getOwnPropertySymbols(value)) {
      if (Object.prototype.propertyIsEnumerable.call(value, symbol)) throw fail(`${label} contains a symbol property`);
    }
    const output = {};
    for (const key of Object.keys(value)) {
      Object.defineProperty(output, key, {
        value: clone(value[key], `${label}.${key}`, seen, depth + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return output;
  } catch (error) {
    if (error?.code) throw error;
    throw fail(`cannot materialize ${label}: ${error.message}`);
  } finally {
    seen.delete(value);
  }
}

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

function jsonBytes(value, label, limit) {
  let serialized;
  try { serialized = JSON.stringify(value); } catch (error) { throw fail(`cannot serialize ${label}: ${error.message}`, "EINVAL"); }
  if (serialized === undefined) throw fail(`cannot serialize ${label}`, "EINVAL");
  if (new TextEncoder().encode(serialized).byteLength > limit) throw fail(`${label} exceeds ${limit} bytes`, "EFBIG");
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw fail(`${label} must be an object`);
  return value;
}

function nonempty(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw fail(`${label} must be a nonempty string`);
  return value;
}

function same(a, b, label) {
  let left;
  let right;
  try {
    left = JSON.stringify(a);
    right = JSON.stringify(b);
  } catch (error) {
    throw fail(`cannot compare ${label}: ${error.message}`);
  }
  if (left !== right) throw fail(`${label} does not match`, "EINVAL");
}

function throwIfAborted(signal, afterDispatch = false) {
  if (!signal?.aborted) return;
  const error = signal.reason instanceof Error
    ? signal.reason
    : fail(afterDispatch ? "invocation cancelled after dispatch" : "invocation cancelled", "ABORT_ERR");
  if (!error.code) error.code = "ABORT_ERR";
  throw error;
}

function requestFrom(parent) {
  object(parent, "parent");
  const request = parent.request ?? parent.plan?.request;
  if (request === undefined) throw fail("parent.request or parent.plan.request is required");
  object(request, "parent request");
  if (!Object.prototype.hasOwnProperty.call(request, "system")) throw fail("parent request.system is required");
  if (!Array.isArray(request.messages)) throw fail("parent request.messages must be an array");
  if (!Array.isArray(request.tools)) throw fail("parent request.tools must be an array");
  return request;
}

function validateParentResponse(request, parentResponse) {
  object(parentResponse, "parentResponse");
  if (!Array.isArray(parentResponse.content)) throw fail("parentResponse.content must be an array");
  const last = request.messages.at(-1);
  if (!last || typeof last !== "object" || last.role !== "assistant" || !Array.isArray(last.content)) {
    throw fail("parent request must end with an assistant tool-use message");
  }
  same(last.content, parentResponse.content, "parentResponse.content");
  if (!parentResponse.content.some((part) => part?.type === "tool_use")) {
    throw fail("parent response must contain a tool_use");
  }
}

function linkage(parent, parentResponse) {
  object(parentResponse, "parentResponse");
  const parentId = parent.id ?? parent.runId ?? parent.run?.id;
  nonempty(parentId, "parent.id");
  const result = { id: parentId };
  if (parent.path !== undefined) result.path = nonempty(parent.path, "parent.path");
  if (parentResponse.id !== undefined) result.responseId = nonempty(parentResponse.id, "parentResponse.id");
  return result;
}

function planTools(tools) {
  if (!Array.isArray(tools)) throw fail("tools must be an array");
  return tools.map((tool, index) => {
    object(tool, `tools[${index}]`);
    const result = {};
    if (tool.path !== undefined) result.path = clone(tool.path, `tools[${index}].path`);
    if (tool.name !== undefined) result.name = clone(tool.name, `tools[${index}].name`);
    return result;
  });
}

/**
 * Assemble a continuation request from a prior canonical request and a builder tail.
 * The returned request is detached from, and deeply immutable to, all caller data.
 */
export function assembleContinuationRequest({ parent, parentResponse, toolResults, input } = {}) {
  const source = requestFrom(parent);
  const parentRequest = clone(source, "parent request");
  validateParentResponse(parentRequest, parentResponse);
  const tail = buildContinuation({ parentResponse, toolResults, ...(input === undefined ? {} : { input }) });
  // The parent request is validated as the transcript through the assistant tool-use
  // response. buildContinuation also returns that response as a standalone tail for its
  // pure callers, so avoid duplicating it when assembling a full continuation request.
  const request = clone({
    ...parentRequest,
    messages: [...parentRequest.messages, ...tail.messages.slice(1)],
  }, "continuation request");
  return freeze(request);
}

function modelResponse(response) {
  const stored = clone(response, "response");
  if (!stored || typeof stored !== "object" || Array.isArray(stored) || !Array.isArray(stored.content)) {
    throw fail("model response must be an object with a content array", "EPROTO");
  }
  jsonBytes(stored, "response", MAX_RESPONSE_BYTES);
  return stored;
}

async function failRun(store, id, state, cause) {
  try { await store.fail(id, state, cause); } catch { /* preserve the dispatch error */ }
}

/**
 * Dispatch exactly one explicit continuation. Tool results are already supplied by the
 * workflow owner; this function never resolves or executes tools and never starts a loop.
 */
export async function continueOnce({
  resources,
  parent,
  parentResponse,
  toolResults,
  agent,
  model,
  tools = [],
  store,
  signal,
  id,
  input,
} = {}) {
  // `resources` is intentionally unused: a continuation receives a materialized request.
  void resources;
  if (!store || typeof store.reserve !== "function") throw fail("continueOnce requires a RunStore", "EINVAL");
  if (!model || typeof model.request !== "function") throw fail("model must be a trusted host adapter", "EINVAL");
  object(agent, "agent");
  const modelPath = nonempty(model.path, "model.path");
  if (agent.model !== modelPath) throw fail("agent.model must exactly match model.path", "EACCES");
  if (input !== undefined && typeof input !== "string") throw fail("input must be a string");

  const parentLink = linkage(parent, parentResponse);
  const request = assembleContinuationRequest({ parent, parentResponse, toolResults, input });
  const toolPlan = planTools(tools);
  const agentPlan = clone(agent, "agent");
  const plan = freeze(clone({
    continuation: {
      parent: parentLink,
      parentResponseId: parentLink.responseId ?? null,
      inputSupplied: input !== undefined,
    },
    parent: parentLink,
    agent: { value: agentPlan },
    model: { path: modelPath },
    tools: toolPlan,
    request,
  }, "plan"));
  jsonBytes(plan, "plan", MAX_PLAN_BYTES);

  // Capture the exact adapter method before any asynchronous store operation.
  const modelRequest = model.request.bind(model);
  const reservation = await store.reserve(id, { request, plan });
  const run = { id: reservation.id, path: reservation.path };

  try {
    throwIfAborted(signal);
  } catch (error) {
    await failRun(store, run.id, "cancelled", error);
    return { ...run, status: "cancelled", response: null };
  }

  try {
    await store.start(run.id);
  } catch (error) {
    await failRun(store, run.id, "failed", error);
    throw error;
  }

  try {
    throwIfAborted(signal);
  } catch (error) {
    await failRun(store, run.id, "cancelled", error);
    return { ...run, status: "cancelled", response: null };
  }

  let response;
  try {
    response = await modelRequest(request, { signal });
  } catch (error) {
    await failRun(store, run.id, "unknown", error);
    throw error;
  }

  let storedResponse;
  try {
    storedResponse = modelResponse(response);
    throwIfAborted(signal, true);
  } catch (error) {
    await failRun(store, run.id, "unknown", error);
    throw error;
  }

  const toolCalls = storedResponse.content
    .filter((part) => part?.type === "tool_use")
    .map((part) => clone(part, "tool call"));
  try {
    const finished = await store.finish(run.id, storedResponse, toolCalls.length ? toolCalls : undefined);
    return {
      ...run,
      status: finished.status,
      response: storedResponse,
      ...(toolCalls.length ? { toolCalls } : {}),
    };
  } catch (error) {
    await failRun(store, run.id, "unknown", error);
    throw error;
  }
}
