# Durable RunStore: real SIGKILL / fresh-process recovery

Date: 2026-10-16
Checkout: `/Users/user/.codex/worktrees/781f/js-agent`

## Reproduce

```sh
node examples/durable-crash-recovery.js
node --test test/durable-crash-recovery.test.js test/durable-run-store.test.js test/durable-restart-observer.test.js
npm test
```

The example uses `mode: "durable"` on a writable `hostfs` mount. Each scenario creates
an isolated temporary directory and forks a real writer process. The writer reserves and
starts a run, sends an IPC checkpoint after reaching a specific persistence boundary, and
waits indefinitely. The parent sends **SIGKILL**, waits for the actual process exit, and
forks a different process that remounts the same directory. No cancellation handler,
finally block, store object, or in-memory state is shared with the restarted worker.

The recovery worker first reads the redacted RunObserver snapshot, calls `recover()`, then
reads the observer again. A second newly constructed store repeats recovery to check that
no additional terminal event is appended. The harness has worker deadlines and reaps all
children before deleting its temporary directory. The CLI emits one JSON report per case,
including writer/recovery PIDs and the actual termination signal.

## Observed cases

| Checkpoint / fault | Before recovery | Reconciled status | Additional evidence |
| --- | --- | --- | --- |
| `completed` | completed | completed | Original terminal journal remains unchanged |
| `started` | started | unknown | One `unknown` event with `process_restart` |
| `started-locked` | reserved, partial | unknown | Kill occurs after started event flush but before status write, while writer lock is held; ordinary recovery returns EBUSY; explicit takeover succeeds |
| `malformed-tail` | started, partial | unknown | Injected truncated JSON tail is preserved byte-for-byte in a `.corrupt-*` file; canonical sequence becomes 1, 2 |
| `status-failure` | started, partial | unknown | Unknown event is committed, but injected EIO rejects the status snapshot write |
| `completed-status-failure` | started, partial | completed | Committed completion survives a rejected status write |
| `tool-status-failure` | started, partial | completed_with_tool_calls | Tool calls in the completed event preserve the continuation-needed state |
| `recovery-status-failure` | started | unknown | First recovery journals unknown then encounters EIO; retry on that same recovering store reconciles without duplicating the event |
| `duplicate-id` | started | unknown | Independent process gets EEXIST while writer is alive; a fresh store also gets EEXIST after restart |
| `external-effect-unknown` | started | unknown | A separate mock receiver receipt exists exactly once; recovery never dispatches the effect again |

All final observer snapshots agree with `recover()`, report durable storage, and have
`partial: false`. Every canonical journal has exactly two ordered events. No failed
snapshot temporary files remain in these exercised failure windows.

The external-effect case deliberately writes a mock receiver receipt outside the run
record before the kill. It is not a network/provider integration test. The receipt proves
that an effect can already have happened while RunStore has no committed outcome; the
correct local result remains unknown rather than inferred success or automatic retry.

## Small fixes driven by failing tests

The initial real-process suite passed 6 cases and failed 4:

1. **Unknown reconciliation:** recovery returned unknown from a committed journal event
   but explicitly skipped rewriting stale `status.json`. Observers continued to see started.
   Unknown is now reconciled like other terminal outcomes.
2. **Completion subtype:** recovery inferred `completed_with_tool_calls` only from the
   potentially stale status snapshot. It now also uses the committed event's tool calls.
3. **Recovery retry:** ownership and cached state were published before reconciliation
   finished. A failed recovery caused its own retry to short-circuit with stale state.
   Ownership/state now become visible only after successful reconciliation.
4. **Finish failure evidence:** `fail()` reported `eventCommitted`, `intendedStatus`, and
   `outcome: "unknown"` when terminal status persistence failed, but `finish()` returned only
   the raw I/O error. Both now share the same error reporting; the recovery-generated unknown
   snapshot uses it too. This is an uncertainty report to the caller, not permission to
   retry an external effect. The committed journal still determines restart reconciliation.

No storage format, public API signature, workflow execution model, or locking protocol
was redesigned. The existing unit regression now checks the persisted status as well as
the recovery return value. The process suite is wired into `npm test` and `test/run.js`;
the latter also now includes the existing durable RunStore suite.

## Verification

- Focused durable/restart suites: **15 passed, 0 failed**.
- Full `npm test`: **199 passed, 0 failed**.
- Standalone example: **10 real SIGKILL/restart scenarios completed**.
- `git diff --check`: clean.

## Explicit boundaries

- SIGKILL is process death, **not** a machine power cut, filesystem corruption campaign,
  remote-storage failure test, or proof of every fsync/rename crash window.
- Fault injection targets status temporary-file writes and a malformed event tail; it does
  not simulate every possible partial write or flush failure.
- Takeover is safe here because the parent has positively observed the writer's death.
  `takeover: true` is not automatic stale-lock detection or fencing. Recovery must not race
  an active writer, even if no operation currently holds its short-lived writer lock.
- `RunObserver` remains a best-effort read-only view, not an atomic multi-file transaction.
  A nonpartial started snapshot before reconciliation does not mean its process is alive.
- Recovery records local uncertainty; it does not resume execution, roll back a receiver,
  guarantee exactly-once delivery, or deduplicate remote effects.
- The earlier `DURABLE-RECOVERY-REPORT.md` describes an in-process remount using volatile
  mode. This report is a separate real-process durable-mode experiment, not a claim that
  the earlier scenario used SIGKILL.
