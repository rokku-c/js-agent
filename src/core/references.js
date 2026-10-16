// Resolve explicit resource references without reaching around the resource facade.

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const DEFAULT_MAX_BYTES = 1024 * 1024;
const MAX_DEPTH = 64;
const REF_FIELDS = new Set(["$ref", "mode", "revision", "selector"]);
const SELECTOR_FIELDS = new Set(["lines"]);

function fail(message, code = "EINVAL") {
  const error = new TypeError(message);
  error.code = code;
  return error;
}

function checkSignal(signal) {
  if (!signal?.aborted) return;
  throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function normalizedPath(path) {
  if (typeof path !== "string" || !path.startsWith("/")) {
    throw fail("reference path must be an absolute string");
  }

  const parts = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

function ownKeys(value) {
  return Object.keys(value);
}

function validateSelector(selector) {
  if (selector === undefined) return undefined;
  if (!selector || typeof selector !== "object" || Array.isArray(selector)) {
    throw fail("reference selector must be an object with a lines range");
  }
  for (const key of ownKeys(selector)) {
    if (!SELECTOR_FIELDS.has(key)) throw fail(`unknown reference selector '${key}'`);
  }
  const lines = selector.lines;
  if (
    !Array.isArray(lines) ||
    lines.length !== 2 ||
    !Number.isSafeInteger(lines[0]) ||
    !Number.isSafeInteger(lines[1]) ||
    lines[0] < 1 ||
    lines[1] < lines[0]
  ) {
    throw fail("reference selector lines must be an inclusive [start, end] range");
  }
  return { lines: [lines[0], lines[1]] };
}

function parseReference(ref) {
  const source = typeof ref === "string" ? { $ref: ref } : ref;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw fail("reference must be an absolute path string or a reference object");
  }
  for (const key of ownKeys(source)) {
    if (!REF_FIELDS.has(key)) throw fail(`unknown reference field '${key}'`);
  }
  if (typeof source.$ref !== "string") throw fail("reference $ref must be a string");

  const path = normalizedPath(source.$ref);
  const mode = source.mode ?? "live";
  if (mode !== "live" && mode !== "pinned") throw fail("reference mode must be 'live' or 'pinned'");
  if (source.revision !== undefined && typeof source.revision !== "string") {
    throw fail("reference revision must be a string");
  }
  if (mode === "pinned" && !/^sha256:[0-9a-f]{64}$/.test(source.revision ?? "")) {
    throw fail("pinned references require a sha256:<hex> full-content revision");
  }
  if (mode === "live" && source.revision !== undefined) {
    throw fail("live references cannot specify a revision");
  }

  const selector = validateSelector(source.selector);
  const requested = { $ref: path, mode };
  if (source.revision !== undefined) requested.revision = source.revision;
  if (selector !== undefined) requested.selector = selector;
  return { path, mode, revision: source.revision, selector, requested };
}

function toBytes(raw) {
  if (typeof raw === "string") return encoder.encode(raw);
  if (raw instanceof Uint8Array) return new Uint8Array(raw);
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw.slice(0));
  if (ArrayBuffer.isView(raw)) {
    return new Uint8Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
  }
  throw fail("resource reads must return UTF-8 text or bytes");
}

function selectLines(text, selector) {
  if (!selector) return text;
  const [start, end] = selector.lines;
  let offset = 0;
  let selectedStart = 0;
  let count = 0;
  // Locate only the requested range. Creating a string/array entry for every
  // source line wastes substantial memory when selecting a few lines of a file.
  while (offset < text.length) {
    count++;
    if (count === start) selectedStart = offset;
    const newline = text.indexOf("\n", offset);
    offset = newline === -1 ? text.length : newline + 1;
    if (count === end) return text.slice(selectedStart, offset);
  }
  throw fail(`reference line range [${start}, ${end}] is outside the ${count}-line source`);
}

async function sha256(bytes) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function validateMaxBytes(maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw fail("maxBytes must be a non-negative safe integer");
}

function checkMaxBytes(bytes, maxBytes) {
  validateMaxBytes(maxBytes);
  if (bytes.byteLength > maxBytes) {
    const error = fail(`materialized reference exceeds maxBytes (${bytes.byteLength} > ${maxBytes})`, "EOVERFLOW");
    throw error;
  }
}

