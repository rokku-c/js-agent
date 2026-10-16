# Real-use report: multi-step workflow harness

Date: 2026-10-16

The concrete harness is `src/core/workflow-harness.js`, exported from `src/runtime.js` as
`runWorkflow`, `executeToolCalls`, and `inspectInvocation`. The runnable offline case is
`examples/workflow-harness.js`:

```sh
node examples/workflow-harness.js
```

It uses two trusted host adapters (`read` and `count`). Each model turn is deterministic. The
first turn returns two tool calls. The harness starts both calls concurrently, restores their
results to the original tool-call order, joins the stored request and response into the parent
transcript, and calls `continueOnce` exactly once. Two workflows (`alpha` and `beta`) share a
`RunStore` and run concurrently with explicit root and child IDs.

## Exact transcript and state inspection

The following is the normalized output from the command above. It is normalized only to omit
volatile event timestamps; request messages, tool IDs, tool-result order, response content,
parent links, invocation statuses, event sequence numbers, and tool scheduling order are shown
exactly as inspected by the harness.

```json
{
  "workflows": [
    {
      "id": "alpha",
      "status": "completed",
      "transcript": [
        [
          {
            "role": "user",
            "content": "investigate alpha"
          }
        ],
        [
          {
            "role": "user",
            "content": "investigate alpha"
          },
          {
            "role": "assistant",
            "content": [
              {
                "type": "tool_use",
                "id": "alpha-read",
                "name": "read",
                "input": {
                  "path": "/fixtures/alpha.txt"
                }
              },
              {
                "type": "tool_use",
                "id": "alpha-count",
                "name": "count",
                "input": {
                  "path": "/fixtures/alpha.txt"
                }
              }
            ]
          },
          {
            "role": "user",
            "content": [
              {
                "type": "tool_result",
                "tool_use_id": "alpha-read",
                "content": "read:/fixtures/alpha.txt"
              },
              {
                "type": "tool_result",
                "tool_use_id": "alpha-count",
                "content": "count:/fixtures/alpha.txt"
              }
            ]
          }
        ]
      ],
      "state": {
        "root": {
          "id": "alpha-root",
          "status": "completed_with_tool_calls",
          "events": [
            {
              "seq": 1,
              "kind": "started"
            },
            {
              "seq": 2,
              "kind": "completed"
            }
          ],
          "response": {
            "id": "response-alpha-tools",
            "content": [
              {
                "type": "tool_use",
                "id": "alpha-read",
                "name": "read",
                "input": {
                  "path": "/fixtures/alpha.txt"
                }
              },
              {
                "type": "tool_use",
                "id": "alpha-count",
                "name": "count",
                "input": {
                  "path": "/fixtures/alpha.txt"
                }
              }
            ]
          }
        },
        "child": {
          "id": "alpha-child",
          "status": "completed",
          "parent": {
            "id": "alpha-root",
            "path": "/runs/alpha-root",
            "responseId": "response-alpha-tools"
          },
          "events": [
            {
              "seq": 1,
              "kind": "started"
            },
            {
              "seq": 2,
              "kind": "completed"
            }
          ],
          "response": {
            "id": "response-alpha-done",
            "content": [
              {
                "type": "text",
                "text": "alpha complete: read:/fixtures/alpha.txt | count:/fixtures/alpha.txt"
              }
            ]
          }
        }
      }
    },
    {
      "id": "beta",
      "status": "completed",
      "transcript": [
        [
          {
            "role": "user",
            "content": "investigate beta"
          }
        ],
        [
          {
            "role": "user",
            "content": "investigate beta"
          },
          {
            "role": "assistant",
            "content": [
              {
                "type": "tool_use",
                "id": "beta-read",
                "name": "read",
                "input": {
                  "path": "/fixtures/beta.txt"
                }
              },
              {
                "type": "tool_use",
                "id": "beta-count",
                "name": "count",
                "input": {
                  "path": "/fixtures/beta.txt"
                }
              }
            ]
          },
          {
            "role": "user",
            "content": [
              {
                "type": "tool_result",
                "tool_use_id": "beta-read",
                "content": "read:/fixtures/beta.txt"
              },
              {
                "type": "tool_result",
                "tool_use_id": "beta-count",
                "content": "count:/fixtures/beta.txt"
              }
            ]
          }
        ]
      ],
      "state": {
        "root": {
          "id": "beta-root",
          "status": "completed_with_tool_calls",
          "events": [
            {
              "seq": 1,
              "kind": "started"
            },
            {
              "seq": 2,
              "kind": "completed"
            }
          ],
          "response": {
            "id": "response-beta-tools",
            "content": [
              {
                "type": "tool_use",
                "id": "beta-read",
                "name": "read",
                "input": {
                  "path": "/fixtures/beta.txt"
                }
              },
              {
                "type": "tool_use",
                "id": "beta-count",
                "name": "count",
                "input": {
                  "path": "/fixtures/beta.txt"
                }
              }
            ]
          }
        },
        "child": {
          "id": "beta-child",
          "status": "completed",
          "parent": {
            "id": "beta-root",
            "path": "/runs/beta-root",
            "responseId": "response-beta-tools"
          },
          "events": [
            {
              "seq": 1,
              "kind": "started"
            },
            {
              "seq": 2,
              "kind": "completed"
            }
          ],
          "response": {
            "id": "response-beta-done",
            "content": [
              {
                "type": "text",
                "text": "beta complete: read:/fixtures/beta.txt | count:/fixtures/beta.txt"
              }
            ]
          }
        }
      }
    }
  ],
  "toolTrace": [
    {
      "event": "tool_started",
      "runId": "alpha-root",
      "toolUseId": "alpha-read",
      "name": "read"
    },
    {
      "event": "tool_started",
      "runId": "alpha-root",
      "toolUseId": "alpha-count",
      "name": "count"
    },
    {
      "event": "tool_started",
      "runId": "beta-root",
      "toolUseId": "beta-read",
      "name": "read"
    },
    {
      "event": "tool_started",
      "runId": "beta-root",
      "toolUseId": "beta-count",
      "name": "count"
    },
    {
      "event": "tool_finished",
      "runId": "alpha-root",
      "toolUseId": "alpha-count",
      "name": "count",
      "ok": true
    },
    {
      "event": "tool_finished",
      "runId": "beta-root",
      "toolUseId": "beta-count",
      "name": "count",
      "ok": true
    },
    {
      "event": "tool_finished",
      "runId": "alpha-root",
      "toolUseId": "alpha-read",
      "name": "read",
      "ok": true
    },
    {
      "event": "tool_finished",
      "runId": "beta-root",
      "toolUseId": "beta-read",
      "name": "read",
      "ok": true
    }
  ]
}
```

