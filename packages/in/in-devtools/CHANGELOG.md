# @noy-db/in-devtools

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
