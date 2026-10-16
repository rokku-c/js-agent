# Real-use report: environment + workflow graph + run observer

Date: 2026-10-16

## Verdict

**Pass for the offline integrated application.** `examples/integrated-environment-graph.js` is a real end-user composition of `createEnvironment`, `createWorkflowGraph`, and `createRunObserver`. It submits one root Agent, executes the root tool batch, fans out two keyed continuations concurrently, reads live graph and run state while both branches are active, then closes and reports the final state.

Run it with:

```sh
node examples/integrated-environment-graph.js
```

The example has no network, credentials, or Git self-modification. Its model and tools are deterministic trusted host adapters over a VFS resource tree.

## What the application does

The resource tree contains a reviewer model description, two tool definitions, and a review brief. `createEnvironment` owns the four scoped Views and the trusted adapter wrappers. The root Agent is prepared by the environment and submitted to `createWorkflowGraph`:

```js
const workflow = await environment.prepareWorkflow({
  agent,
  input: "Review this brief and fan out the follow-up work.",
});
const started = await graph.startRoot({ graphId, ...workflow });
```

The root model requests `summary` and `risks`. The graph executes those tool calls through the environment's scoped tool adapters. Two explicit continuation edges are then started with `Promise.all` through `continueBranch`. Each branch waits at the model adapter gate, which makes the live state observable before the branches finish.

The UI is a small terminal report. It renders graph node status, edge status, observer run status, event sequence numbers, and a normalized JSON report containing `live`, `final`, `root`, and branch concurrency fields.

## Evidence

The live snapshot was taken while both continuation model requests were blocked:

```text
INTEGRATED REVIEW UI

graph integrated-review: completed
nodes:
  root           completed_with_tool_calls
  branch:summary completed
  branch:risks   completed
runs:
  integrated-review-risks  completed events=2
  integrated-review-root   completed_with_tool_calls events=2
  integrated-review-summary completed events=2
root observer: completed_with_tool_calls events=2
```

The normalized live graph and runs were:

```json
{
  "graph": {
    "status": "waiting",
    "nodes": [
      ["root", "completed_with_tool_calls"],
      ["branch:summary", "running"],
      ["branch:risks", "running"]
    ],
    "edges": [
      ["root:summary", "running"],
      ["root:risks", "running"]
    ]
  },
  "runs": [
    ["integrated-review-root", "completed_with_tool_calls"],
    ["integrated-review-summary", "started"],
    ["integrated-review-risks", "started"]
  ]
}
```

The final graph was `completed`, with the root in `completed_with_tool_calls` and both continuation nodes and edges in `completed`. The application measured a branch concurrency of `2`. The observer output contained only status, event metadata, file availability, and volatility/redaction markers; request, plan, response, and tool payloads stayed out of the observer view.

Validation:

- `node --test test/integrated-environment-graph.test.js` — 1 passed.
- `npm test` — full suite passed.
- The integration test verifies shared `RunStore` wiring, live `waiting`/`running` graph state, concurrent `started` run snapshots, final graph closure, redaction, and measured overlap.

## API seams and minimal fix

The natural boundary was almost present but had one composition gap. `createEnvironment.run()` internally built the catalog, the model adapter wrapper, the tool adapter map, the scoped agent View, and the shared RunStore. `createWorkflowGraph.startRoot()` needs those same graph-compatible values. An application that reconstructed them would duplicate the environment's adapter boundary and could accidentally give the graph a different catalog or View.

The minimal fix is `environment.prepareWorkflow(options)`. It builds the exact options that `run()` already used, including the environment-scoped `resources`, `model`, `tools`, `toolAdapters`, and `store`. `run()` now delegates to it, so the direct environment path and graph path share one construction path. No new execution model or adapter sandbox was added.

The remaining composition is explicit by design:

- The app creates one `RunStore` and passes it to both `createEnvironment` and `createWorkflowGraph`.
- The graph owns persisted workflow nodes and edges under `/workflows`.
- `createRunObserver` wraps `environment.observe`, so its `/runs` reads retain the observer permission View and its redacted contract.
- Live inspection uses `startRoot`, `continueBranch`, `graph.inspect`, and `observer.list` before `graph.close`; the convenience `graph.run()` intentionally waits for the join.

## Limits

This is an offline integration check. `RunStore` remains volatile: a failed terminal status write can leave an observer with an older persisted status, as covered by the existing adversarial tests. The trusted model and tool adapters are scoped by Views but are still host JavaScript. Graph recovery and cancellation remain the existing graph semantics and are not changed by this example.
