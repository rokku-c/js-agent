// A path/operation authorization facade for trusted JavaScript, not an OS sandbox.
// Drivers and resource values remain trusted; granting an operation authorizes its
// driver-defined effects (including recursive remove and directory rename).
import { VfsError } from "./errors.js";
import { normalize, resolvePath } from "./paths.js";

const operations = new Set(["stat", "list", "read", "write", "mkdir", "remove", "rename"]);
// Private policy data only: neither a facade nor its description exposes resources.
const policies = new WeakMap();

function invalid(detail) {
  throw new VfsError("EINVAL", detail, { operation: "createView" });
}

function compile(grants) {
  if (!Array.isArray(grants)) invalid("grants must be an array");
  return Array.from(grants, (grant) => {
    if (!grant || typeof grant.path !== "string" || !grant.path.startsWith("/")) {
      invalid("grant paths must be absolute strings");
    }
    const tree = grant.path.endsWith("/**");
    const raw = tree ? grant.path.slice(0, -3) || "/" : grant.path;
    // No general glob language, escapes, or patterns hidden by normalization.
    if (/[\*?\[\]{}\\\0]/u.test(raw)) invalid("only a trailing /** grant glob is supported");
    if (!Array.isArray(grant.operations) ||
        Array.from(grant.operations).some((op) => !operations.has(op))) {
      invalid("grant operations must name supported resource operations");
    }
    return { base: normalize(raw), tree, operations: [...new Set(grant.operations)] };
  });
}

function matches(grant, path) {
  return path === grant.base || (grant.tree &&
    (grant.base === "/" || path.startsWith(grant.base + "/")));
}

function intersect(child, parent) {
  const result = [];
  for (const a of child) {
    for (const b of parent) {
      const ops = a.operations.filter((op) => b.operations.includes(op));
      if (!ops.length) continue;
      let scope;
      if (a.base === b.base) scope = { base: a.base, tree: a.tree && b.tree };
      else if (b.tree && matches(b, a.base)) scope = a;
      else if (a.tree && matches(a, b.base)) scope = b;
      else continue;
      result.push({ base: scope.base, tree: scope.tree, operations: ops });
    }
  }
  return result;
}

/**
 * Grants are {path, operations: string[]}. Paths are exact or end in /**;
 * a subtree grant includes its root. Requests use the Vfs POSIX normalization.
 *
 * exists requires stat. mkdirp requires stat and mkdir on every non-root
 * ancestor it touches, preflighted before any effect; even existing ancestors
 * must be authorized. mkdir({recursive:true}) follows the same checks.
 * abs is pure path arithmetic and confers no authority. No open/invoke or driver
 * handles are exposed. Options (including signals) pass to the resource API;
 * actual support/cancellation depends on that API and its drivers.
 */
export function createView(resources, { grants = [] } = {}) {
  if (!resources || (typeof resources !== "object" && typeof resources !== "function")) {
    invalid("resources must be a Vfs or resource view");
  }
  const requested = compile(grants);
  const parent = policies.get(resources);
  const policy = parent ? intersect(requested, parent) : requested;
  const allows = (op, path) => policy.some((g) => g.operations.includes(op) && matches(g, path));
  const check = (op, path) => {
    if (typeof path !== "string") {
      throw new VfsError("EINVAL", "resource paths must be strings", { operation: op });
    }
    const abs = normalize(path);
    if (!allows(op, abs)) {
      throw new VfsError("EACCES", "operation is outside this view", { path: abs, operation: op });
    }
    return abs;
  };
  const dispatch = (op) => async (path, ...args) => resources[op](check(op, path), ...args);

  const facade = Object.freeze({
    stat: dispatch("stat"),
    read: dispatch("read"),
    write: dispatch("write"),
    async remove(path, ...args) {
      const abs = check("remove", path);
      const opts = args[0] ?? {};
      if (opts.recursive && !policy.some((g) => g.tree && g.operations.includes("remove") && matches(g, abs))) {
        throw new VfsError("EACCES", "recursive remove requires subtree authority", { path: abs, operation: "remove" });
      }
      return resources.remove(abs, ...args);
    },

    async exists(path, ...args) {
      return resources.exists(check("stat", path), ...args);
    },

    async list(path, ...args) {
      const abs = check("list", path);
      const entries = await resources.list(abs, ...args);
      return entries.filter((entry) => {
        // Only immediate directory entries can be disclosed by this listing.
        const name = entry.name;
        if (typeof name !== "string" || !name || name === "." || name === ".." || name.includes("/")) {
          return false;
        }
        const child = normalize(`${abs}/${name}`);
        return policy.some((g) => g.operations.length > 0 && matches(g, child));
      }).map((entry) => {
        const child = normalize(`${abs}/${entry.name}`);
        // Listing may reveal a name through a read/write grant, but metadata such as
        // size, mode, mtime, device flags, and symlink targets requires stat authority.
        if (allows("stat", child)) return { ...entry };
        return { name: entry.name };
      });
    },

    async mkdir(path, opts = {}) {
      const abs = check("mkdir", path);
      if (opts.recursive) return facade.mkdirp(abs, opts);
      return resources.mkdir(abs, opts);
    },

    async mkdirp(path, opts = {}) {
      const abs = check("mkdir", path);
      const ancestors = [];
      let cur = "";
      for (const part of abs === "/" ? [] : abs.slice(1).split("/")) {
        cur += "/" + part;
        check("stat", cur);
        check("mkdir", cur);
        ancestors.push(cur);
      }
      for (const ancestor of ancestors) {
        try {
          const st = await facade.stat(ancestor, opts);
          if (st.type !== "dir") {
            throw new VfsError("ENOTDIR", "not a directory", { path: ancestor, operation: "mkdirp" });
          }
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
          await facade.mkdir(ancestor, { ...opts, recursive: false });
        }
      }
    },

    async rename(from, to, ...args) {
      const source = check("rename", from);
      const destination = check("rename", to);
      // A directory rename moves every descendant. Require explicit subtree authority
      // on both sides; a root-only grant must not move hidden children across a boundary.
      const sourceStat = await resources.stat(source, args[0]);
      if (sourceStat?.type === "dir") {
        if (!policy.some((g) => g.tree && g.operations.includes("rename") && matches(g, source)) ||
            !policy.some((g) => g.tree && g.operations.includes("rename") && matches(g, destination))) {
          throw new VfsError("EACCES", "directory rename requires subtree authority on both paths", {
            path: `${source} → ${destination}`, operation: "rename",
          });
        }
      }
      return resources.rename(source, destination, ...args);
    },

    abs: (input, cwd = "/") => resolvePath(input, cwd),
    derive: (options = {}) => createView(facade, options),
    // Fresh data, including fresh operation arrays, so callers can safely serialize
    // or edit descriptions. Derived descriptions report the effective intersection.
    describe: () => ({
      grants: policy.map((g) => ({
        path: g.tree ? (g.base === "/" ? "/**" : g.base + "/**") : g.base,
        operations: [...g.operations],
      })),
    }),
  });
  policies.set(facade, policy);
  return facade;
}
