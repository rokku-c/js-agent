# Real-use report: durable journal release service

Run `node examples/journal-release-service.js`. The application uses only the package's
public `js-agent/kernel` and `js-agent/runtime` exports. It needs no network or credentials.
It creates temporary hostfs storage, starts a separate writer process, kills it with
`SIGKILL`, waits for process exit, remounts the same directory, recovers, prints a JSON
report, and removes its temporary files.

## Application behavior

A resource-backed tool reads a private release brief. The root model returns that tool
call; the Environment assembles its scoped adapter and executes it. Two graph continuations
then overlap: `check` verifies rollback and `publish` invokes a delegated
`release.publish` service. A two-way promise barrier makes overlap deterministic. The
writer announces readiness only after the check branch has durably completed and the
publish service has written and fsynced its receipt. The publish model request never
returns a response before the process is killed.

The service is an offline provider simulator. Its receipt file is outside the mounted
runtime tree and outside both journal protocols. The test therefore knows that one effect
occurred, while invocation recovery correctly reports `unknown`. No provider reconciliation
is silently inferred from that receipt, and no retry, model request, or service call is
performed during recovery or duplicate submission.

| State after remount/recovery | Observed result |
| --- | --- |
| RunStore mode | `durable` |
| Graph commit pointer version | `2` (journal mode) |
| Root | `completed_with_tool_calls` |
| Check branch | `completed` |
| Publish branch before recovery | `started`, event sequence 1 |
| Publish branch after recovery | `unknown`, events `started`, `unknown`, sequence 2 |
| Graph after recovery and close | `unknown` |
| Provider receipts | Exactly one |
| Dispatches before / after restart | 3 / 0 |
| Repeated publish submission | Deduplicated, `unknown` |
| Repeated recovery | No remaining uncertain runs |
| Observer raw request read | `EACCES` |

Observer grants allow only root listing, stat on the three known run directories, and
reads of their status/events. `environment.observer` returns redacted metadata. The
application never needs to grant raw request/plan/response reads to an observer, and fresh
observer reads before recovery exactly match the writer's last observation. Recovery order
is explicit in the helper's contract and the report: stop writer, remount, inspect claims,
recover uncertain run journals, then reconcile the graph index. Read-only observation
does not recover anything.

## Missing seam found and fixed

The public composition APIs already cover journal selection, Environment adapter preparation,
service authority, graph continuation, redacted observation, deduplication, and ordered
recovery. No new coordinator or general application framework was needed.

The crash experiment exposed a failure in the existing `Environment.recoverWorkflow()`
convenience method: graph claims commit before run reservation. A process killed between
those two writes leaves a valid running graph node but no run directory. The helper called
`RunStore.recover()` on the absent run, threw `ENOENT`, and never reached graph recovery.

The fix checks the directory only when inspection reports a missing status. If the entire
run is absent, the helper returns `{ id, path, status: "unknown", recovered: false,
missing: true }` and lets graph recovery conservatively reconcile the claim. It does not
create a run or redispatch. If the directory exists, journal recovery proceeds normally;
permission and other storage errors remain failures. The caller still must stop or fence
the original writer before using this mutating recovery API.

The second subprocess test kills the writer at the resource adapter's run-directory
reservation boundary, after its graph claim commits. It verifies an unknown graph node,
no synthetic observer run, no provider receipt, and no replay. A third regression test
interrupts the graph commit after the invocation's completed journal record, removes its
status projection, remounts, and proves recovery restores the completed outcome. It also
proves a denied directory stat propagates `EACCES` without changing the running graph claim.

## Validation

- `node examples/journal-release-service.js` — real killed writer, journal remount,
  one provider receipt, zero recovery dispatches.
- `node --test test/journal-release-service.test.js test/environment.test.js test/workflow-journal.test.js test/restarting-service.test.js test/release-review-application.test.js`
  — 21 passed, 0 failed.
- `npm test` — 268 passed, 0 failed, 0 skipped (Node v26.10.0, macOS hostfs).
- `git diff --check` — passed.

## Limits

- The deterministic model and file-backed provider exercise application integration;
  they do not validate a real model SDK, remote API, provider idempotency key, or retry policy.
- Process death is tested. Power loss, directory durability of the simulator ledger,
  filesystem/hardware failure, and remote filesystem semantics are not certified.
- There is no transaction spanning provider effects, run journals, and graph commits,
  and no exactly-once external effect guarantee. Unknown outcomes need application/provider
  reconciliation before any deliberate retry.
- The test kills outside graph/run mutation locks. Stale graph locks fail closed with
  `EBUSY` and need operator handling. Old writers must be stopped or externally fenced;
  this helper is not a safe distributed takeover mechanism.
- Observer snapshots are best effort; they are not an atomic graph-plus-run snapshot.
  The example uses fixed known run IDs to keep grants narrow; a multi-user application
  must build those grants from its own authorization policy.
- The example cleans up its temporary storage after reporting. Production retention,
  journal compaction, operational dashboards, and provider reconciliation are application
  responsibilities.
