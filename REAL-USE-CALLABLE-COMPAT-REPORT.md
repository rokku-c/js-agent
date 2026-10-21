# Real-use compatibility report: generic callable resources

## Verdict

The generic `Vfs.invoke(path, input, options)` and `View.invoke(...)` protocol is compatible with the legacy resource surface exercised here. Existing `read`, `write`, and `open` paths remain in place, while callable dispatch requires both `stat().callable === true` and a driver `invoke` method. A View grant for `invoke` is independent from `read` and `write`.

## Audit matrix

| Surface | Result | Compatibility evidence |
| --- | --- | --- |
| `mem` files | pass | missing paths retain `ENOENT`, plain files reject `invoke` with `ENOTSUP`, and synthetic mount directories are non-callable |
| `hostfs` files | pass | mounted host files reject `invoke` and `open`; read-only behavior remains unchanged |
| `proc`, `secret`, and `bin` | pass | metadata/configuration files reject `invoke` and `open` cleanly |
| `/dev` | pass | `/dev/null` is non-callable; callable device metadata without an implementation reports `ENOTSUP`; byte-device behavior remains unchanged |
| `net:/dev/net/request` | pass | generic invocation, legacy response-valued `write`, and `r+` `open` work; malformed input is `EINVAL`; caller cancellation remains `ABORT_ERR` |
| `ai` model nodes | pass | fake local invocation, legacy `write`, and conversation `open` work; malformed input is `EINVAL`; network-backed cancellation reaches the net driver |
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

- `npm test`: 281 passed, 0 failed.
- `node --test test/callable-compat.test.js`: 4 passed.
- `node examples/real-use-callable.js`: exit 0; aborted effect is `unknown`, workflow effect is `completed`.
- `node examples/connector-service-authority.js`: exit 0; model grant is `model.request`, tool service grant is empty.

The compatibility coverage is in `test/callable-compat.test.js`; the test manifest includes it in
`npm test`. The audit also cross-checks the existing service-authority and public API declaration
suites rather than duplicating their handler and type-system cases.

## Limitations

The kernel does not journal arbitrary external effects. A driver or trusted connector must define the dispatch boundary, retain effect identity, and record `unknown` when cancellation cannot prove the provider outcome. `invoke` does not retry an unknown effect, and the offline fixture has no provider reconciliation endpoint. Service handlers are trusted host code and own their provider-specific cancellation and error sanitization.
