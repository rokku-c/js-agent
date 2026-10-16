import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("getting-started example completes through the public package exports", async () => {
  const { stdout } = await run(process.execPath, ["examples/getting-started.js"], { cwd: root });
  const result = JSON.parse(stdout);
  assert.equal(result.status, "completed");
  assert.equal(result.answer, "Use explicit resource permissions.\n");
  assert.deepEqual(result.observed, {
    status: "completed_with_tool_calls",
    events: ["started", "completed"],
  });
});
