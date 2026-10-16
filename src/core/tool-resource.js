// Resource-backed tool definitions.
//
// This module deliberately stops at metadata. An `entry` field is descriptive only; this
// loader never reads, imports, evaluates, or otherwise executes entry.js. A host that wants
// a callable descriptor must provide an explicit trusted adapter map to loadToolResource.

import { normalize } from "../kernel/paths.js";
import { VfsError } from "../kernel/errors.js";

const DEFAULT_MAX_BYTES = 1024 * 1024;
const TOOL_NAME = /^[a-z][a-z0-9_-]*$/u;
const DEFINITION_FIELDS = new Set(["name", "description", "input_schema", "entry"]);
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function fail(detail, code = "EINVAL", path = null) {
  throw new VfsError(code, detail, path ? { path } : undefined);
}

function checkSignal(signal) {
  if (!signal?.aborted) return;
  throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function validateMaxBytes(maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    fail("maxBytes must be a non-negative safe integer");
  }
}

function toolPath(path) {
  if (typeof path !== "string" || !path.startsWith("/")) {
    fail("tool path must be an absolute path");
  }

  const normalized = normalize(path);
  const parts = normalized === "/" ? [] : normalized.slice(1).split("/");
  if (parts.length !== 2 || parts[0] !== "tools" || !TOOL_NAME.test(parts[1])) {
    fail("tool path must be a /tools/<name> directory", "EINVAL", normalized);
  }
  return normalized;
}

function readOptions({ view, revision, maxBytes, signal }) {
  const options = { encoding: "utf8", maxBytes, signal };
  if (view !== undefined) options.view = view;
  if (revision !== undefined) options.revision = revision;
  return options;
}

function statOptions({ view, signal }) {
  const options = { signal };
  if (view !== undefined) options.view = view;
  return options;
}

function toText(raw, path, maxBytes) {
  let bytes;
  let text;

  if (typeof raw === "string") {
    text = raw;
    bytes = encoder.encode(raw);
  } else if (raw instanceof Uint8Array) {
    bytes = new Uint8Array(raw);
    try {
      text = decoder.decode(bytes);
    } catch (cause) {
      fail("definition.json is not valid UTF-8", "EINVAL", path);
    }
  } else if (raw instanceof ArrayBuffer) {
    bytes = new Uint8Array(raw);
    try {
      text = decoder.decode(bytes);
    } catch (cause) {
      fail("definition.json is not valid UTF-8", "EINVAL", path);
    }
  } else if (ArrayBuffer.isView(raw)) {
    bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    try {
      text = decoder.decode(bytes);
    } catch (cause) {
      fail("definition.json is not valid UTF-8", "EINVAL", path);
    }
  } else {
    fail("definition.json must be UTF-8 text or bytes", "EINVAL", path);
  }

  if (bytes.byteLength > maxBytes) {
    fail(`definition.json is ${bytes.byteLength} bytes, over the ${maxBytes} limit`, "EOVERFLOW", path);
  }
  return text;
}

function plainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail(`${label} must be an object`);
  }
  return value;
}

function validateSchema(schema, label = "input_schema", root = true) {
  plainObject(schema, label);
  if (root && schema.type !== "object") fail("input_schema.type must be 'object'");
  if (!root && schema.type !== undefined &&
      (typeof schema.type !== "string" &&
       (!Array.isArray(schema.type) || schema.type.some((type) => typeof type !== "string")))) {
    fail(`${label}.type must be a string or an array of strings`);
  }
  if (schema.properties !== undefined) {
    plainObject(schema.properties, `${label}.properties`);
    for (const [name, property] of Object.entries(schema.properties)) {
      validateSchema(property, `${label}.properties.${name}`, false);
    }
  }
  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required) || schema.required.some((name) => typeof name !== "string")) {
      fail(`${label}.required must be an array of strings`);
    }
    if (new Set(schema.required).size !== schema.required.length) {
      fail(`${label}.required must not contain duplicate names`);
    }
  }
  if (schema.additionalProperties !== undefined &&
      typeof schema.additionalProperties !== "boolean") {
    validateSchema(schema.additionalProperties, `${label}.additionalProperties`, false);
  }
  if (schema.items !== undefined) {
    if (Array.isArray(schema.items)) {
      schema.items.forEach((item, index) => validateSchema(item, `${label}.items[${index}]`, false));
    } else {
      validateSchema(schema.items, `${label}.items`, false);
    }
  }
  return schema;
}

function validateDefinition(value, path) {
  plainObject(value, "tool definition");
  for (const key of Object.keys(value)) {
    if (!DEFINITION_FIELDS.has(key)) fail(`unknown tool definition field '${key}'`, "EINVAL", path);
  }

  if (typeof value.name !== "string" || !TOOL_NAME.test(value.name)) {
    fail("tool definition name must match [a-z][a-z0-9_-]*", "EINVAL", path);
  }
  if (typeof value.description !== "string" || value.description.trim() === "") {
    fail("tool definition description must be a non-empty string", "EINVAL", path);
  }
  validateSchema(value.input_schema);
  if (value.entry !== undefined) {
    if (typeof value.entry !== "string" || value.entry.length === 0 || value.entry.startsWith("/") ||
        value.entry.split("/").some((part) => part === ".." || part === "")) {
      fail("tool definition entry must be a non-empty relative path", "EINVAL", path);
    }
  }
  return value;
}

