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

## Restarting service integration pass

Date: 2026-10-16
Checkout: `/Users/user/.codex/worktrees/c541/js-agent`

This pass supersedes the earlier volatile-only service assessment above. It adds an actual
process-loss scenario rather than describing two still-live objects as a process restart.

### Runnable path

```sh
node examples/restarting-service.js
```

The example uses only `js-agent/kernel` and `js-agent/runtime` exports. A child service builds
separate resource and hostfs storage trees, an explicit durable RunStore at `/state/runs`, an
Environment, and a workflow graph. The parent waits until model dispatch, kills the child with
SIGKILL, waits for its exit, then remounts the backend and creates fresh service objects. A
standalone `createRunObserver` reads the same persisted run through an authorized View.

Observed result:

- Before recovery: `storage: "durable"`, status `started`, event sequence 1.
- After RunStore recovery, followed by graph reconciliation: run and graph are `unknown`,
  event sequence 2, observer `partial: false`.
- Model dispatches after restart: **0**.
- No request/plan/response content appears in the report.

### Friction fixed with minimal public API changes

1. **Injected store roots silently diverged from observer roots.** Environment now defaults
   its root to `store.root` and rejects a conflicting explicit root. The no-store default
   remains `/runs` with a volatile store.
2. **Recovery required preparing a fresh execution just to retrieve the store.**
   `environment.store` exposes the same trusted writer handle used by `prepareWorkflow`;
   graph construction and restart recovery no longer need catalog reads or a new request.
   `describe().runs.mode` and `.recovery` make the selected mode visible.
3. **A durable capability declaration without `sync()` was accepted until first write.**
   Construction now fails early with `ENOTSUP`. Capability declarations still come from the
   adapter; the API cannot certify a custom backend's truthfulness or write authorization.
4. **A committed `unknown` journal event could leave a stale `started` status snapshot after
   recovery.** Recovery now reconciles that terminal status too. The regression test injects
   a failed status write, checks the observer becomes non-partial `unknown`, and checks a
   subsequent fresh-store recovery does not append another event.

No model request/response, continuation, or tool execution semantics were redesigned.

### Permissions and limits made explicit

- Redaction is not authorization. Broad subtree read grants also permit raw payload reads
  through `environment.observe` or the source View. The service example instead grants list
  on the run root, stat on one authorized run directory, and exact reads of `status.json` and
  `events.jsonl`. Tests deny all three raw payload files, other run IDs, and writes.
- Only give an untrusted UI the observer facade. Environment and its store are trusted host
  objects, not client-facing capabilities.
- `snapshot.storage` is recorded writer metadata; `volatile: true` continues to describe
  best-effort observation, not the persistence mode. No observer call performs recovery.
- Recovery requires the previous writer to be stopped or externally fenced. Abandoned writer
  locks return `EBUSY`; explicit `takeover: true` is tested but is safe only after external
  confirmation that no prior writer can continue. There is no distributed lease/fencing API.
- RunStore journal recovery must precede graph reconciliation. Graph snapshots are a separate
  derived index, do not inherit the durable journal protocol, and can still be missing or
  corrupt. The example proves process restart, not power-loss or distributed crash safety.
- External effects remain unknown after interrupted dispatch. There is no automatic replay,
  exactly-once guarantee, rollback, or distributed transaction.
- Remounting/reconstructing adapters and reapplying authorization remain service responsibilities;
  the Environment does not serialize host functions or infer the original backend.

### Verification

```sh
node examples/restarting-service.js
node test/run.js restarting-service durable-run-store environment workflow-graph
npm test
```

Focused integration/recovery suites: **19 passed**. Full offline suite: **194 passed**.
The new restart suite is included in both test runners. No credentials or live model endpoint
were used.

## Public runtime contract conformance pass

Date: 2026-10-16

This pass follows the executable `js-agent/kernel` and `js-agent/runtime` entrypoints as a new
integration user. It adds [`docs/runtime-api.d.ts`](docs/runtime-api.d.ts) as a typed API
reference and [`test/public-api-conformance.test.js`](test/public-api-conformance.test.js) as a
small checker that compares the declared runtime exports with the package and runs a durable
streaming application.

The application creates an in-memory resource tree, a separate durable hostfs storage tree,
and an Environment with exact agent and observer grants. Its trusted model adapter consumes an
incremental canonical stream. The RunStore persists the private request and completed response;
the observer returns only status/event metadata. A read-only resource View rejects a write, and
an incomplete stream rejects with `EINCOMPLETE`, `outcome: "unknown"`, and a partial response.

The pass also clarifies a documentation mismatch. The “Complete local flow” in
`docs/protocols.md` describes the target resource protocol using a `mounts` field and an agent
path, while the current executable constructor uses `resources`, `storage`, `model`, `tools`,
and `permissions`. That section is now labeled pseudocode and links to
`docs/getting-started.md` for the runnable API.

Contract findings:

- Resource operations are independently authorized; read does not imply write.
- Complete model streams require closed blocks and `message_stop`; the runtime preserves an
  interrupted dispatch as `unknown`.
- Durable RunStore construction requires declared exclusive mkdir, atomic rename, append, and
  flush capabilities. Memory storage remains volatile and is rejected for durable mode.
- `environment.observer` and `createRunObserver` are redacted and best effort. The lower-level
  `environment.observe.inspect` and `inspectInvocation` APIs are trusted inspection paths and
  can expose payloads only when their View grants those files.
- Public failures are thrown with machine-readable `.code` values such as `EACCES`, `EPROTO`,
  `EINCOMPLETE`, and `ENOTSUP`.

Validation:

```text
node --test test/public-api-conformance.test.js
3 passed

npm test
248 passed

node examples/getting-started.js
node examples/environment-app.js
node examples/restarting-service.js
```
