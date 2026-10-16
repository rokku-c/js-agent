import { invokeOnce } from "./invocation.js";
import { continueOnce } from "./workflow.js";

function fail(message, code = "EINVAL") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw fail(`${label} must be an object`);
  return value;
}

function abortError(signal) {
  if (!signal?.aborted) return null;
  const error = signal.reason instanceof Error
    ? signal.reason
    : fail("workflow cancelled", "ABORT_ERR");
  if (!error.code) error.code = "ABORT_ERR";
  return error;
}

function throwIfAborted(signal) {
  const error = abortError(signal);
  if (error) throw error;
}

function toolContent(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value;
  if (value === undefined) return "(no output)";
  try { return JSON.stringify(value); } catch (error) { return String(value); }
}

function errorText(error) {
  return `${error?.name ?? "Error"}: ${error?.message ?? String(error)}`;
}

function adapterFor(adapters, name) {
  if (adapters instanceof Map) return adapters.get(name);
  return adapters?.[name];
}

async function executeOne(toolCall, adapters, { signal, trace, runId } = {}) {
  const toolUseId = toolCall?.id;
  const name = toolCall?.name;
  if (typeof toolUseId !== "string" || toolUseId.length === 0) {
    throw fail("model tool call is missing a nonempty id", "EPROTO");
  }
  if (typeof name !== "string" || name.length === 0) {
    throw fail(`tool call ${toolUseId} is missing a name`, "EPROTO");
  }

  const adapter = adapterFor(adapters, name);
  const started = Date.now();
  trace?.push({ event: "tool_started", runId, toolUseId, name });
  try {
    throwIfAborted(signal);
    if (typeof adapter !== "function") {
      throw fail(`no trusted adapter supplied for tool ${name}`, "ENOENT");
    }
    const value = await adapter({
      input: toolCall.input ?? {},
      signal,
      toolCall,
      runId,
    });
    throwIfAborted(signal);
    trace?.push({ event: "tool_finished", runId, toolUseId, name, ok: true, ms: Date.now() - started });
    return { tool_use_id: toolUseId, content: toolContent(value) };
  } catch (error) {
    if (signal?.aborted || error?.code === "ABORT_ERR" || error?.name === "AbortError") throw error;
    trace?.push({ event: "tool_finished", runId, toolUseId, name, ok: false, ms: Date.now() - started, error: errorText(error) });
    return { tool_use_id: toolUseId, content: errorText(error), is_error: true };
  }
}

/**
 * Execute one model response's independent tool calls concurrently.
 * The returned array is always in the response's original tool-call order.
 * Tool adapters are trusted host functions; this module does not import or evaluate code
 * supplied by the model or by a resource.
 */
export async function executeToolCalls(toolCalls, adapters, options = {}) {
  if (!Array.isArray(toolCalls)) throw fail("toolCalls must be an array");
  object(adapters, "tool adapters");
  const { signal, trace, runId } = options;
  const settled = await Promise.allSettled(
    toolCalls.map((toolCall) => executeOne(toolCall, adapters, { signal, trace, runId })),
  );
  const cancellation = abortError(signal) ?? settled.find((item) => item.status === "rejected" && (
    item.reason?.code === "ABORT_ERR" || item.reason?.name === "AbortError"
  ))?.reason;
  if (cancellation) {
    if (!cancellation.code) cancellation.code = "ABORT_ERR";
    throw cancellation;
  }
  return settled.map((item, index) => {
    if (item.status === "fulfilled") return item.value;
    const toolUseId = toolCalls[index]?.id;
    if (typeof toolUseId !== "string" || toolUseId.length === 0) throw item.reason;
    return { tool_use_id: toolUseId, content: errorText(item.reason), is_error: true };
  });
}

async function readJson(storage, path) {
  if (!storage || typeof storage.read !== "function") throw fail("workflow harness requires storage.read", "EINVAL");
  return JSON.parse(await storage.read(path));
}

/**
 * Inspect one invocation's persisted state. This deliberately reads the same files a UI or
 * another host observer would read, instead of reaching into RunStore's private maps.
 */
export async function inspectInvocation(storage, pathOrId, { root = "/runs" } = {}) {
  const path = pathOrId.startsWith("/") ? pathOrId : `${root}/${pathOrId}`;
  const [request, plan, response, status, eventsText] = await Promise.all([
    readJson(storage, `${path}/request.json`),
    readJson(storage, `${path}/plan.json`),
    storage.read(`${path}/response.json`).then(JSON.parse).catch(() => null),
    readJson(storage, `${path}/status.json`),
    storage.read(`${path}/events.jsonl`),
  ]);
  const events = eventsText.trim() === "" ? [] : eventsText.trim().split("\n").map(JSON.parse);
  return { id: path.slice(path.lastIndexOf("/") + 1), path, status, request, plan, response, events };
}

/**
 * Run the concrete two-phase workflow owned by this module:
 * invoke once, execute its returned tool calls, then dispatch exactly one continuation.
 */
export async function runWorkflow({
  storage,
  resources,
  agent,
  input,
  model,
  tools = [],
  store,
  toolAdapters,
  signal,
  id,
  continuationId,
  continuationInput,
  trace = [],
} = {}) {
  object(store, "store");
  object(toolAdapters, "tool adapters");
  const root = await invokeOnce({ resources, agent, input, model, tools, store, signal, id });
  if (root.status !== "completed_with_tool_calls") {
    return { status: root.status, root, toolResults: [], continuation: null, trace };
  }

  try {
    throwIfAborted(signal);
    const toolResults = await executeToolCalls(root.toolCalls, toolAdapters, {
      signal,
      trace,
      runId: root.id,
    });
    throwIfAborted(signal);

    const storedRequest = await readJson(storage, `${root.path}/request.json`);
    const parent = {
      ...root,
      // invokeOnce persists the request and response as separate snapshots. The workflow
      // owner joins them into the provider transcript required by continueOnce.
      request: {
        ...storedRequest,
        messages: [
          ...storedRequest.messages,
          { role: "assistant", content: root.response.content },
        ],
      },
    };
    const continuation = await continueOnce({
      parent,
      parentResponse: root.response,
      toolResults,
      agent,
      model,
      tools,
      store,
      signal,
      id: continuationId,
      input: continuationInput,
    });
    return { status: continuation.status, root, toolResults, continuation, trace };
  } catch (error) {
    if (signal?.aborted || error?.code === "ABORT_ERR" || error?.name === "AbortError") {
      return { status: "cancelled", root, toolResults: [], continuation: null, trace };
    }
    throw error;
  }
}
