# Real Use Report: external-resource evaluator B

Date: 2026-10-16
Checkout: `/Users/user/.codex/worktrees/19fa/js-agent`

## Verdict

**Conditional pass for the implemented volatile resource contract.** View authorization, current-content pinning, selected-byte bounds, cancellation propagation, and external-effect uncertainty held under the hostile cases below. Two input-boundary defects were fixed. The implementation still has a documented transport limitation and a material partial-storage limitation described below, so it is not a durable RunState or streaming-quota guarantee.

## Exercise and evidence

The adversarial suite is [test/adversarial.test.js](test/adversarial.test.js). It uses a simulated remote namespace with delayed reads, stale content, mutable returned buffers, credential-shaped entries, shell-like path strings, and failing status writes.

| Boundary | Hostile case | Evidence |
| --- | --- | --- |
| View authorization | Traversal into an ungranted secret, non-string path coercion, and a remote shell command string | All are rejected before the adapter is called. The facade exposes no `open` or `exec`. |
| Credential opacity | `/dev/secrets` lists a token with size, mode, and target metadata | The View returns only `{name: "TOKEN"}`. The token value requires its explicit read grant; stat is denied. |
| Delayed View read | Remote read waits on an AbortSignal | The same abort reason reaches the caller and the adapter sees the cancellation. |
| Pinning | Remote returns newer bytes after a delayed read | A pinned old SHA-256 revision returns `ESTALE`; the current bytes are never accepted as the old revision. |
| Byte bounds | Invalid `maxBytes`, mutable `ArrayBuffer`, and a 1 MiB source with a small selected line | Invalid bounds fail before `read`; bytes are copied before hashing; selected UTF-8 output stays within the cap. |
| Reference cancellation | Abort occurs before a delayed read releases | The abort reason wins after the read settles; no late value is returned. |
| RunState | Model-side effect happens before a disconnect | The run is recorded as `unknown`, so the effect is not presented as success. |
| Admission cancellation | Agent/context read completes after cancellation | The run is `cancelled` and the model is never called. |
| Partial persistence | Terminal status temp write fails | `store.lastError()` records `EIO`, but the persisted status remains the previous `started` state. This is an observed volatile-storage limitation. |
| Root namespace | RunStore configured with `/` | Run paths are now canonical `/root-run/...`, without the invalid `//root-run/...` form. |

The full suite passes: **153 tests, 153 passed**. Focused verification also passes with `node test/run.js adversarial` (**8/8**).

## Changes made

- `View` now rejects non-string resource paths before normalization or dispatch, preventing type-coercion from becoming an authorization input.
- Reference `maxBytes` is validated before awaiting a remote read.
- RunStore joins `/` roots without producing double-slash resource paths.
- The adversarial suite is included in `npm test` and the named suite runner.

## Trust-boundary assessment

The View is an operation/path capability facade over trusted JavaScript. It successfully prevents the caller from reaching ungranted paths or extracting raw resource handles, but it does not sandbox a malicious driver: once an operation is granted, driver-defined effects remain trusted by design.

Pinned references authenticate the bytes returned by the current resource. They do not retrieve historical revisions. A remote resource can therefore return `ESTALE`, delay indefinitely, or ignore cancellation; the resolver can reject after it settles, but it cannot force a non-cooperative adapter to stop.

The byte limit is a post-read materialization cap. The current API passes `encoding` and `signal` to `read` and may buffer a large source before applying the selected-content bound. The adversarial test confirms the cap on the materialized selection, not a network or memory quota.

Credentials remain opaque when they are behind an ungranted resource path, and listing redacts metadata. Credential names are still discoverable when a directory list grant is given. Connector-specific service-grant and error-redaction enforcement is outside this milestone; hostile connector errors should be treated as potentially sensitive before being persisted to RunState.

RunStore is explicitly `volatile`. A failed terminal status write can leave observers reading an older snapshot even though the in-memory store records `lastError` and returns the requested terminal result. Durable commit/recovery and an atomic status/event protocol are still required before treating RunState as an authoritative cross-process record under storage failure.
