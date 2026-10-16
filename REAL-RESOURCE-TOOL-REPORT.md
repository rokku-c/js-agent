# Resource-defined tool report

## Result

Pass. A real `/tools/prefix-read/` resource now contains both `definition.json` and `entry.js`.
The example explicitly loads the entry source, turns it into a callable through a host-selected
loader, supplies the resulting `{ path, invoke }` binding to `createEnvironment`, and executes it
through `createWorkflowGraph`.

Run it with:

```sh
node examples/resource-defined-tool.js
```

The output includes the entry revision, `completed_with_tool_calls` for the root invocation, the
resource-backed answer, and a completed graph.

## Why metadata loading stopped short

`loadToolDefinition()` intentionally reads and validates only `definition.json`. That gives the
model a stable, JSON-shaped catalog without importing arbitrary bytes from a resource. The
existing Environment contract then required a separately supplied trusted adapter for every tool
path. Consequently, an `entry.js` field could describe a tool but could not compose behavior into
the adapter map by itself.

## Binding boundary

`bindToolResource(resources, path, { loader })` is the explicit bridge. It:

1. loads the validated definition;
2. reads the declared relative entry source through the supplied View;
3. passes source, paths, definition, and the entry SHA-256 revision to the caller's loader;
4. requires the loader to return a function;
5. returns the existing trusted adapter shape with `invoke()`.

The runtime does not import, evaluate, or sandbox resource code. A host must select the loader and
therefore owns the execution policy. The binding's View is retained for invocation, so the entry
function receives only the resource authority used to create the binding. Metadata cataloging
continues to avoid entry reads, and calling `bindToolResource` without a loader fails before any
resource read.

## Validation

```sh
node --test test/tool-resource.test.js test/resource-defined-tool.test.js
npm test
```

The focused tests cover metadata-only loading, explicit loader requirements, entry revision
capture, non-callable loader rejection, missing entrypoints, and the Environment → WorkflowGraph
execution path.
