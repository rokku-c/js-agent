// mounts.js — mount specs, and the boot sequence
//
// a mount spec is one string, and it is the same string whether it arrives on the command
// line or is typed at the prompt:
//
//     driver:at[,key=value…]
//
//     hostfs:/host,source=.,mode=ro
//     net:/dev/net,allow=api.anthropic.com
//     ai:/dev/providers/ai,vendor=anthropic,token-file=/dev/secrets/ANTHROPIC_AUTH_TOKEN
//
// one spelling, two entry points, so `--mount X` and `mount X` cannot drift apart.
//
// values are strings, and a driver coerces what it needs. `,` separates options and `=`
// splits a key from its value, both at the top level only — a value may contain them if
// it is quoted, which matters for an URL.

import { normalize } from "./paths.js";

/**
 * @param {string} spec
 * @returns {{driver: string, at: string, options: Record<string, string|boolean>}}
 */
export function parseSpec(spec) {
  const text = String(spec ?? "").trim();
  if (!text) throw new Error("empty mount spec");

  const [head, ...rest] = splitTop(text, ",");
  const colon = head.indexOf(":");
  const driver = (colon < 0 ? head : head.slice(0, colon)).trim();
  const atRaw = colon < 0 ? "/" + driver : head.slice(colon + 1).trim();

  if (!driver) throw new Error(`mount spec has no driver: ${spec}`);
  const at = normalize(atRaw || "/" + driver);

  const options = Object.create(null);
  for (const opt of rest) {
    if (!opt.trim()) continue;
    const eq = opt.indexOf("=");
    if (eq < 0) {
      options[opt.trim()] = true; // a bare word is a switch: `,ro`
      continue;
    }
    const key = opt.slice(0, eq).trim();
    options[key] = unquote(opt.slice(eq + 1).trim());
  }
  return { driver, at, options };
}

/** the inverse — for printing a table back in the form that would re-mount it. */
export function formatSpec({ driver, at, options = {} }) {
  const opts = Object.entries(options)
    .filter(([, v]) => v !== undefined && v !== false)
    .map(([k, v]) => (v === true ? k : `${k}=${needsQuoting(v) ? JSON.stringify(String(v)) : v}`))
    .join(",");
  return `${driver}:${at}${opts ? "," + opts : ""}`;
}

function needsQuoting(v) {
  return /[,"]/.test(String(v));
}

function unquote(s) {
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    return s.slice(1, -1);
  }
  return s;
}

/** split on a separator that is not inside quotes **or brackets**.
 *
 *  the brackets matter as much as the quotes: a mount option carrying JSON — `script=[{…}]`
 *  for the scripted dialect, a policy fragment, a model list — is full of commas, and a
 *  splitter that only knows about quotes shreds it into a dozen meaningless options. it
 *  fails as "unknown option 'content'" rather than as anything resembling the real mistake. */
function splitTop(text, sep) {
  const out = [];
  let cur = "";
  let quote = null;
  let depth = 0;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null;
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === "[" || ch === "{") depth++;
    else if (ch === "]" || ch === "}") depth = Math.max(0, depth - 1);

    if (ch === sep && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * Boot a namespace. Order matters and is the point: /dev and /proc have to exist before a
 * driver can be mounted under them, and /bin is a mount like any other — the tool set the
 * agent is offered *is* which entries of /bin are mounted.
 *
 * @param {import('./vfs.js').Vfs} vfs
 * @param {{tools?: string[], mounts?: string[]|object[], state?: string|null}} opts
 */
export async function bootMounts(vfs, opts = {}) {
  const { tools = [], mounts = [], state = null } = opts;

  // the floor. these are not capabilities — they are what makes a namespace a namespace.
  await vfs.mount("mem", "/", {});
  await vfs.mount("mem", "/tmp", {});
  await vfs.mount("dev", "/dev", {});
  await vfs.mount("proc", "/proc", {});
  await vfs.mount("bin", "/bin", { tools: tools.join(",") });

  // /agent — sessions, context entries, run events and the policy file. everything under
  // it is opt-in, and mounting it is what turns "sessions" on. with no /agent a run is
  // ephemeral and a --session flag fails with a reason rather than writing nowhere.
  if (state) {
    await vfs.mount("hostfs", "/agent", { source: state, mode: "rw", create: true });
  }

  for (const m of mounts) {
    const spec = typeof m === "string" ? parseSpec(m) : m;
    await vfs.mount(spec.driver, spec.at, spec.options);
  }

  return vfs;
}
