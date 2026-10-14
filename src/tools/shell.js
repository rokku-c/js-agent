// shell — run a program.
//
// ── argv by default, a shell only when asked ──
// nu-agent split `exec` from `shell` for this reason and it is worth keeping: a command
// handed to a shell is re-split on spaces, so a filename with a space, a `$(…)`, or a glob
// means something the caller did not write. `shell` takes argv by default, and `--shell`
// opts into the interpretation on purpose.
//
// ── the deadline, and what actually stops ──
// the child is spawned `detached`, which on POSIX makes it a process *group leader*, so
// `kill(-pid)` reaches its children too. nu-agent had to walk `/proc` for this because its
// tool child was not a group leader; here the group is made deliberately.
//
// a non-zero exit **throws**, so the loop marks the call as an error — a command that failed
// must not reach the model as a successful empty result. `--json` returns the exit code as
// data instead, for a caller who is inspecting failures rather than acting on them.

import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { defineTool } from "../core/tools.js";
import { VfsError } from "../kernel/errors.js";
import { clamp } from "../core/fileio.js";

export default defineTool({
  name: "shell",
  description:
    "Run a program. Arguments are passed as argv with no shell in between, so nothing is " +
    "re-split or expanded. Pass shell=true to run the command through a shell instead, " +
    "which is what you want for pipes, globs and shell syntax. Throws on a non-zero exit " +
    "unless json=true.",
  params: {
    command: { type: "string", positional: 0, required: true, description: "the program, or the whole command line if shell=true" },
    args: { type: "array", flag: "args", description: "argv for the program (ignored when shell=true)" },
    shell: {
      type: "boolean",
      flag: "shell",
      description: "run the command through a shell rather than as argv",
    },
    stdin: { type: "string", flag: "stdin", description: "text to feed to its stdin" },
    cwd: { type: "string", flag: "cwd", description: "host working directory" },
    timeoutMs: { type: "integer", flag: "timeout-ms", default: 120000 },
    maxOutput: { type: "integer", flag: "max-output", default: 8000 },
    json: { type: "boolean", flag: "json", description: "return {exit_code, stdout, stderr} instead of throwing" },
  },

  async run({ input, cwd, signal }) {
    const argv = input.shell
      ? [process.env.SHELL || "/bin/sh", "-c", input.command, ...(input.args ?? [])]
      : [input.command, ...(input.args ?? []).map(String)];

    // a program that does not exist should say so in the words the caller used, not as ENOENT
    if (!input.shell && !looksLikePath(input.command)) {
      const found = await which(input.command);
      if (!found) {
        throw new VfsError("ENOENT", `no such program: ${input.command}`, {
          operation: "shell",
          hint: "this runs programs on the host, not commands in the namespace — for those, name the command directly (they are shell builtins or /bin tools)",
        });
      }
      argv[0] = found;
    }

    const r = await spawnCollect(argv, {
      cwd: input.cwd ?? undefined,
      stdin: input.stdin,
      timeoutMs: input.timeoutMs,
      signal,
    });

    const out = clamp(r.stdout, input.maxOutput, "stdout");
    const err = clamp(r.stderr, input.maxOutput, "stderr");

    if (input.json) {
      return { exit_code: r.code, stdout: out, stderr: err, timed_out: r.timedOut || undefined };
    }
    if (r.timedOut) {
      throw new VfsError("ETIMEDOUT", `the program ran past its ${input.timeoutMs}ms deadline and was killed`, {
        operation: "shell",
        hint: "it produced no result — do not read this as 'found nothing'. retry narrower, or raise timeout-ms.",
      });
    }
    if (r.code !== 0) {
      throw new VfsError("EIO", `exit code ${r.code}: ${err || out || "(no output)"}`, {
        operation: "shell",
        hint: "pass json=true to get the exit code as data instead of an error",
      });
    }
    return out.replace(/\n$/, "");
  },
});

function looksLikePath(cmd) {
  return cmd.includes("/");
}

function which(cmd) {
  for (const dir of String(process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    const p = `${dir}/${cmd}`;
    try {
      accessSync(p, constants.X_OK);
      return p;
    } catch {
      // keep looking
    }
  }
  return null;
}

/** spawn, feed stdin, collect both streams, and hold a deadline over the whole group. */
function spawnCollect(argv, { cwd, stdin, timeoutMs, signal }) {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      // `detached` is what makes the child a process-group leader, so the kill below
      // reaches its children — without it, killing the direct child orphans anything it
      // started, and a `sleep` left behind by a killed tool is a real thing that happened
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let done = false;

    const finish = (code, how) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      resolve({ code: code ?? -1, stdout, stderr, timedOut: how === "timeout" });
    };

    const killGroup = (sig) => {
      try {
        if (process.platform === "win32") child.kill(sig);
        else process.kill(-child.pid, sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
          // already gone
        }
      }
    };

    // TERM first so a well-behaved program can clean up, then KILL whatever ignored it
    const onAbort = () => {
      killGroup("SIGTERM");
      setTimeout(() => killGroup("SIGKILL"), 250).unref?.();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");
      setTimeout(() => killGroup("SIGKILL"), 250).unref?.();
    }, timeoutMs);
    timer.unref?.();

    signal?.addEventListener?.("abort", onAbort, { once: true });

    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => {
      stderr += String(e.message);
      finish(-1, "error");
    });
    child.on("close", (code) => finish(code, timedOut ? "timeout" : "exit"));

    if (stdin != null) child.stdin.end(stdin);
    else child.stdin.end();
  });
}
