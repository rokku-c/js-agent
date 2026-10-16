# Implementation Status

The architecture documents describe the target. This page records the first implementation
milestone and the boundary between available code and planned behavior.

## First milestone: one request with observable inputs and output

The public experimental entrypoint is `js-agent/runtime`. Its primitives are intentionally
independent: callers can use a resource View or reference resolver without running an agent.

| Primitive | Responsibility | Boundary |
| --- | --- | --- |
| `createView(resources, {grants})` | Authorize file operations and derive narrower views | Trusted JavaScript API; no process isolation or driver-handle delegation |
| `resolveReference(resources, ref)` | Read a text reference, select lines, record hashes | Exact paths, live reads, SHA-256 content assertions; no Git snapshots or search selectors |
| `resolveArguments(resources, input)` | Resolve explicit `$ref` objects inside arguments | Ordinary strings remain literal; `$literal` escapes structured data |
| `createRunStore(storage)` | Record request, materialized plan, response, status and events | Volatile milestone; atomic rename is not an fsync or distributed transaction guarantee |
| `createRunObserver(storage)` | Read redacted status/event metadata for concurrent UI or Agent observation | Polling, best-effort and explicitly volatile; payload files are not exposed |
| `invokeOnce(options)` | Resolve a simple AgentSpec and dispatch exactly one model request | No tool execution, retries, session, or continuation scheduler |
| `loadToolDefinition(resources, path)` | Load and validate a resource-backed tool definition | Metadata only; `entry.js` is never executed |
| `buildContinuation(options)` | Build the next canonical request tail from one response and a complete tool batch | Pure builder; no model call or tool execution |
| `continueOnce(options)` | Dispatch one explicit continuation from a parent request | No tool execution or implicit session loop; parent linkage is recorded in the plan |

The legacy CLI remains available. It now passes immutable run context through tools and nested
tasks instead of mutating `vfs.agent*` fields. Its existing model loop and Worker lifecycle are
not replaced by this milestone.

## Resource Views

Grant paths are exact paths or a trailing `/**` subtree pattern, including that subtree's root.
Operations default to denied. Requests are normalized before matching, and derived Views
intersect with their parents. Views do not expose raw drivers, mounting, or `open()` handles.

```js
const reader = createView(vfs, {
  grants: [{ path: '/workspace/**', operations: ['stat', 'list', 'read'] }],
});
const sourceOnly = reader.derive({
  grants: [{ path: '/workspace/src/**', operations: ['read'] }],
});
```

`exists` requires `stat`. Listings reveal only immediate children covered by effective grants.
`mkdirp` preflights `stat` and `mkdir` authority on every non-root ancestor. Recursive deletion
and directory renaming authorize whole driver operations; do not grant them when descendant
exceptions must be preserved. File Views do not constrain a trusted driver's internal effects.

The trusted host supplies model and tool adapters separately. Selecting an adapter is an
explicit service capability; it does not grant reads of its credentials. The generic service
grant protocol in the architecture is still planned.

## Reference semantics

```js
const selected = await resolveReference(reader, {
  $ref: '/workspace/src/main.js',
  selector: { lines: [1, 20] },
});
```

Line ranges are one-based and inclusive, preserving the original line endings. `mode: 'live'`
is the default. For `mode: 'pinned'`, `revision` must be a full-source `sha256:<hex>` digest.
This checks the current source against that digest; it does not retrieve historical content.
The provenance records full-source and selected-content hashes. Unsupported selectors fail.

A reference byte cap bounds selected content after reading. Current VFS reads may buffer the
entire source; this is not yet a transport or memory quota. Historical retrieval and bounded
streaming require driver support.

## AgentSpec and execution

The milestone accepts only `model`, `system`, `context`, and `tools`. An AgentSpec can be a
plain object or an absolute path to a JSON file. Prompt and context entries are references;
model and tool selections are exact paths in explicitly supplied adapter catalogs.

The host supplies the effective resources facade. Authored `view`, Git `revision`, dynamic
module loading and other unsupported fields must fail rather than silently imply enforcement.
Model requests receive captured input and tool definitions. Proposed tool calls are returned
as data; the host decides whether and how to execute them.

No mandatory Run/session wrapper is introduced. Each invocation directly owns `/runs/<id>`.
A future optional workflow can group these records without changing the one-request primitive.
Concurrent requests are independent; conflict handling for shared workspaces is not supplied
by concurrency itself.

## Verification and next steps

New focused suites cover Views, references, overlapping legacy runs, one-request execution, continuations, tool metadata, and worker cancellation.
The offline example demonstrates their composition without credentials or network access.

Next milestones should add bounded model/stream lifecycle adapters, reference-aware dynamic
tools and explicit continuation assembly before Git activation. Worktree switching, remote
connectors, browser packaging, hostile-code isolation, durable recovery and UI hosting remain
planned. Existing prototype tests do not establish those guarantees.

## Continuations

`buildContinuation` requires one result for every `tool_use` block in the parent response. It
preserves provider blocks, IDs, result order, and error flags, then returns a deeply frozen request.
The caller decides when to persist and dispatch that request as a new Invocation. `continueOnce`
does that dispatch while preserving the parent's system, tool catalog, and message history. It
is not an automatic session loop and it accepts only already materialized tool results.

## Dynamic tool definitions

`loadToolDefinition` reads `/tools/<name>/definition.json` and validates its JSON schema.
An `entry.js` field is descriptive metadata and is never imported or evaluated by this milestone.
The host must bind executable behavior explicitly. This keeps dynamic tool metadata composable
without accidentally turning resource content into ambient code.

## Environment and Run observation

The current runtime also exports `createEnvironment`, `createRunObserver`, and
`createWorkflowGraph`. `createEnvironment` composes four explicit views—agent, model, tools,
and observer—around the existing one-request primitives. Model and tool adapters remain trusted
host functions; the facade makes that boundary visible and does not claim to sandbox them.

`createRunObserver` lists and watches redacted volatile RunState snapshots. It treats malformed
or incomplete event tails as partial observations rather than inventing success. It does not
turn volatile storage into durable recovery.

`createWorkflowGraph` persists node and edge state above individual RunState records. It supports
concurrent branches, joins, keyed continuation deduplication, aggregate cancellation, and
restart inspection. It is still backed by volatile storage; external effects remain `unknown`
when recovery cannot establish their outcome.

Try the graph example with:

```sh
node examples/workflow-graph.js
```
