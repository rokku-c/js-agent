# Connector and driver authority audit

The audit found three authority boundary defects.

- `Vfs.narrow()` reused driver instances whose AI driver closures retained the full parent VFS. A child limited to `/dev/providers/ai` could therefore discover a parent-only credential and network mount, and dispatch through them. The AI driver now uses the operation context VFS for credential, transport, descriptor, and handle operations.
- A narrowed VFS retained `mount()` and `umount()`. A child could add an unrestricted mount or remove a shared mount. Narrowed views now reject mount-table mutation while the trusted host VFS retains both operations.
- `Vfs.mounts()` fed `/proc/mounts` raw mount options. `secret:values=` and `ai:token=` values were disclosed. Public mount descriptions now redact credential-bearing option keys.

A concurrent same-path mount race was also reproduced: both callers could pass the duplicate check before either mount awaited driver loading. Mount points are now reserved before the first await; one caller wins and the other receives `EBUSY`.

The audit added regression tests for each case, including the AI child credential/network case, mount mutation, secret redaction, and concurrent mounts. Existing service authority, nested environment, View derivation, callable invocation, and multi-tenant tests did not expose additional defects.

The trusted-host boundary remains explicit: model and tool adapters are host-trusted functions, and VFS narrowing continues to share the underlying driver instances for intended shared state. The fix scopes driver cross-mount lookups to the calling VFS context; it does not turn trusted JavaScript drivers or adapters into a language sandbox.
