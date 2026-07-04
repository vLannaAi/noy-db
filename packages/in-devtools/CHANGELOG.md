# @noy-db/in-devtools

## 0.3.0-pre.3

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.3.0-pre.3

## 0.3.0-pre.2

### Minor Changes

- 0.3 version line continues — lockstep with `@noy-db/hub` 0.3.0-pre.2 (describe() group/order metadata, \_history in the .noydb pod; see the hub changelog). No package-specific changes beyond the hub realignment.

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.3.0-pre.2

## 0.3.0-pre.1

### Minor Changes

- 0.3 version line — lockstep with `@noy-db/hub` 0.3.0-pre.1 (kernel/enclave reorg, family doors, `withX()` service gating; see the hub changelog). No package-specific changes beyond the hub realignment.

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.3.0-pre.1

## 0.2.0-pre.31

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.2.0-pre.31

## 0.2.0-pre.5

Initial release. A **framework-agnostic, read-only inspector core** for a live noy-db ([#265](https://github.com/vLannaAi/noy-db/issues/265), Track B — B1). A pure consumer of public hub APIs — no hub changes, fully serializable output.

- **`createInspector(db)`** exposes: `listVaults`, `snapshot` (vault → collections → schema/stats), `records` (paged), `subscribe` (live write feed), and `pendingWrites`.
- Read-only and already-unlocked-only: it surfaces decrypted data solely within an open session and never writes through a non-public path.
- `subscribeConflicts(handler)` — surface multi-user/multi-tab write-conflict overlaps.
- `createInspector(db, { meter })` + `meterSnapshot()` — optional aggregate store-op latency (null when unmetered).
