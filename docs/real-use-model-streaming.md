# Model connector streaming exercise

The mounted AI/network/SSE path now shares a canonical stream lifecycle with
trusted model adapters. A completed response is returned once, after explicit
`message_stop` and clean end of input. Partial text and tool arguments remain
provisional; an interrupted request does not become a successful response or a
retry.

## Reproduction

```sh
node --test test/model-stream.test.js
node examples/streaming-model.js
npm test
```

Validated on 2026-10-16: **242 tests passed**, including **18 streaming tests**.
The example prints text incrementally, then reports:

```json
{
  "completed": "completed",
  "requests": 3,
  "toolCalls": 1,
  "incrementalTextEvents": 4,
  "toolArgumentEvents": 5,
  "partialStatus": "unknown",
  "failure": { "code": "EINCOMPLETE", "outcome": "unknown" }
}
```

Those three requests are one root invocation, its single explicit continuation,
and a separate interrupted invocation. The interrupted tool call never executes.
The example's fake AI driver generates actual SSE frames, including fragmented
tool arguments. Tests also mount the network and Anthropic drivers over native
`Response`/`ReadableStream` fixtures with controlled pulls, split UTF-8 bytes,
disconnects, cancellation, and stalled reads. No credentials or live provider
requests are needed.

## Findings and changes

| Exercise | Original behavior | Result |
| --- | --- | --- |
| Slow async renderer | Callback promises ignored; reading ran ahead | `onEvent` is awaited before reading another event |
| Interleaved OpenAI tool arguments and text | Deltas and block stops targeted the last active block | Each event targets its canonical block index; two tool calls assemble independently |
| Clean EOF after partial content | Partial content returned as successful response | `EINCOMPLETE`, provisional `partialResponse`, `outcome: "unknown"` |
| Socket or provider error after text | Partial output lost or provider error treated as raw text | Failure preserves received content and rejects the request |
| Signal cancellation / handle close | Lifecycle and close did not reliably stop consumption | Pending reads/callback waits reject; transport receives cancellation; closed model handles reject reuse |
| Return immediately after network headers | Body and timer cleanup could be skipped | Unread body is cancelled and timeout/listeners disposed |
| Streaming response size | Streaming bypassed network byte limit | Streaming enforces the configured `max-bytes` |
| Truncated/malformed tool JSON with terminal marker | Could become a successful tool response | Strict lifecycle rejects unfinished blocks or invalid JSON |
| Environment failure after dispatch | Existing RunStore already understood unknown outcome | Reused unchanged: failure is journaled as `unknown`; no response/tool-call artifacts, tools, continuation, or automatic retry |
| Cancellation before invocation dispatch | Existing invocation returns `cancelled` | Preserved and verified with zero model requests |

## Connector contract

```js
import { consumeModelStream } from "js-agent/runtime";

const adapter = {
  async request(request, { signal }) {
    // This trusted connector owns provider/credential/network authority.
    const events = connector.events(request, { signal });
    return consumeModelStream(events, { signal, onEvent: renderEvent });
  },
};
```

`consumeModelStream` accepts a sync or async iterable of canonical events and
returns the canonical assistant message. It performs no dispatch, tool execution,
retry, or workflow coordination. Events are `message_start`, `block_start`,
`text_delta`, `thinking_delta`, `signature_delta`, `tool_input_delta`, `block_stop`,
`message_delta`, `message_stop`, and `error`. Block events use a numeric `index`;
tool fragments use `json`. `message_delta` carries `stop_reason` and/or `usage`.
An `error` event carries a `message`.

The accumulator moved from the SSE decoder into `core/model-stream.js` and is
still re-exported from the existing SSE module. SSE handles framing and dialect
translation; both public connector streams and mounted AI streams use the same
completion/error handling. The low-level `sse.consume` remains permissive by
default for inspecting non-SSE error bodies; model requests require completion.

Failures carry `code`, `outcome: "unknown"`, and a detached `partialResponse`.
Typical codes are `EINCOMPLETE` for EOF without completion, `ABORT_ERR` for
cancellation, `EPROTO` for malformed lifecycle/tool data, and `EIO` for transport
or provider failure. HTTP rejection codes are preserved. Partial tool arguments
can remain strings; **do not execute partialResponse tool calls**. Only a resolved
complete response may enter the workflow's tool execution path.

The example grants the adapter one named service operation. That trusted service
owns the mounted model handle; resource Views retain their existing read/write
interface and do not acquire `open()`, model dispatch, secrets, or network access.
Each model invocation still makes one request, and the workflow still owns the
explicit continuation.

## Limits

- Backpressure means the lifecycle does not ask for another event while
  `onEvent` is pending. A provider, socket, or stream implementation can still
  buffer internally. The existing exec and relay network transports buffer their
  bodies; this change does not make those transports incremental.
- Cancellation settles the lifecycle even when an iterator or callback ignores
  the signal. Trusted connectors must honor that signal to release their own IO;
  arbitrary callback work cannot be forcibly stopped.
- Partial responses are error-side display data, not durable replay/checkpoint
  state. RunStore records the unknown outcome without persisting partial content.
  Reconnection and automatic retry are deliberately absent.
- OpenAI's existing dialect synthesizes `message_stop` at `finish_reason` and
  accepts later usage metadata. The lifecycle waits for clean EOF too; a later
  transport failure is conservatively unknown.
- The portable accumulator has no independent byte budget. Mounted network
  streams enforce their existing byte limit; other trusted connectors must bound
  their own input. Validation here covers stream completion and tool JSON, not a
  full provider schema validator.
