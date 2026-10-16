# Core Protocols and Examples

This document sketches the target protocol; its examples are not yet executable APIs.
See [Implementation status](./implementation.md) and the [offline example](../examples/one-request.js)
for the current executable subset.

This document is the compact implementation contract. The other design documents explain why
the pieces exist; this document shows how they fit together.

## Public model

The public model has four concepts:

| Concept | Question it answers |
| --- | --- |
| **Environment** | What resources exist and where are they mounted? |
| **Resource** | What can be observed, changed, invoked, or watched? |
| **AgentSpec** | How should resources be composed into one model request? |
| **Run** | What happened while evaluating one AgentSpec and its continuations? |

`View`, `Reference`, `Revision`, `Driver`, and `Connector` are mechanisms used to implement
those four concepts. `Invocation` is the one-request record inside a Run.

## Minimal schemas

### AgentSpec

```json
{
  "type": "agent",
  "model": { "$ref": "/models/default", "mode": "pinned" },
  "system": [
    { "$ref": "/agents/reviewer/system/base.md", "mode": "live" }
  ],
  "context": [
    { "$ref": "/workspace", "selector": "git:changed-files", "mode": "live" }
  ],
  "tools": [
    { "$ref": "/tools/read", "revision": "git:abc123" }
  ],
  "view": { "$ref": "/views/reviewer" },
  "revision": "git:abc123"
}
```

### View

```json
{
  "type": "view",
  "parent": "/views/default",
  "grants": [
    { "path": "/workspace/src/**", "operations": ["stat", "list", "read"] },
    { "path": "/tools/read", "operations": ["stat", "read", "invoke"] },
    { "path": "/models/default", "operations": ["stat", "invoke"] }
  ]
}
```

The effective View is the intersection of the caller View, AgentSpec View, and revision View.
A model connector may hold separate bounded service grants for credentials and transport.

### Resource reference

```json
{
  "$ref": "/workspace/src/main.js",
  "selector": { "lines": [20, 45] },
  "mode": "pinned",
  "revision": "git:abc123"
}
```

`mode: live` resolves when the relevant phase runs. `mode: pinned` requires a version or
content identity. Both the requested reference and the resolved value are recorded.

### Run and Invocation

```json
{
  "run_id": "run-123",
  "root": "inv-0",
  "status": "running",
  "invocations": [
    {
      "id": "inv-0",
      "request_id": "req-0",
      "status": "completed_with_tool_calls",
      "response": "/runs/run-123/invocations/inv-0/response.json",
      "continuation": "inv-1"
    },
    {
      "id": "inv-1",
      "parent": "inv-0",
      "request_id": "req-1",
      "status": "completed"
    }
  ]
}
```

The durable directory is:

```text
/runs/run-123/
  run.json
  status.json
  events.jsonl
  invocations/inv-0/
    request.json
    plan.json
    response.json
    effects/
  invocations/inv-1/
    request.json
    plan.json
    response.json
    effects/
  output.json
```

## Complete local flow

> The following block is the target resource protocol expressed as pseudocode. It is not the
> current JavaScript constructor signature: the executable API uses `createEnvironment({
> resources, storage, model, tools, permissions })`. Start with [getting started](./getting-started.md)
> for a runnable application and use this section for the durable resource layout.

```js
const env = createEnvironment({
  mounts: [
    hostfs("/workspace", { source: ".", mode: "rw" }),
    memory("/runs"),
    model("/models/default", { provider: "fake" }),
    tools("/tools", { names: ["read", "search"] }),
  ],
});

const run = await env.run("/agents/reviewer", {
  input: "Review the current change.",
});

console.log(await env.read(`${run.path}/status.json`));
console.log(await env.read(`${run.path}/invocations/inv-0/plan.json`));
console.log(await env.read(`${run.path}/events.jsonl`));
```

The model sees a frozen catalog and a materialized Prompt AST. If it requests `search`, the
executor validates the call, resolves any reference arguments, records the effect, runs the
tool, and creates a continuation Invocation with the original response and ordered results.

## Dynamic tool flow

Invocation A may create a tool resource:

```text
/tools/find-todos/
  definition.json
  entry.js
```

Invocation B must explicitly include `/tools/find-todos` in its AgentSpec or tool catalog. The
creation does not mutate an active request. Invocation C may be given a narrower View and fail
to resolve the tool even though it exists in the Environment.

## Self-modifying flow

```text
read /self/revision.json
create /workspaces/self/candidates/run-123
write candidate prompt or code
run tests against candidate
activate candidate revision
run a new Invocation
```

The active Invocation remains pinned to the old revision. The new revision affects later work.

## Conformance scenarios

An implementation is not conformant until it can demonstrate:

1. two concurrent Runs with isolated Views;
2. a model invocation that uses a credential without exposing it to the Agent;
3. a live reference resolved and recorded at effect time;
4. a dynamic tool created by one Run and explicitly loaded by another;
5. a provider disconnect represented as `unknown` rather than success;
6. a cancelled worker whose owned handles are closed or marked unknown;
7. a self-modifying candidate activated without retargeting a running Invocation;
8. a UI and an Agent reading the same RunState resources.
