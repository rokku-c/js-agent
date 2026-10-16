# Multi-tenant environment review

## Verdict

Two environments can run concurrently over one durable host-backed storage adapter when each environment has its own resource grants, run root, graph root, observer root, model/tool adapters, and service grants. The adversarial test uses tenant `a` and tenant `b` with the same run ID (`same-run`) and graph ID (`shared-graph`); both complete independently and persist under their own roots.

## Checks

- Model and tool adapters receive separate View and service-authority capabilities. Each adapter can read and call only its tenant's resources and services.
- Observer reads and invocation inspection reject the other tenant's resource and run paths.
- Reusing a model/tool configuration object and mutating its paths, functions, or grants after environment construction does not alter the bound environment.
- Same run and graph IDs do not collide when durable roots are `/tenants/a/runs`, `/tenants/b/runs`, `/tenants/a/graphs`, and `/tenants/b/graphs`.
- An environment with a configured `graphRoot` rejects a different graph root, including another tenant's root. Graph roots that overlap a run-store root are rejected.
- Injecting a RunStore backed by another storage adapter is rejected; this prevents an environment observer from reading one backend while its runs are written to another. WorkflowGraph accepts deliberately wrapped storage adapters used by existing recovery integrations, so its root overlap check remains the coordinator-side guard.
- Graph and run IDs remain path-safe through their existing identifier validation; traversal-style graph IDs are refused before storage access.

## Boundary

Model and tool adapters remain trusted host functions. Their Views and service authorities constrain the capabilities passed into them, while the host application remains responsible for selecting tenant roots and grants. `graphRoot` makes that graph namespace an environment-level binding so callers cannot retarget a configured environment to another tenant after construction.
