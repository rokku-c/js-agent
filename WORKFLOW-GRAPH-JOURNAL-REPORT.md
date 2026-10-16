# Workflow graph competing-user benchmark and journal experiment

The smallest default improvement is an indexed duplicate-edge lookup. The optional
journal reduces graph write volume substantially, but does not consistently improve
latency. Keep snapshot persistence as the default.

## API and implementation

```js
const graph = createWorkflowGraph({
  storage,
  store,
  persistence: 'journal', // default: 'snapshot'
  lockTimeoutMs: 2000,    // durable graph writer contention deadline
});
```

All existing graph operations and returned node/edge shapes remain available. Existing
v1 snapshots remain readable. Readers automatically detect the journal format; callers
reopening a journal do not need to repeat the option. Older runtimes that only understand
v1 graph files cannot read the opt-in format.

- Duplicate-edge lookup builds a node-key Map once per claim, replacing the nested
  scan of the entire node array for every candidate edge.
- Journal persistence writes changed node/edge records and graph metadata to numbered
  files under `/workflows/<id>/journal/`. A small v2 `graph.json` publishes the committed
  sequence. The public inspection result still has the v1 graph shape.
- Each mutation atomically publishes a delta, then the commit pointer. A failure before
  publishing the pointer leaves an ignored orphan; a later writer can replace that
  unpublished sequence. No partial JSONL-tail repair or in-place node-shard transaction
  is needed. Node and edge changes share one commit boundary.
- A generation token prevents cached prefixes from crossing graph replacement. Up to
  eight graphs are cached per storage object. Reads replay newly published records;
  returned states are detached from cached state. Published journal files are immutable.
- Durable RunStores now imply graph-level exclusive filesystem locks and flushed atomic
  snapshots for **both** formats. The previous WeakMap lock only covered callers sharing
  one storage object. Locks cover short read/modify/write transactions, never model calls.
  Graph storage capabilities are checked separately from RunStore capabilities because
  the graph root may resolve to a different mount.

## Measurements

Recorded on macOS arm64, Node v26.10.0. Each row is one local run, not a statistical
latency guarantee. The deterministic model makes one root tool request and one request
per branch. Counts include only graph storage writes, not RunStore writes. All runs
assert completion, request counts and a fresh-cache graph inspection.

The unmodified `db59547` baseline is retained in
`benchmark/workflow-journal-before.jsonl`: 32/128/512 branches wrote
662,881 / 9,987,229 / 158,705,245 bytes respectively. This confirms quadratic write
amplification independently of provider latency.

Final memory comparison (`benchmark/workflow-journal-after.jsonl`):

| Branches | Snapshot bytes | Journal bytes | Snapshot ms | Journal ms | Cold inspect ms (snapshot / journal) |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 32 | 662,881 | 56,305 | 18.4 | 14.0 | 0.3 / 0.6 |
| 128 | 9,987,229 | 219,587 | 63.9 | 79.5 | 1.1 / 1.8 |
| 512 | 158,705,245 | 876,285 | 678.6 | 1,043.6 | 2.1 / 7.6 |
| 1,024 | 634,460,917 | 1,754,141 | 2,364.6 | 4,216.2 | 4.0 / 14.6 |

At 1,024 branches the journal writes about 362 times fewer bytes, but takes about
1.8 times as long in memory. It doubles graph write calls (4,104 versus 2,052) and
retains 2,052 committed record files. Cloning, validation and change detection still
walk the current graph on each mutation; write volume becomes linear, overall CPU
work does not. Cold replay is linear in committed records plus current graph size.

A separate durable hostfs comparison is retained in
`benchmark/workflow-journal-durable.jsonl`. It uses actual exclusive mkdir, atomic
rename and fsync for graph and RunStore writes:

| Branches | Snapshot ms | Journal ms | Cold inspect ms (snapshot / journal) |
| ---: | ---: | ---: | ---: |
| 32 | 2,646.9 | 3,663.9 | 1.9 / 8.3 |
| 128 | 10,610.6 | 14,593.5 | 9.1 / 56.4 |

Extra flushes and file operations outweigh the byte savings in these samples. Neither
experiment supports changing the default format.

Reproduce:

```sh
npm run bench:graph
BRANCHES=32,128,512,1024 npm run bench:graph
GRAPH_DURABLE=1 BRANCHES=32,128 npm run bench:graph
PERSISTENCE=snapshot npm run bench:graph
```

## Verification

`npm test`: **265 passed**, including ten new journal/contention tests and the existing
workflow, crash, observer, environment, durable-store, public API and scale suites.

New coverage includes:

- Three simultaneous Node processes sharing one durable store, for each persistence
  format: 36 attempts yield exactly 28 unique child dispatches, 29 nodes and 28 edges.
  Four shared edges deduplicate across all three writers without losing other claims.
- Multiple branches, a later continuation level, explicit join/close, terminal duplicate
  edges after remount, and fresh invocation observers.
- `close()` rejecting running nodes; recovery fencing a live evaluator's late result;
  cancellation from another storage mount winning completion while preserving the
  invocation's actual terminal evidence.
- A real SIGKILL during a dispatched child request. A fresh mount sees the running
  claim, recovers it to unknown, and observes the completed sibling.
- Injected failure publishing the completion pointer. Inspection ignores the orphan
  delta; recovery reconciles the completed RunStore invocation.
- Missing/malformed published records rejected on cold read, stale locks rejected
  without takeover, generation-safe cache replacement and a linear-write-volume guard.

## Limits and recommendation

This is an opt-in append-journal experiment, not a general DAG scheduler or a fully
available distributed coordinator. Joins remain the existing explicit `close()` barrier;
there is no new automatic multi-parent model invocation.

A SIGKILL while holding the short graph writer lock leaves
`/workflows/.lock-<id>`. Further writes fail with `EBUSY`; read-only inspection remains
available. An operator must establish that **all writers for that graph are stopped**
before removing the lock and invoking recovery. The implementation never guesses that
a timed-out owner is dead. A crash during initial graph creation can also leave incomplete
metadata requiring operator repair. The SIGKILL test specifically kills during model
dispatch, when no graph lock is held; it does not establish automatic recovery from
every syscall boundary or power loss.

Cancellation across processes is persistent and wins graph state at commit time; it
does not remotely abort an already-running provider call. Invocation evidence remains
in RunStore. Existing external effects are not replayed or described as rolled back.

The journal has no compaction yet. Long-lived graphs accumulate files, hot operations
still copy graph-sized state, and cold inspection reads every committed record. Volatile
stores still coordinate only within one shared storage object; use durable mode for
multiple processes. All writers must use this updated runtime for its lock protocol to
protect the graph. Keep snapshots for ordinary workloads; consider the journal only
when graph write volume is the measured constraint and these tradeoffs are acceptable.
