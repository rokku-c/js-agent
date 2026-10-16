# External connector watch UI report

## Verdict

**Pass for the remote-shaped UI flow.** The fixture composes an `InMemoryConnector`, a `View`, `createRunObserver`, and `createWorkflowGraph` without giving the UI direct access to model requests, plans, responses, or tool payloads. The UI observes remote file/status changes and volatile run state while two workflow branches are active, then reports the joined graph.

Run it with:

```sh
node examples/external-workflow-ui.js
```

## Flow exercised

`examples/external-workflow-ui.js` uses a connector shaped like a release service:

- `/remote/release/brief.md` is a live external reference;
- `/remote/release/review-rules.md` is read as a SHA-256 pinned reference;
- `/remote/tools/*/definition.json` supplies tool metadata;
- `/status.json` reports connector health;
- `/runs` and `/workflows` stay in a separate VFS-backed volatile store.

The external View grants `watch` and file operations under `/remote/**`, plus `read` and
`watch` for status. The model and tools receive narrower derived Views. The UI starts a
subtree file watch and an exact status watch, starts the root graph node, waits until both
continuation nodes are `started`, mutates the live brief and connector status, and consumes
those two external changes. It then releases both model gates, consumes terminal observer
snapshots, closes the graph, and renders the final state.

The observed live state is:

```text
remote changes: write:/remote/release/brief.md, status:/status.json
graph: waiting
root: completed_with_tool_calls
branch:summary: running
branch:risks: running
runs: completed_with_tool_calls, started, started
```

The final state is a completed graph with both edges and branch runs completed. Measured
branch overlap is `2`. The live brief resolves to its updated content, while the pinned
review rules continue to resolve against their original revision. A stale pinned revision
still fails through the existing connector/reference tests.

## Watch API seams

Both APIs return async iterables, but they observe different things:

| API | Source | Item | Default | Cursor/termination |
| --- | --- | --- | --- | --- |
| `View.watch(path)` | connector push events | one change (`kind`, `path`, `source`, revision/status data) | no initial snapshot | caller closes with `return()` or signal |
| `createRunObserver(...).watch(id)` | run files polled by interval | redacted point-in-time snapshot | initial snapshot | `after` filters event sequence; terminal state ends the stream by default |

The UI handles this seam explicitly: connector watches drive resource-change rows, while
observer watches drive run-status rows. Both now reject pending and future reads when their
signal is aborted, so a cancelled UI subscription cannot silently drain stale connector
changes. The observer remains advisory and may skip transient file states because it polls.

## Minimal fix

The connector watch previously retained only one pending `next()` waiter. A second concurrent
consumer could leave the first promise unresolved. Abort removed the watcher but left queued
changes available and caused later reads to return `{ done: true }`, which differed from the
observer's abort behavior. The watch now:

- keeps all pending `next()` waiters in FIFO order;
- clears queued values on close and rejects pending/future reads with the abort reason;
- bounds the queue with `maxQueue` (default `256`);
- fails explicitly with `EOVERFLOW` when a producer outruns a consumer instead of dropping events;
- preserves clean `return()` closure as a normal `{ done: true }` result.

The View remains the authorization boundary: the connector is never handed to the UI when a
narrow View is sufficient, and `View.watch` checks the requested path before forwarding it.

## Redaction and metadata

Run observer snapshots contain status, event sequence/kind/time, file availability, and the
`volatile`/`redacted` markers. They do not contain request, plan, response, error messages,
tool calls, or connector metadata. Provider identity and freshness metadata are visible only
through an external `stat` grant; the fixture report keeps that separate from the observer
payload. This preserves the existing distinction between resource metadata and redacted run
observation.

## Validation

- `node --test test/connector.test.js test/external-workflow-ui.test.js test/integrated-environment-graph.test.js` — 7 passed.
- `node examples/external-workflow-ui.js` — completed with two concurrent branches.
- `npm test` — full suite passed after the focused checks.

This remains an in-memory and volatile integration check. It does not claim remote delivery,
replay, durable event storage, or historical retrieval for pinned references.
