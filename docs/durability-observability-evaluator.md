# Durability and observability evaluator report

Date: 2026-10-16
Checkout: `/Users/user/.codex/worktrees/9f7e/js-agent`

## Verdict

The RunStore remains correctly described as volatile. Storage failures can leave an older
status snapshot visible after a newer event, and a process restart does not reconstruct the
RunStore's in-memory ownership or sequence maps. The smallest justified improvement is in the
workflow graph: it now persists a root invocation claim before dispatch, so restart recovery has
a graph node to reconcile. Recovery also classifies a claimed invocation with a missing or
unreadable status snapshot as `unknown`.

This does not make the RunStore durable. The graph and invocation snapshots still depend on the
caller-provided VFS, atomic rename where available, and whatever persistence guarantees that VFS
provides.

## Scenarios exercised

| Scenario | Evidence | Result |
| --- | --- | --- |
| Terminal status write failure | `test/adversarial.test.js`: fail the temporary `status.json` write after appending `unknown` | The writer returns `unknown` and records the error, while a fresh store still reads `started`; the observer reports `partial: true`. |
| Process restart during a root request | `test/workflow-graph.test.js`: restart with a fresh graph and RunStore while the model is blocked after invocation start | The persisted root claim is `uncertain`; explicit recovery marks it `unknown`; a late completion cannot overwrite that graph state. |
| Process restart with no readable invocation snapshot | `test/workflow-graph.test.js`: recover a graph claim whose RunStore status is missing | Recovery marks the claim `unknown` instead of leaving a running graph claim. |
| Partial event tail | `test/adversarial.test.js`: append incomplete JSON containing a secret error field | The observer stops at the last valid sequence, reports `partial: true`, and returns no payload or secret. |
| Observer permissions | `test/environment.test.js`: observer grant present and observer grant empty | An authorized environment observer can inspect the run; an ungranted observer receives `EACCES`. Model, tool, agent, and observer grants remain separate. |
| Concurrent graph recovery | Existing child recovery test plus the new root recovery test | A recovered `process_restart` node remains `unknown` when the original in-process operation finishes later. |

## Change boundary

`src/core/workflow-graph.js` claims the root before calling `invokeOnce`. The claim uses the
same persisted graph index as continuation claims. `recover()` now treats every non-terminal
persisted invocation state, including `missing` and `unreadable`, as uncertain for a running graph
node. The late-completion guard applies to the root as it already did to continuation nodes.

## Explicit limits

The graph write and RunStore writes are separate snapshots; there is no distributed transaction
between them. Atomic rename is not an `fsync` or a crash-consistent commit protocol. A crash can
still leave temporary files, an old graph snapshot, an old status snapshot, or a valid event with
no matching status. Recovery deliberately reports `unknown` when outcome cannot be established.
The observer is polling and best effort: it can miss transient states, and it exposes only the
last readable redacted metadata. No external effect is rolled back or claimed exactly once.

Focused verification: `node --test test/adversarial.test.js test/environment.test.js test/workflow-graph.test.js` — **20 tests passed**.
Full verification: `npm test` — **172 tests passed**.
