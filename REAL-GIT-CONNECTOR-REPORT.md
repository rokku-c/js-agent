# Real-use report: Git candidate revision through the runtime

Date: 2026-10-16

## Result

Pass. The existing Git lifecycle API is sufficient for a real prompt and AgentSpec update:

```text
createCandidate → editCandidate → commitCandidate → runCheck
→ runCandidate(Environment + WorkflowGraph + RunObserver)
→ activate → runFuture
```

The integration does not add a Git-aware shortcut to the core runtime. The connector callback
receives the immutable candidate `worktree` and `revision`; the trusted host integration mounts
that worktree read-only as `/candidate`, then gives the runtime only its normal resource Views.

## What was exercised

`test/git-revision-connector.test.js` creates a temporary Git repository and a detached Git
worktree. It edits both `prompt.md` and `agent.json`, commits them, and runs a real Node check
from the candidate worktree. The candidate invocation then:

- reads the prompt and AgentSpec through the agent View;
- dispatches one model request through the model adapter View;
- persists the request in a real RunStore;
- evaluates a real WorkflowGraph;
- inspects redacted status and `started`, `completed` events through RunObserver.

After validation, activation advances the connector's active pointer. `runFuture` captures that
activated candidate and repeats the same Environment, graph, and observer flow. The test checks
that both invocations read the edited prompt and that the future provenance contains the active
candidate ID and revision.

The runnable version is:

```sh
node examples/git-revision-environment.js
```

A normalized run produced:

```json
{
  "candidate": {
    "id": "prompt-review",
    "status": "activated",
    "revision": "git:<candidate commit>",
    "prompt": "Review the candidate prompt.\n",
    "agent": {
      "model": "/models/reviewer",
      "context": ["/candidate/prompt.md"],
      "tools": []
    },
    "graph": { "status": "completed", "nodeStatus": "completed" },
    "run": { "status": "completed", "events": ["started", "completed"] }
  },
  "activation": {
    "candidateId": "prompt-review",
    "revision": "git:<candidate commit>"
  },
  "future": {
    "candidateId": "prompt-review",
    "revision": "git:<candidate commit>",
    "prompt": "Review the candidate prompt.\n",
    "graph": { "status": "completed", "nodeStatus": "completed" },
    "run": { "status": "completed", "events": ["started", "completed"] }
  }
}
```

## Boundary decision

No new connector method was needed. The missing integration was the real composition and
coverage of the existing seams. Git owns worktrees, checks, provenance, activation, and cleanup.
The host callback owns the explicit `hostfs` mount. `createEnvironment` owns the four Views and
trusted adapter handoff. WorkflowGraph owns invocation ownership and joins. RunObserver exposes
only volatile, redacted status and event metadata.

The model adapter never receives the candidate worktree. The observer never receives the Git
connector or host filesystem handle. Core code never shells out to Git.

## Validation

```text
npm test
178 tests passed

node examples/git-revision-environment.js
candidate and future graph status: completed
candidate and future events: started, completed
```
