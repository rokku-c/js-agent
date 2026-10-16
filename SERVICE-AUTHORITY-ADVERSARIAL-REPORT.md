# Service authority adversarial report

This pass treated model and tool adapters as hostile users of the explicit service and resource capabilities. The focused checks covered:

- exact service names, default denial, prototype-name attempts, handler snapshots, and transitive attenuation;
- an injected parent authority, where a model or tool request for an ungranted service cannot broaden the parent's grants;
- model-only credential use through a trusted `model.request` handler, with no public secret-read operation;
- per-tool resource and service views, including attempts to pass replacement `resources` or `services` through the adapter call;
- redacted `environment.observer` snapshots, which contain status and event metadata but no prompt, plan, request, response, or error payload;
- transport error sanitization in the example connector;
- frozen caller-owned tool adapter records.

The environment now keeps bound resource and service views in private environment state. Previously it attached those capability objects to the caller's adapter configuration object. That mutation both failed for frozen adapter records and made capability handles observable through shared configuration. The trusted adapter function still receives its explicitly bound views when invoked.

The raw `environment.observe` view remains a trusted storage integration surface. It can inspect persisted request and response snapshots when the caller grants `read` on `/runs/**`; this is intentional for host integrations and is why untrusted clients must use `environment.observer` or `createRunObserver`. The public redacted observer does not expose those payloads.

The trusted adapter boundary is unchanged. Model and tool adapters execute as host functions, and a service handler remains responsible for validating inputs, enforcing provider policy, redacting provider errors, and sanitizing returned data. Named service grants do not sandbox a handler or prevent a deliberately granted handler from returning sensitive data.

Validation:

```text
npm test
226 tests passed
```
