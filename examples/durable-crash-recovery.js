// Real process death, not cancellation or rebuilding objects in the same process.
// Run: node examples/durable-crash-recovery.js
import { fork } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const worker = fileURLToPath(new URL("./helpers/durable-crash-worker.js", import.meta.url));
export const scenarios = ["completed", "started", "started-locked", "malformed-tail", "status-failure",
  "completed-status-failure", "tool-status-failure", "recovery-status-failure", "duplicate-id", "external-effect-unknown"];

function launch(phase, directory, scenario) {
  const child = fork(worker, [phase, directory, scenario], { stdio: ["ignore", "ignore", "pipe", "ipc"], execArgv: [] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  let received = false;
  let resolveMessage, rejectMessage;
  const message = new Promise((resolve, reject) => { resolveMessage = resolve; rejectMessage = reject; });
  // Keep rejection handled even while the caller is waiting on another worker.
  message.catch(() => {});
  const timer = setTimeout(() => {
    rejectMessage(new Error(`worker timed out: ${phase}/${scenario}: ${stderr}`));
    child.kill("SIGKILL");
  }, 10_000);
  const exit = new Promise((resolve, reject) => {
    child.once("error", (e) => { clearTimeout(timer); rejectMessage(e); reject(e); });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (!received) rejectMessage(new Error(`worker exited before checkpoint: ${phase}/${scenario} (${code}, ${signal}): ${stderr}`));
      resolve({ code, signal });
    });
  });
  exit.catch(() => {});
  child.once("message", (value) => { received = true; resolveMessage(value); });
  return { child, message, exit };
}

export async function runCrashScenario(scenario) {
  if (!scenarios.includes(scenario)) throw new Error(`unknown scenario: ${scenario}`);
  const directory = await mkdtemp(path.join(os.tmpdir(), "js-agent-sigkill-"));
  const workers = [];
  const start = (phase) => { const process = launch(phase, directory, scenario); workers.push(process); return process; };
  try {
    const writer = start("write");
    const checkpoint = await writer.message;
    let duplicateWhileAlive;
    if (scenario === "duplicate-id") {
      const duplicate = start("duplicate");
      duplicateWhileAlive = await duplicate.message;
      const exited = await duplicate.exit;
      if (exited.code !== 0) throw new Error("duplicate worker failed");
    }
    writer.child.kill("SIGKILL");
    const killed = await writer.exit;
    if (killed.signal !== "SIGKILL") throw new Error(`writer was not killed: ${JSON.stringify(killed)}`);
    // Only now is takeover safe: this parent has reaped the writer, not merely timed it out.
    const reader = start("recover");
    const observation = await reader.message;
    const exited = await reader.exit;
    if (exited.code !== 0) throw new Error(`recovery worker failed: ${JSON.stringify(exited)}`);
    return { scenario, checkpoint, killed, duplicateWhileAlive, ...observation };
  } finally {
    for (const { child } of workers) if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL");
    await Promise.allSettled(workers.map(({ exit }) => exit));
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  for (const scenario of scenarios) {
    const result = await runCrashScenario(scenario);
    console.log(JSON.stringify({ scenario, writerPid: result.checkpoint.pid, recoveryPid: result.pid,
      signal: result.killed.signal, before: result.before.status, recovered: result.recovered.status,
      after: result.after.status, partialBefore: result.before.partial, partialAfter: result.after.partial,
      events: result.after.events.map(({ kind }) => kind), busy: result.busy?.code,
      duplicate: result.duplicateWhileAlive?.error?.code, effectReceipts: result.effects.trim().split("\n").filter(Boolean).length }));
  }
}
