# Workflow graph crash/recovery adversarial report

Date: 2026-10-16. Scope: graph coordinator, durable local RunStore, disk reconstruction,
redacted observer. No provider/network calls.

## Evidence and fixes

The new `test/workflow-graph-crash.test.js` contains 12 adversarial cases. Its child-process
fixture creates a hostfs durable RunStore, completes a tool-calling root and one branch,
submits duplicate continuation attempts, then blocks a second dispatched branch. The test
kills that real process with SIGKILL, remounts the directory, reconstructs all objects, checks
that `close()` rejects unfinished work, recovers the interrupted run and graph, and reconstructs
again. It verifies one dispatch per logical edge, completed/unknown edge recovery, no retry
run, and payload-free durable observer snapshots. This is process-crash evidence, not a power-loss test.

Additional failing-before/passing-after cases justified these changes:

- A remounted coordinator lacked an AbortController for new branches. Create it before claiming
  work. Persisted cancellation also wins graph node/edge completion when another coordinator
  cannot signal the local provider; preserve the real invocation status separately.
- Cancelling a terminal graph rewrote completed/unknown to cancelled. Terminal cancellation is
  now a no-op. Root cancellation reads the persisted invocation outcome instead of inventing a
  cancelled invocation when the durable record says unknown.
- Late branch callers received completed even though recovery had fenced the node as unknown.
  Return the final graph-node status while preserving the provider result as separate evidence.
  Fence all reconciled claims, including RunStore-recovered terminal unknown outcomes.
- Reusing a branch key under different parents produced duplicate node keys and run reservations.
  Scoped hashed identities now distinguish nested nodes. Lossy normalized branch names also no
  longer alias. Existing ordinary root-branch IDs remain compatible. Reusing an explicit run ID
  for a different node fails before writing a ghost claim.
- Escaped edge keys prevent component ambiguity. Deduplication compares stored parent/node
  relationships, preserving old v1 unescaped edge records.
- Unknown graph versions, redirected graph paths, duplicate nodes/run IDs, missing endpoints,
  and orphan nodes were accepted as recoverable state. These now fail closed with EPROTO before
  recovery can rewrite evidence. This is structural validation, not a migration or repair service.

## Recovery contract and limits

`graph.json` remains a version-1 index: graph identity/path/status/cancellation, root key,
node invocation IDs/paths/statuses, and explicit directed edges. Request/response payloads stay
in RunStore. `recover()` repairs node and edge claims from status snapshots; it does not replay
models or tools. Durable `store.recover(id)` is explicit and separate: use it before graph
recovery when journal reconciliation is needed. The test verifies this ordering.

`close()` is an explicit aggregate join, not a multi-parent invocation or durable scheduler.
Completed root tool results are not automatically re-executed/reconstituted after restart;
a caller continuing a reconstructed root must supply its tool results.

Graph mutation locks are process-local and keyed by the storage object. This patch does **not**
provide atomic multi-process graph writers, cross-process cancellation signaling, distributed
exactly-once effects, graph/run transactions, graph-file fsync guarantees, or power-failure
recovery. The graph uses atomic rename where available but is not promoted to the durable
RunStore's flush/ownership contract. RunStore recovery needs exclusive ownership; concurrent
live takeover remains outside this graph API. Corrupt historical duplicate-node graphs are
rejected rather than guessed into a repaired topology.

## Validation

- Focused graph suites: `node --test test/workflow-graph.test.js test/workflow-graph-crash.test.js`.
- Complete normal regression: `npm test` (includes new crash suite).
- `git diff --check`.
