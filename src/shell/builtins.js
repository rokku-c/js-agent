// builtins.js — the shell's own commands.
//
// ── what belongs here and what does not ──
// these are the commands a *shell* has: navigation, the mount table, the pipe helpers that
// make a pipeline worth writing. the tools in /bin are the ones a *model* is offered, and
// they live in src/tools/ — the shell reaches them through /bin like anything else.
//
// the overlap is deliberate where it exists. `ls` is here as well as in /bin because a
// namespace you cannot look at is a namespace you cannot reason about, and that should not
// depend on which tools happen to be mounted.
//
// every command declares `params` in the same shape the tools do — one declaration serving
// the model and the shell — which is why a flag typo is an error here rather than a
// silently ignored argument.

import { defineTool } from "../core/tools.js";
import { VfsError } from "../kernel/errors.js";
import { parseSpec, formatSpec } from "../kernel/mounts.js";
import { knownDrivers } from "../kernel/registry.js";
import { clamp, countLines } from "../core/fileio.js";

const human = (n) => {
  if (n == null) return "-";
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
  return `${(n / 1024 / 1024).toFixed(1)}M`;
};

/** print a value the way a shell should: a string as itself, a record as JSON, nothing
 *  for nothing. a table would be prettier, but `| json` has to stay exact and one
 *  rendering cannot be both. */
export function render(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return JSON.stringify(value, null, 2);
}

