#!/usr/bin/env node
// bootstrap.js — the OS comes up.
//
// the order is the design:
//
//   1. arm the airgap, if asked
//   2. build a namespace out of nothing: / , /dev, /proc, /bin
//   3. mount what the caller named — and *nothing* they did not
//   4. start the shell, or run one line, or run the agent
//
// step 3 is where this differs from every other agent runtime. there is no ambient
// filesystem, no ambient network, and no ambient model: the host is mounted read-only at
// /host unless `--rw` says otherwise, and reaching a model takes three mounts that are
// each visible in `mount --list` and each refusable on their own.

import { Vfs } from "./src/kernel/vfs.js";
import { bootMounts, parseSpec } from "./src/kernel/mounts.js";
import { installAirgap } from "./src/kernel/airgap.js";
import { Shell, repl } from "./src/shell/repl.js";
import { agentCommand } from "./src/core/agent-command.js";
import { style, mark } from "./src/shell/style.js";
import { reason } from "./src/kernel/errors.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export const VERSION = "0.1.0";

const USAGE = `
js-agent — an agent runtime that runs inside an operating system it mounts itself.

  js-agent [options] [script.js]

what there is to begin with
  /            an in-memory tree, writable, gone when you leave
  /dev         null, zero, random, tty
  /proc        the mount table, readable — this is how you find out what is reachable
  /bin         the tools: read, write, edit, ls, calc, js, shell, task
  /host        the current directory, mounted READ-ONLY (use --rw, or --no-host to skip)

and nothing else. no network, no model, no home directory — each of those is a mount.

options
  --mount <spec>      mount a driver: driver:at[,key=value…]   (repeatable)
  --rw                mount /host read-write
  --no-host           do not mount the host filesystem at all
  --root <dir>        the host directory mounted at /host        (default: .)
  --state <dir>       mount /agent there, which is what turns sessions on
  --tools <a,b,c>     what /bin contains   (default: read,write,edit,ls,calc,js,shell,task)

  --airgap            replace globalThis.fetch with a tripwire that explains itself
  -e, --exec <line>   run one shell line and exit
  -f, --file <path>   run a script file (host path) and exit
  -q, --quiet         no banner

  --agent <task>      run the agent loop on <task>
  --agent-tools <a,b,c>   which of /bin the agent may use   (default: read,write,edit)
  --agent-session <id>    keep this run in a session
  --resume                continue that session instead of starting it

  -h, --help          this
  -v, --version       version

the three mounts a model needs, and none of which are implied by the others:

  --mount secret:/dev/secrets,env=ANTHROPIC_AUTH_TOKEN
  --mount net:/dev/net,allow=api.anthropic.com
  --mount ai:/dev/providers/ai,vendor=anthropic,token-file=/dev/secrets/ANTHROPIC_AUTH_TOKEN

then:  cat /dev/providers/ai/type/api/anthropic/messages/model/claude-sonnet-5
`;

export function parseArgv(argv) {
  const opts = {
    mounts: [],
    rw: false,
    host: true,
    root: ".",
    state: null,
    tools: "read,write,edit,ls,calc,js,shell,task",
    agentTools: "read,write,edit",
    airgap: false,
    exec: null,
    file: null,
    quiet: false,
    agent: null,
    script: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    switch (a) {
      case "--mount":
        opts.mounts.push(next());
        break;
      case "--rw":
        opts.rw = true;
        break;
      case "--no-host":
        opts.host = false;
        break;
      case "--root":
        opts.root = next();
        break;
      case "--state":
        opts.state = next();
        break;
      case "--tools":
        opts.tools = next();
        break;
      case "--agent-tools":
        opts.agentTools = next();
        break;
      case "--airgap":
        opts.airgap = true;
        break;
      case "-e":
      case "--exec":
        opts.exec = next();
        break;
      case "-f":
      case "--file":
        opts.file = next();
        break;
      case "-q":
      case "--quiet":
        opts.quiet = true;
        break;
      case "--agent":
        opts.agent = next();
        break;
      case "--agent-session":
        opts.agentSession = next();
        break;
      case "--resume":
        opts.resume = true;
        break;
      case "-h":
      case "--help":
        opts.help = true;
        break;
      case "-v":
      case "--version":
        opts.version = true;
        break;
      default:
        if (a.startsWith("-")) throw new Error(`unknown option: ${a}`);
        if (opts.script) throw new Error(`unexpected extra argument: ${a}`);
        opts.script = a;
    }
  }
  return opts;
}

