# Workflow/DAG evaluator B report

This report records the concurrency break tests and the competing graph API added in
`src/core/workflow-graph.js`. The API is a coordinator over the existing one-request
`RunStore` records. It does not create an Environment or expose a generic RunState observer.

## Evidence against the fixed two-phase harness

The existing harness is correct for one root invocation, one concurrent tool batch, and one
continuation. Its persisted files expose each invocation, but they do not represent ownership
of the workflow that links them.

| Adversarial case | Existing behavior | Graph API behavior |
| --- | --- | --- |
| Independent continuation branches | `runWorkflow` creates one continuation and has no branch key | `continueBranch` claims independent keyed edges and dispatches them concurrently |
| Duplicate continuation attempts | A caller-supplied ID only prevents reuse of that ID; the same logical parent can receive multiple children under different IDs | `(graph, parentKey, branchKey)` is claimed before dispatch; a duplicate returns the existing in-flight or terminal result |
| Cancellation during a child request | The harness returns `cancelled`, while the child invocation can finish as `unknown` after the provider observes cancellation | Graph cancellation is persisted and wins the aggregate state; the child keeps its invocation evidence and is represented as `cancelled` at graph level with `unknown` invocation status |
| Restart-like inspection | A fresh `RunStore` can read snapshots but has no graph index or recovery decision | A fresh graph instance reads `graph.json`, reconciles node claims against invocation `status.json`, and `recover()` marks an uncertain `started` or `reserved` node `unknown` |
| Late completion after recovery | There is no workflow record to prevent a late child result from becoming the visible workflow state | Recovery marks the node with `process_restart`; a late evaluator completion cannot overwrite the recovered graph state |

The current harness's invocation queue is still useful: it serializes writes for each individual
invocation and preserves ordered tool results. The missing boundary is the persisted graph claim
around those invocations.

## API shape

```js
const graph = createWorkflowGraph({ storage, store });

const root = await graph.startRoot({
  graphId: "review",
  agent,
  input: "review the change",
  model,
  tools,
  toolAdapters,
});

const [one, two] = await Promise.all([
  graph.continueBranch({
    graphId: "review",
    branchKey: "security",
    parentKey: "root",
    parent: root.root,
    parentResponse: root.root.response,
    toolResults: root.toolResults,
    agent,
    model,
    tools,
  }),
  graph.continueBranch({
    graphId: "review",
    branchKey: "correctness",
    parentKey: "root",
    parent: root.root,
    parentResponse: root.root.response,
    toolResults: root.toolResults,
    agent,
    model,
    tools,
  }),
]);

await graph.close("review");
```

`run({ id, root, branches })` is a convenience for the same sequence. `continueBranch` accepts a
completed continuation as its `parent` and `parentKey`, which allows later DAG levels without
introducing a generic task scheduler.

The graph is persisted under `/workflows/<id>/graph.json`. Invocation request, response, status,
and event files remain under the existing RunStore root. `inspectWorkflowGraph()` is a
read-only graph-specific reconciliation view; `recover()` is the explicit recovery action.

The graph is still backed by the repository's volatile VFS RunStore. Recovery records an honest
`unknown` graph node when the process may have died after dispatch. It does not claim that an
external effect was rolled back.

## Validation

The focused suite covers:

- concurrent branch overlap and explicit graph close;
- two simultaneous attempts for one logical edge, with one child dispatch;
- cancellation racing a provider response, including the child `unknown` invocation snapshot;
- a second graph/store instance detecting a stale `started` child and preventing late overwrite
  after recovery.

`npm test` includes this suite as `test/workflow-graph.test.js`.
