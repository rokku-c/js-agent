// shell.test.js — the line parser, which is where a shell earns or loses trust.

import { test } from "node:test";
import assert from "node:assert/strict";
import { shellOf, tmpdir } from "./helpers.js";
import { parseLine } from "../src/shell/parse.js";

const isCommand = (n) => ["ls", "cat", "count", "echo", "mount", "read", "write", "json"].includes(n);

test("parse: the mode is decided for the whole line, before anything is split", () => {
  // a command line, and only then are the separators looked for
  assert.equal(parseLine("ls /dev", isCommand).mode, "command");
  assert.equal(parseLine("ls /dev | count", isCommand).mode, "command");
  assert.equal(parseLine("ls /dev | count", isCommand).stages.length, 2);

  // `|` is also bitwise-or. this is the case the whole design exists for: split first and
  // `4 | 1` becomes a two-stage pipeline that tries to run `1`.
  assert.equal(parseLine("4 | 1", isCommand).mode, "js");
  assert.equal(parseLine("mode = 4 | 1", isCommand).mode, "js");

  // and `>` is also greater-than
  assert.equal(parseLine("total = a > b", isCommand).mode, "js", "an assignment is JavaScript");
  // `count > 0` is command mode — and *that* is exactly why it is refused rather than
  // quietly interpreted: the redirect target looks like a comparison, so the shell says so
  assert.throws(() => parseLine("count > 0", isCommand), /looks like a comparison/);

  // a `|` inside a regex or a template literal is never seen by the splitter
  assert.equal(parseLine("x = s.replace(/a|b/, '')", isCommand).mode, "js");
  assert.equal(parseLine("s = `a ${x | 0} b`", isCommand).mode, "js");

  // assignment to a name that happens to be a command is still assignment
  assert.equal(parseLine("read = 5", isCommand).mode, "js");
  // and a call is a call
  assert.equal(parseLine("ls('/dev')", isCommand).mode, "js");
});

test("parse: the escapes run both ways", () => {
  const forced = parseLine("js ls /dev", isCommand);
  assert.equal(forced.mode, "js");
  assert.equal(forced.code, "ls /dev");

  // `!` goes the other way: a line whose first token the classifier would not accept
  const command = parseLine("! count 5", isCommand);
  assert.equal(command.mode, "command");
  assert.equal(command.stages[0].name, "count");

  // both escapes are escapes; neither is a way to run something that is not there
  assert.throws(() => parseLine("! foo bar", isCommand), /is not a command/);
});

test("parse: a redirect to something that looks like a comparison is refused", () => {
  assert.throws(() => parseLine("count 5 > 0", isCommand), /looks like a comparison/);
  assert.throws(() => parseLine("ls /dev > 12", isCommand), /looks like a comparison/);
  const ok = parseLine("ls /dev > /tmp/out.txt", isCommand);
  assert.deepEqual(ok.redirect, { path: "/tmp/out.txt", append: false });
  assert.equal(parseLine("ls /dev >> /tmp/out.txt", isCommand).redirect.append, true);
});

test("parse: argument shapes", () => {
  const stage = (line) => parseLine(line, isCommand).stages[0].tokens;
  // a bare word is a flag; `--a=b` splits on the first `=`
  assert.equal(stage("ls --long")[0].kind, "flag");
  assert.equal(stage("ls --long")[0].name, "long");
  assert.equal(stage("cat --n=5")[0].value, "5");
  assert.equal(stage("cat --n=")[0].value, "");
  // a negative number is a number, never a flag
  assert.deepEqual(stage("cat -3"), [{ kind: "positional", value: "-3" }]);
  // `--` ends the flags, so a file named `--weird` is reachable
  assert.deepEqual(stage("cat -- --weird"), [{ kind: "positional", value: "--weird" }]);
  // an ambiguous short cluster is refused rather than guessed
  assert.throws(() => stage("cat -la"), /ambiguous/);
  // quotes: single is literal, double processes escapes
  assert.equal(stage("cat 'a b'")[0].value, "a b");
  assert.equal(stage('cat "a\\tb"')[0].value, "a\tb");
  assert.equal(stage("cat 'a\\tb'")[0].value, "a\\tb");
  // a backtick in an argument is refused, because every shell reader takes it as command
  // substitution and an argument that can call functions is not a restricted literal
  assert.throws(() => stage("cat `date`"), /backticks are not command substitution/);
  // `{}` is the one evaluation surface
  assert.deepEqual(stage("cat {1 + 1}")[0].value, { js: "1 + 1" });
});

