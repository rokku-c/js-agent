# Self-modification adversarial review B

## Verdict

The prior Git candidates were useful prototypes, but neither was safe to carry forward as a core
facility. The check-capable candidate from `208bfee` had the better lifecycle surface. The later
`6d271fc` candidate improved dirty-worktree and revision checks, but removed the explicit check
runner and still left Git and host filesystem ownership in `src/core`.

The implementation in this worktree keeps the lifecycle in
[`src/connectors/git-revision.js`](src/connectors/git-revision.js). The runtime exports the
connector as `createGitRevisionConnector`; core code receives lifecycle results and immutable
provenance through that boundary. The connector remains a trusted host adapter. It is not an
untrusted Agent capability and it does not make arbitrary candidate JavaScript executable inside
the kernel.

## Prior candidate findings

| Case | `208bfee` | `6d271fc` | Connector result |
| --- | --- | --- | --- |
| Same-process activation race | Serialized by a local promise tail | Serialized by a local promise tail | Retained and combined with a filesystem lock |
| Cross-instance activation race | No shared lock or atomic compare-and-swap | No shared lock or atomic compare-and-swap | Atomic lock-directory mutex plus fresh active-pointer check |
| Stale base revision | Usually rejected through the default expected base, but only if the caller used the default | Caller could omit the expectation and activate an old-base candidate | Candidate base must equal the current active revision on every activation |
| Failed check | Explicit check records and activation gate | No check runner | Failed and mutating checks are recorded and cannot validate |
| Failed invocation result | A returned `{status: "failed"}` was recorded as successful | Caller-defined result was accepted | Only passed/completed/explicitly successful results validate |
| Malicious edit path | Rejected traversal, absolute paths, and `.git` segments | `.git` itself could be edited; metadata worktree paths were insufficiently trusted | Reject `.git` case-insensitively, traversal, symlinks, and tampered worktree metadata |
| Candidate cleanup | Active status only; repeated removal was not safe | Active status only | Active pointer is checked, removal is idempotent, and metadata remains observable |
| In-flight request | Captured active worktree and revision correctly | Captured active worktree and revision correctly | Preserved and tested while a competing activation completes |
| Host boundary | `fs`/Git lived in `src/core` | `fs`/Git lived in `src/core` | Host filesystem and Git are confined to `src/connectors` |

## Adversarial coverage

`test/git-revision-connector.test.js` exercises:

- `.git`, traversal, absolute, Windows-style, and symlink edit paths;
- a failed check, a check that leaves the candidate dirty, and the activation gate;
- an invocation returning a failed status;
- post-commit tampering and dirty-tree rejection;
- two connector instances activating candidates against the same base concurrently;
- a candidate created from a stale base after another candidate activates;
- idempotent cleanup and refusal to remove the active candidate;
- a request paused in flight while a newer candidate activates, proving that its revision and
  worktree remain the ones captured at request start.

The candidate worktree and lifecycle journal are outside the repository. Git commands use argument
arrays through `execFile`; edit paths are checked before directory creation and file writes. The
active pointer is replaced atomically, and activation serializes through an OS-level atomic
`mkdir` lock shared by connector instances.

## Architecture review

Direct host `fs` and Git calls in `src/core` violate the repository's stated ownership model:
Git worktree creation, revision metadata, cleanup, and activation belong to a connector. A core
module should not discover the physical repository or invoke a host process. The prior candidate
implementations crossed that boundary.

Moving those calls into `src/connectors/git-revision.js` is the appropriate fix. The connector
returns a worktree path only to the trusted host integration callback that mounts or reads the
candidate for evaluation. The Agent still receives its resources through the existing View and
invocation APIs. This change does not claim that a View sandboxes trusted adapter JavaScript.

## Remaining limits

The lock-directory mutex closes the tested cross-instance race, but a process that dies while
holding the lock can leave a stale lock until an operator removes it. Atomic rename also does not
provide fsync or a distributed transaction. Candidate check commands are trusted host commands and
must be selected by the host; they are not an Agent-controlled shell capability. Activation is
therefore a durable, observable connector workflow, not a crash-proof distributed commit protocol.

## Verification

```text
node --test test/git-revision-connector.test.js
# 4 passed

npm test
# 174 passed, 0 failed

git diff --check
# clean
```
