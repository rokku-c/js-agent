// registry.js — the only place a driver module is loaded
//
// ── why this file matters more than it looks ──
// every entry below is a *dynamic* import. nothing imports a driver until someone mounts
// it. that is what makes the central claim of this runtime true rather than aspirational:
//
//     an agent whose namespace has no /dev/net cannot reach a network.
//
// not "does not" — *cannot*. the module holding the transport is not in the process until
// `mount net` runs it into existence, and no other file names it. the `airgap` test suite
// enforces that statically, by refusing a `fetch(` or a net builtin import anywhere
// outside src/drivers/net.js.

const LOADERS = {
  mem: () => import("../drivers/mem.js"),
  dev: () => import("../drivers/dev.js"),
  proc: () => import("../drivers/proc.js"),
  hostfs: () => import("../drivers/hostfs.js"),
  secret: () => import("../drivers/secret.js"),
  net: () => import("../drivers/net.js"),
  ai: () => import("../drivers/ai.js"),
  bin: () => import("../drivers/bin.js"),
};

/** a driver name → its module. cached, because a module is loaded once whatever the
 *  number of mounts using it. */
const cache = new Map();

export async function loadDriver(name) {
  const key = String(name ?? "");
  if (cache.has(key)) return cache.get(key);

  const load = LOADERS[key];
  if (!load) {
    const known = Object.keys(LOADERS).join(", ");
    throw new Error(`unknown driver: ${name || "(none)"}. known drivers: ${known}`);
  }

  const mod = await load();
  const driver = mod.default;
  if (!driver || typeof driver.mount !== "function") {
    throw new Error(`driver ${key} did not export a driver (see defineDriver in kernel/driver.js)`);
  }
  cache.set(key, driver);
  return driver;
}

export function knownDrivers() {
  return Object.keys(LOADERS);
}

/** the one-line description of each driver, for `mount --list` and the README's table.
 *  this loads every driver module, so it is for the help path only — never for anything
 *  on the hot path, and never for anything that has to stay airgapped. */
export async function describeDrivers() {
  const out = [];
  for (const name of knownDrivers()) {
    const d = await loadDriver(name);
    out.push({ name, description: d.description ?? "" });
  }
  return out;
}