test("shell: a line is a command or JavaScript, and both work", async () => {
  const s = await shellOf({ tools: ["read", "write", "ls", "calc"] });
  assert.equal((await s.run("ls /dev")).out.trim().split("\n").sort().join(" "), "null random tty urandom zero");
  assert.equal((await s.run("2 ** 10")).out.trim(), "1024");
  assert.equal((await s.run("await Promise.resolve('hi')")).out.trim(), "hi");
  // declarations persist between lines — a REPL that forgets is not a REPL
  await s.run("let n = 41");
  assert.equal((await s.run("n + 1")).out.trim(), "42");
});

test("shell: a pipe lands the value in the declared input slot, and nowhere else", async () => {
  const s = await shellOf({ tools: ["ls"] });
  assert.equal((await s.run("ls /dev | count")).out.trim(), "5");
  // only the declared slot receives it — a stage that wants to *compute* with the value
  // reads it by name, and a stage that declares no slot is not handed one anyway
  assert.equal((await s.run("echo abc | echo { _.trim() + 'def' }")).out.trim(), "abcdef");
  assert.equal((await s.run("count { 2 + 3 }")).out.trim(), "1", "a bare number still counts as one thing");
});

test("shell: redirection writes, and a device's reply is printed", async () => {
  const s = await shellOf({ tools: ["read", "write"] });
  await s.run("echo hello > /tmp/a.txt");
  assert.equal((await s.run("cat /tmp/a.txt")).out.trim(), "hello");
  await s.run("echo more >> /tmp/a.txt");
  assert.equal((await s.run("cat /tmp/a.txt")).out.trim(), "hello\nmore");
});

test("shell: a mistyped command is a mistyped command, not a ReferenceError", async () => {
  const s = await shellOf({ tools: ["read", "ls"] });
  await assert.rejects(() => s.run("lss /dev"), (e) => {
    assert.equal(e.code, "ENOENT");
    assert.match(e.message, /unknown command 'lss'/);
    assert.match(e.message, /did you mean 'ls'/);
    return true;
  });
  // an ordinary JavaScript error keeps its own message
  await assert.rejects(() => s.run("nope + 1"), /nope is not defined/);
});

test("shell: an unknown flag is refused with the list, never ignored", async () => {
  const s = await shellOf({ tools: ["ls"] });
  await assert.rejects(() => s.run("ls /dev --deeep"), (e) => {
    assert.match(e.message, /unknown argument 'deeep'/);
    assert.match(e.message, /known arguments: --path, --long/);
    return true;
  });
});

test("shell: the working directory is a namespace path, and `cd` moves it", async () => {
  const s = await shellOf({ tools: ["ls", "read"] });
  await s.run("mkdir /work");
  await s.run("echo hi > /work/note.txt");
  await s.run("cd /work");
  assert.equal((await s.run("pwd")).out.trim(), "/work");
  assert.equal((await s.run("cat note.txt")).out.trim(), "hi");
  assert.equal((await s.run("read note.txt")).out.trim(), "hi");
});

test("shell: mounting at the prompt takes effect immediately", async () => {
  const s = await shellOf({ tools: ["ls"] });
  assert.equal((await s.run("ls /")).out.includes("data"), false);
  await s.run("mount mem:/data");
  assert.equal((await s.run("ls /")).out.includes("data"), true);
  assert.equal((await s.run("ls /data")).out.trim(), "(empty directory)");
  await s.run("umount /data");
  assert.equal((await s.run("ls /")).out.includes("data"), false);
});

test("shell: the command set is the builtins plus what /bin holds", async () => {
  const withRead = await shellOf({ tools: ["read", "ls"] });
  assert.equal(withRead.shell.originOf("read"), "/bin (a mounted tool)");
  assert.equal(withRead.shell.originOf("cat"), "builtin");
  assert.equal(withRead.shell.originOf("write"), null);

  const without = await shellOf({ tools: ["ls"] });
  assert.equal(without.shell.originOf("read"), null, "a tool that is not mounted does not exist");
  await assert.rejects(() => without.run("read /proc/version"), /unknown command 'read'/);
});

test("shell: /bin is a catalogue whose entries read as their own definitions", async () => {
  const s = await shellOf({ tools: ["read", "edit"] });
  const def = JSON.parse(await s.vfs.read("/bin/read"));
  assert.equal(def.name, "read");
  assert.equal(def.input_schema.type, "object");
  assert.ok(def.params.path.positional === 0);
  // and it is a catalogue, not a launcher
  await assert.rejects(() => s.vfs.write("/bin/read", "x", { create: true }), /permission denied/);
});
