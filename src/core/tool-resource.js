// Resource-backed tool metadata. Entry sources are read only through explicit binding.
import { normalize } from "../kernel/paths.js";
import { VfsError } from "../kernel/errors.js";
import { resolveReference } from "./references.js";

const DEFAULT_MAX_BYTES = 1024 * 1024;
const TOOL_NAME = /^[a-z][a-z0-9_-]*$/u;
const DEFINITION_FIELDS = new Set(["name", "description", "input_schema", "entry"]);

function fail(detail, code = "EINVAL", path = null) {
  throw new VfsError(code, detail, path ? { path } : undefined);
}

function toolPath(path) {
  if (typeof path !== "string" || !path.startsWith("/")) {
    fail("tool path must be an absolute path");
  }
  return normalize(path);
}

function snapshotOptions({ revision, maxBytes = DEFAULT_MAX_BYTES, signal } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    fail("maxBytes must be a non-negative safe integer");
  }
  if (revision !== undefined &&
      (typeof revision !== "string" || !/^sha256:[0-9a-f]{64}$/.test(revision))) {
    fail("revision must be a sha256:<hex> full-content revision");
  }
  return { revision, maxBytes, signal };
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

async function loadDefinition(resources, path, { revision, maxBytes, signal }) {
  const definitionPath = `${path === "/" ? "" : path}/definition.json`;
  const ref = revision === undefined
    ? definitionPath
    : { $ref: definitionPath, mode: "pinned", revision };
  const { value, provenance } = await resolveReference(resources, ref, { maxBytes, signal });
  const definition = parseDefinition(value, definitionPath);
  return deepFreeze({ path, ...definition, revision: provenance.contentHash });
}

/**
 * Read exactly definition.json under an absolute tool directory through the supplied
 * resource facade. The returned revision is always the SHA-256 hash of those bytes.
 * An optional revision asserts that hash; it does not retrieve historical content.
 * Entry metadata is retained without reading or executing the entrypoint.
 *
 * @param {{read(path: string, options?: object): Promise<string|Uint8Array|ArrayBuffer>}} resources
 * @param {string} path absolute tool directory, in any mount
 * @param {{revision?: string, maxBytes?: number, signal?: AbortSignal}} options
 */
export async function loadToolDefinition(resources, path, options = {}) {
  const base = toolPath(path);
  const snapshot = snapshotOptions(options);
  return loadDefinition(resources, base, snapshot);
}

async function bindLoadedDefinition(resources, definition, { loader, maxBytes, signal }) {
  if (definition.entry === undefined) {
    fail(`tool definition at ${definition.path} does not declare an entry`, "EINVAL", definition.path);
  }
  const entryPath = `${definition.path === "/" ? "" : definition.path}/${definition.entry}`;
  const { value: source, provenance } = await resolveReference(resources, entryPath, { maxBytes, signal });
  const implementation = await loader({
    source,
    path: definition.path,
    entryPath,
    definition,
    revision: provenance.contentHash,
  });
  if (typeof implementation !== "function") {
    fail("tool resource loader must return a function", "EINVAL", entryPath);
  }

  // The implementation is deliberately called through the trusted adapter shape used by
  // Environment and WorkflowGraph. Resource source never gets evaluated by this module;
  // the explicit loader above owns that decision and any isolation policy.
  return Object.freeze({
    path: definition.path,
    definition,
    entryPath,
    entryRevision: provenance.contentHash,
    async invoke(options = {}) {
      return implementation({
        ...options,
        path: definition.path,
        entryPath,
        definition,
        resources,
      });
    },
  });
}

/**
 * Explicitly bind a resource-defined tool to a trusted host loader.
 *
 * `loadToolDefinition()` remains metadata-only. This function reads the declared entry source
 * only after the caller supplies `loader`; the loader decides whether and how source is
 * evaluated, including any sandbox or VM policy. The returned record is directly usable as an
 * Environment `tools.adapters` entry and therefore by WorkflowGraph's existing adapter path.
 *
 * @param {{read(path: string, options?: object): Promise<string|Uint8Array|ArrayBuffer>}} resources
 * @param {string} path absolute tool directory
 * @param {{loader(options: {source: string, path: string, entryPath: string, definition: object, revision: string}): Promise<Function>|Function, revision?: string, maxBytes?: number, signal?: AbortSignal}} options
 */
export async function bindToolResource(resources, path, options = {}) {
  if (typeof options.loader !== "function") {
    fail("bindToolResource requires an explicit loader; resource code is never evaluated automatically");
  }
  const base = toolPath(path);
  const snapshot = snapshotOptions(options);
  const definition = await loadDefinition(resources, base, snapshot);
  return bindLoadedDefinition(resources, definition, { ...snapshot, loader: options.loader });
}

/** Resolve explicit directories in order, rejecting duplicate names without discovery. */
export async function toolCatalog(resources, paths, options = {}) {
  if (!Array.isArray(paths)) fail("tool catalog paths must be an array");
  // Capture every caller-owned selection before the first resource read can yield.
  const selectedPaths = Array.from(paths, toolPath);
  const snapshot = snapshotOptions(options);
  const catalog = [];
  const names = new Set();
  for (const path of selectedPaths) {
    const definition = await loadDefinition(resources, path, snapshot);
    if (names.has(definition.name)) {
      fail(`duplicate tool name '${definition.name}'`, "EEXIST", definition.path);
    }
    names.add(definition.name);
    catalog.push(definition);
  }
  return Object.freeze(catalog);
}
