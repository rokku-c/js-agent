# Versioning and Self-Modification

Versioning is how the environment can change while an active Invocation remains interpretable.
Git worktrees are the first practical implementation, but the semantics are broader: a
revision is an immutable environment candidate.

## Revision

A revision identifies a coherent set of files and definitions:

```text
source code
system prompts
tool definitions
JavaScript programs
AgentSpecs
environment configuration
```

A revision may be represented by a Git commit, an immutable object-store snapshot, or another
content identity. An Invocation records the revision it resolved.

```json
{
  "revision": "git:abc123",
  "workspace": "/worktrees/run-123",
  "agent": "/agents/self"
}
```

## Worktree lifecycle

A self-modifying workflow follows this sequence:

```text
current revision
      ↓
create candidate worktree
      ↓
modify source, prompts, tools, or environment
      ↓
run checks and candidate Invocations
      ↓
record candidate result
      ↓
activate or reject candidate
```

Candidate worktrees are ordinary resources:

```text
/workspaces/self/
  current
  candidates/run-123/
  revisions/abc123/
```

The worktree connector owns Git operations, conflicts, cleanup, and revision metadata. The
Agent uses it through resource operations rather than calling Git through an untracked side
channel.

## Activation

Activation changes the revision selected by future Invocations. It does not mutate the
meaning of a running Invocation.

```text
active revision: abc123
running invocation: pinned to abc123
candidate revision: def456
future invocation: may select def456
```

An activation record should include:

```json
{
  "from": "git:abc123",
  "to": "git:def456",
  "activated_by": "/runs/run-123",
  "when": "2026-10-15T12:00:00Z",
  "checks": ["test:passed", "smoke:passed"]
}
```

Rollback is another activation to an earlier known revision.

## Self-knowledge

A runtime may expose self-knowledge through a mount such as:

```text
/self/
  definition/
  source/
  revision.json
  runtime.json
  environment/
```

If this mount is absent, the Agent does not need to know where the runtime itself is hosted.
It may still operate a remote `/workspace` or `/remote` as its complete visible world.

The distinction is:

```text
physical host      where the process actually runs
visible environment what the Agent can observe and operate
self definition    the source and resources that define the Agent
```

These may be the same, partially overlap, or be completely separate.

## Prompt and tool versioning

Prompt fragments and tools are versioned resources. A run records their resolved revisions:

```json
{
  "system": [
    { "path": "/agents/self/system/base.md", "revision": "git:abc123" },
    { "path": "/workspace/.agent/rules.md", "revision": "git:def456" }
  ],
  "tools": [
    { "path": "/tools/search", "revision": "git:abc123" }
  ]
}
```

Changing a prompt or tool affects future Invocations unless a caller explicitly requests a
pinned revision.

## Environment changes

An environment definition can itself be versioned:

```text
/environment/
  mounts.json
  views/
  connectors/
  policies/
```

A candidate change may add a new mount, change a View, or replace a connector. It must be
validated as a candidate before activation. The active environment remains observable while
the candidate is tested.

## Recovery

Versioning does not roll back external side effects. A failed candidate can be rejected and a
source revision restored, but writes to external systems remain recorded in the Invocation's
effect log.

Recovery therefore uses both:

- revision identity for code and definitions;
- effect identity and state for external operations.

See [Execution Model](./execution-model.md#effect-records).

## What a revision pins

A revision is a manifest, not merely a source commit. It may pin:

- AgentSpec and prompt definitions;
- tool schemas, entrypoints, and dependencies;
- JavaScript runtime code;
- environment and View definitions;
- connector identities and configuration references;
- mount identities and compatibility versions.

A revision does not silently pin mutable external data. Live Notion pages, remote workspaces,
model behavior, and external service state remain observations. Their identity, freshness,
content hash where available, and retrieval time are recorded in the resolved plan.

The active revision is selected by an environment pointer. Activating a candidate uses a
compare-and-swap on that pointer; a competing activation must fail or retry against the new
head. An Invocation that has started resolving cannot be retargeted by activation.
