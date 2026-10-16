import { resolveReference } from "./references.js";

const MAX_INPUT_BYTES = 256 * 1024;
const MAX_PLAN_BYTES = 4 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const ALLOWED_AGENT_FIELDS = new Set(["model", "system", "context", "tools"]);

function fail(message, code = "EINVAL") {
  const e = new Error(message);
  e.code = code;
  return e;
}

function clone(value, label = "value") {
  let serialized;
  try { serialized = JSON.stringify(value); } catch (e) { throw fail(`cannot materialize ${label}: ${e.message}`, "EINVAL"); }
  if (serialized === undefined) throw fail(`cannot materialize ${label}`, "EINVAL");
  try { return JSON.parse(serialized); } catch (e) { throw fail(`cannot materialize ${label}: ${e.message}`, "EINVAL"); }
}

function jsonBytes(value, label, limit) {
  let serialized;
  try { serialized = JSON.stringify(value); } catch (e) { throw fail(`cannot serialize ${label}: ${e.message}`, "EINVAL"); }
  if (serialized === undefined) throw fail(`cannot serialize ${label}`, "EINVAL");
  const size = new TextEncoder().encode(serialized).byteLength;
  if (size > limit) throw fail(`${label} exceeds ${limit} bytes`, "EFBIG");
}

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

function bytes(value) { return new TextEncoder().encode(String(value)).byteLength; }

function absolute(value, label) {
  if (typeof value !== "string" || !value.startsWith("/") || value.includes("//") || value.split("/").includes("..")) {
    throw fail(`${label} must be an absolute path`, "EINVAL");
  }
  return value;
}

function text(value, label) {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try { return JSON.stringify(value); } catch { throw fail(`${label} is not representable as text`, "EINVAL"); }
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const e = signal.reason instanceof Error ? signal.reason : fail("invocation cancelled", "ABORT_ERR");
  if (!e.code) e.code = "ABORT_ERR";
  throw e;
}

function adapterAt(adapters, path, kind) {
  const found = (adapters ?? []).filter((x) => x?.path === path);
  if (found.length !== 1) throw fail(`${kind} is not an exact supplied trusted adapter: ${path}`, "EACCES");
  return found[0];
}

async function resolved(resources, ref, label, signal) {
  try {
    return await resolveReference(resources, ref, { maxBytes: MAX_PLAN_BYTES, signal });
  } catch (e) {
    e.message = `${label}: ${e.message}`;
    throw e;
  }
}

function agentFields(agent) {
  if (!agent || typeof agent !== "object" || Array.isArray(agent)) throw fail("AgentSpec must be an object", "EINVAL");
  for (const key of Object.keys(agent)) {
    if (!ALLOWED_AGENT_FIELDS.has(key)) throw fail(`unsupported AgentSpec field: ${key}`, "ENOTSUP");
  }
  return agent;
}

function references(value, label) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw fail(`${label} must be an array`, "EINVAL");
  return value.map((ref, i) => {
    const copy = clone(ref, `${label}[${i}]`);
    if (typeof copy !== "string" && (!copy || typeof copy !== "object" || typeof copy.$ref !== "string")) {
      throw fail(`${label}[${i}] must be a reference`, "EINVAL");
    }
    absolute(typeof copy === "string" ? copy : copy.$ref, `${label}[${i}]`);
    return copy;
  });
}

function recordAdmissionFailure(store, run, e) {
  return store.fail(run.id, "failed", e).catch(() => undefined);
}

/**
 * Execute exactly one trusted model request. Tool calls are returned for the caller's
 * workflow; this function never executes tools or starts another model turn.
 *
 * @returns {Promise<{id:string,path:string,status:string,response:any,toolCalls?:any[]}>}
 */
