# Durable backend recovery and observation report

Date: 2026-10-16
Checkout: `/Users/user/.codex/worktrees/9f0e/js-agent`

## Finding

A backend that preserves the existing resource operations can be observed after a process
restart through the same `stat`, `list`, and `read` APIs. The new Environment-level
`observer` is the redacted RunState facade over that View. It reports run identity, status,
event sequence, timestamps, storage mode, and partial persistence; it does not return request,
plan, response, or event payload fields.

The executable scenario uses a `hostfs` directory as the shared backend. Process one starts a
root invocation and stops while the model request is in flight. Process two remounts the same
directory, rebuilds `createEnvironment`, `createRunStore`, `createWorkflowGraph`, and the
observer, then observes the persisted run and recovers the graph. The run file is still
`started` when process two first reads it; the graph recovery classifies the unresolved result
as `unknown` with `recovery: "process_restart"`. After the old process is cancelled, the run
store records `unknown`, and the second observer sees that terminal state without seeing the
model payload.

## Recovery fix

There was a separate graph snapshot failure window after a child invocation had already written
its terminal RunState. Recovery previously corrected the child node but left its graph edge in
`running`. `recover()` now reconciles the edge with the persisted terminal status, or with
`unknown` when the status is missing or non-terminal.

## Limits

The existing `RunStore` remains `mode: "volatile"`; hostfs persistence makes the files available
after remounting but does not create a crash-consistent RunStore protocol. Graph snapshots,
status snapshots, event appends, and model/tool side effects are still separate operations. The
implementation makes no distributed transaction, exactly-once, rollback, or external-effect
claim. An unresolved in-flight result is deliberately reported as `unknown`.

Focused verification:

```text
node --test test/environment.test.js test/workflow-graph.test.js test/durable-restart-observer.test.js
```

Full verification: `npm test`.
