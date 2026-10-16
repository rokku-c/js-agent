function fail(message, code = "EINVAL") {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Make a JSON-shaped copy without retaining references to caller-owned data.
 * Provider responses are JSON data, so rejecting executable or host objects is
 * preferable to silently changing them while materializing a request.
 */
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
    if (prototype !== Object.prototype && prototype !== null) {
      throw fail(`${label} must contain plain objects`);
    }
    for (const symbol of Object.getOwnPropertySymbols(value)) {
      if (Object.prototype.propertyIsEnumerable.call(value, symbol)) {
        throw fail(`${label} contains a symbol property`);
      }
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

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw fail(`${label} must be an object`);
  }
  return value;
}

function id(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw fail(`${label} must be a nonempty string`);
  }
  return value;
}

function blocks(value, label) {
  if (!Array.isArray(value)) throw fail(`${label} must be an array`);
  const output = clone(value, label);
  for (const [index, block] of output.entries()) {
    if (!block || typeof block !== "object" || Array.isArray(block)) {
      throw fail(`${label}[${index}] must be a content block`);
    }
  }
  return output;
}

function resultContent(value, label) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return blocks(value, label);
  throw fail(`${label} must be a string or content block array`);
}

function parentToolUses(content) {
  const ids = new Set();
  for (const [index, block] of content.entries()) {
    if (block.type !== "tool_use") continue;
    const toolUseId = id(block.id, `parentResponse.content[${index}].id`);
    if (ids.has(toolUseId)) throw fail(`duplicate parent tool_use id: ${toolUseId}`, "EEXIST");
    ids.add(toolUseId);
  }
  return ids;
}

/**
 * Assemble a frozen canonical message tail after a tool batch, not a full request.
 * The caller must append these messages to the prior request history and supply
 * the remaining request configuration. Results follow the parent tool-call order.
 * This pure helper neither dispatches a model request nor invokes a tool.
 * JSON clone depth is limited to 64 edges from parentResponse.content or each
 * toolResults entry (the clone root is depth 0); deeper data fails with EINVAL.
 */
export function buildContinuation({ parentResponse, toolResults, input } = {}) {
  object(parentResponse, "parentResponse");
  if (!Array.isArray(parentResponse.content)) throw fail("parentResponse.content must be an array");
  if (!Array.isArray(toolResults)) throw fail("toolResults must be an array");
  if (input !== undefined && typeof input !== "string") throw fail("input must be a string");

  const parentContent = blocks(parentResponse.content, "parentResponse.content");
  const parentIds = parentToolUses(parentContent);
  if (parentIds.size === 0) throw fail("parentResponse must contain at least one tool_use");
  const resultsById = new Map();

  for (const [index, rawResult] of toolResults.entries()) {
    object(rawResult, `toolResults[${index}]`);
    const result = clone(rawResult, `toolResults[${index}]`);
    const toolUseId = id(result.tool_use_id, `toolResults[${index}].tool_use_id`);
    if (resultsById.has(toolUseId)) throw fail(`duplicate tool result id: ${toolUseId}`, "EEXIST");
    if (!parentIds.has(toolUseId)) throw fail(`unknown tool result id: ${toolUseId}`);
    if (!Object.prototype.hasOwnProperty.call(result, "content")) {
      throw fail(`toolResults[${index}].content is required`);
    }
    if (Object.prototype.hasOwnProperty.call(result, "is_error") && typeof result.is_error !== "boolean") {
      throw fail(`toolResults[${index}].is_error must be boolean`);
    }

    const resultBlock = {
      type: "tool_result",
      tool_use_id: toolUseId,
      content: resultContent(result.content, `toolResults[${index}].content`),
    };
    if (result.is_error === true) resultBlock.is_error = true;
    resultsById.set(toolUseId, resultBlock);
  }

  for (const toolUseId of parentIds) {
    if (!resultsById.has(toolUseId)) throw fail(`missing tool result for tool_use id: ${toolUseId}`);
  }

  const resultBlocks = [...parentIds].map((toolUseId) => resultsById.get(toolUseId));
  const messages = [
    { role: "assistant", content: parentContent },
    { role: "user", content: resultBlocks },
  ];
  if (input !== undefined) messages.push({ role: "user", content: input });
  return freeze({ messages });
}
