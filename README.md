# js-agent

> **Architecture documentation:** [docs/README.md](./docs/README.md)
> **Runtime API:** [getting started](./docs/getting-started.md) · `node examples/getting-started.js` · [implementation status](./docs/implementation.md)
> The CLI described below retains the prototype loop; the runtime API also provides explicit Environment, observer, workflow graph, and Git revision connector layers.

An agent runtime that runs inside an operating system it mounts itself.

```bash
node bin/js-agent                                    # an OS comes up; you get a shell
node bin/js-agent -e 'ls /dev'                       # nothing there but null and random
node bin/js-agent --mount net:/dev/net,allow=example.com -e 'ls /dev'
```

It is a port of [nu-agent](https://github.com/rokku-c/nu-agent) — the same loop, the same
folding, the same sessions, the same rule about naming — onto a namespace instead of a
shell. That one change is the whole point, so it is worth stating first.

---

## The rule

nu-agent's rule is one sentence: **the agent sees capabilities, not the host.** Its tools are
`read`, `write`, `edit`, `shell`, and exactly one of them is named after the host language,
because a model writing nushell has to know it is writing nushell and nothing else does.

Nushell is ambient — you start it and you are already inside a filesystem. JavaScript is not
an operating system at all. So this had to build the missing part, and building it made the
boundary explicit for the first time:

> **Nothing is ambient. Every capability the agent has — files, the network, the model
> itself — is a mount, and a mount is a file tree in one namespace.**

That is the design, and it is why "no network by default" and "the model API is not a network
request" are the same requirement rather than two. An agent whose namespace lacks `/dev/net`
cannot reach the network, because there is no path from the kernel to a socket: the module
holding a transport is not in the process until `mount net` runs it into existence, and a
test refuses a `fetch(` anywhere else in the tree.

The naming rule is kept exactly. **A file's name is its tool name** — `src/tools/read.js`
exports `read` — and exactly one tool names the host language: `js`.

---

## What comes up

```
js-agent> ls /
  bin/  dev/  host/  proc/  tmp/

js-agent> ls /dev
  null  random  tty  urandom  zero

js-agent> cat /proc/mounts
  mem on / (defaults)
  proc on /proc (defaults)
  bin on /bin (tools="read,write,edit,ls,calc,js,shell,task")
  hostfs on /host (source=/somewhere,mode=ro)
```

That is the whole floor: an in-memory root, four devices, a readable mount table, the tool
catalog, and the current directory mounted **read-only**. No network, no model, no home
directory, no environment. Each of those is something you mount, and each appears in
`mount --list` when you do.

The shell is ES2025. A line whose first word names a command is a command; anything else is
JavaScript, with top-level `await`, `using`, and the iterator helpers.

```
js-agent> ls /dev | count
  5
js-agent> await (2n ** 64n)
  18446744073709551616n
js-agent> ls -l /dev | head -n 2
js-agent> help read
```

Flags are declared, not parsed by vibe: `--long` and `-l` are the same parameter, the short
form is opt-in per parameter, and two parameters claiming one spelling is an error when the
tool is *declared* rather than a coin flip when it is called. A flag that is not declared is
an error with a suggestion — `--nubers` gets `did you mean --numbers?` — because a shell that
ignores a mistyped flag is a shell whose successful-looking runs did something else.

**Mode is decided for the whole line, before anything is split.** That is the one decision
the shell turns on, and it is not fussiness: `|` is also bitwise-or and `>` is also
greater-than, so a parser that splits first turns `count > 0` into a write to a file named
`0` and `4 | 1` into a two-stage pipeline that tries to run `1`. Both are valid JavaScript
that the splitter would have destroyed. So one classifier runs on the line's first token;
if it names a command, the line is command mode and *only then* are `|` and `>` looked for.
Otherwise the line is JavaScript and is never split at all. `js …` forces JavaScript, `! …`
forces command mode.

---

## The model is a file

This is the part that is worth the rest.

```
js-agent> ls /dev/providers/ai/type/api/anthropic/messages/model
  claude-opus-5  claude-sonnet-5

js-agent> cat /dev/providers/ai/type/api/anthropic/messages/model/claude-sonnet-5
  { "vendor": "anthropic", "api": "messages", "model": "claude-sonnet-5",
    "endpoint": "https://api.anthropic.com/v1/messages",
    "auth_present": true, "auth": "set (48 chars)",
    "net_mounted": true, "net": "/dev/net/request",
    "kind": "device", "callable": true, "append": false, … }
```

| operation | meaning | cost |
|---|---|---|
| `read` | a descriptor: what this is, whether it is usable | free, offline |
| `list` on `model/` | the model ids this mount knows | free, offline |
| `write` | one canonical request → the canonical response | tokens, seconds |
| `open(path, 'r+')` | a conversation handle: `send`, `stream`, the transcript | what you ask for |

The asymmetry between `read` and `write` is the design of the node. Finding out what a model
*is* must never require calling it, or the answer costs money and a round trip. So the
descriptor is two presence checks — is a credential configured, is a network mounted — and
never a probe, and it reports *that* a token is set and never its contents.

A one-shot write carries the request and returns the reply, so this works:

```
js-agent> echo '{"max_tokens":100,"messages":[{"role":"user","content":"say pong"}]}' \
            > /dev/providers/ai/type/api/anthropic/messages/model/claude-sonnet-5
  { "content": [ { "type": "text", "text": "pong" } ], "stop_reason": "end_turn", … }
```

A stream cannot be carried by a write — a write has one return value and a stream has many —
so asking for one there is refused with a message saying to open the node instead. Streaming
lives on the handle, takes an `AbortSignal` from the tool deadline, and parses SSE on
blank-line *frame* boundaries rather than per line, because `data:` may repeat within one
event and a line-at-a-time reader truncates a multi-line payload.

### Three mounts, none implied by the others

A model needs a namespace, a credential and a network, and they are three separate things:

```
js-agent> mount secret:/dev/secrets,env=ANTHROPIC_AUTH_TOKEN
js-agent> mount net:/dev/net,allow=api.anthropic.com
js-agent> mount ai:/dev/providers/ai,vendor=anthropic,token-file=/dev/secrets/ANTHROPIC_AUTH_TOKEN
```

Each can be refused on its own, and each refusal names the fix:

```
$ js-agent --mount ai:/dev/providers/ai,vendor=anthropic
✗ ENETDOWN: network is not mounted · the ai driver has no transport at /dev/net/request
→ mount one: mount net:/dev/net,allow=<host>

$ js-agent --mount net:/dev/net,allow=example.com --mount ai:…,token-file=/dev/secrets/K
✗ EACCES: permission denied · host is not on this mount's allowlist: api.anthropic.com
→ mounted allowlist: example.com. re-mount with allow=example.com,api.anthropic.com if this is intended.
```

The credential is a **file in the same namespace**, so a subagent that is not given
`/dev/secrets` cannot use the model even when it *is* given `/dev/providers` — because the
token is not in an environment it inherited, it is behind a mount it was not handed.

And the network mount carries a scope: hosts, methods, a byte cap, and whether redirects may
be followed (a redirect is the classic way around an allowlist). `allow` is **required**;
`allow=*` is how you say "anything", and having to say it is the point. The transport is
pluggable — `fetch`, a CLI, or a relay — because the design must not depend on `fetch`
existing, or on CORS being absent.

---

## The tools

`/bin` is a mount. The agent is offered exactly the entries in its `/bin`, so
`--tools read,edit` narrows what it can do by the same mechanism that gives it a filesystem,
and a subagent narrows further by passing a smaller set. There is no separate capability
system to keep in sync, and no way to hand a run a tool its namespace does not contain.

| tool | what it does | isolated |
|---|---|---|
| `read` `write` `edit` `ls` | files, out of the namespace | no |
| `js` | run JavaScript against the namespace | **worker** |
| `shell` | run a program — argv by default, a shell only with `shell=true` | no |
| `calc` | arithmetic, sandboxed to `+ - * / % ^ ( )` | no |
| `task` | hand a subtask to a nested run | nested |

`js` runs in a **worker thread against a proxy VFS**: every operation posts a message to the
parent and waits, so the script can read and write the namespace and cannot see the mount
table, because the table is not in that process. A script that spins forever is
`terminate()`d in about 60 milliseconds — a stop a signal could not achieve on a tight
`for(;;){}` — and the kernel is untouched. `vm` is used to give the script clean globals and
is **not** a security boundary; the boundary is the mount table, and the worker is the blast
radius.

Tool arguments come from a single declaration that serves both readers: the model, as
`input_schema`, and the shell, as its argument validator. That second job is not decoration —
validating flags against the declaration is what stops `--__proto__={…}` from inventing a
flag that was never passed, what keeps `--version 1.0` the string `"1.0"`, and what makes a
mistyped flag an error instead of a silently ignored argument.

---

## Running it

```bash
node bin/js-agent                                  # the shell
node bin/js-agent -e 'ls /dev'                     # one line
node bin/js-agent -f script.js                     # a script
node bin/js-agent --agent 'summarise /host/README.md' --agent-tools read

# a whole run, with the model and nothing else
js-agent \
  --mount secret:/dev/secrets,env=ANTHROPIC_AUTH_TOKEN \
  --mount net:/dev/net,allow=api.anthropic.com \
  --mount ai:/dev/providers/ai,vendor=anthropic,token-file=/dev/secrets/ANTHROPIC_AUTH_TOKEN \
  --state ~/.js-agent \
  --agent 'read /host/README.md and tell me the rule in one sentence'
```

A mount spec is `driver:at[,key=value…]` — the same string on the command line and at the
prompt, so `--mount` and `mount` cannot drift apart. `--rw` makes `/host` writable, `--state`
mounts `/agent` (which is what turns sessions on), `--airgap` arms an opt-in tripwire on
`globalThis.fetch`.

### Drivers

| driver | what it is |
|---|---|
| `mem` | an in-memory tree — the root filesystem |
| `dev` | `/dev`: null, zero, random, tty |
| `proc` | `/proc`: the mount table, the process, argv |
| `hostfs` | the real filesystem, `source=` and `mode=ro\|rw`, clamped to its root |
| `secret` | credentials as files, from `env=`, `values=`, or `file=` |
| `net` | the network, with an allowlist and a pluggable transport |
| `ai` | models as a path tree |
| `bin` | the tool catalog |

`hostfs` re-resolves every path through `realpath` and checks it against the mount root, so
`/host/../etc/passwd` **and** a symlink inside the mount pointing out of it both fail.

---

## Testing

```bash
npm test              # the hermetic suites: no network, no credentials, no host
node test/run.js      # everything, including e2e against a real endpoint
node test/run.js vfs shell
```

| suite | covers |
|---|---|
| `unit` | pure functions — paths, errno, schema generation, folding arithmetic, markdown |
| `vfs` | the mount table, resolution, synthesised mount points, `hostfs` clamping |
| `shell` | line classification, pipelines, redirection, the JS fallback, typo diagnostics |
| `ai` | both dialects' translation, the SSE machine replayed from canned bytes, the device |
| `core` | folding, sessions and the gate — the three places a run can lie to itself |
| `agent` | the whole loop against the scripted dialect, tool round trip included |
| `airgap` | **static**: nothing outside `src/drivers/net.js` names a transport |
| `e2e` | a real endpoint — reports itself skipped, exit code zero, without credentials |

`agent` is the one that matters most: it drives request → tool call → result → second round →
final answer with **no socket anywhere in the process**, using a scripted dialect that emits
real Anthropic SSE frames through the real streaming machine. The only thing missing is the
wire. That is a claim the suite tests rather than asserts.

### What a real endpoint found that the hermetic suite could not

Worth recording, because it is the argument for having both.

The conversation handle kept its own transcript *and* the loop passed the full one, so every
message was sent twice. Against the scripted dialect that is invisible — it answers from a
list and does not care. Against a real endpoint it is a 502 saying a `tool_use` had no
`tool_result` after it, on the second round, which is exactly the shape of bug a mock is
structurally unable to catch. The fix is a rule now written down where it belongs: **pass
`messages` and you own the transcript; omit them and the handle keeps it for you.**

---

## Layout

```
bootstrap.js            the OS comes up: airgap, mounts, then shell or one line
bin/js-agent            the entry point
src/kernel/             the kernel — knows nothing about agents or models
  vfs.js                mount table, path resolution, syscall dispatch
  driver.js             the driver contract
  registry.js           driver name → module. THE ONLY PLACE A DRIVER IS LOADED.
  mounts.js             mount specs, and the boot sequence
  paths.js  errors.js  airgap.js
src/drivers/            everything that touches the world outside the process
  mem dev proc hostfs secret net ai bin
  ai/sse.js             the dialect-independent streaming machine
  ai/dialects/          anthropic (pass-through) · openai (all the translation) · fake
src/shell/              parse.js (the classifier) · builtins.js · repl.js · style.js
src/core/               the runtime: agent · execute · worker · policy · context ·
                        session · events · markdown · tools
src/tools/              read write edit ls js shell calc task
test/                   eight suites and a runner
```

A file's name is its public tool name, so `src/tools/`' filenames are API surface, not
labels.

---

## Deliberately not built

**MCP** (client and server), **transcript handoff** from other agents, and the **trace HTML
page**. The mount table is the seam each one attaches to — an MCP server is a driver that
speaks stdio, and `core/events.js` already holds the data a trace page renders — so none of
them require reworking what is here.

## License

MIT
