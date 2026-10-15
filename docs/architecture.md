# Architecture

This document defines the system from the outside inward. Each layer has one question,
one primary abstraction, and one responsibility. Higher layers may use lower layers but
must not redefine their semantics.

## 1. External world: connectors

**Question:** How does an external system enter the environment?

**Mental model:** A connector is an adapter that makes one external system available as a
resource tree.

Examples include:

- a local directory;
- a process or shell;
- an SSH host;
- a Git repository and its worktrees;
- a model provider;
- an HTTP API;
- object storage;
- Notion or another document system;
- a browser or UI host.

The core runtime must not assume that any of these exists. A host supplies connectors when
it creates an environment:

```js
const environment = createEnvironment({
  mounts: [
    hostfs("/workspace", { source: ".", mode: "rw" }),
    ssh("/remote", { host: "build-server" }),
    model("/models/default", { provider: "anthropic" }),
  ],
});
```

A connector owns external details such as authentication, transport, retries, and remote
failure. The resource protocol is the boundary it presents to the rest of the system. See
[Runtime and Connectors](./runtime-and-connectors.md).

## 2. Resources: the addressable world

**Question:** What can exist in the environment?

**Mental model:** Everything has an address and a description.

A resource may be:

- a byte file;
- a directory;
- a query result;
- a model endpoint;
- a tool definition;
- a running task;
- an event stream;
- a Git revision;
- a remote workspace;
- an AgentSpec;
- an application.

The resource model defines discovery, data access, invocation, and observation. It does not
require every resource to have identical behavior. It requires every resource to expose its
behavior through the same address space and explicit metadata. See [Resource Model](./resource-model.md).

## 3. Namespace and view: what is visible

**Question:** What does this particular computation see and use?

**Mental model:** The namespace is the whole tree; a view is a window into that tree.

A namespace contains mounts and derived resources. A view selects a subset of resources and
operations for one Invocation or one JavaScript runtime.

```text
full namespace
├── workspace/
├── models/
├── tools/
├── agents/
├── runs/
├── git/
└── remote/

reviewer view
├── workspace/
├── models/default/
├── tools/read/
├── tools/search/
└── runs/
```

A view is explicit and immutable for the lifetime of an Invocation. Child views may be
narrower, never wider. The view is separate from the resource implementation: a driver must
not retain an unrestricted parent view in a closure.

## 4. References: how resources are composed

**Question:** How can one resource use part of another resource without copying it?

**Mental model:** A reference is a typed pointer into the resource tree.

References can select:

- a whole file or directory;
- a line range;
- a JSON path;
- a search result;
- an event subset;
- a Git revision;
- a live external query.

References are used by prompts, contexts, tool arguments, AgentSpecs, and workflow code.
Pinned and live references have different semantics and must be recorded when resolved. See
[Resource Model](./resource-model.md#references).

## 5. JavaScript runtime: how resources are recombined

**Question:** How does a user or agent create new behavior from existing capabilities?

**Mental model:** JavaScript is the environment's construction language.

JavaScript can read and write resources, resolve references, invoke tools and models, create
new tools, define workflows, build applications, and instantiate another environment. It
receives an explicit view rather than ambient host access.

The runtime is an implementation of the resource protocol, not a second authority beside it.
A JavaScript program that invokes a resource goes through the same view and capability checks
as a built-in tool. See [Runtime and Connectors](./runtime-and-connectors.md#javascript-runtime).

## 6. Agent composition: a recipe, not a process

**Question:** How is an agent assembled?

**Mental model:** An AgentSpec is a recipe that names a model, prompt fragments, context
references, tools, runtime, and view.

An AgentSpec is itself a resource, normally represented by a directory. It can be copied,
versioned, mounted, referenced, and modified like any other resource. See
[Execution Model](./execution-model.md#agentspec).

## 7. Invocation and Run: one request and its workflow

**Question:** What is an agent at runtime?

**Mental model:** An Invocation is one model request; a Run is the workflow that links
Invocations and effects.

An Invocation resolves the AgentSpec, materializes its prompt and context, and records one
terminal model response or request failure. Tool effects are separate records. If another
model request is needed, the Run creates a continuation Invocation with an explicit transcript
handoff. See [Execution Model](./execution-model.md#request-continuations) and
[Protocols and Examples](./protocols.md).

This makes concurrent work natural. Two Invocations may use the same AgentSpec and history
while having different inputs, views, revisions, and outputs. See
[Execution Model](./execution-model.md#invocation).

## 8. Observable state: every meaningful fact is a resource

**Question:** How can an authorized observer know what happened?

**Mental model:** A running Invocation is a directory that keeps changing.

A RunState exposes its request, resolved inputs, status, events, effects, and result. A UI,
CLI, debugger, or another agent reads the same resources. There is no separate hidden trace
model that is required to understand a run.

## 9. Versioned environments and applications

**Question:** How can an environment change without making an active run ambiguous?

**Mental model:** A revision is a complete candidate environment; activation changes future
Invocations.

Git worktrees provide a practical implementation for source, prompts, tools, and environment
definitions. An active Invocation is pinned to a revision. A self-modifying agent creates and
tests a candidate worktree, then activates it for later Invocations. See
[Versioning and Self-Modification](./versioning.md).

## Architectural boundaries

The following boundaries are intentional:

| Boundary | Owns | Must not own |
| --- | --- | --- |
| Connector | External transport and authentication | Agent policy or conversation history |
| Resource driver | A resource tree and its operations | Global runtime state |
| Namespace | Mounting and path resolution | Model loops or prompt composition |
| View | Visibility and allowed operations | Driver-specific transport details |
| Reference resolver | Selecting and materializing resources | Agent control flow |
| JS runtime | Composition and computation | Ambient host authority |
| Agent runner | One Invocation | UI rendering or connector internals |
| Run store | Durable observable state | Deciding what the model should do |
| Workflow/UI | Orchestration or presentation | Private copies of system state |
