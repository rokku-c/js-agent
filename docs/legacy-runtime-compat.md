# Legacy CLI and runtime compatibility

The repository ships two public execution surfaces. They share resource ideas and canonical model
shapes, but they do not share a session object or an adapter implementation. This page records the
behavior verified against the current checkout so a caller can choose the surface deliberately.

## Which surface owns what?

| Concern | Legacy CLI and agent loop | `js-agent/runtime` |
| --- | --- | --- |
| Entry point | `js-agent`, `Shell`, and `Vfs` | `createEnvironment`, `invokeOnce`, and workflow helpers |
| Agent state | `/agent/sessions/<id>.json` when `/agent` is mounted | `/runs/<id>/` through a `RunStore` |
| Unit of model work | A loop round, optionally resumed through a session | One `Invocation` per `invokeOnce` call; a workflow continuation is another invocation |
| Model boundary | Mounted model device; raw `write` is one request, `open` returns a stateful handle | Trusted `ModelAdapter.request()` receives a canonical request and returns a canonical response |
| Tools | `/bin` modules selected by name and executed by the loop | Resource definitions provide metadata; trusted `ToolAdapter.invoke()` supplies execution |
| Resource policy | Optional `/agent/policy.json`; a missing file means tool policy default `allow` | `createView` and `ServiceAuthority` default to deny when no grants are supplied |
| Observation | Session commands inspect conversation files | `RunObserver` exposes redacted run metadata; `observe` is a separately granted storage view |

The runtime does not read legacy session files, and the CLI does not consume `RunStore` records as
sessions. A session ID and an invocation ID are different namespaces.

## `write` and `invoke`

At the kernel boundary, these are separate operations:

- `Vfs.write(path, data, options)` is the legacy byte or device-write operation. A normal file
  needs `create: true` when it does not exist. A callable model device still accepts a one-shot
  canonical request through this spelling and returns the model response in `{ value }`.
- `Vfs.invoke(path, input, options)` is the generic callable-resource operation. The target must
  report `callable: true`, the caller must have an `invoke` grant in a `View`, and the device result
  is returned directly.
- A one-shot write or invoke cannot carry a stream. Legacy model streaming uses
  `await vfs.open(modelPath, "r+")` followed by `handle.stream(request)`; the handle is
  single-flight and keeps a transcript.

Both legacy spellings now forward `options.signal` to the driver. Cancellation before dispatch is
rejected with `ABORT_ERR`; cancellation after a model request has been sent remains an uncertain
external operation and must be treated as such by the driver.

Runtime model calls do not use `ResourceAdapter.write` as an alias. `invokeOnce` calls the supplied
`ModelAdapter.request` exactly once. `Environment.run` adds the explicit tool execution and one
continuation workflow around that request. A resource adapter may expose `invoke` for callable
resources, but a model adapter is selected separately by `model.path`.

## Sessions, Invocations, and continuations

A legacy session is a resumable conversation. The loop stores the canonical, unfolded message list
under `/agent/sessions`, derives context-fold placeholders when needed, and `--resume` loads the
conversation again. Supplying an existing session ID without `--resume` fails with `EEXIST` so a
new task cannot silently append to an old one.

A runtime Invocation is a durable record of one admitted model request. It stores the materialized
request, plan, response, and status under `/runs/<id>`. `invokeOnce` returns tool calls to its
caller; it does not execute tools or send another model turn. `runWorkflow` or `Environment.run`
can execute that batch and create a separate continuation Invocation. A provider failure after
start is recorded as `unknown`, not as a resumable session or a successful empty response.

## Tools and model streams

Legacy tools are JavaScript modules mounted under `/bin`. Their `defineTool` declaration is used by
the shell parser and by the agent's model catalog, and the loop invokes the module directly.

Runtime resource tools have two deliberately separate parts:

1. `loadToolDefinition` or `toolCatalog` reads and validates `definition.json` metadata.
2. A trusted `ToolAdapter.invoke` (or an explicit `bindToolResource` loader) supplies behavior.

Reading a resource definition does not execute its `entry.js`, and `createEnvironment` rejects a
selected tool without a matching trusted adapter. This separation prevents metadata discovery from
quietly becoming code execution.

The legacy model handle owns conversation state and offers `send` or `stream`. Runtime adapters
receive the complete canonical message list for each request. For streamed adapters,
`consumeModelStream` folds canonical events into the same response shape used by a non-streaming
adapter; malformed or incomplete streams fail with an error carrying `outcome: "unknown"` and,
when available, `partialResponse`.

## Defaults and errors

The two surfaces intentionally use different default boundaries:

- The legacy tool policy is permissive when no policy file exists. An explicit policy can deny or
  defer a call, and the denial is rendered as an ordinary tool error for the model.
- Runtime resource Views and named services are closed until grants are supplied. This affects
  adapter access to resources and connectors; the host adapters themselves are trusted code. The
  public `Environment` API has no legacy policy-file option.

Legacy kernel failures are `VfsError` instances with `code`, numeric `errno`, `path`, `operation`,
and optional `hint`; the message includes the actionable fields. Runtime lower-level admission and
workflow helpers commonly throw plain `Error` objects with a `code`, while View and resource
operations retain `VfsError` behavior. Runtime status is part of the result boundary: model
transport or response failures are persisted as `unknown`, tool failures become ordered
`is_error` tool results, and cancellation is reported as `cancelled` before dispatch or as an
uncertain outcome after dispatch.

## Reproduction commands

From the repository root, these commands exercise both surfaces and their current contracts:

```sh
npm test
node examples/getting-started.js
node examples/resource-defined-tool.js
node examples/real-use-callable.js
node --test test/callable-compat.test.js
```

The CLI can be exercised without a host mount or network. The shell write is explicit about file
creation:

```sh
node bin/js-agent --no-host -q -e 'js await write({path:"/tmp.txt",content:"legacy\n",create:true})'
```

The model examples use fake or offline adapters. No command above contacts a provider.

## Current limits

This is a compatibility guide, not an automatic bridge. There is no supported conversion from a
legacy session JSON file to a runtime `RunStore` run, no automatic `/bin` to resource-tool catalog
adapter, and no runtime stateful model handle. The TypeScript declarations intentionally leave many
workflow option records as `Record<string, unknown>` while the JavaScript validators enforce the
runtime contract. Trusted model and tool adapters also remain host code; a `View` scopes their
resource calls but is not a JavaScript sandbox.
