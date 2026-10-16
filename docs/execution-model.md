# Execution Model

This document defines how an AgentSpec becomes one model request and how the result becomes
observable state.

## AgentSpec

An AgentSpec is a resource-backed recipe. A typical definition is:

```text
/agents/code-reviewer/
  agent.json
  system/
    identity.md
    review-rules.md
    output-format.md
  context/
    architecture.md
  tools/
    read.ref
    search.ref
  model.ref
  view.json
```

Example `agent.json`:

```json
{
  "model": "/models/default",
  "system": [
    "/agents/code-reviewer/system/identity.md",
    "/agents/code-reviewer/system/review-rules.md",
    "/agents/code-reviewer/system/output-format.md"
  ],
  "context": [
    "/agents/code-reviewer/context/architecture.md",
    { "$ref": "/workspace", "selector": "git:changed-files" }
  ],
  "tools": [
    "/tools/read",
    "/tools/search"
  ],
  "view": "/views/code-reviewer.json"
}
```

The definition is data. It may be assembled from local files, remote resources, Git
revisions, or dynamically generated references.

## Prompt composition

System prompt composition is ordered and inspectable. The resolver combines prompt fragments
according to the AgentSpec and records the source of every fragment:

```json
{
  "fragments": [
    { "source": "/agents/reviewer/system/identity.md", "order": 0 },
    { "source": "/workspace/.agent/rules.md", "order": 1 },
    { "source": "/agents/reviewer/system/output-format.md", "order": 2 }
  ],
  "materialized": "/runs/run-123/resolved/system.md"
}
```

Prompt fragments may be live or pinned references. The Invocation records the final material
sent to the model and its provenance. A later edit to a live prompt must not silently rewrite
the history of a completed run.

## Context selection

History is stored in the environment. It is not automatically equivalent to current context.

```text
history = all relevant prior resources
context = the subset selected for this Invocation
```

A context selector may use:

- the current task;
- recent events;
- semantic or textual search;
- Git changes;
- explicit references;
- summaries or indexes;
- limits on size, age, or source.

A context selector is itself a resource-backed program or definition. Different AgentSpecs
may select different context from the same history.

## Tool definitions

A tool is a resource with a definition and an implementation:

```text
/tools/search/
  definition.json
  entry.js
  invoke
```

`definition.json` contains the name, description, input schema, output shape, and capability
requirements. `entry.js` implements the behavior against the Invocation's View.

The model sees only tools resolved from the AgentSpec. The executor validates input, resolves
reference arguments, checks the View, invokes the tool, bounds its output, and writes its
execution state.

Tools may be loaded dynamically because they are resources. A tool created during one
Invocation becomes available to a later Invocation when its View and version permit it.

## Invocation

An Invocation is one evaluation of an AgentSpec:

```ts
interface InvocationRequest {
  id: string;
  agent: ResourceRef;
  input: unknown;
  view: View;
  revision?: RevisionRef;
  parent?: string;
  budget?: Budget;
}
```

An Invocation performs these phases:

1. resolve the AgentSpec;
2. derive and freeze the View;
3. resolve model, system, context, and tools;
4. persist the resolved plan;
5. issue one model request;
6. record the complete response and terminal state;
7. return proposed tool calls without executing them.

An optional workflow dispatches those tool effects and constructs another Invocation. The
one-request primitive does not require a Run scheduler or persistent session.

A model request that needs another tool call does not require a mutable session object. The
next request is a new Invocation linked by `parent` or `continuation`.

This gives the system a natural concurrency model:

```js
await Promise.all([
  invoke("/agents/reviewer", { input: taskA }),
  invoke("/agents/reviewer", { input: taskB }),
  invoke("/agents/tester", { input: taskC }),
]);
```

## RunState

Every Run has a state directory. Each Invocation has a subdirectory inside it:

```text
/runs/run-123/
  run.json
  status.json
  events.jsonl
  invocations/inv-0/
    request.json
    plan.json
    response.json
    effects/
  output.json
```

`status.json` is the current Run status. An Invocation's `response.json` and effect records
are immutable after their terminal state, while the Run status and event stream continue to
advance as continuations are created.

`status.json` uses a small state machine:

```text
created → resolving → running → completed
                         ├── waiting_for_tool
                         ├── failed
                         ├── cancelled
                         └── unknown
```

`unknown` means the runtime cannot establish whether an external effect completed. It must
not be treated as an empty result or automatically retried when the effect may be
non-idempotent.

Events are append-only observations. Snapshots such as `status.json` make current state cheap
to read; events explain how it got there. Both are resources and both are readable through
the normal View.

## Effect records

Before an external effect begins, the run writes a started record:

