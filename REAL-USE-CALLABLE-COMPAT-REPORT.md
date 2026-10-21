# Real-use compatibility report: generic callable resources

## Verdict

The generic `Vfs.invoke(path, input, options)` and `View.invoke(...)` protocol is compatible with the legacy resource surface exercised here. Existing `read`, `write`, and `open` paths remain in place, while callable dispatch requires both `stat().callable === true` and a driver `invoke` method. A View grant for `invoke` is independent from `read` and `write`.

## Audit matrix

| Surface | Result | Compatibility evidence |
| --- | --- | --- |
| `mem` files | pass | plain files reject `invoke` with `ENOTSUP`; normal file writes still use `create` and byte semantics |
| `hostfs` files | pass | mounted host files reject `invoke`; read-only and read/write behavior remains unchanged |
| `proc`, `secret`, and `bin` | pass | metadata/configuration files reject `invoke` cleanly |
| `/dev` | pass | `/dev/null` is non-callable; callable device metadata without an implementation reports `ENOTSUP` |
| `net:/dev/net/request` | pass | generic invocation returns the response; malformed input is `EINVAL`; caller cancellation remains `ABORT_ERR` |
| `ai` model nodes | pass | fake model invocation works; malformed input is `EINVAL`; network-backed cancellation reaches the net driver |
| `View` | pass | `invoke` is separately authorized, arguments/options are forwarded, and derived views cannot widen it |
| service authority | pass | existing public authority tests verify exact grants, delegation intersection, handler errors, and signal forwarding |
| public typed API | pass | declarations include optional adapter `invoke`, required view `invoke`, the `invoke` grant operation, and service `call` |
| external effect uncertainty | pass | the offline job example records `unknown` after post-dispatch abort and exposes the effect for reconciliation |

## Compatibility fixes

The audit found three narrow boundary issues:

- A pre-aborted generic call could run `stat` and return `ENOTSUP` for a plain file. `Vfs.invoke` now checks cancellation before stat or driver dispatch and normalizes DOM abort reasons to `ABORT_ERR`.
- The AI one-shot callable path dropped its signal when it crossed into the legacy net write device. It now forwards the signal through that write, and net preserves caller cancellation instead of wrapping it as `EIO`.
- Generic net and AI inputs that are malformed JSON or not objects now fail with `EINVAL`. Legacy net `write` parsing and the existing `write`/`open` dispatch paths remain unchanged; generic-only timeout classification does not alter legacy timeout behavior.

## Real-use validation

The offline callable example performs an aborted job submission and a successful Environment → WorkflowGraph → RunObserver call. The aborted effect is observable as `state: "unknown"`; the successful effect is `completed`.

Validation completed in this checkout:

- `npm test`: 277 passed, 0 failed.
- Focused callable compatibility tests: 4 passed.
- All 19 `examples/*.js` programs: exit 0.
- Both `examples/*.sh` programs: exit 0.

## Limitations

The kernel does not journal arbitrary external effects. A driver or trusted connector must define the dispatch boundary, retain effect identity, and record `unknown` when cancellation cannot prove the provider outcome. `invoke` does not retry an unknown effect, and the offline fixture has no provider reconciliation endpoint. Service handlers are trusted host code and own their provider-specific cancellation and error sanitization.
