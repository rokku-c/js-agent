import { VfsError } from "./errors.js";

const MAX_ID_LENGTH = 256;

/**
 * Validate the portable identity part of callable-resource options. Other options remain
 * connector-owned and are passed through unchanged.
 */
export function validateInvokeOptions(options = {}) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new VfsError("EINVAL", "invoke options must be an object", { operation: "invoke" });
  }
  for (const field of ["operationId", "idempotencyKey"]) {
    const value = options[field];
    if (value === undefined) continue;
    if (typeof value !== "string" || value.length === 0 || value.length > MAX_ID_LENGTH || /[\u0000-\u001f\u007f]/u.test(value)) {
      throw new VfsError("EINVAL", `${field} must be a nonempty string of at most ${MAX_ID_LENGTH} printable characters`, { operation: "invoke" });
    }
  }
  return options;
}

export const INVOKE_ID_MAX_LENGTH = MAX_ID_LENGTH;
