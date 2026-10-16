// run.js — run the suites, by name or all of them.
//
// `node --test test/` does the whole thing and is what `npm test` calls. this exists for the
// case nu-agent's runner was written for: running two suites while working on one of them,
// and getting a per-suite line rather than a wall of output.
//
//   node test/run.js              everything
//   node test/run.js vfs shell    just those

import { spawn } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** cheap and hermetic first, so a failure in the parser is not buried under a 700ms
 *  worker-deadline test that also failed for its own reasons. */
const SUITES = ["unit", "vfs", "shell", "ai", "core", "agent", "airgap", "view", "references", "run-context", "invocation", "runtime", "tool-resource", "continuation", "worker-cancel", "workflow", "workflow-harness", "adversarial", "e2e"];

const asked = process.argv.slice(2);
const unknown = asked.filter((a) => !SUITES.includes(a));
if (unknown.length) {
  console.error(`unknown suite(s): ${unknown.join(", ")}. known: ${SUITES.join(", ")}`);
  process.exit(2);
}
const chosen = asked.length ? asked : SUITES;

const only = chosen.map((s) => path.join(HERE, `${s}.test.js`)).filter((f) => fs.existsSync(f));

const child = spawn(process.execPath, ["--test", ...only], { stdio: "inherit" });
child.on("close", (code) => process.exit(code ?? 1));
