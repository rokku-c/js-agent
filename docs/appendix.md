# Appendix

## Definitions

### Environment

A mounted resource world plus derived Views and runtime services. An Environment may be
process-local or durable; persistence is a property of its resource stores and connectors,
not an implicit guarantee of the word Environment.

### Resource

An addressable object in the environment with metadata and explicit operations. Files,
directories, tools, models, tasks, revisions, and event streams are all resources.

### Driver

An adapter that exposes an external or virtual source as a resource subtree.

### Connector

A driver whose primary purpose is to connect an external system such as a host, SSH server,
cloud store, document service, or model provider.

### Namespace

The complete mounted resource tree available to an environment.

### View

An immutable, scoped selection of visible resources and allowed operations for a computation.

### Reference

A typed pointer to a resource, optionally including a selector, revision, and live/pinned
mode.

### AgentSpec

A resource-backed recipe containing a model, system prompt references, context references,
tool references, runtime options, and a View.

### Invocation

One model request attempt with one terminal response or request failure. Tool effects are
separate records. A continuation is another Invocation with an explicit transcript handoff.

### RunState

The observable resources produced and maintained by a Run: request, resolved plans, Invocation
states, status, events, effects, and result. Each Invocation has an InvocationState resource
inside the RunState tree.

### Workflow

JavaScript or another resource-backed program that creates, links, waits for, and combines
Invocations.

### Revision

An immutable identity for a coherent set of source files, prompts, tools, and environment
definitions.

### Run

The observable workflow rooted at one Invocation. A Run owns continuation scheduling, aggregate
budget, cancellation, and recovery. It is the public name for a complete agent execution.

### Session

A convenience projection over related Runs, Invocations, and history. It is not the primitive
unit of execution.

## Glossary

| Term | Meaning |
| --- | --- |
| **active resource** | A resource that accepts an invocation or exposes ongoing state. |
| **capability** | Permission to perform a named operation on a scoped resource. |
| **context** | Material selected for one model request. |
| **driver** | Code implementing a resource subtree. |
| **effect** | An externally observable operation such as writing a file or sending a request. |
| **live reference** | A reference resolved against current state at Invocation time. |
| **mount** | Attaching a driver subtree at a namespace path. |
| **pinned reference** | A reference resolved against a fixed revision or content identity. |
| **provenance** | The source, revision, selector, and materialization details behind a value. |
| **resource tree** | The addressable hierarchy exposed by an Environment. |
| **run** | The observable workflow record rooted at one Invocation. |
| **selector** | A query that extracts part of a referenced resource. |
| **tool** | A callable resource with an input definition and implementation. |
| **view** | The resource and operation scope visible to one computation. |

## Design principles

### 1. The environment is the long-lived object

Resources and state persist in the environment. An Agent is assembled and evaluated when
needed. A continuous session is an optional projection, not a foundational abstraction.

### 2. Addressability beats special cases

If a thing matters, it should have a path, metadata, state, and observable operations. New
resource types should extend the tree rather than create parallel APIs.

### 3. Composition is data

Prompts, contexts, tools, models, and Views are references in definitions. Composition should
be inspectable, versionable, and reproducible.

### 4. JavaScript is the construction language

The core should be small enough to run inside JavaScript. New behavior should normally be
built by composing resources rather than adding a new framework concept.

### 5. Every execution has a frozen plan

An Invocation records the exact AgentSpec, View, revision, prompt, context, tools, and
references used. Live resources may change later without rewriting history.

### 6. Observation is a first-class operation

Status, events, effects, connection state, and resolved inputs are resources. Debugging should
read the same world that execution uses.

### 7. Capabilities are explicit and monotonic

A derived View may reduce access but may not silently gain access. Tools are one expression of
capability; they are not a substitute for operation-level authorization.

### 8. Active work has an owner

Invocations own handles, workers, child processes, streams, timers, and in-flight requests.
Cancellation and cleanup follow the ownership tree.

### 9. External effects are honest

A timeout or crash may leave an effect in an unknown state. The system records that state
rather than fabricating an empty result or blindly retrying a non-idempotent operation.

### 10. Version boundaries are explicit

Running work is pinned. Self-modification creates a candidate revision. Activation affects
future work and preserves rollback information.

## Core invariants

1. Every meaningful state has an observable resource representation.
2. Every resource operation is evaluated against an explicit View.
3. A connector cannot bypass the View through a hidden parent context.
4. An AgentSpec can be resolved without depending on a mutable session object.
5. A completed Invocation can explain what it actually saw and used.
6. A dynamic tool is versioned and bound to the Invocation that loaded it.
7. A child View is never broader than its parent View.
8. A running Invocation remains bound to its original revision.
9. An unresolved external effect is represented as `unknown`.
10. A UI, CLI, and Agent observe the same resource state.

## Open decisions and migration notes

The design intentionally leaves these choices open:

- the exact reference selector language;
- the wire format for remote resource access;
- the persistence backend for RunState;
- the minimum portable JavaScript host API;
- the OS isolation mechanism for untrusted code;
- the model event schema across providers;
- whether resource paths use URI syntax in addition to POSIX-like paths;
- how conflicts are represented when multiple Invocations write the same resource (the
  default contract is reject-on-conflict for mutable structured resources);
- which protocol fields are optional in a volatile, non-durable deployment.

A practical migration from the current prototype is:

1. split the current VFS into namespace, View, and resource dispatch;
2. remove Agent-specific mutable fields from the shared VFS and introduce RunContext;
3. enforce operation grants and bounded connector authority at the resource boundary;
4. materialize durable RunState and effect identities;
5. define ResourceRef and record resolved references;
6. expose current tools through resource adapters, then represent Agent definitions and tools as resource directories;
7. choose the compatibility boundary for the current multi-round loop, then add one-request Invocation continuations;
8. unify model and connector streaming protocols with cancellation;
9. add revision pinning and Git worktree activation;
10. make existing shell, CLI, and UI clients consume the same state resources.

The current `src/kernel`, `src/drivers`, `src/core`, and `src/tools` directories can remain
useful implementation boundaries during this migration, but directory names are not the
architecture. The contracts above are.
