# @noy-db/memory

## 0.5.0

### Initial release

In-memory adapter for `@noy-db/core` — backed by nested `Map`s, no persistence, data is lost when the process exits. Intended for testing, development, and ephemeral workloads.

Implements every mandatory method on `NoydbAdapter` (`get`, `put`, `delete`, `list`, `loadAll`, `saveAll`) plus the optional `listPage` pagination capability and the optional `listCompartments` cross-compartment enumeration capability. Version conflict detection via `expectedVersion` on `put` throws `ConflictError`. System collections (those prefixed with `_`) are filtered out of `loadAll` so backup/restore round-trips don't confuse the ledger with user data.

Zero runtime dependencies.