```json
{
  "effect_id": "effect-1",
  "kind": "tool",
  "resource": "/tools/write",
  "state": "started",
  "idempotency_key": "run-123/effect-1"
}
```

On completion it writes the result and changes the state to `completed`. If the process dies
between those writes, recovery marks the effect `unknown`. This is the minimum information
needed to make resumption honest.

## Cancellation and ownership

An Invocation owns:

- its View;
- its model request;
- resources opened by that request.

The optional workflow separately owns tool executions and their:

- open resource handles;
- child processes or workers;
- timers and output buffers.

Cancellation propagates through that ownership tree. The runtime cancels in-flight work,
closes handles, terminates workers, and records the final state. Cancellation does not pretend
to roll back an already completed external write.

## Session as a projection

A session may still be exposed for convenience:

```text
/sessions/last-review/
```

But it is a projection over an Invocation graph and selected history. It is not the primitive
that owns execution. This distinction permits concurrent Invocations, branching context, and
multiple interfaces over the same state.

## Request continuations

An Invocation owns exactly one model request attempt and one terminal model response or
request failure. A tool call is a separate effect. A continuation is a new Invocation that
carries an explicit transcript handoff.

```text
I0: request R0 → assistant tool_use(t1, t2)
T1: execute t1 → tool_result(r1)
T2: execute t2 → tool_result(r2)
I1(parent=I0): request R1 with R0 response + [r1, r2]
I1: final assistant response
```

The parent Invocation becomes `completed_with_tool_calls` after its response is durably
stored. It does not remain a mutable session. A workflow owner creates `I1`, supplies the
ordered tool results, and owns the continuation budget and cancellation relationship.

The complete provider response is persisted before any tool effect begins. Tool-call IDs and
provider-specific response blocks are preserved verbatim. Unknown tools, invalid arguments,
and denied calls produce structured tool errors; they are never silently executed.

Multiple independent tool calls may run concurrently only when their definitions declare
compatible effect behavior. Results are ordered by the original tool-call order when handed to
the continuation. Continuation creation is idempotent on `(parent, response_id, tool_batch_id)`.

The public word **Run** may refer to the complete workflow rooted at an Invocation. The
primitive execution record remains the one-request Invocation. A Run owns its Invocation graph,
aggregate budget, cancellation, and recovery; lineage (`parent`) and ownership are separate
edges.

## Effective View

An AgentSpec contains an authored View. The caller supplies an upper-bound View. The effective
View is their intersection:

```text
effective_view = caller_view ∩ agentspec_view ∩ revision_view
```

If the AgentSpec requests a capability outside the caller's View, resolution fails. A
continuation inherits the frozen effective View unless the workflow explicitly derives a
narrower child View. No continuation can broaden it.

## Resolution timing and snapshots

Resolution has three distinct moments:

1. **Plan resolution:** AgentSpec, authored View, model, prompt definitions, tool catalog,
   and revision are resolved before the request.
2. **Context resolution:** selectors capture individually authorized observations and produce an
   immutable context artifact for that request. A snapshot-capable driver may supply a snapshot
   ID; unrelated remote systems do not share an implied atomic snapshot.
3. **Effect-time resolution:** model-generated tool arguments and live references inside them
   are resolved immediately before the tool effect, then recorded in the effect plan.

A live resource may change between these moments. The run records what it actually observed;
“frozen plan” means the selected definitions and materialized request are fixed, not that all
external state is frozen. A continuation reuses the prior transcript and may either reuse the
prior context artifact or explicitly request a new context snapshot.

Context selection is read-only, has a selector identity and version, deterministic ordering,
deduplication, truncation, and size accounting. Selector side effects are prohibited.

## Prompt AST

Prompt composition is represented as an ordered, provider-neutral Prompt AST. There are no
implicit prompt sources:

```json
{
  "parts": [
    { "role": "system", "source": "/agents/reviewer/system/identity.md" },
    { "role": "system", "source": "/workspace/.agent/rules.md" },
    { "role": "context", "source": "/workspace", "selector": "git:changed-files" },
    { "role": "user", "value": "Review the current change." }
  ]
}
```

Each part records source path, revision or content hash, selector, role, order, and materialized
size. Missing or unauthorized references fail resolution by default. A deployment may opt into
an explicit optional-reference policy, which records omissions in the plan.

Provider dialects translate this AST into their wire format. They do not add hidden prompt
fragments.

## Model request effects

A model request is an external operation even when it only returns data: it may be billable,
retain input, or complete after the caller loses its connection. Each request has a durable
request ID, attempt ID, request hash, provider identity, and idempotency policy.

A transport failure after dispatch is `unknown` unless the provider confirms non-execution.
Automatic retry requires a connector-declared idempotency guarantee or an explicit caller
policy. The run records partial streamed output separately from a completed assistant message.
