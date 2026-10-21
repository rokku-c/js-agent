# Resource Model

The resource model is the foundation on which connectors, JavaScript, AgentSpecs, and
observable runs depend. Its goal is not to make every resource behave like a POSIX file. Its
goal is to give every resource one discoverable address and explicit operations.

## Resource tree

Every environment exposes a rooted tree. A resource has a path and metadata:

```json
{
  "path": "/models/default/request",
  "type": "endpoint",
  "readable": true,
  "writable": false,
  "callable": true,
  "observable": true,
  "versioned": false
}
```

The minimum metadata answers:

- what is this resource;
- which operations does it support;
- is it readable, writable, callable, or observable;
- what version or revision identifies it;
- what limits or input schema apply.

A resource may expose behavior through child nodes instead of adding custom methods:

```text
/jobs/123/
  request.json
  status.json
  result.json
  events.jsonl
  control
```

This gives long-running work the same discoverability as files while making its active
behavior explicit.

## Base operations

The protocol has a small common core:

```ts
interface ResourceStore {
  stat(path: Path): Promise<Stat>;
  list(path: Path): Promise<DirEntry[]>;
  read(path: Path, options?: ReadOptions): Promise<Value>;
  write(path: Path, value: Value, options?: WriteOptions): Promise<WriteResult>;
  watch(path: Path, options?: WatchOptions): AsyncIterable<Change>;
}
```

Callable resources additionally expose:

```ts
interface CallableResource {
  invoke(path: Path, input: unknown, options?: InvokeOptions): Promise<InvocationResult>;
}

interface InvokeOptions {
  signal?: AbortSignal;
  operationId?: string;
  idempotencyKey?: string;
}

interface InvocationResult {
  status: "completed" | "failed" | "cancelled" | "unknown";
  value?: unknown;
  effect?: { id: string; state: "started" | "completed" | "failed" | "cancelled" | "unknown" };
}
```

A driver may implement these operations with a local file, a remote API, a database query,
or an in-memory object. The caller does not need to know which implementation is behind the
path.

Streaming is represented as an observable resource or an async result with cancellation. It
must have one protocol everywhere. A network driver and a model driver must not return two
incompatible kinds of `stream()` object.

## Drivers

A driver maps one external or virtual source into a resource subtree:

```ts
interface Driver {
  name: string;
  mount(options: unknown, context: MountContext): Promise<ResourceInstance>;
}
```

A driver instance is scoped to the mount and receives a scoped resource context. It must not
capture a parent context with broader access. Driver state that matters to observers must be
represented under the mounted subtree or emitted as events.

Examples:

```text
hostfs:/workspace
ssh:/remote
model:/models/default
notion:/notion/team
worktree:/self/source
memory:/tmp
```

A driver is an adapter, not a policy engine. Authorization is decided by the current View and
operation request before the driver is called.

## Namespaces and mounts

A namespace is a collection of mounted trees. Mounts are explicit and inspectable:

```text
/proc/mounts
```

Path resolution uses the longest matching mount point. Mounting a resource does not imply
that unrelated resources become visible. A child View filters both the mount tree and the
operations that may be performed.

The namespace is responsible for:

- normalization and traversal rules;
- mount and unmount lifecycle;
- longest-prefix resolution;
- view derivation;
- operation dispatch;
- driver error normalization.

It is not responsible for Agent state, prompts, model loops, or session behavior.

## Views and capabilities

A View is an immutable capability description:

```ts
interface View {
  id: string;
  parent?: string;
  mounts: MountSelector[];
  grants: Grant[];
  revision?: RevisionRef;
}

type Grant = {
  path: PathPattern;
  operations: ("stat" | "list" | "read" | "write" | "watch" | "invoke")[];
};
```

Every resource operation is evaluated against the View. Tool visibility is derived from the
same View but is not the complete authorization model. A hidden tool and a denied write are
different facts.

A child View satisfies:

```text
visible(child) ⊆ visible(parent)
allowed_operations(child) ⊆ allowed_operations(parent)
```

