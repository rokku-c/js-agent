// airgap.js — an optional, and deliberately modest, tripwire.
//
// ── what this is not ──
// this is not the sandbox. the sandbox is the mount table, and it does not depend on this
// file: the net driver is a module nobody imports until `mount net` runs, and a static test
// refuses a `fetch(` anywhere outside it. that is the real guarantee, and it holds whether
// or not anything here runs.
//
// ── so what is this for ──
// it catches the *accidental* path — a dependency, a stray helper, a line someone pasted —
// by replacing `globalThis.fetch` with something that says what is wrong instead of
// silently succeeding. the net driver calls `networkHandle()` to get the real one back.
//
// it is off by default because a tripwire that fires during normal work is not a safety
// feature, it is an obstacle, and the design does not need it.

import { VfsError } from "./errors.js";

let realFetch = null;
let installed = false;

/** arm the tripwire. returns the function that disarms it. */
export function installAirgap() {
  if (installed) return () => {};
  realFetch = globalThis.fetch;

  globalThis.fetch = function airgappedFetch(...args) {
    const target = String(args[0]?.url ?? args[0] ?? "");
    throw new VfsError("ENETDOWN", "global fetch was called, but a network is not mounted", {
      hint:
        "reach the network through the namespace instead — write a request to the net " +
        "device (`mount net /dev/net`), which is also what carries the host allowlist. " +
        `target was ${target || "(unknown)"}`,
    });
  };
  globalThis.fetch.airgapped = true;
  installed = true;

  return () => {
    globalThis.fetch = realFetch;
    installed = false;
  };
}

/**
 * The real `fetch`, for the one module allowed to hold it.
 *
 * It is handed out rather than imported so that the only reference to a transport outside
 * drivers/net.js is this function's return value — which the airgap test can account for,
 * and which cannot be reached from a tool or a driver that was merely mounted.
 */
export function networkHandle() {
  if (realFetch) return realFetch;
  if (typeof globalThis.fetch === "function" && !globalThis.fetch.airgapped) return globalThis.fetch;
  return null;
}

export function airgapArmed() {
  return installed;
}
