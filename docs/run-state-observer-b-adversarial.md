# RunState observer B adversarial report

Date: 2026-10-16
Checkout: `/Users/user/.codex/worktrees/932a/js-agent`

## Verdict

The competing observer API is justified for UI and Agent consumers of concurrent runs. It is
read-only, projects only status and event metadata, and makes volatile persistence visible
instead of presenting a failed write as a durable terminal result.

## API and trust boundary

`createRunObserver(storage, { root, interval })` is exported from `src/runtime.js` and returns:

- `snapshot(id)` for one best-effort view;
- `list()` for safe summaries of the run directories under `root`;
- `watch(id, { after, includeInitial, untilTerminal, signal })` as an async iterator for polling
  state changes while a run is in progress.

The observer reads only `status.json` and `events.jsonl`. It never reads `request.json`,
`plan.json`, or `response.json`. Event payloads such as `toolCalls` and failure objects are
removed. Statuses and event kinds are allow-listed, timestamps are accepted only in the
RunStore ISO form, and storage failures are represented by safe codes. No error message or
persisted payload is returned.

Every result includes `volatile: true` and `redacted: true`. `partial: true` means that status
or event persistence was missing, unreadable, malformed, or inconsistent at the observation
point. A missing terminal snapshot therefore stays visible as the last persisted state; an
observer does not infer success or recovery from the writer's in-memory return value.

`watch()` polls because the generic VFS has no cross-process file notification contract. It
emits the initial snapshot by default, then changed redacted snapshots, and stops after an
observed terminal status. Consumers must treat the stream as advisory and re-observe after a
process or storage restart.

## Adversarial evidence

The focused cases are in [test/adversarial.test.js](../test/adversarial.test.js).

| Boundary | Hostile case | Evidence |
| --- | --- | --- |
| Concurrent consumption | Three runs change independently to `failed`, `unknown`, and `cancelled` | Three observer streams consume them concurrently and reach the matching terminal states. |
| Secret opacity | Request, plan, and failure strings contain a sentinel secret | Observer JSON contains no request/plan/response/error/message/tool-call fields or secret text. |
| Partial terminal persistence | The terminal status temp write fails after the `unknown` event is appended | Observer sees persisted `started`, reports `partial: true`, and does not claim terminal state. |
| Partial JSONL | An incomplete event line contains a secret error field | The incomplete line is omitted, the cursor remains at the last valid sequence, and the secret is absent. |
| Volatile listing | Runs are listed while terminal states differ | Listing returns sorted safe snapshots only. |

Focused verification: `node --test test/adversarial.test.js` — **11 tests passed**.
Full verification is recorded with the final change.

## Limits kept explicit

This is not a durable commit or recovery protocol. Atomic rename, event append, and polling do
not provide an fsync, distributed transaction, or exactly-once observation guarantee. A UI may
miss a transient partial state between polls, and a run whose status write failed may remain
`started` forever from the observer's point of view. Environment construction and DAG/workflow
scheduling are outside this change.
