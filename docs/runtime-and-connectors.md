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

`loadToolDefinition(resources, path)` reads and validates `definition.json` only. It does not
read or execute `entry.js`, because metadata discovery must not turn resource bytes into ambient
code. A host that intentionally enables executable resource behavior calls
`bindToolResource(resources, path, { loader })`. That explicit loader receives the entry source,
its path, the validated definition, and the entry content revision; it decides whether to evaluate
the source, use a VM, or hand it to a supervised worker. The returned `{ path, invoke }` binding is
a trusted adapter and can be supplied to `createEnvironment({ tools: { adapters } })`, then passed
unchanged through `prepareWorkflow()` to `createWorkflowGraph()`.

The binding records the tool path and entry revision. A tool changed after binding does not change
the callable already held by that run.

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

### Implemented service delegation

The JavaScript runtime exports `createServiceAuthority(services, { grants })`. `services`
is a trusted record of named handlers, or an existing service authority. Grants are exact
operation names, default to `[]`, and are intersected with available parent operations.
Unknown names confer no authority; there is no wildcard syntax. The returned frozen facade
has `call(name, input, options)`, `derive({ grants })`, and `describe()`. Descriptions contain
only effective grant names. Handler bindings and grant arrays are snapshotted.

```js
const modelOnly = createServiceAuthority({
  "model.request": privateProviderRequest,
  "network.health": privateHealthCheck,
}, { grants: ["model.request"] });

const environment = createEnvironment({
  resources,
  services: modelOnly,
  model: {
    path: "/models/default",
    serviceGrants: ["model.request"],
    adapter: (request, { services, signal }) =>
      services.call("model.request", request, { signal }),
  },
  tools: {
    paths: ["/tools/lookup"],
    adapters: [{
      path: "/tools/lookup",
      resourceGrants: [{ path: "/workspace/brief.md", operations: ["read"] }],
      serviceGrants: [],
      invoke: ({ input, resources }) => resources.read(input.path),
    }],
  },
  permissions: {
    tools: [
      { path: "/tools/**", operations: ["read"] },
      { path: "/workspace/**", operations: ["read"] },
    ],
  },
});
```

Environment also accepts a trusted handler record directly as `services`. Model and tool
adapters receive independent service facades; omitted `serviceGrants` deny every service
operation. An injected parent authority caps all these grants. Agent reference resolution
and observers receive no service facade. `describe().delegation` reports effective service
grants and per-tool resource views without revealing handlers or credential values.

A tool's optional `resourceGrants` narrows `permissions.tools` by intersection. An empty
array removes all resource authority; omitting it retains the existing shared tool view.
The tool catalog still loads definitions through `permissions.tools`, so a tool adapter
need not read its own definition or other tools' metadata. Caller-supplied adapter options
cannot replace the assigned resource/service facades.

This implements named operation delegation, **not** the declarative `credential.use` or
`network.request` manifest interpreter sketched above. A trusted provider handler must bind
its credential and endpoint policy, validate inputs, handle redirects and cancellation, and
sanitize responses/errors. Do not expose a generic credential getter or unrestricted HTTP
handler as `model.request`. The authority facade forwards handler outputs and errors; it
does not redact them or contain hostile host JavaScript. Neither adapters nor service
handlers become untrusted sandboxes.

See [the offline runnable example](../examples/connector-service-authority.js) and
[the service-authority exercise report](real-use-service-authority.md).