/**
 * @param {{read(path: string, options?: object): Promise<string|Uint8Array|ArrayBuffer>}} resources
 * @param {string|{$ref:string,mode?:"live"|"pinned",revision?:string,selector?:{lines:[number,number]}}} ref
 * @param {{maxBytes?: number, signal?: AbortSignal}} options
 */
export async function resolveReference(resources, ref, { maxBytes = DEFAULT_MAX_BYTES, signal } = {}) {
  checkSignal(signal);
  if (!resources || typeof resources.read !== "function") throw fail("resources must provide read(path, options)");
  const parsed = parseReference(ref);
  validateMaxBytes(maxBytes);
  checkSignal(signal);

  // The facade is the only access path. In particular, do not inspect or unwrap it.
  const raw = await resources.read(parsed.path, { encoding: "binary", signal });
  checkSignal(signal);
  const bytes = toBytes(raw);
  const contentHash = await sha256(bytes);
  checkSignal(signal);
  if (parsed.mode === "pinned" && contentHash !== parsed.revision) {
    throw fail(`pinned reference content mismatch: expected ${parsed.revision}, got ${contentHash}`, "ESTALE");
  }

  let text;
  try {
    text = typeof raw === "string" ? raw : decoder.decode(bytes);
  } catch {
    throw fail("referenced resource is not valid UTF-8 text");
  }
  const value = selectLines(text, parsed.selector);
  const selectedBytes = encoder.encode(value);
  checkMaxBytes(selectedBytes, maxBytes);
  const selectedHash = await sha256(selectedBytes);
  checkSignal(signal);

  return {
    value,
    provenance: {
      requested: parsed.requested,
      contentHash,
      selectedHash,
      bytes: selectedBytes.byteLength,
      selector: parsed.selector,
      resolvedAt: new Date().toISOString(),
    },
  };
}

function cloneLiteral(value, depth, ancestors) {
  if (depth > MAX_DEPTH) throw fail(`reference argument nesting exceeds depth ${MAX_DEPTH}`);
  if (value === null || typeof value !== "object") return value;
  if (ancestors.has(value)) throw fail("reference arguments contain a cycle");

  const nextAncestors = new Set(ancestors);
  nextAncestors.add(value);
  if (Array.isArray(value)) return value.map((item) => cloneLiteral(item, depth + 1, nextAncestors));

  const output = {};
  for (const key of ownKeys(value)) {
    // defineProperty keeps even a literal "__proto__" key as data and cannot mutate the
    // output object's prototype. The same rule makes constructor/prototype keys inert.
    Object.defineProperty(output, key, {
      value: cloneLiteral(value[key], depth + 1, nextAncestors),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return output;
}

async function resolveArgumentValue(resources, value, options, depth, ancestors, provenance) {
  if (depth > MAX_DEPTH) throw fail(`reference argument nesting exceeds depth ${MAX_DEPTH}`);
  if (value === null || typeof value !== "object") return value;

  if (ancestors.has(value)) throw fail("reference arguments contain a cycle");
  const nextAncestors = new Set(ancestors);
  nextAncestors.add(value);

  if (Array.isArray(value)) {
    const output = [];
    for (const item of value) {
      output.push(await resolveArgumentValue(resources, item, options, depth + 1, nextAncestors, provenance));
    }
    return output;
  }

  const keys = ownKeys(value);
  if (keys.includes("$ref")) {
    const resolved = await resolveReference(resources, value, options);
    provenance.push(resolved.provenance);
    return resolved.value;
  }
  if (keys.includes("$literal")) {
    if (keys.length !== 1) throw fail("$literal objects may contain only '$literal'");
    return cloneLiteral(value.$literal, depth + 1, nextAncestors);
  }

  const output = {};
  for (const key of keys) {
    Object.defineProperty(output, key, {
      value: await resolveArgumentValue(resources, value[key], options, depth + 1, nextAncestors, provenance),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return output;
}

/** Resolve only explicit reference objects; ordinary strings remain literal values. */
export async function resolveArguments(resources, input, options = {}) {
  const provenance = [];
  const value = await resolveArgumentValue(resources, input, options, 0, new Set(), provenance);
  return { value, provenance };
}
