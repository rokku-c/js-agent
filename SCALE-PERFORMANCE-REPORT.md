# Performance and capacity review

Benchmarked concurrent one-request runs, graph fan-out, observer lists and watches,
large reference selections, fragmented SSE frames, and long cancellable streams.
Four localized fixes remove demonstrated CPU/memory overhead and bound observer
list fan-out. No model scheduling, persistence, retry, or durability semantics changed.

## Reproduce

```sh
npm run bench:scale
npm test
```

The benchmark uses local in-memory fixtures, checks results and exact request counts,
and emits JSONL. Captured runs are in `benchmark/baseline.jsonl` and
`benchmark/after.jsonl`. Baseline source is commit
`472e7cd062f88d0e97c49553ec9505c1dc703102`. Both captures used the same benchmark
script with Node v26.10.0 on macOS arm64 and `--expose-gc`.

These are single-process diagnostic measurements, not service throughput promises.
There is no remote provider or disk latency. `heapDeltaMiB` is end-minus-start
heap use, not peak memory or total allocation; only `retainedMiB` explicitly forces
GC while a stream remains alive. Timings and ordinary heap deltas vary with JIT,
GC and machine load. Byte counts and concurrency counts are deterministic evidence.

## Measured changes

| Case | Before | After |
| --- | ---: | ---: |
| 1 MiB SSE frame in 64-byte chunks | 1,929.02 ms | 4.12 ms |
| 80,000 cancellable content-free events, retained heap | 39.10 MiB | 0.04 MiB |
| Same event stream, elapsed | 81.84 ms | 36.16 ms |
| Select four bytes from 4 MiB / 2,097,152-line source | 58.26 ms | 2.44 ms |
| Same reference operation, end heap delta | 95.97 MiB | 4.02 MiB |
| List 1,000 runs, peak simultaneous storage reads | 1,000 | 32 |
| List 1,000 runs, elapsed | 9.28 ms | 10.47 ms |

- SSE framing now scans only newly received text plus at most three boundary
  characters. It accumulates fragments and joins once per frame. LF, CRLF,
  mixed delimiters, empty frames and the unterminated final frame are preserved.
  Increasing frame size fourfold previously increased time about seventeenfold;
  the new implementation scales with received bytes.
- Stream cancellation now rejects only the current pending await. The previous
  `Promise.race` against one never-settled abort promise retained reactions from
  every completed event and callback. Awaited callbacks still apply backpressure,
  and cancellation still interrupts uncooperative pending reads/callbacks.
- Line selectors locate the requested offsets directly instead of creating an
  array/string entry for every source line. Full-content hashing, selected hashing,
  UTF-8 validation, inclusive line semantics and byte limits remain intact.
- `createRunObserver(storage, { concurrency: 32 })` bounds snapshot workers per
  `list()` call. The default is 32; any positive safe integer is accepted. Sorting,
  missing-run handling, errors and redaction remain intact. Independent calls and
  explicit watches are not covered by a global limiter. Watch change detection
  also serializes its signature once per poll instead of twice.

## Other scale results and remaining limits

The 1,000 simultaneous one-request fixture completed in 115.33 ms after the changes
(113.67 ms before), with exactly 1,000 requests and 1,000 concurrently active model
adapters. No cross-run serialization was observed in this volatile fixture.
This also demonstrates that callers can dispatch arbitrarily large batches;
there is no global admission or provider concurrency cap.

For 1,000 terminal watches, all 1,000 snapshots completed in 9.88 ms. A separate
live-watch fixture delivered both running and terminal states to every watcher:
2,000 snapshots in 30.19 ms, including fixture writes. Watchers retain independent
poll schedules. They reread status and event files on every poll; callers should
choose polling intervals and watch populations for their storage backend. Listing
still returns an array containing all run summaries; the new concurrency setting
bounds active IO, not result size. The normal one-request lifecycle has very few
events, but a large externally supplied event file is read, parsed and signed in
full on each watch poll.

Graph writes remain quadratic in branch count:

| Branches | Model requests | Graph snapshot writes | Graph bytes written | After elapsed |
| --- | ---: | ---: | ---: | ---: |
| 32 | 33 | 68 | 0.69 MiB | 10.86 ms |
| 128 | 129 | 260 | 10.43 MiB | 60.21 ms |
| 512 | 513 | 1,028 | 165.65 MiB | 904.90 ms |

Every branch claim/completion acquires a graph-specific lock, reloads the graph,
and rewrites its growing JSON snapshot. A fourfold increase in branches produces
about sixteenfold write volume. Independent model calls can overlap, but graph
metadata updates serialize. No cache or batching was added because it would need
an explicit crash/recovery and cross-coordinator consistency design. This remains
a limitation for wide graphs, especially on storage with write/flush latency.
The benchmark uses volatile storage and does not establish durable lock throughput.

Additional source-level capacity observations (not fixed or throughput-benchmarked):

- Reference `maxBytes` bounds the selected materialized value **per reference**.
  The facade reads the entire source, and revision verification hashes it in full
  before selection. It does not cap source reads or aggregate resolved arguments.
- The invocation 8 MiB response check runs after the model returns its assembled
  response. Canonical `consumeModelStream` itself has no content/event/frame cap.
  Mounted network streams do enforce their configured byte limit (8 MiB default),
  but a trusted custom adapter must supply its own source/backpressure limits.
- Pure model event folding copies the block array for deltas/new blocks and copies
  retained unknown-event arrays. Very many content blocks or unknown events can
  therefore still cause quadratic work. The new cancellation fix specifically
  removes retained abort reactions, not response-content storage.
- RunStore keeps per-run ownership/status/sequence metadata for its lifetime.
  WorkflowGraph retains controllers for created graph IDs. Neither exposes an
  eviction/disposal API; long-lived coordinators accumulate metadata with total
  lifetime run/graph count. Persisted records also need an application retention
  policy. Existing lock queues and in-flight entries do remove settled entries.

## Verification

`npm test`: **250 passed, 0 failed**. The focused model-stream/reference/adversarial
suite passed 39 tests. Added regression coverage verifies every delimiter split,
a 1 MiB fragmented frame, GC retention below a generous 12 MiB threshold for 60,000
content-free cancellable events (the old implementation retains roughly 29 MiB),
large-source line selection and hashes, empty/CRLF/final-line ranges, and default
and configured observer storage concurrency. Existing tests verify slow-consumer
backpressure, blocked-read/callback cancellation, graph deduplication/recovery,
reference permissions and observer redaction. Every benchmark case also asserts
successful output and relevant exact request/snapshot counts.
