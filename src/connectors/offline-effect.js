// An offline external-effect connector for testing the callable-resource contract.
// It models the two provider behaviors that a caller must handle:
//   * deduplicating providers retain one receipt per idempotency key;
//   * non-deduplicating providers cannot turn an interrupted dispatch into success.
// Receipts and operation status are ordinary read resources, so reconciliation uses the same
// View as dispatch. This connector never claims global exactly-once delivery.
import { VfsError } from "../kernel/errors.js";
import { validateInvokeOptions } from "../kernel/invoke-options.js";
const printable = /^[\x20-\x7e]+$/u;

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function fail(code, message, path, operation) {
  throw new VfsError(code, message, { path, operation });
}

function pathOf(path) {
  if (typeof path !== "string" || path.includes("\0")) fail("EINVAL", "connector path must be a string", path, "resource");
  return path === "" ? "/" : (path.startsWith("/") ? path : `/${path}`).replace(/\/+/gu, "/").replace(/\/$/u, "") || "/";
}

function json(value) {
  return JSON.stringify(value, null, 2) + "\n";
}

function fileStat(size = null, resource = {}) {
  return { type: "file", size, device: false, callable: false, appendable: false, mtime: 0, mode: 0o444, resource };
}

function dirStat() {
  return { type: "dir", size: null, device: false, callable: false, appendable: false, mtime: 0, mode: 0o755 };
}

function abortCause(signal, message = "effect dispatch timed out") {
  const error = signal?.reason instanceof Error ? signal.reason : new Error(message);
  error.code ??= signal?.reason?.name === "TimeoutError" ? "ETIMEDOUT" : "ABORT_ERR";
  return error;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safePart(value, label) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || !printable.test(value)) {
    throw new VfsError("EINVAL", `${label} must be a nonempty printable string`, { operation: "invoke" });
  }
  return value;
}

/**
 * A deterministic, process-local effect service. `deduplicate: true` is an explicit provider
 * capability, not a runtime guarantee. A timeout only makes the caller's outcome unknown;
 * the receipt can subsequently be read or retried with the same key.
 */
export class OfflineEffectConnector {
  #receipts = new Map();
  #operations = new Map();
  #nextReceipt = 0;
  #deduplicate;
  #delayMs;

  constructor({ deduplicate = true, delayMs = 15 } = {}) {
    if (!Number.isSafeInteger(delayMs) || delayMs < 0) throw new TypeError("delayMs must be a non-negative safe integer");
    this.#deduplicate = deduplicate === true;
    this.#delayMs = delayMs;
  }

