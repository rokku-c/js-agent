// A capability facade for trusted connector handlers, not a JavaScript sandbox.
// Named operations bind provider/credential/network policy inside the handler.
const authorities = new WeakMap();

function fail(message, code = "EINVAL") {
  return Object.assign(new Error(message), { code });
}

function name(value) {
  if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9_.:-]*$/u.test(value)) {
    throw fail("service names must be nonempty identifiers without wildcards");
  }
  return value;
}

/**
 * services is a trusted record of named async handlers, or an existing authority.
 * Grants are exact names; delegation intersects the parent's effective grants.
 * Handlers own input validation, transport policy, output/error sanitization and
 * cancellation. The facade never exposes a handler or credential getter.
 */
export function createServiceAuthority(services = {}, { grants = [] } = {}) {
  if (!services || typeof services !== "object" || Array.isArray(services)) {
    throw fail("services must be a handler record or service authority");
  }
  if (!Array.isArray(grants)) throw fail("service grants must be an array");
  const requested = new Set(Array.from(grants, name));
  const parent = authorities.get(services);
  const available = parent ?? new Map(Object.entries(services).map(([key, handler]) => {
    name(key);
    if (typeof handler !== "function") throw fail(`service ${key} must be a function`);
    return [key, handler];
  }));
  // Snapshot only delegated handlers; a child cannot recover the registry or parent.
  const allowed = new Map([...available].filter(([key]) => requested.has(key)));
  const authority = Object.freeze({
    async call(operation, input, options = {}) {
      name(operation);
      const handler = allowed.get(operation);
      if (!handler) throw fail("service operation is outside this authority", "EACCES");
      return handler(input, options);
    },
    derive: (options = {}) => createServiceAuthority(authority, options),
    describe: () => ({ grants: [...allowed.keys()] }),
  });
  authorities.set(authority, allowed);
  return authority;
}
