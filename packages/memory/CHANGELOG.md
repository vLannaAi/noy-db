# @noy-db/memory

## 1.0.0

### Patch Changes

- Updated dependencies [2d38d62]
- Updated dependencies [2d38d62]
- Updated dependencies [2d38d62]
- Updated dependencies [2d38d62]
- Updated dependencies [2d38d62]
  - @noy-db/core@0.7.0

## 0.6.0

### Patch Changes

- Updated dependencies [755f151]
- Updated dependencies [92f2000]
- Updated dependencies [36dbdbc]
- Updated dependencies [f968f83]
- Updated dependencies [bd21ad7]
- Updated dependencies [d90098a]
- Updated dependencies [958082b]
- Updated dependencies [f65908a]
  - @noy-db/core@0.6.0

## 0.5.0

### Initial release

In-memory adapter for `@noy-db/core` — backed by nested `Map`s, no persistence, data is lost when the process exits. Intended for testing, development, and ephemeral workloads.

Implements every mandatory method on `NoydbAdapter` (`get`, `put`, `delete`, `list`, `loadAll`, `saveAll`) plus the optional `listPage` pagination capability and the optional `listCompartments` cross-compartment enumeration capability. Version conflict detection via `expectedVersion` on `put` throws `ConflictError`. System collections (those prefixed with `_`) are filtered out of `loadAll` so backup/restore round-trips don't confuse the ledger with user data.

Zero runtime dependencies.
