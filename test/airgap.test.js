// airgap.test.js — the claim, checked statically.
//
// "no network by default" is worth exactly as much as the mechanism behind it. the mechanism
// is that the net driver is a module nobody imports until `mount net` runs, and that no other
// file names a transport. that is a property of the source, so it is checked against the
// source — a runtime assertion could only prove that the paths a test happened to take were
// clean.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { namespace } from "./helpers.js";
import { installAirgap, airgapArmed, networkHandle } from "../src/kernel/airgap.js";
import { knownDrivers, loadDriver } from "../src/kernel/registry.js";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

async function sourceFiles(dir = ROOT, out = []) {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await sourceFiles(full, out);
    else if (e.name.endsWith(".js") && !full.includes(`${path.sep}test${path.sep}`)) out.push(full);
  }
  return out;
}

const NET_DRIVER = path.join(ROOT, "src", "drivers", "net.js");
const AIRGAP = path.join(ROOT, "src", "kernel", "airgap.js");

/** comments out, so the check reads code.
 *
 *  without this it fires on the comment in registry.js that *describes* the rule — which is
 *  a reminder that a textual check is a blunt instrument. it is still the right instrument
 *  here: a call is a call, and the alternative is proving the absence of a code path by
 *  running it, which only ever proves the paths a test took. */
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/[^\n]*/g, "$1");

test("airgap: no file but the net driver reaches for a network primitive", async () => {
  const offenders = [];
  for (const file of await sourceFiles()) {
    if (file === NET_DRIVER || file === AIRGAP) continue;
    const text = code(await fs.readFile(file, "utf8"));
    const rel = path.relative(ROOT, file);

    // a call, not a mention: `networkHandle()` appears in airgap.js's own export, and the
    // word "fetch" appears in comments explaining why there is none
    if (/(^|[^.\w])fetch\s*\(/.test(text)) offenders.push(`${rel}: fetch(`);
    for (const mod of ["node:net", "node:http", "node:https", "node:dgram", "node:tls"]) {
      if (new RegExp(`from\\s+["']${mod.replace(":", ":")}["']`).test(text) || text.includes(`"${mod}"`)) {
        offenders.push(`${rel}: imports ${mod}`);
      }
    }
    if (/XMLHttpRequest|WebSocket\s*\(/.test(text)) offenders.push(`${rel}: a browser transport`);
  }
  assert.deepEqual(offenders, [], "the net driver is the only way out of this process");
});

test("airgap: the registry is the only place a driver is loaded, and it loads on demand", async () => {
  for (const file of await sourceFiles()) {
    if (file.endsWith(`${path.sep}registry.js`)) continue;
    const text = code(await fs.readFile(file, "utf8"));
    // a static import of a driver would put it in the process at boot, whether or not it was
    // ever mounted — which is exactly what the on-demand registry exists to prevent
    const m = /from\s+["'][^"']*\/drivers\/[a-z-]+\.js["']/.exec(text);
    assert.equal(m, null, `${path.relative(ROOT, file)} imports a driver directly`);
  }
});

test("airgap: nothing is loaded until it is mounted", async () => {
  // the registry knows every driver by name without loading any of them
  assert.deepEqual(knownDrivers().sort(), ["ai", "bin", "dev", "hostfs", "mem", "net", "proc", "secret"]);
  // and loading one is a deliberate act — this is the call `mount net` makes, and the only
  // way the module containing the transport enters the process
  const net = await loadDriver("net");
  assert.equal(net.name, "net");
  await assert.rejects(() => loadDriver("nope"), /unknown driver: nope/);
});

test("airgap: the tripwire is off by default, and when armed it explains itself", () => {
  assert.equal(airgapArmed(), false);
  const real = globalThis.fetch;
  const disarm = installAirgap();
  assert.equal(airgapArmed(), true);
  try {
    assert.throws(() => globalThis.fetch("https://example.com"), (e) => {
      assert.equal(e.code, "ENETDOWN");
      assert.match(e.message, /global fetch was called, but a network is not mounted/);
      assert.match(e.message, /write a request to the net device/);
      assert.match(e.message, /example\.com/);
      return true;
    });
    // …and the driver can still get the real one, which is the whole arrangement: the
    // tripwire catches the accidental path, the mount is the deliberate one
    assert.equal(typeof networkHandle(), "function");
  } finally {
    disarm();
  }
  assert.equal(globalThis.fetch, real);
  assert.equal(airgapArmed(), false);
});

test("airgap: a booted namespace has no network and no model, whatever the process has", async () => {
  const vfs = await namespace();
  assert.equal(await vfs.exists("/dev/net"), false);
  assert.equal(await vfs.exists("/dev/providers"), false);
  assert.equal(await vfs.exists("/dev/secrets"), false);
  // the only thing /dev offers is the four nodes every system has
  assert.deepEqual((await vfs.list("/dev")).map((e) => e.name), ["null", "random", "tty", "urandom", "zero"]);
  assert.equal((await vfs.read("/proc/mounts")).includes("net"), false);
});