function deepFreeze(value, seen = new Set()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function parseDefinition(text, definitionPath) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    fail("definition.json is not valid JSON", "EINVAL", definitionPath);
  }
  return validateDefinition(value, definitionPath);
}

async function definitionParts(resources, path, options) {
  if (!resources || typeof resources.read !== "function") {
    fail("resources must provide read(path, options)");
  }
  const base = toolPath(path);
  const definitionPath = `${base}/definition.json`;
  const { maxBytes = DEFAULT_MAX_BYTES, signal } = options;
  validateMaxBytes(maxBytes);
  checkSignal(signal);

  const raw = await resources.read(definitionPath, readOptions({ ...options, maxBytes }));
  checkSignal(signal);
  const definition = parseDefinition(toText(raw, definitionPath, maxBytes), definitionPath);

  let stat;
  if (typeof resources.stat === "function") {
    stat = await resources.stat(base, statOptions(options));
    checkSignal(signal);
  }

  const actualRevision = stat?.revision;
  if (actualRevision !== undefined && typeof actualRevision !== "string") {
    fail("tool resource revision must be a string", "EINVAL", base);
  }
  if (options.revision !== undefined && typeof options.revision !== "string") {
    fail("revision must be a string");
  }
  if (options.revision !== undefined && actualRevision !== undefined && options.revision !== actualRevision) {
    fail(`tool resource revision mismatch: expected ${options.revision}, got ${actualRevision}`, "ESTALE", base);
  }

  return {
    base,
    definitionPath,
    definition,
    revision: actualRevision ?? options.revision,
  };
}

function definitionDescriptor(parts) {
  const { base, definition, revision } = parts;
  const descriptor = {
    path: base,
    name: definition.name,
    description: definition.description,
    input_schema: definition.input_schema,
    revision,
  };
  if (definition.entry !== undefined) descriptor.entry = definition.entry;
  return deepFreeze(descriptor);
}

/**
 * Load and validate the metadata for one resource-backed tool.
 *
 * `entry` is retained as metadata, but is never read or executed.
 * @param {{read(path: string, options?: object): Promise<string|Uint8Array|ArrayBuffer>}} resources
 * @param {string} path absolute `/tools/<name>` directory path
 * @param {{view?: unknown, revision?: string, maxBytes?: number, signal?: AbortSignal}} options
 */
export async function loadToolDefinition(resources, path, options = {}) {
  return definitionDescriptor(await definitionParts(resources, path, options));
}

function adapterFrom(map, descriptor) {
  if (map == null) return undefined;
  if (map instanceof Map) return map.get(descriptor.name) ?? map.get(descriptor.path);
  if (typeof map !== "object") fail("trusted invoke adapters must be an object or Map");
  if (Object.hasOwn(map, descriptor.name)) return map[descriptor.name];
  if (Object.hasOwn(map, descriptor.path)) return map[descriptor.path];
  return undefined;
}

/**
 * Load a definition and, only when explicitly supplied, bind a trusted invoke adapter.
 * No adapter means `invoke` is undefined. The definition's entrypoint is never executed.
 *
 * `invokeAdapters` is intentionally an option rather than a property read from the
 * resource tree. Resource content cannot grant itself executable behavior.
 */
export async function loadToolResource(resources, path, options = {}) {
  const definition = await loadToolDefinition(resources, path, options);
  const { entry: _entry, ...metadata } = definition;
  const adapter = adapterFrom(options.invokeAdapters, metadata);
  if (adapter !== undefined && typeof adapter !== "function") {
    fail(`trusted invoke adapter for '${metadata.name}' must be a function`);
  }
  if (adapter === undefined) return deepFreeze({ ...metadata, invoke: undefined });

  const invoke = (input, invokeOptions = {}) => adapter(input, {
    ...invokeOptions,
    path: metadata.path,
    revision: metadata.revision,
    view: invokeOptions.view ?? options.view,
    signal: invokeOptions.signal ?? options.signal,
  });
  return deepFreeze({ ...metadata, invoke });
}

/**
 * Resolve an explicit list of tool directories. There is no directory discovery here.
 * The returned array and each descriptor are immutable.
 */
export async function toolCatalog(resources, paths, options = {}) {
  if (!Array.isArray(paths)) fail("tool catalog paths must be an array");
  const catalog = [];
  const names = new Map();
  for (const path of paths) {
    const definition = await loadToolDefinition(resources, path, options);
    const prior = names.get(definition.name);
    if (prior !== undefined) {
      fail(`duplicate tool name '${definition.name}'`, "EEXIST", definition.path);
    }
    names.set(definition.name, definition.path);
    catalog.push(definition);
  }
  return Object.freeze(catalog);
}