export async function invokeOnce({ resources, agent, input, model, tools = [], store, signal, id } = {}) {
  if (!store || typeof store.reserve !== "function") throw fail("invokeOnce requires a RunStore", "EINVAL");
  if (!model || typeof model.request !== "function") throw fail("model must be a trusted host adapter", "EINVAL");
  if (typeof input !== "string") throw fail("input must be a string", "EINVAL");
  if (bytes(input) > MAX_INPUT_BYTES) throw fail(`input exceeds ${MAX_INPUT_BYTES} bytes`, "EFBIG");
  if (!Array.isArray(tools)) throw fail("tools must be an array", "EINVAL");

  // Bind and clone synchronously. Resource resolution yields, so callers must not be able
  // to change the adapter method, AgentSpec, or tool catalog underneath a materialization.
  const modelRequest = model.request.bind(model);
  const modelPathAtEntry = model.path;
  const agentSnapshot = typeof agent === "string" ? agent : clone(agent ?? { model: "/models/default" }, "agent");
  const toolCatalog = clone(tools, "tool catalog");
  const admissionRequest = freeze(clone({ system: "", messages: [{ role: "user", content: input }], tools: [] }, "admission request"));
  const admissionPlan = clone({
    admission: true,
    input,
    agent: typeof agentSnapshot === "string" ? { ref: agentSnapshot } : { value: agentSnapshot },
    model: { path: modelPathAtEntry },
    tools: toolCatalog.map((tool) => ({ path: tool?.path, name: tool?.name })),
  }, "admission plan");
  jsonBytes(admissionPlan, "plan", MAX_PLAN_BYTES);

  let reservation;
  try {
    // Reserve before any reference read, so a missing/invalid resource is an observable
    // admission failure with a run directory and status rather than an untracked throw.
    reservation = await store.reserve(id, { request: admissionRequest, plan: admissionPlan });
  } catch (e) {
    throw e;
  }
  const run = { id: reservation.id, path: reservation.path };

  let agentValue;
  let agentProvenance = null;
  let request;
  let plan;
  try {
    if (typeof agentSnapshot === "string") {
      absolute(agentSnapshot, "agent reference");
      const r = await resolved(resources, agentSnapshot, "agent", signal);
      agentProvenance = r.provenance;
      if (typeof r.value === "string") {
        try { agentValue = JSON.parse(r.value); } catch (e) { throw fail(`agent reference is not valid JSON: ${e.message}`, "EINVAL"); }
      } else agentValue = r.value;
    } else agentValue = agentSnapshot;

    const spec = agentFields(clone(agentValue, "AgentSpec"));
    const modelPath = absolute(spec.model ?? "/models/default", "agent model");
    adapterAt([{ path: modelPathAtEntry, request: modelRequest }], modelPath, "model");
    const systemRefs = references(spec.system, "system");
    const contextRefs = references(spec.context, "context");
    const toolPaths = spec.tools == null ? [] : clone(spec.tools, "agent tools");
    if (!Array.isArray(toolPaths)) throw fail("agent tools must be an array", "EINVAL");
    const selected = toolPaths.map((path, i) => {
      absolute(path, `agent tools[${i}]`);
      return adapterAt(toolCatalog, path, "tool");
    });
    const names = new Set();
    for (const tool of selected) {
      if (typeof tool.name !== "string" || !tool.name) throw fail(`tool ${tool.path} has no name`, "EINVAL");
      if (names.has(tool.name)) throw fail(`duplicate selected tool name: ${tool.name}`, "EEXIST");
      names.add(tool.name);
    }

    const system = [];
    const context = [];
    for (const [i, ref] of systemRefs.entries()) {
      const r = await resolved(resources, ref, `system[${i}]`, signal);
      system.push({ ref: clone(ref), value: text(r.value, `system[${i}]`), provenance: clone(r.provenance) });
    }
    for (const [i, ref] of contextRefs.entries()) {
      const r = await resolved(resources, ref, `context[${i}]`, signal);
      context.push({ ref: clone(ref), value: text(r.value, `context[${i}]`), provenance: clone(r.provenance) });
    }

    const systemText = system.map((x) => `[system ${referenceName(x.ref)}]\n${x.value}`).join("\n\n");
    const contextText = context.map((x) => `[context ${referenceName(x.ref)}]\n${x.value}`).join("\n\n");
    const definitions = selected.map((tool) => ({
      name: tool.name,
      description: String(tool.description ?? ""),
      input_schema: clone(tool.input_schema ?? {}, `tool ${tool.name} schema`),
    }));
    request = freeze(clone({
      system: systemText,
      messages: [{ role: "user", content: contextText ? `${input}\n\n${contextText}` : input }],
      tools: definitions,
    }, "request"));
    plan = freeze(clone({
      agent: typeof agentSnapshot === "string" ? { ref: agentSnapshot, provenance: clone(agentProvenance) } : { value: clone(spec) },
      input,
      model: { path: modelPath },
      system,
      context,
      tools: selected.map((tool) => ({ path: tool.path, name: tool.name, description: String(tool.description ?? ""), input_schema: clone(tool.input_schema ?? {}) })),
      request,
    }, "plan"));
    jsonBytes(plan, "plan", MAX_PLAN_BYTES);

    // Keep the exact trusted adapter method captured at entry; selection is checked against
    // the captured path and cannot be changed during the awaited reference reads.
    await store.materialize(run.id, { request, plan });
  } catch (e) {
    await recordAdmissionFailure(store, run, e);
    throw e;
  }

  try {
    throwIfAborted(signal);
  } catch (e) {
    await store.fail(run.id, "cancelled", e).catch(() => undefined);
    return { ...run, status: "cancelled", response: null };
  }
  try {
    await store.start(run.id);
  } catch (e) {
    // A failed start journal is a storage failure. No model request is dispatched.
    await store.fail(run.id, "failed", e).catch(() => undefined);
    throw e;
  }
  try {
    throwIfAborted(signal);
  } catch (e) {
    await store.fail(run.id, "cancelled", e).catch(() => undefined);
    return { ...run, status: "cancelled", response: null };
  }

  let response;
  try {
    response = await modelRequest(request, { signal });
  } catch (e) {
    await store.fail(run.id, signal?.aborted ? "unknown" : "unknown", e).catch(() => undefined);
    throw e;
  }

  let storedResponse;
  try {
    storedResponse = clone(response, "response");
    if (!storedResponse || typeof storedResponse !== "object" || Array.isArray(storedResponse) || !Array.isArray(storedResponse.content)) {
      throw fail("model response must be an object with a content array", "EPROTO");
    }
    jsonBytes(storedResponse, "response", MAX_RESPONSE_BYTES);
  } catch (e) {
    await store.fail(run.id, "unknown", e).catch(() => undefined);
    throw e;
  }
  if (signal?.aborted) {
    const e = signal.reason instanceof Error ? signal.reason : fail("invocation cancelled after dispatch", "ABORT_ERR");
    await store.fail(run.id, "unknown", e).catch(() => undefined);
    throw e;
  }

  const toolCalls = storedResponse.content.filter((part) => part?.type === "tool_use").map((part) => clone(part, "tool call"));
  try {
    await store.finish(run.id, storedResponse, toolCalls.length ? toolCalls : undefined);
  } catch (e) {
    await store.fail(run.id, "unknown", e).catch(() => undefined);
    throw e;
  }
  return { ...run, status: "completed", response: storedResponse, ...(toolCalls.length ? { toolCalls } : {}) };
}

function referenceName(ref) {
  return typeof ref === "string" ? ref : ref?.$ref ?? "reference";
}
