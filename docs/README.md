# js-agent Design

This directory describes the target architecture for `js-agent`.

The project is an extensible computing environment in which resources, tools, prompts,
contexts, model providers, workspaces, and running state share one addressable resource
model. An agent is assembled from those resources and evaluated on demand; it is not
fundamentally a long-lived session object.

This is a design specification, not a claim that every part is implemented in the current
prototype. The implementation should be judged against the invariants in this document. The
legacy prototype remains a compatibility starting point. The runtime provides file-operation Views, one-request records, explicit Environment and
workflow graph composition, and a Git revision connector; durable recovery, generic connector
delegation, and automatic continuation scheduling remain planned.

For implemented APIs and current limitations, start with [Implementation status](./implementation.md). To run the shortest complete application, see [Getting started](./getting-started.md).

## Contents

1. [Getting started](./getting-started.md) — a complete offline application using the public exports.
2. [Architecture](./architecture.md) — the layered system and its boundaries.
3. [Resource Model](./resource-model.md) — resources, drivers, namespaces, views, and references.
4. [Execution Model](./execution-model.md) — agent definitions, invocations, context resolution, tools, and observable state.
5. [Runtime and Connectors](./runtime-and-connectors.md) — JavaScript composition, host adapters, remote resources, and applications.
6. [Versioning and Self-Modification](./versioning.md) — Git worktrees, revisions, environment changes, and activation.
7. [Protocols and Examples](./protocols.md) — compact schemas, complete flows, and conformance scenarios.
8. [Appendix](./appendix.md) — definitions, glossary, design principles, invariants, and open decisions.

## The four public concepts

```text
Environment = the mounted resource world
Resource    = anything addressable in that world
AgentSpec   = a recipe that composes resources into one request
Run         = the observable workflow produced by evaluating that recipe
```

An `Invocation` is the one-request record inside a Run. `View`, `Reference`, `Revision`,
`Driver`, and `Connector` are mechanisms used to implement the four public concepts.

The execution flow is:

```text
external connector
        ↓
resource tree
        ↓
view and capability selection
        ↓
reference resolution
        ↓
agent composition
        ↓
one model request and its effects
        ↓
observable run state
```

The system should remain understandable if the word “agent” is replaced with “a program
that resolves resources, asks a model once, and writes the result into the same environment.”

## Design status

The documents describe the intended architecture. They deliberately separate:

- **invariants**, which every implementation must preserve;
- **protocols**, which allow independent drivers and runtimes to interoperate; and
- **policies**, which may vary by deployment.

The current prototype is the starting point for an incremental migration. See the
[open decisions and migration notes](./appendix.md#open-decisions-and-migration-notes).
