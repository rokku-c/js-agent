# Real use report: callable external resources

## Verdict

**Pass for the generic callable resource path.** A job submission endpoint can be addressed by
one resource path, inspected through `stat` and `read`, authorized by a View, invoked once with
an `AbortSignal`, and used by a trusted Environment tool without exposing host or service
authority to the caller.

The example is fully offline. `OfflineJobResource` models an HTTP `POST /jobs/submit` or a
stored procedure, but its dispatch is a deterministic timer. It exposes its effect journal as
`/external/effects/effect-N.json` and job status as `/external/jobs/<id>/status.json`.

## API change

`Vfs.invoke(path, input, options)` and `View.invoke(path, input, options)` are now first-class
operations. A View grant must include `invoke`, independently of `read` or `write`. A mounted
VFS resource must report `callable: true` from `stat`; the kernel then dispatches the driver's
`invoke` method with the caller's signal in its scoped context. `write` remains available as a
compatibility operation for existing request devices, but the generic API does not route invoke
through write.

The HTTP and local AI devices also implement `invoke`, preserving their one-request behavior.
The existing trusted model and tool adapter boundaries remain unchanged: a View limits resource
operations, while adapter JavaScript and named service authorities remain trusted host code.

## What was exercised

`examples/real-use-callable.js` performs two calls:

1. It starts `aborted-job`, aborts after dispatch begins, and gets `ABORT_ERR` with
   `outcome: "unknown"`. The effect resource remains readable with `state: "unknown"`, so the
   caller has evidence that it must reconcile rather than retry blindly.
2. It creates an Environment whose tool adapter invokes the same resource, starts a
   WorkflowGraph root, executes the tool, creates the continuation, closes the graph, and reads
   the terminal RunObserver snapshot. The successful effect is recorded as `completed`.

Focused tests cover View denial, signal delivery, effect uncertainty, the mounted local AI
callable path, and Environment/WorkflowGraph/RunObserver composition.

## Limitations

The kernel does not create an effect journal for an arbitrary driver. The driver owns effect
identity and must record `unknown` after dispatch when it cannot prove the outcome; this keeps
transport and provider semantics behind the trusted connector boundary. The offline fixture's
journal is process-local and has no provider reconciliation endpoint. Recovery therefore cannot
turn its unknown effect into completed automatically, and the generic `invoke` API does not
retry it.
