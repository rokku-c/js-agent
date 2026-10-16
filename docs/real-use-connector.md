# External resource real-use report

## Verdict

**Pass for the resource, View, and Reference boundary.** An SSH-shaped file, a Notion-shaped
page, and a cloud-shaped JSON object can use the same `stat`, `list`, `read`, `write`, and
`watch` contracts. Their external identity and freshness information stays in `stat().resource`
metadata. The existing live and SHA-256 pinned reference resolver materializes them without a
provider branch. The existing AgentSpec resolver accepts their paths as system/context refs, and
the existing tool catalog loads cloud-hosted `definition.json` metadata without reading or
executing an entrypoint.

The only core change needed was adding `watch` to `createView`'s generic operation set and
forwarding it through derived views. Status is represented as the ordinary read-only
`/status.json` resource, so it does not need a special View operation.

## What was exercised

`src/connectors/in-memory.js` implements a connector-shaped in-memory store with:

- file and synthesized directory resources;
- provider metadata and external IDs on `stat` and directory listings;
- read-only connector status at `/status.json`;
- live writes with explicit compare-and-swap revision checks;
- SHA-256 content revisions suitable for the current pinned-reference contract;
- async-iterable watches for a resource subtree, including status changes and cancellation.

`test/connector.test.js` uses SSH, Notion, and cloud paths together. It verifies metadata,
status, scoped watch delivery, View denial, live reference updates, stale pinned references,
write conflicts, and a model request whose AgentSpec, context, and tool definition all come
from connector resources.

## Boundaries found

This prototype does not provide real SSH, Notion, or cloud transport, authentication, retries,
rate limits, provider-native history, or durable event delivery. Those remain connector-owned
concerns outside this in-memory test double.

Pinned references still mean “the current bytes match this SHA-256” rather than “retrieve an
old provider revision.” The connector has no historical store. AgentSpec currently rejects an
authored `view` or `revision` field, and `invokeOnce` still receives the trusted model adapter
and selected tool catalog from the host. Tool definitions are metadata only; entrypoints are
not executed. Callable external resources and a generic `invoke` operation are not covered by
this prototype because the current JavaScript View does not expose `invoke`.

The result supports external observable resources through the existing file/reference model,
with `watch` as the one missing generic View capability filled in by this change. The remaining
limitations are documented protocol gaps rather than reasons to add SSH, Notion, or cloud
special cases.
