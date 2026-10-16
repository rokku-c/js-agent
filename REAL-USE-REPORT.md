# Real-use report: public API and getting started

Date: 2026-10-16

## Verdict

**Pass for a new developer following the documented offline paths.** The package exports match the
documented `js-agent`, `js-agent/kernel`, and `js-agent/runtime` entrypoints. The existing
Environment, Run Observer, Workflow Graph, and Git revision connector APIs are reachable from
the runtime export. Every JavaScript example runs, and the new getting-started flow completes a
root request, a tool call, an explicit continuation, and a redacted observation without a
network or credential.

One real blocker was found and fixed: `examples/mount-a-model.sh` used an undefined `$J`
variable after defining `ROOT_JS`. Under `set -u`, the script stopped before its second mount
check. It now calls a local `js_agent` wrapper.

## Public surface checked

Commands used:

```sh
node --input-type=module -e 'const root = await import("js-agent"); const runtime = await import("js-agent/runtime"); const kernel = await import("js-agent/kernel"); console.log(JSON.stringify({root:Object.keys(root).sort(), runtime:Object.keys(runtime).sort(), kernel:Object.keys(kernel).sort()}, null, 2));'
```

Observed exports:

- `js-agent`: `VERSION`, `boot`, `parseArgv`
- `js-agent/kernel`: `Vfs`
- `js-agent/runtime`: Environment, Run Observer, Workflow Graph, Git revision connector,
  View, Run Store, invocation, continuation, tool catalog, and workflow harness functions

The new `test/public-api.test.js` keeps this documented surface from silently drifting. Relative
Markdown links in `README.md` and `docs/*.md` were also checked; all resolve.

## Executable examples

These commands all completed successfully:

```sh
node examples/one-request.js
node examples/environment-app.js
node examples/workflow-harness.js
node examples/workflow-graph.js
node examples/integrated-environment-graph.js
node examples/getting-started.js
bash examples/offline-loop.sh
bash examples/mount-a-model.sh
```

The live model script correctly stops after its credential-free checks when no
`ANTHROPIC_AUTH_TOKEN` is present. It reports the missing credential and exits successfully;
with credentials, its final steps remain the real endpoint path.

`examples/getting-started.js` uses only package exports. It builds an in-memory Environment with
explicit agent, model, tool, and observer permissions, runs a deterministic model that requests
`read`, executes that trusted adapter, and checks the continuation response through a redacted
Run Observer. Its output is documented in [Getting started](docs/getting-started.md).

## Validation

```sh
npm test
node test/run.js unit vfs shell ai core agent airgap view references run-context invocation runtime tool-resource continuation worker-cancel workflow workflow-harness workflow-graph environment connector integrated-environment-graph git-revision-connector getting-started public-api adversarial
node test/run.js
node --test test/getting-started.test.js test/public-api.test.js
```

Results:

- `npm test`: 179 passed.
- the full offline `node test/run.js` suite excluding `e2e`: 179 passed.
- `node test/run.js`: 182 total, 179 passed, 1 failed, 2 skipped. The OpenAI live case was attempted because an OpenAI credential is present in the environment, but the endpoint failed with `fetch failed` / `EIO`; the Anthropic cases skipped without credentials.
- Focused public API and getting-started tests: 2 passed.

The runtime remains intentionally explicit: model and tool adapters are trusted host functions,
Run Store persistence is volatile, and the Git connector requires a real Git worktree. Those
limits are already stated in the implementation and connector documentation and do not block the
offline getting-started path.

## Durable RunStore adversarial pass

Date: 2026-10-16

The smallest honest durable contract is now explicit. `mode: "durable"` requires a storage
mount that declares exclusive directory creation, atomic rename, append, and flush. Hostfs
implements those primitives; memory remains volatile and is rejected. Run directories reserve
IDs with exclusive `mkdir`, writers serialize through a directory lock, snapshots use temporary
files plus atomic rename, and the journal is authoritative during restart recovery.

The focused tests cover duplicate IDs across store instances, restart during a started request,
malformed JSONL tails, failed terminal status writes, and temporary-file cleanup. Recovery
quarantines malformed tails and records an interrupted started run as `unknown`. A status failure
after the terminal event is journaled raises an outcome with `outcome: "unknown"`; a fresh store
can reconcile that journal. No protocol claim is made about an external effect: after dispatch,
process loss or provider disconnect leaves the effect `unknown`, and the store does not retry it
or infer success.

Validation: `npm test` passed with the focused durable tests included.
