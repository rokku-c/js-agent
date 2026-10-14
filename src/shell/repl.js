// repl.js — the shell. ES2025 is the language; a command line is sugar on top.
//
// ── the two halves ──
// a line is either a command or JavaScript, and parse.js decides which for the *whole*
// line before anything is split. this file is what runs either one.
//
// in command mode each stage is looked up, its arguments are bound against its own
// declaration, and the piped value lands in the parameter marked `input`. in JS mode the
// line goes to a context holding the namespace and every command as a function — so
// `ls('/dev')` and `ls /dev` are two spellings of one call, and there is always a way to
// do from JS what the shell can do from sugar.
//
// ── the one thing a shell must get right ──
// a shell that swallows a typo into the language becomes a shell people stop trusting.
// `lss /dev` must not be `lss / dev` → "lss is not defined". parse.js can only classify a
// line as a command if the name is known, so a typo arrives as JS — and this file
// recognises that shape and says `unknown command 'lss'` instead.

import * as vm from "node:vm";
import * as readline from "node:readline";
import { VfsError, reason } from "../kernel/errors.js";
import { validateInput, nearest } from "../core/tools.js";
import { parseLine, bindArguments, inputSlot } from "./parse.js";
import { builtins, builtinNames, render } from "./builtins.js";
import { style, mark } from "./style.js";

export class Shell {
  #vfs;
  #cwd = "/";
  #sandbox;
  #context;
  #commands = new Map();
  #binTools = new Map();
  #evaluate;

  constructor(vfs, { out = (s) => process.stdout.write(s), err = (s) => process.stderr.write(s) } = {}) {
    this.#vfs = vfs;
    this.out = out;
    this.err = err;

    for (const b of builtins) this.#commands.set(b.name, { tool: b, origin: "builtin" });

    // /bin is the other half of the command set. reading it through the namespace rather
    // than importing src/tools/ directly is the point: the shell can only run what the
    // namespace actually contains, which is the same rule the agent lives under.
    this.refresh();

    this.#sandbox = this.#makeSandbox();
    this.#context = vm.createContext(this.#sandbox, { name: "js-agent-shell" });
  }

  get vfs() {
    return this.#vfs;
  }
  get cwd() {
    return this.#cwd;
  }

  /** re-read /bin. called on bootstrap and whenever the mount table changes, so a
   *  `mount bin /bin tools=read,edit` at the prompt takes effect immediately. */
  refresh() {
    this.#binTools.clear();
    try {
      const res = this.#vfs.resolve("/bin");
      for (const t of res.mount.instance.tools?.() ?? []) {
        this.#binTools.set(t.name, t);
      }
    } catch {
      // no /bin mounted — the shell still works, it just has fewer commands
    }
  }

  // ── the command registry ───────────────────────────────────────────────────────

  lookup(name) {
    return this.#commands.get(name)?.tool ?? this.#binTools.get(name) ?? null;
  }

