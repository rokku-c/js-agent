# Connector service-authority exercise

The existing Environment API could keep credential resources outside the agent view, but
provider adapters had to capture private host services themselves. There was no inspectable
service delegation API, and every tool adapter received the complete `permissions.tools`
view, including sibling tool definitions. Those gaps justified two small additions:

- `createServiceAuthority`: exact named operations, deny-by-default delegation, parent
  intersection, immutable facades, and descriptions containing only grant names.
- Environment wiring: `services`, per-adapter `serviceGrants`, and optional tool
  `resourceGrants` that intersect the existing tool view.

`node examples/connector-service-authority.js` completes a model → lookup tool → model
workflow offline. A trusted `model.request` handler reads a synthetic credential from
`/secrets/provider` and gives it only to the injected trusted transport. The endpoint and
POST method are fixed; redirects are rejected. The model adapter receives a separate model
resource view and the single service operation. The lookup adapter can read only the brief,
although the agent can also read another workspace file. No real provider or credential is
used, and the transport is a fixture rather than a live network request.

`test/service-authority.test.js` verifies:

- No service calls without explicit grants; absent names and inherited object methods deny.
- Delegation cannot regain a removed operation, including through an injected Environment
  parent authority. Mutating registry entries, grant arrays, or descriptions does not change
  already constructed authorities.
- Model and tool service grants remain separate. Caller options cannot substitute broader
  resource/service capabilities. Requested broad resource grants cannot exceed the parent.
- Agent, model adapter, observer, and narrowed tool resource views cannot read the secret.
  The tool also cannot read an internal workspace file or its own catalog metadata.
- The model round trip sends the synthetic credential only to the trusted transport, and
  neither results, descriptions, observer snapshots, nor persisted run files contain it.
- The example's provider handler sanitizes transport errors that contain credential text.

The trusted adapter boundary is unchanged. Host functions can still use ambient facilities;
this API governs capabilities passed through the runtime and does not isolate hostile code.
The handler owns argument policy and output/error sanitization. Granting a named operation
permits all inputs accepted by that handler. Signals are forwarded; cancellation depends on
the handler and transport. The example deliberately has no public `secret.read` service or
general HTTP proxy. Production credential rotation, real network enforcement, provider
response validation, retries, rate limits, and manifest-based credential/network policies
remain connector responsibilities.