  get deduplicates() { return this.#deduplicate; }

  async stat(path) {
    const abs = pathOf(path);
    if (abs === "/" || abs === "/effects" || abs === "/effects/receipts" || abs === "/effects/status") return dirStat();
    if (abs === "/effects/submit") {
      return {
        type: "device", size: null, device: true, callable: true, appendable: false, mtime: 0, mode: 0o555,
        resource: { provider: "offline-effect", kind: "effect-submit", idempotency: this.#deduplicate ? "supported" : "unsupported" },
      };
    }
    const receiptId = this.#receiptPath(abs);
    if (receiptId && this.#receipts.has(receiptId)) return fileStat(null, { provider: "offline-effect", kind: "receipt" });
    const operationId = this.#statusPath(abs);
    if (operationId && [...this.#receipts.values()].some((receipt) => receipt.operationId === operationId)) {
      return fileStat(null, { provider: "offline-effect", kind: "status" });
    }
    fail("ENOENT", "no such effect resource", abs, "stat");
  }

  async list(path) {
    const abs = pathOf(path);
    if (abs === "/") return ["effects"].map((name) => ({ name, ...dirStat() }));
    if (abs === "/effects") return [
      { name: "submit", ...(await this.stat("/effects/submit")) },
      { name: "receipts", ...dirStat() },
      { name: "status", ...dirStat() },
    ];
    if (abs === "/effects/receipts") return [...this.#receipts.keys()].map((id) => ({ name: `${id}.json`, ...fileStat() }));
    if (abs === "/effects/status") return [...new Set([...this.#receipts.values()].map((receipt) => receipt.operationId).filter(Boolean))]
      .map((operationId) => ({ name: `${encodeURIComponent(operationId)}.json`, ...fileStat() }));
    fail("ENOTDIR", "not a directory", abs, "list");
  }

  async read(path) {
    const abs = pathOf(path);
    if (abs === "/effects/submit") return json({
      kind: "external-effect",
      input: { payload: "object", delayMs: "number?" },
      options: { operationId: "stable caller operation identity", idempotencyKey: "provider deduplication key" },
      reconciliation: "read receipt.json or status.json after unknown",
    });
    const receiptId = this.#receiptPath(abs);
    if (receiptId) {
      const receipt = this.#receipts.get(receiptId);
      if (!receipt) fail("ENOENT", "effect receipt not found", abs, "read");
      return json(receipt);
    }
    const operationId = this.#statusPath(abs);
    if (operationId) {
      const receipt = [...this.#receipts.values()].reverse().find((candidate) => candidate.operationId === operationId);
      if (!receipt) fail("ENOENT", "effect status not found", abs, "read");
      return json({ operationId, idempotencyKey: receipt.idempotencyKey ?? null, receiptId: receipt.id, state: receipt.state, result: receipt.result ?? null });
    }
    fail("ENOENT", "no such effect resource", abs, "read");
  }

  async write() { fail("EACCES", "offline effect connector is read-only; use invoke", "/effects", "write"); }

  async exists(path) {
    try { await this.stat(path); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; }
  }

  async invoke(path, input, options = {}) {
    const abs = pathOf(path);
    if (abs !== "/effects/submit") fail("ENOTSUP", "resource is not callable", abs, "invoke");
    validateInvokeOptions(options);
    if (!input || typeof input !== "object" || Array.isArray(input)) fail("EINVAL", "effect input must be an object", abs, "invoke");
    const operationId = safePart(options.operationId, "operationId");
    const idempotencyKey = safePart(options.idempotencyKey, "idempotencyKey");
    const key = this.#deduplicate && idempotencyKey ? idempotencyKey : null;
    if (key && this.#operations.has(key)) {
      const operation = this.#operations.get(key);
      return this.#waitFor(operation.promise, options, operation.receipt, true);
    }

    const receipt = {
      id: `receipt-${++this.#nextReceipt}`,
      state: "started",
      resource: "/effects/submit",
      operationId: operationId ?? null,
      idempotencyKey: idempotencyKey ?? null,
      payload: clone(input.payload ?? null),
    };
    this.#receipts.set(receipt.id, receipt);
    const work = this.#complete(receipt, input);
    if (key) this.#operations.set(key, { receipt, promise: work });
    return this.#waitFor(work, options, receipt, false);
  }

  receipts() { return [...this.#receipts.values()].map(clone); }

  async #complete(receipt, input) {
    await delay(Number.isSafeInteger(input.delayMs) && input.delayMs >= 0 ? input.delayMs : this.#delayMs);
    // A non-deduplicating provider has no evidence after an interrupted dispatch. Keep its
    // receipt unknown even if this local simulation's timer eventually fires.
    if (receipt.state === "unknown") return { status: "unknown", value: null, effect: { id: receipt.id, state: "unknown" }, receipt: clone(receipt) };
    const result = { effectId: receipt.id, accepted: true, payload: clone(input.payload ?? null) };
    receipt.state = "completed";
    receipt.result = result;
    return { status: "completed", value: result, effect: { id: receipt.id, state: "completed" }, receipt: clone(receipt) };
  }

  async #waitFor(work, options, receipt, deduplicated) {
    const signal = options.signal;
    if (signal?.aborted) {
      const cause = abortCause(signal, "effect dispatch was cancelled");
      const error = new Error("effect dispatch outcome is unknown", { cause });
      error.name = "AbortError";
      error.code = cause.code;
      error.outcome = "unknown";
      error.effect = clone({ ...receipt, state: "unknown", reason: cause.message });
      throw error;
    }
    let timer = null;
    let abort;
    const interrupted = new Promise((_, reject) => {
      abort = () => reject(abortCause(signal));
      signal?.addEventListener("abort", abort, { once: true });
      if (Number.isSafeInteger(options.timeoutMs) && options.timeoutMs >= 0) {
        timer = setTimeout(() => reject(Object.assign(new Error("effect dispatch timed out"), { code: "ETIMEDOUT" })), options.timeoutMs);
      }
    });
    try {
      const result = await Promise.race([work, interrupted]);
      return { ...result, deduplicated: deduplicated || undefined };
    } catch (cause) {
      const unknown = { ...receipt, state: "unknown", reason: cause.message };
      if (!this.#deduplicate || !this.#operations.has(receipt.idempotencyKey)) {
        receipt.state = "unknown";
        receipt.reason = cause.message;
      }
      const error = new Error("effect dispatch outcome is unknown", { cause });
      error.name = cause.code === "ETIMEDOUT" ? "TimeoutError" : "AbortError";
      error.code = cause.code ?? "ABORT_ERR";
      error.outcome = "unknown";
      error.effect = clone(unknown);
      error.receipt = clone(unknown);
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }

  #receiptPath(path) {
    const match = /^\/effects\/receipts\/([^/]+)\.json$/u.exec(path);
    return match?.[1] ?? null;
  }

  #statusPath(path) {
    const match = /^\/effects\/status\/([^/]+)\.json$/u.exec(path);
    if (!match) return null;
    try { return decodeURIComponent(match[1]); }
    catch { return match[1]; }
  }
}

export function createOfflineEffectConnector(options = {}) {
  return new OfflineEffectConnector(options);
}