  originOf(name) {
    if (this.#commands.has(name)) return "builtin";
    if (this.#binTools.has(name)) return "/bin (a mounted tool)";
    return null;
  }

  isCommand(name) {
    return this.#commands.has(name) || this.#binTools.has(name);
  }

  commandNames() {
    return [...new Set([...this.#commands.keys(), ...this.#binTools.keys()])];
  }

  /** register a command from outside — how `agent` is added, and how a mount can
   *  contribute a command that is not a tool. */
  register(tool, origin = "builtin") {
    this.#commands.set(tool.name, { tool, origin });
    if (this.#sandbox) this.#sandbox[tool.name] = this.#makeCallable(tool);
  }

  // ── running a line ─────────────────────────────────────────────────────────────

  /**
   * @param {string} line
   * @returns {Promise<{value: any, printed: boolean}>}
   */
  async execute(line) {
    const parsed = parseLine(line, (n) => this.isCommand(n));
    if (!parsed) return { value: undefined, printed: false };

    if (parsed.mode === "js") {
      let value;
      try {
        value = await this.evalJs(parsed.code);
      } catch (e) {
        throw this.#explainTypo(parsed.code, e);
      }
      return this.#finish(value, null);
    }

    let value;
    for (const stage of parsed.stages) {
      const tool = this.lookup(stage.name);
      // parse.js already proved the name resolves; this is for a mount that changed
      // between the parse and the run, which cannot happen here but should not be a crash
      if (!tool) throw new VfsError("ENOENT", `no such command: ${stage.name}`);

      // bind the piped value first: a `{ … }` argument may read `_`
      this.#sandbox._ = value;
      const raw = await bindArguments(tool, stage.tokens, (src) => this.evaluate(src));
      if (value !== undefined) {
        const slot = inputSlot(tool);
        if (slot && raw[slot] === undefined) raw[slot] = value;
      }
      value = await this.invoke(tool, raw);
    }

    return this.#finish(value, parsed.redirect);
  }

  #finish(value, redirect) {
    if (value && typeof value === "object" && value.exit) return { value, printed: true };

    if (redirect) {
      const path = this.#vfs.abs(redirect.path, this.#cwd);
      return this.#vfs
        .write(path, typeof value === "string" ? value : render(value), {
          create: true,
          append: redirect.append,
        })
        .then((r) => {
          // a device's reply is what a redirect to /dev/providers/… is *for*: the write
          // returns the answer, and printing it is the whole point of the command
          const printed = r.value !== undefined;
          if (printed) this.out(render(r.value) + "\n");
          return { value: r.value ?? r, printed: printed || true };
        });
    }

    const text = render(value);
    if (text !== "") this.out(text + "\n");
    return { value, printed: text !== "" };
  }

  /** validate + persist side effects (cd) + run. one path for builtins and tools alike. */
  async invoke(tool, rawInput) {
    const input = validateInput(tool, rawInput);
    const result = await tool.run({
      vfs: this.#vfs,
      cwd: this.#cwd,
      input,
      shell: this,
      log: (m) => this.err(m + "\n"),
      signal: null,
    });
    if (result && typeof result === "object" && typeof result.cd === "string") {
      this.#cwd = result.cd;
      this.#sandbox.cwd = result.cd;
    }
    return result;
  }

  // ── JavaScript ─────────────────────────────────────────────────────────────────

  /** a command as a JS function: `ls('/dev')`, `write('/x', 'hi')`, or named
   *  `ls({ path: '/dev', long: true })` when there is any doubt about the order. */
  #makeCallable(tool) {
    return async (...args) => {
      const raw = Object.create(null);
      if (args.length === 1 && args[0] && typeof args[0] === "object" && !Array.isArray(args[0])) {
        Object.assign(raw, args[0]);
      } else {
        args.forEach((v, i) => {
          const p = tool.positional[i];
          if (p) raw[p.name] = v;
        });
      }
      return this.invoke(tool, raw);
    };
  }

  #makeSandbox() {
    const sandbox = {
      cwd: this.#cwd,
      _: undefined,
      print: (...a) => this.out(a.map(render).join(" ") + "\n"),
      console: {
        log: (...a) => this.out(a.map(render).join(" ") + "\n"),
        error: (...a) => this.err(a.map(render).join(" ") + "\n"),
        warn: (...a) => this.err(a.map(render).join(" ") + "\n"),
      },
      cmd: Object.create(null),
      vfs: Object.create(null),
    };

    // the namespace, as an API — the same operations the tools use, resolved against the
    // shell's working directory so `vfs.read('notes.md')` means what it looks like
    const abs = (p) => this.#vfs.abs(p, this.#cwd);
    Object.assign(sandbox.vfs, {
      read: async (p) => this.#vfs.read(abs(p)),
      write: async (p, data, opts) => this.#vfs.write(abs(p), data, { create: true, ...opts }),
      ls: async (p = ".") => this.#vfs.list(abs(p)),
      stat: async (p) => this.#vfs.stat(abs(p)),
      exists: async (p) => this.#vfs.exists(abs(p)),
      mkdir: async (p) => this.#vfs.mkdirp(abs(p)),
      remove: async (p, opts) => this.#vfs.remove(abs(p), opts),
      mount: (driver, at, opts) => this.#vfs.mount(driver, at, opts),
      umount: (at) => this.#vfs.umount(at),
      mounts: () => this.#vfs.mounts(),
      open: async (p, flags) => this.#vfs.open(abs(p), flags),
      abs,
    });

    for (const name of this.commandNames()) {
      const tool = this.lookup(name);
      sandbox[name] = this.#makeCallable(tool);
      sandbox.cmd[name] = sandbox[name];
    }
    return sandbox;
  }

  /** evaluate a `{ … }` argument or a JS line. */
  evaluate(src) {
    return this.evalJs(src, { allowAsync: false });
  }

  /**
   * Run JavaScript the way a shell should: declarations persist between lines, and
   * top-level `await` works.
   *
   * `vm.runInContext(code)` is what makes `let`/`const`/`using` at the top level persist —
   * they land in the context's own global lexical scope, which is exactly a REPL's lifetime.
   * the async wrapper is for the one thing a plain script cannot do.
   *
   * ── and why the choice is made this way ──
   * the tempting test is "did it fail with a SyntaxError mentioning await". it is wrong, and
   * quietly so: in a *script* (unlike a module) `await` is a legal identifier, so
   * `await f()` does not raise a syntax error about await — it parses as a call to something
   * named `await` and fails later, or worse, V8 reports `Unexpected identifier 'f'`. a check
   * keyed on the word "await" never fires and every awaited line breaks for a reason that
   * names an identifier nobody wrote. so any SyntaxError retries as async, and the original
   * error is what surfaces if the retry fails too — it points at the text that was typed.
   *
   * the same applies to `instanceof SyntaxError`, which does not hold across a vm realm.
   */
  async evalJs(code, { allowAsync = true } = {}) {
    const trimmed = String(code ?? "").trim();
    if (!trimmed) return undefined;

    if (!allowAsync) {
      return vm.runInContext(`(${trimmed})`, this.#context, { filename: "<arg>" });
    }

    let first;
    try {
      return await vm.runInContext(trimmed, this.#context, { filename: "<shell>" });
    } catch (e) {
      if (e?.name !== "SyntaxError") throw e;
      first = e;
    }

    try {
      return await vm.runInContext(`(async () => (${trimmed}))()`, this.#context, { filename: "<shell>" });
    } catch (e) {
      if (e?.name !== "SyntaxError") throw e;
    }
    try {
      return await vm.runInContext(`(async () => { ${trimmed} })()`, this.#context, { filename: "<shell>" });
    } catch (e) {
      throw first ?? e;
    }
  }

  /** a value that is a promise from a shell line is worth waiting for, and one that is a
   *  device handle is worth closing — this is where `await using` pays for itself. */
  static async settle(value) {
    return await value;
  }

  /**
   * A mistyped command is a JavaScript ReferenceError, and that is the wrong error.
   *
   * parse.js can only call a line a command when the name is *known*, so `lss /dev` falls
   * through to JavaScript and dies as `lss / dev` → "lss is not defined" — which names a
   * variable that was never meant to be one and suggests nothing. a shell that turns a
   * typo into that is a shell people stop trusting, so the shape is recognised and the
   * question they actually asked is answered instead.
   */
  #explainTypo(code, e) {
    // `instanceof ReferenceError` does NOT work here, and it is worth knowing why: an
    // error thrown inside a vm context is constructed by *that realm's* intrinsics, so it
    // is a ReferenceError there and a plain Error out here. the name is the portable fact.
    if (e?.name !== "ReferenceError") return e;
    const m = /^([A-Za-z_][A-Za-z0-9_-]*)/.exec(code.trim());
    if (!m) return e;
    const word = m[1];
    // only when the line *looks* like an invocation — a bare identifier after it is an
    // argument, not an operand. `x + 1` must keep its own error.
    const rest = code.trim().slice(word.length);
    if (rest !== "" && !/^\s/.test(rest)) return e;
    if (!e.message.startsWith(word)) return e;
    // …and only when what follows is *arguments*, not an operand. `nope + 1` is an
    // expression whose own error is the right one; `lss /dev` is a command someone
    // mistyped. the operator list is what tells them apart, and `/` is deliberately not
    // on it — a leading slash is far more often a path than it is a division.
    if (/^\s*[-+*%<>=!&|^~?:.,;)\]}]/.test(rest)) return e;

    const hit = nearest(word, this.commandNames());
    return new VfsError("ENOENT", `unknown command '${word}'`, {
      hint: hit
        ? `did you mean '${hit}'? (or \`js ${code.trim()}\` to evaluate it as JavaScript)`
        : `\`js ${code.trim()}\` evaluates it as JavaScript; \`help\` lists what this shell knows`,
    });
  }
}

/**
 * The interactive loop.
 *
 * line-based, not full-screen, and for nu-agent's reason: the terminal's own line editor
 * already does arrows, history and bracketed paste correctly, and re-implementing them is
 * how a shell ends up worse than the one it replaced. it also means a crash costs a line,
 * not a screen.
 */
export async function repl(shell, { banner = true } = {}) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: style.prompt("› "),
    historySize: 500,
    completer: (line) => {
      const parts = line.split(/\s+/);
      if (parts.length <= 1) {
        const hits = shell.commandNames().filter((n) => n.startsWith(parts[0] ?? ""));
        return [hits.length ? hits : shell.commandNames(), parts[0] ?? ""];
      }
      return [[], line];
    },
  });

  if (banner) {
    shell.err(
      [
        style.dim(`js-agent · node ${process.versions.node} · pid ${process.pid}`),
        style.dim(`mounted: ${shell.vfs.mounts().map((m) => m.at).join(" ")}`),
        style.dim("`help` for what this shell knows · `mount --list` for what is reachable"),
        "",
      ].join("\n")
    );
  }

  rl.prompt();
  for await (const line of rl) {
    const text = line.trim();
    if (text) {
      try {
        const { value } = await shell.execute(text);
        if (value && typeof value === "object" && value.exit) break;
      } catch (e) {
        shell.err(mark("err", style.red(reason(e))) + "\n");
      }
    }
    rl.prompt();
  }
  rl.close();
  shell.out("\n");
}