The View is passed explicitly through the call chain. It is never stored as mutable fields on
a shared global VFS object.

## References

A reference identifies a resource and an optional selector:

```ts
interface ResourceRef {
  $ref: string;
  revision?: string;
  mode?: "live" | "pinned";
  selector?: Selector;
}
```

Examples:

```json
{ "$ref": "/workspace/src/main.js", "selector": { "lines": [20, 45] } }
```

```json
{
  "$ref": "/runs/run-123/events.jsonl",
  "selector": { "where": "kind == 'tool.completed'", "limit": 20 }
}
```

```json
{ "$ref": "/workspace", "revision": "git:abc123", "mode": "pinned", "selector": "changed-files" }
```

References have two modes:

- **Pinned:** resolve against a named revision or content identity. This supports reproducible
  runs.
- **Live:** resolve when an Invocation starts. This supports current context, current status,
  and external queries.

Reference resolution produces both the materialized value and provenance:

```ts
interface ResolvedRef {
  requested: ResourceRef;
  resolvedVersion?: string;
  value: unknown;
  sourcePath: string;
  selector?: Selector;
  bytes?: number;
}
```

Every Invocation stores the resolved references it actually used. See
[Execution Model](./execution-model.md#resolution-timing-and-snapshots).

## Reference arguments

Tool arguments may contain references instead of copied values:

```json
{
  "file": {
    "$ref": "/workspace/src/main.js",
    "selector": { "lines": [1, 80] }
  },
  "instructions": {
    "$ref": "/agents/reviewer/system/review-rules.md"
  }
}
```

The executor resolves these arguments before invoking the tool, records the provenance, and
passes the materialized value to the tool. A tool does not need to implement reference parsing
itself.

## State as resources

Any state that an authorized observer may need must have a resource representation. This
includes:

- current mount and View state;
- driver connection state;
- model request state;
- tool execution state;
- open worktrees and revisions;
- Invocation status;
- event streams;
- unresolved external effects.

In-memory caches are allowed as optimizations. They are not allowed to be the only source of
meaningful state.

## Authority domains

The View controls what the caller may see and do. A connector may also need authority to
perform a bounded operation on behalf of the caller—for example, a model connector may use a
credential without making the credential readable to the Agent.

These are separate domains:

```text
caller View
    ├── visible resources and caller operations
    └── delegated service grants ──→ connector
                                      ├── credential use
                                      └── transport use
```

A connector grant is scoped to a named service operation, destination, and limit. It is not a
copy of the parent View and cannot be used by the Agent as a general-purpose parent view.
Credentials are opaque references. Their values must not appear in mount metadata, process
arguments, events, prompts, or ordinary `read` results.

For example, an Agent may invoke `/models/default` while lacking `read` access to the model
connector's credential and transport resources. The model connector uses its own bounded
service grant to obtain them. This is a delegation from the Environment owner to the
connector, not an escape from the Agent's View.

## Operation lifecycle

Every operation has one lifecycle regardless of whether its implementation is local or
remote:

```text
created → started → completed
                   ├── failed
                   ├── cancelled
                   └── unknown
```

An operation has an owner, an operation ID, an input digest, an abort signal, and a disposal
path. An operation that may cause an external effect must be durably marked `started` before
being dispatched. A timeout after dispatch produces `unknown` unless the connector can prove
that the effect did not happen.

`read`, `list`, and `stat` normally observe. `write` changes stored state. `invoke` performs a
named operation and may have external effects. `watch` observes over time. A driver may expose
compatibility aliases such as `open`, but they must map to this lifecycle and use the same
cancellation and error semantics.

## Conflict semantics

Concurrent reads are allowed. Concurrent writes require one explicit policy per resource:

- compare-and-swap with a version token;
- append-only merge;
- deterministic last-writer-wins; or
- reject on conflict.

The default for mutable structured resources is reject-on-conflict. A caller that wants
last-writer-wins or a merge must request it explicitly. Every conflict and resolution is
observable in RunState.