export const builtins = [
  defineTool({
    name: "ls",
    description: "list a directory — the namespace, mount points included",
    params: {
      path: { type: "string", positional: 0, default: ".", description: "directory to list" },
      long: { type: "boolean", flag: "long", short: "l", description: "one line per entry, with type and size" },
    },
    async run({ vfs, cwd, input }) {
      const path = vfs.abs(input.path, cwd);
      const entries = await vfs.list(path);
      if (!entries.length) return "(empty directory)";
      if (!input.long) {
        return entries.map((e) => (e.type === "dir" ? e.name + "/" : e.name)).join("\n");
      }
      return entries
        .map((e) => {
          const kind = e.type === "dir" ? "d" : e.device ? "c" : "-";
          const notes = [];
          if (e.mountpoint) notes.push(`mount:${e.driver}`);
          if (e.callable) notes.push("callable");
          if (e.executable) notes.push("tool");
          if (e.target) notes.push(`→ ${e.target}`);
          return `${kind} ${human(e.size).padStart(7)}  ${e.name}${notes.length ? "  " + notes.join(" ") : ""}`;
        })
        .join("\n");
    },
  }),

  defineTool({
    name: "cat",
    description: "read a file and print it",
    params: {
      path: { type: "string", positional: 0, required: true, description: "file to read" },
      maxBytes: { type: "integer", flag: "max-bytes", default: 200000, description: "refuse files larger than this" },
    },
    async run({ vfs, cwd, input }) {
      const path = vfs.abs(input.path, cwd);
      const st = await vfs.stat(path);
      if (st.type === "dir") throw new VfsError("EISDIR", "is a directory", { path });
      const bytes = await vfs.read(path, { encoding: "binary" });
      const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
      if (text.includes("�") && bytes.length > 0) {
        throw new VfsError("EIO", "this file is not text", {
          path,
          hint: "use `shell file <path>` to find out what it is",
        });
      }
      return clamp(text.replace(/\n$/, ""), input.maxBytes);
    },
  }),

  defineTool({
    name: "stat",
    description: "show what is at a path — type, size, mount, whether it is a device",
    params: { path: { type: "string", positional: 0, required: true } },
    async run({ vfs, cwd, input }) {
      const path = vfs.abs(input.path, cwd);
      const st = await vfs.stat(path);
      // ask the mount table rather than reconstructing it from the path: the resolver
      // already knows which mount won, and re-deriving that here is how `stat` ends up
      // attributing /host/x to the root filesystem
      const { mount } = vfs.resolve(path);
      return {
        path,
        type: st.type,
        size: st.size,
        mode: "0o" + (st.mode ?? 0).toString(8),
        mtime: st.mtime ? new Date(st.mtime).toISOString() : null,
        device: st.device ?? false,
        callable: st.callable ?? false,
        appendable: st.appendable ?? false,
        mountpoint: st.mountpoint ?? path === mount.at,
        driver: st.driver ?? mount.driver,
        mount_options: mount.options,
      };
    },
  }),

  defineTool({
    name: "cd",
    description: "change the working directory",
    params: { path: { type: "string", positional: 0, default: "/" } },
    async run({ vfs, cwd, input }) {
      const path = vfs.abs(input.path, cwd);
      const st = await vfs.stat(path);
      if (st.type !== "dir") throw new VfsError("ENOTDIR", "not a directory", { path });
      return { cd: path };
    },
  }),

  defineTool({
    name: "pwd",
    description: "print the working directory",
    params: {},
    async run({ cwd }) {
      return cwd;
    },
  }),

  defineTool({
    name: "echo",
    description: "print its arguments",
    params: {
      text: {
        type: "any",
        positional: 0,
        rest: true,
        input: true,
        default: [],
        description: "the words to print, joined by spaces",
      },
      json: { type: "boolean", flag: "json", description: "parse the text as JSON and pass the value through" },
    },
    async run({ input }) {
      const parts = Array.isArray(input.text) ? input.text : [input.text];
      const text = parts
        .filter((p) => p !== undefined && p !== null && p !== "")
        .map((p) => (typeof p === "string" ? p : JSON.stringify(p)))
        .join(" ");
      if (input.json) return JSON.parse(text);
      // a trailing newline, because that is what `echo` means and because without it
      // `echo a >> f` twice produces `aa` — which is a real thing that happened here
      return text + "\n";
    },
  }),

  defineTool({
    name: "mount",
    description:
      "mount a driver into the namespace, or list what is mounted. " +
      "spec is `driver:at[,key=value…]`",
    params: {
      spec: { type: "string", positional: 0, description: "e.g. hostfs:/host,source=.,mode=ro" },
      list: { type: "boolean", flag: "list", description: "show the mount table" },
    },
    async run({ vfs, input }) {
      if (input.list || !input.spec) {
        const rows = vfs.mounts().map((m) => formatSpec(m));
        return rows.length ? rows.join("\n") : "(nothing mounted)";
      }
      const spec = parseSpec(input.spec);
      await vfs.mount(spec.driver, spec.at, spec.options);
      return `mounted ${spec.driver} at ${spec.at}`;
    },
  }),

  defineTool({
    name: "umount",
    description: "unmount whatever is at a path",
    params: { path: { type: "string", positional: 0, required: true } },
    async run({ vfs, cwd, input }) {
      const path = vfs.abs(input.path, cwd);
      await vfs.umount(path);
      return `unmounted ${path}`;
    },
  }),

  defineTool({
    name: "mkdir",
    description: "create a directory, and its parents",
    params: { path: { type: "string", positional: 0, required: true } },
    async run({ vfs, cwd, input }) {
      const path = vfs.abs(input.path, cwd);
      await vfs.mkdirp(path);
      return `created ${path}`;
    },
  }),

  defineTool({
    name: "rm",
    description: "remove a file, or a directory with --recursive",
    params: {
      path: { type: "string", positional: 0, required: true },
      recursive: { type: "boolean", flag: "recursive" },
    },
    async run({ vfs, cwd, input }) {
      const path = vfs.abs(input.path, cwd);
      await vfs.remove(path, { recursive: input.recursive });
      return `removed ${path}`;
    },
  }),

  defineTool({
    name: "mv",
    description: "rename a path",
    params: {
      from: { type: "string", positional: 0, required: true },
      to: { type: "string", positional: 1, required: true },
    },
    async run({ vfs, cwd, input }) {
      const a = vfs.abs(input.from, cwd);
      const b = vfs.abs(input.to, cwd);
      await vfs.rename(a, b);
      return `${a} → ${b}`;
    },
  }),

  defineTool({
    name: "head",
    description: "the first N lines of the input",
    params: {
      n: { type: "integer", flag: "n", default: 10 },
      text: { type: "string", positional: 0, default: "", input: true },
    },
    async run({ input }) {
      return input.text.split("\n").slice(0, input.n).join("\n");
    },
  }),

  defineTool({
    name: "tail",
    description: "the last N lines of the input",
    params: {
      n: { type: "integer", flag: "n", default: 10 },
      text: { type: "string", positional: 0, default: "", input: true },
    },
    async run({ input }) {
      const lines = input.text.split("\n");
      return lines.slice(Math.max(0, lines.length - input.n)).join("\n");
    },
  }),

  defineTool({
    name: "count",
    description: "how many items — lines of text, or elements of a list",
    params: { value: { type: "any", positional: 0, input: true } },
    async run({ input }) {
      const v = input.value;
      if (v == null || v === "") return 0;
      if (Array.isArray(v)) return v.length;
      if (typeof v === "string") return countLines(v);
      if (typeof v === "object") return Object.keys(v).length;
      return 1;
    },
  }),

  defineTool({
    name: "json",
    description: "parse the input as JSON, or re-render it as JSON",
    params: {
      value: { type: "any", positional: 0, input: true },
      pretty: { type: "boolean", flag: "pretty", default: true },
    },
    async run({ input }) {
      const v = typeof input.value === "string" ? JSON.parse(input.value) : input.value;
      return input.pretty ? JSON.stringify(v, null, 2) : JSON.stringify(v);
    },
  }),

  defineTool({
    name: "which",
    description: "where a command comes from — a builtin, or /bin",
    params: {
      name: { type: "string", positional: 0, required: true, description: "the command to look up" },
    },
    async run({ shell, input }) {
      const origin = shell.originOf(input.name);
      if (!origin) {
        const names = shell.commandNames();
        throw new VfsError("ENOENT", `no such command: ${input.name}`, {
          hint: `this namespace has: ${names.join(", ")}`,
        });
      }
      return `${input.name}: ${origin}`;
    },
  }),

  defineTool({
    name: "help",
    description: "what the shell knows how to do",
    params: { name: { type: "string", positional: 0, description: "show one command in detail" } },
    async run({ shell, input }) {
      if (input.name) {
        const tool = shell.lookup(input.name);
        if (!tool) throw new VfsError("ENOENT", `no such command: ${input.name}`);
        const lines = [`${tool.name} — ${tool.description}`, ""];
        for (const [n, p] of Object.entries(tool.params)) {
          const long = `--${p.flag ?? n}`;
          const how =
            p.positional !== undefined
              ? `arg ${p.positional + 1}`
              : p.short
                ? `-${p.short}, ${long}`
                : p.flag || n
                  ? long
                  : "(input)";
          const extra = [
            p.required ? "required" : null,
            p.default !== undefined ? `default ${JSON.stringify(p.default)}` : null,
            p.input ? "receives the piped value" : null,
          ].filter(Boolean);
          lines.push(`  ${how.padEnd(14)} ${p.type ?? "any"}  ${p.description ?? ""}${extra.length ? `  (${extra.join(", ")})` : ""}`);
        }
        return lines.join("\n");
      }

      const names = shell.commandNames().sort();
      const own = builtins.map((b) => b.name);
      const fromBin = names.filter((n) => !own.includes(n));
      return [
        "the line is JavaScript unless its first word names a command.",
        "  js <code>   force JavaScript      ! <cmd>   force a command",
        "  a | b       b receives the piped value in its declared input slot ($_)",
        "  x > path    write the result to a path (append with >>)",
        "",
        `shell commands:  ${own.sort().join(" ")}`,
        fromBin.length ? `/bin (mounted):  ${fromBin.join(" ")}` : "/bin (mounted):  (nothing)",
        "",
        `drivers available: ${knownDrivers().join(" ")}`,
        "help <name> for one command's arguments.",
      ].join("\n");
    },
  }),

  defineTool({
    name: "ps",
    description: "what this namespace is — mounts, drivers, memory",
    params: {},
    async run({ vfs }) {
      const mounts = vfs.mounts();
      const rows = mounts.map((m) => `  ${m.at.padEnd(20)} ${m.driver}`);
      const mem = mounts.find((m) => m.driver === "mem");
      const root = mem ? vfs.resolve("/") : null;
      const usage = root?.mount?.instance?.usage?.();
      return [
        `js-agent · node ${process.versions.node} · pid ${process.pid}`,
        `uptime ${(process.uptime() | 0)}s · heap ${human(process.memoryUsage().heapUsed)}`,
        "",
        "mounts:",
        ...rows,
        usage ? `\nroot filesystem: ${human(usage.bytes)} in memory` : "",
      ]
        .filter(Boolean)
        .join("\n");
    },
  }),

  defineTool({
    name: "exit",
    description: "leave the shell",
    params: {},
    async run() {
      return { exit: true };
    },
  }),
];

export const builtinNames = builtins.map((b) => b.name);
