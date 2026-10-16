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
