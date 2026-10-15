# Runtime and Connectors

The runtime makes the resource model programmable. Connectors make external systems visible.
Neither should silently bypass the current View.

## JavaScript runtime

The JavaScript runtime receives an explicit environment handle:

```ts
interface JsEnvironment {
  stat(path: string): Promise<Stat>;
  list(path: string): Promise<DirEntry[]>;
  read(path: string, options?: ReadOptions): Promise<unknown>;
  write(path: string, value: unknown, options?: WriteOptions): Promise<WriteResult>;
  watch(path: string, options?: WatchOptions): AsyncIterable<Change>;
  invoke(path: string, input: unknown, options?: InvokeOptions): Promise<unknown>;
  resolve(ref: ResourceRef): Promise<ResolvedRef>;
  loadTool(path: string): Promise<CallableTool>;
}
```

The handle is scoped to one View and one Invocation. JavaScript programs must not receive
ambient host modules unless the host explicitly grants them. A deployment may offer a trusted
mode with direct host access, but that is a runtime policy and must not be confused with a
restricted mode.

The JavaScript runtime can:

- combine resources into new tools;
- select context for a model request;
- run concurrent Invocations;
- implement workflows;
- create or update AgentSpecs;
- generate applications and UIs;
- instantiate another environment;
- expose a new driver through an approved connector boundary.

## Dynamic tools

A dynamic tool is an ordinary resource-backed tool:

```text
/tools/find-todos/
  definition.json
  entry.js
```

The loader:

1. reads and validates `definition.json`;
2. resolves its entrypoint;
3. binds the tool to the current View;
4. checks the declared capability requirements;
5. returns a callable tool object.

The loader records the tool path and revision in the Invocation plan. A tool changed during a
run does not change the tool already bound to that run.

## Connector shape

A connector should expose a resource subtree and a status surface:

```text
/connectors/ssh-build-server/
  definition.json
  status.json
  control
  resources → /remote
```

The status surface reports connection state, endpoint identity where permitted, limits, and
last error. Credentials are separate protected resources; a connector may use them without
making their contents visible to an Agent.

## Models

A model provider is a callable resource. It may be mounted at:

```text
/models/anthropic/sonnet/
  description.json
  request
  events
```

The model interface accepts a canonical request and emits canonical model events. Provider
specific dialects belong inside the connector:

```ts
interface ModelClient {
  request(input: ModelRequest, options?: RequestOptions): Promise<ModelResponse>;
  stream(input: ModelRequest, options?: RequestOptions): AsyncIterable<ModelEvent>;
}
```

Conversation history belongs to the Invocation and its resource state. A model client does not
silently keep a second transcript. A non-streaming request is a collection of the same event
protocol, not a second incompatible semantic path.

## Host and SSH environments

A host may expose a local or remote shell as a resource:

```text
/remote/bin/shell
/remote/workspace
/remote/processes
```

An Agent with only those resources can treat the remote environment as its complete world.
The outer runtime may know that it is running on another machine, but that fact is not
implicitly visible.

Conversely, an Agent with a `/self` mount, source worktree, revision metadata, and runtime
status can inspect and modify its own implementation. Self-awareness is a granted view, not a
mandatory global property.

## Cloud and document resources

External stores use the same model:

```text
/notion/team/project
/s3/artifacts/build-123
/database/orders/query
```

A remote resource should expose:

- a stable path;
- metadata and schema;
- read and write semantics;
- synchronization or freshness information;
- external identity where permitted;
- errors and rate limits;
- an observation or status path.

The resource path is the local identity. The external identity belongs in metadata so that
callers do not need to encode provider-specific IDs into every workflow.

## UI and applications

An application is another resource-backed program:

```text
/apps/run-monitor/
  app.json
  index.html
  main.js
  styles.css
```

It reads `/runs`, `/events`, `/workspace`, or other resources through the same interface as an
Agent. It does not need a private tracing API. A UI may submit writes or invocations through
resources for which its View has permission.

## Trust profiles

The architecture supports several trust profiles, but each must be explicit:

| Profile | Meaning |
| --- | --- |
| Trusted JS | JavaScript may use host facilities granted by the host; Worker termination is a lifecycle feature. |
| Scoped runtime | JavaScript receives only the resource API and connector capabilities. |
| Host shell | The Agent is intentionally allowed to operate a local or remote shell. |
| Restricted process | The host supplies a real OS or container boundary in addition to the resource View. |

A Worker or VM alone is not a security boundary. The resource View controls the runtime API;
OS isolation is required when hostile code must be contained.

## Connector authority and credentials

A connector has two identities: the caller-visible resource identity and its private service
identity. The private identity is limited by a connector manifest:

```json
{
  "resource": "/models/default",
  "service_grants": [
    { "kind": "credential.use", "credential": "anthropic-prod" },
    { "kind": "network.request", "hosts": ["api.anthropic.com"], "methods": ["POST"] }
  ],
  "redact": ["authorization", "credential", "prompt.secret"]
}
```

The Agent can call the model resource, but cannot turn the model connector into a general HTTP
client or read the credential. A connector must report its external identity, limits, retry
policy, idempotency behavior, and shutdown behavior through its status resources.

This distinction also defines the trust boundary. A trusted connector may hold a credential;
a model, observer, or ordinary Agent code must not receive it unless a separate View grants
that access.
