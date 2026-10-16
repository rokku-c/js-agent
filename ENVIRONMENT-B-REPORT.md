# Environment builder B report

## Verdict

**Pass, with an explicit-catalog recommendation.** A small `createEnvironment` facade is useful when it composes existing resource Views, `RunStore`, and the workflow harness without introducing another execution model. The API is easy to explain when each adapter receives one named View and run state is observed through another. It should not silently discover paths or tools during execution.

The implementation is a real resource-backed application: context and tool definitions are read from a VFS, the model and tool implementations are trusted host adapters, the tool result drives an explicit continuation, and an observer reads the persisted run files through its own View.

## API boundary

`createEnvironment` accepts four permission sets:

- `agent` resolves the AgentSpec's context and prompt references.
- `model` is passed to the configured model adapter only.
- `tools` is passed to configured tool adapters only.
- `observer` wraps run storage for status, event, and invocation inspection.

The model and tool adapters are intentionally still trusted JavaScript. Their paths and methods are captured by the environment, and their resource access is scoped by the corresponding View. This makes the host adapter boundary visible in `describe().adapterBoundary` instead of implying that a View can sandbox adapter code.

The run uses the configured `tools.paths` as an exact catalog. Each path must have a matching trusted adapter. `discoverTools()` is a separate operation that requires `list` permission and returns definitions from a directory; it is useful for an operator or catalog builder, but `run()` never calls it.

## Evidence

`test/environment.test.js` covers:

- model, tool, and observer Views with different grants;
- a model adapter reading its model resource while a tool adapter is denied that path;
- an explicit tool catalog excluding a separately discoverable tool;
- a model tool call, resource-backed tool execution, continuation, and persisted run observation;
- exact trusted adapter path matching and observer denial.

`examples/environment-app.js` is a deterministic runnable demo with no network or credentials.

## Limits

This facade does not make adapter JavaScript untrusted, add a new `invoke` syscall, or change RunStore/workflow semantics. Discovery is not a security boundary; listing permission only controls what the catalog builder can see. The existing volatile RunStore behavior remains the source of truth for storage guarantees.
