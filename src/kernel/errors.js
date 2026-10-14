// errors.js — errno-shaped failures, thrown, never returned
//
// ── why these throw ──
// the whole runtime turns on one rule the tool executor enforces:
//
//     a returned value is a success; a thrown value is an `is_error` tool_result
//     the model reads and corrects itself from.
//
// so a device that *returns* `{errno: "ENETDOWN"}` re-opens the exact hole this design
// exists to close — a caller that does not branch hands the model a normal-looking
// result containing a fake answer. everything that can fail, throws.
//
// ── why the message is self-contained ──
// nu-agent measured that only `msg` survives a catch there, and the same discipline is
// kept here for a different reason: the message is what reaches the model, and the
// model cannot see `code`, `path`, or `hint` unless they are written into it. so the
// message carries the errno, the path, the operation, and — when there is one — the
// command that fixes it.

// the codes this runtime actually raises. the numbers match Linux's so a reader who
// knows them is not surprised; nothing here depends on the number.
export const ERRNO = {
  EPERM: 1,
  ENOENT: 2,
  EIO: 5,
  EBADF: 9,
  EACCES: 13,
  EBUSY: 16,
  EEXIST: 17,
  ENOTDIR: 20,
  EISDIR: 21,
  EINVAL: 22,
  ENOSPC: 28,
  ENOTEMPTY: 39,
  ENOSYS: 38,
  ENODEV: 19,
  ENETDOWN: 100,
  ETIMEDOUT: 110,
  ECONNREFUSED: 111,
  EOVERFLOW: 75,
  ENOTSUP: 95,
};

// the one-line English for each code, so a message reads like an errno without the
// reader having to keep a table in their head.
const STRERROR = {
  EPERM: "operation not permitted",
  ENOENT: "no such file or directory",
  EIO: "input/output error",
  EBADF: "bad file descriptor",
  EACCES: "permission denied",
  EBUSY: "device or resource busy",
  EEXIST: "file exists",
  ENOTDIR: "not a directory",
  EISDIR: "is a directory",
  EINVAL: "invalid argument",
  ENOSPC: "no space left",
  ENOTEMPTY: "directory not empty",
  ENOSYS: "not implemented",
  ENODEV: "no such device",
  ENETDOWN: "network is not mounted",
  ETIMEDOUT: "timed out",
  ECONNREFUSED: "connection refused",
  EOVERFLOW: "value too large",
  ENOTSUP: "operation not supported",
};

export class VfsError extends Error {
  /**
   * @param {keyof typeof ERRNO} code
   * @param {string} detail    what was attempted, in the caller's terms
   * @param {{path?: string, operation?: string, hint?: string, cause?: unknown}} [ctx]
   */
  constructor(code, detail, ctx = {}) {
    const parts = [`${code}: ${STRERROR[code] ?? "error"}`];
    if (detail) parts.push(detail);
    if (ctx.path) parts.push(`path=${ctx.path}`);
    if (ctx.operation) parts.push(`op=${ctx.operation}`);
    let message = parts.join(" · ");
    // the hint is an instruction, not more description — it goes last and is phrased as
    // something to do, because its reader is usually a model deciding what to try next.
    if (ctx.hint) message += `\n→ ${ctx.hint}`;

    super(message, ctx.cause !== undefined ? { cause: ctx.cause } : undefined);
    this.name = "VfsError";
    this.code = code;
    this.errno = ERRNO[code] ?? ERRNO.EIO;
    this.detail = detail ?? "";
    this.path = ctx.path ?? null;
    this.operation = ctx.operation ?? null;
    this.hint = ctx.hint ?? null;
  }

  /** the same error with a different path — used when a driver's relative path is
   *  re-absolutised on the way out, so the caller always sees a namespace path. */
  at(absPath) {
    if (this.path === absPath) return this;
    const e = new VfsError(this.code, this.detail, {
      path: absPath,
      operation: this.operation,
      hint: this.hint,
      cause: this.cause,
    });
    return e;
  }
}

export function isVfsError(e) {
  return e instanceof VfsError;
}

/** the reason, as one line, for code that has to report a failure without rethrowing it.
 *  mirrors nu-agent's `reason` command: the useful sentence, never a wrapper. */
export function reason(e) {
  if (e == null) return "unknown error";
  if (typeof e === "string") return e;
  const msg = e.message ?? String(e);
  const cause = e.cause;
  if (cause && cause.message && !msg.includes(cause.message)) {
    return `${msg} (cause: ${cause.message})`;
  }
  return msg;
}
