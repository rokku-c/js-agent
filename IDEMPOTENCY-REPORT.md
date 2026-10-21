# Callable resource idempotency report

## Verdict

**Pass for the explicit delivery and reconciliation contract.** Callable resource options now
validate and carry `operationId` and `idempotencyKey` through `Vfs` and `View`. Tool-call
execution derives stable identities from the durable run ID and model tool-use ID, so a retry
can present the same provider key. `OfflineEffectConnector` demonstrates both provider cases:
a deduplicating provider returns one receipt for timeout recovery and duplicate concurrent calls;
a provider without deduplication leaves the interrupted receipt `unknown` and a retry receives a
new receipt.

The contract does not provide global exactly-once execution. The connector owns provider
semantics, and callers must reconcile an `unknown` outcome by reading a receipt or status
resource before deciding what to do next.

## What was exercised

- `operationId` and `idempotencyKey` validation and forwarding through the callable View.
- Timeout followed by receipt reconciliation and retry with the same key.
- Duplicate concurrent dispatch with the same key, producing one provider receipt when the
  connector advertises deduplication.
- A non-deduplicating connector preserving `unknown` after interruption and producing a new
  receipt on retry.
- Stable tool identities across repeated `executeToolCalls` delivery for one durable run and
  tool-use ID.
- Durable RunStore restart classification: a committed `started` invocation becomes
  `unknown`, while the persisted plan retains its operation identity.
- WorkflowGraph recovery after a process-style restart, including fencing a late model result
  so it cannot overwrite the recovered `unknown` graph claim.

## Contract

`invoke(path, input, { signal, operationId, idempotencyKey })` treats the two identity fields as
printable strings. The kernel and View validate them; other options remain connector-owned.
`operationId` identifies the logical caller operation. `idempotencyKey` is the provider-facing
key and only has deduplication meaning when the provider explicitly supports it.

For tool calls, the default values are:

```text
operationId   = <runId>:<toolUseId>
idempotencyKey = <runId>:<toolUseId>
```

An adapter may pass those values to a callable resource. A connector may retain a receipt after
the caller times out, and should expose that receipt through ordinary resources for
reconciliation. An interrupted call with no provider evidence remains `unknown`.

## Files

- `src/kernel/invoke-options.js` — shared identity validation.
- `src/kernel/vfs.js` and `src/kernel/view.js` — explicit callable option boundary.
- `src/core/workflow-harness.js` — stable tool-call identity propagation.
- `src/connectors/offline-effect.js` — offline receipt/status connector with explicit
  deduplicating and non-deduplicating modes.
- `test/idempotency.test.js` — focused contract and recovery tests.