The key persisted observations are:

| Invocation | `status.json` status | `events.jsonl` kinds | parent |
| --- | --- | --- | --- |
| `/runs/alpha-root` | `completed_with_tool_calls` | `started`, `completed` | none |
| `/runs/alpha-child` | `completed` | `started`, `completed` | `alpha-root`, response `response-alpha-tools` |
| `/runs/beta-root` | `completed_with_tool_calls` | `started`, `completed` | none |
| `/runs/beta-child` | `completed` | `started`, `completed` | `beta-root`, response `response-beta-tools` |

`alpha-child` and `beta-child` each contain the exact two-message continuation tail: one
assistant tool-use message followed by one user message with two ordered tool results. The
parent response is not duplicated in the assembled request.

The focused failure paths are covered by `test/workflow-harness.test.js`:

| Case | Observed state |
| --- | --- |
| tool adapter throws | `error-root` is `completed_with_tool_calls`; `error-child` is `completed`; the first ordered result has `is_error: true` and the second is successful |
| model adapter throws | `unknown-root` is `unknown`; events are `started`, `unknown`; `unknown-child` does not exist |
| cancellation during tool execution | workflow result is `cancelled`; `cancel-root` remains inspectable as `completed_with_tool_calls`; `cancel-child` does not exist |

## Design review

The implementation now gives a usable orchestration layer over the one-request primitives:

- `invokeOnce` owns admission, request materialization, model dispatch, response persistence,
  and the parent terminal state.
- `executeToolCalls` owns trusted adapter dispatch and concurrency. It converts ordinary adapter
  failures into canonical `is_error` results and preserves model order after concurrent execution.
- `buildContinuation` remains the pure canonical tail builder.
- `continueOnce` owns one child model dispatch and records the parent link in the child plan.
- `RunStore` remains the observable invocation store. `inspectInvocation` reads its files through
  the same storage interface an external observer can use.

A small required fix was made in `assembleContinuationRequest`. It previously validated a parent
request that already ended with the parent assistant tool-use response and then appended that
same assistant message again. The builder still returns the assistant block for pure callers,
but full request assembly now appends only the tool-result and optional input messages. This
keeps the provider transcript valid while preserving the existing `buildContinuation` contract.

The remaining gaps are explicit:

1. There is no aggregate persisted `Run` record or child index. The harness knows the root and
   child IDs, and parent linkage is discoverable in `plan.json`, but a UI must already know which
   invocation directories to inspect.
2. Workflow cancellation during tool execution is an in-memory harness result. The parent
   invocation is correctly terminal as `completed_with_tool_calls`, but `RunStore` has no
   workflow-level cancellation event and no child record is created.
3. The harness treats supplied adapters as independent because the caller has asserted that
   property. It does not yet enforce effect declarations, conflict detection, retries, or
   idempotent continuation creation.
4. `RunStore` is still the documented volatile implementation. Its atomic rename path is useful
   for this test, but it does not provide durable recovery or distributed transaction semantics.
5. Tool adapters are trusted host functions by design. The harness does not sandbox model-provided
   code or dynamically import resource content.

These gaps are visible in the tests and state inspection rather than represented as successful
workflow guarantees.

## Validation

- `npm test`: passed, 149 tests.
- `node test/run.js workflow-harness`: passed, 4 tests.
- `node examples/workflow-harness.js`: passed and produced the transcript/state output above.
- `node test/run.js e2e`: the Anthropic case skipped because credentials were absent; the OpenAI
  live case attempted its external endpoint and failed with `EIO` / `fetch failed` at
  `/dev/net/request`. This is an environment/network result, outside the offline harness.
