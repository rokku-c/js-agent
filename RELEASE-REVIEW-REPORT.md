# Release review application report

The checked-in example `examples/release-review-application.js` composes the runtime into an offline release-readiness review. It stores the release brief, review policy, model metadata, and a tool definition plus entrypoint as resources. The entrypoint is evaluated only by the example's explicit loader, then runs with a narrowed resource view and the `release.evidence` service authority. The model adapter receives only `release.status`.

The application uses a host-backed durable `RunStore` under `/runs` and a `WorkflowGraph` under `/workflows`. The root model response requests `release-evidence`; the graph then starts `security` and `migration` continuation branches. The security branch completes. The migration model request is deliberately held at a restart boundary.

The second half remounts the same temporary directory in a fresh `Vfs`, constructs a fresh `RunStore`, `Environment`, `RunObserver`, and `WorkflowGraph`, and calls `environment.recoverWorkflow()`. The observer sees only redacted run metadata. Recovery journals the in-flight migration as `unknown`, marks its graph node with `recovery: "process_restart"`, and does not dispatch the replacement model. Releasing the old request afterward produces `EALREADY`; its late completion cannot overwrite the recovered result.

Run it with:

```sh
node examples/release-review-application.js
```

Representative UI output:

```text
RELEASE REVIEW UI
workflow release-review: unknown
tool release-evidence @ sha256:<entry revision>
before restart: waiting; after recovery: unknown
nodes:
  root               completed_with_tool_calls
  branch:security    completed
  branch:migration   unknown (process_restart)
runs:
  release-review-migration         unknown events=2
  release-review-root              completed_with_tool_calls events=2
  release-review-security          completed events=2
service calls: release.status, release.evidence, review.branch
observer redacted: true; payloads exposed: false
late pre-restart branch: unknown
```

The durable guarantee covers the local journal and recovery decision. An external effect that was interrupted during a model or connector dispatch remains unknown; this example preserves that uncertainty and never replays it automatically.
