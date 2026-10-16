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

- `createWorkflowGraph({ storage, store })` coordinates a root invocation and keyed
  continuation branches. See [the graph example](../examples/workflow-graph.js).
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
5. Read the redacted state through `environment.observer` or a standalone
   `createRunObserver(createView(storage, { grants }), { root })`.

If a dead writer left `.writer-lock`, `recover(id, { takeover: true })` can explicitly remove
it, **only after external confirmation that the previous writer cannot continue**. No lease,
fencing token, automatic safe takeover, or distributed transaction is provided. Graph
snapshots do not inherit RunStore's durable journal protocol; missing/corrupt graphs still
require application handling. The example tests process loss, not power-loss durability.

Observers and permissions are distinct: redaction removes payloads from returned snapshots,
but a broad `/runs/**` read grant still authorizes raw payload reads on that View. The example
instead grants list on the root, stat on one authorized run directory, and read on only that
run's `status.json` and `events.jsonl`. Share only the observer facade with UI code, never the
Environment, its `store`, or raw storage. `snapshot.storage` is the writer's recorded mode;
`snapshot.volatile: true` means observation remains best-effort, not transactional or a
recovery operation, even when the recorded mode is durable.