/** a line reader for /dev/tty — available when the shell is not itself holding stdin. */
function makeLineReader(interactive) {
  if (interactive) return null;
  return async () => {
    const { createInterface } = await import("node:readline/promises");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question("");
    rl.close();
    return answer;
  };
}

export async function boot(argv = process.argv.slice(2), { out = process.stdout, err = process.stderr } = {}) {
  const opts = parseArgv(argv);
  if (opts.help) {
    out.write(USAGE.trimStart() + "\n");
    return { code: 0 };
  }
  if (opts.version) {
    out.write(`${VERSION}\n`);
    return { code: 0 };
  }

  const interactive = !opts.exec && !opts.file && !opts.script && !opts.agent;
  if (opts.airgap) installAirgap();

  const log = (m) => err.write(style.dim(m) + "\n");
  const vfs = new Vfs({ log });

  const defaultMounts = [];
  if (opts.host) {
    defaultMounts.push({
      driver: "hostfs",
      at: "/host",
      options: { source: path.resolve(opts.root), mode: opts.rw ? "rw" : "ro" },
    });
  }

  await bootMounts(vfs, {
    tools: opts.tools.split(",").map((s) => s.trim()).filter(Boolean),
    state: opts.state ? path.resolve(opts.state) : null,
    mounts: defaultMounts,
  });

  // named mounts go on last so they can override a default (`--mount hostfs:/host,…`)
  for (const spec of opts.mounts) {
    const m = parseSpec(spec);
    if (vfs.mounts().some((x) => x.at === m.at)) await vfs.umount(m.at);
    await vfs.mount(m.driver, m.at, m.options);
  }

  // /dev/tty needs the terminal, and the terminal belongs to whoever is running the shell
  const devRes = vfs.resolve("/dev");
  devRes.mount.instance.setIO?.({
    write: (s) => out.write(s),
    error: (s) => err.write(s),
    readLine: makeLineReader(interactive),
  });

  const shell = new Shell(vfs, { out: (s) => out.write(s), err: (s) => err.write(s) });
  vfs.onMount(() => shell.refresh());
  // `agent` is a command like any other, and it is registered after the shell exists
  // because it needs the shell's own namespace rather than one of its own
  shell.register(agentCommand);

  const ctx = { vfs, shell, opts, out, err, log };

  if (opts.agent) return await runAgentTask(ctx);
  if (opts.exec) return await runLines(ctx, [opts.exec], { echo: false });
  if (opts.file) {
    const text = await fs.readFile(path.resolve(opts.file), "utf8");
    return await runLines(ctx, text.split("\n"), { echo: false });
  }
  if (opts.script) {
    const text = await fs.readFile(path.resolve(opts.script), "utf8");
    return await runLines(ctx, text.split("\n"), { echo: false });
  }

  await repl(shell, { banner: !opts.quiet });
  return { code: 0 };
}

/** run a list of lines as a script: stop at the first failure, and say which line. */
async function runLines({ shell, err }, lines, { echo }) {
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const text = raw.trim();
    if (!text || text.startsWith("#")) continue;
    if (echo) err.write(style.dim(`${i + 1}│ `) + text + "\n");
    try {
      const { value } = await shell.execute(text);
      if (value && typeof value === "object" && value.exit) break;
    } catch (e) {
      err.write(mark("err", `${style.red(reason(e))}${style.dim(`  (line ${i + 1})`)}`) + "\n");
      return { code: 1 };
    }
  }
  return { code: 0 };
}

async function runAgentTask({ vfs, shell, err, opts }) {
  try {
    const extra = [
      opts.agentSession ? ` --session ${opts.agentSession}` : "",
      opts.resume ? " --resume" : "",
    ].join("");
    const { value } = await shell.execute(
      `agent ${JSON.stringify(opts.agent)} --tools ${opts.agentTools} --stream --md${extra}`
    );
    void value;
  } catch (e) {
    err.write(mark("err", style.red(reason(e))) + "\n");
    return { code: 1 };
  }
  return { code: 0 };
}
