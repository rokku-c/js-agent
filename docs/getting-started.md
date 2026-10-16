# Getting started

This is the shortest complete application. It creates an in-memory resource world, gives an
`Environment` a deterministic model and tool adapter, runs one root request plus its explicit
tool continuation, and reads the redacted result through a `RunObserver`.

Run it from the repository root:

```sh
node examples/getting-started.js
```

The example imports only the package entrypoints:

```js
import { Vfs } from "js-agent/kernel";
import { createEnvironment, createRunObserver } from "js-agent/runtime";
```

`createEnvironment({ resources, model, tools, permissions })` creates four independent Views.
The agent selects exact model, context, and tool paths. `environment.run({ agent, input, id,
continuationId })` performs the root request, executes the supplied trusted tool adapter, and
performs the explicit continuation. `createRunObserver(resources)` exposes status and event
metadata without request, plan, response, or tool payloads.

The next API layers are also public from `js-agent/runtime`:

- `environment.createWorkflowGraph({ root, persistence })` coordinates a root invocation and keyed
  continuation branches using the Environment's storage and RunStore. `persistence` is
  `"snapshot"` by default; choose `"journal"` when graph write volume is the constraint.
  See [the graph example](../examples/workflow-graph.js) and the [persistence conformance example](../examples/workflow-persistence.js).
  The standalone `createWorkflowGraph({ storage, store })` remains available for lower-level composition.
- `createGitRevisionConnector({ repository, stateDir })` manages candidate worktrees, checks,
  candidate invocations, and compare-and-swap activation. Its callback receives captured
  revision provenance. See [versioning](./versioning.md).

The package exports are checked by `test/public-api.test.js`, and the executable getting-started
flow is checked by `test/getting-started.test.js`.

## A service that restarts

Run the offline, real-process restart example:

```sh
node examples/restarting-service.js
```

It kills a writer after dispatch, waits for its exit, remounts the same hostfs directory,
then rebuilds the Environment, RunStore, graph coordinator, and read-only observer. The
interrupted invocation becomes `unknown`; recovery does not call the model again.

For journal graph persistence, concurrent branches, and a separately persisted external
receipt, run `node examples/journal-release-service.js`. Its [application report](./real-use-journal-service.md)
describes both the dispatch crash and the earlier graph-claim/run-reservation crash.

For a durable service, explicitly supply `createRunStore(storage, { root, mode: "durable" })`
to `createEnvironment({ resources, storage, store, model, permissions })`. The default
remains volatile, even on hostfs. Durable admission requires declared storage capabilities
and implemented storage methods, including `sync()`; it rejects memory mounts. The store
root becomes the Environment's default run/observer root; a conflicting explicit root is
rejected. `environment.store` is the same trusted store, available for graph construction
and recovery without preparing a new model request. `environment.describe().runs` reports
its mode and whether durable recovery is available.

Restart order matters:

1. Stop or externally fence the old writer. Recovery is **not** a read-only UI operation.
2. Remount the same backend and recreate all process-local objects, permissions, and adapters.
3. Recover the affected invocations with `environment.store.recover(id)`.
4. Reconcile the derived graph index with `graph.recover(graphId)`.
   `environment.recoverWorkflow(graph, graphId)` performs steps 3 and 4 in that order for
   every uncertain graph node; it never re-dispatches an interrupted request. A graph
   claim can exist before its run directory. In that case the helper returns a run entry
   with `status: "unknown", recovered: false, missing: true` and reconciles the graph
   without manufacturing a run. A missing status file in an existing run still triggers
   journal recovery; storage permission/I/O errors propagate.
5. Read the redacted state through `environment.observer` or a standalone
   `createRunObserver(createView(storage, { grants }), { root })`.

If a dead writer left `.writer-lock`, `recover(id, { takeover: true })` can explicitly remove
it, **only after external confirmation that the previous writer cannot continue**. No lease,
fencing token, automatic safe takeover, or distributed transaction is provided. Graph
persistence has its own commit protocol.
`environment.createWorkflowGraph({ persistence: "journal" })` selects delta records and
an atomic commit pointer. Stale graph locks fail
with `EBUSY`; missing/corrupt graphs still require application handling. The examples test
process loss, not power-loss durability.

Graph persistence is selected when a coordinator is opened. A v1 snapshot opened with
`persistence: "journal"` is migrated on its next graph mutation; the migration publishes a
journal commit pointer and keeps the old graph state readable until that commit succeeds. A
journal graph remains journaled when reopened with the snapshot default. There is no automatic
compaction or downgrade, and older runtimes that only understand v1 cannot read the migrated
format.

Observers and permissions are distinct: redaction removes payloads from returned snapshots,
but a broad `/runs/**` read grant still authorizes raw payload reads on that View. The example
instead grants list on the root, stat on one authorized run directory, and read on only that
run's `status.json` and `events.jsonl`. Share only the observer facade with UI code, never the
Environment, its `store`, or raw storage. `snapshot.storage` is the writer's recorded mode;
`snapshot.volatile: true` means observation remains best-effort, not transactional or a
recovery operation, even when the recorded mode is durable.
