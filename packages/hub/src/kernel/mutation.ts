// kernel/mutation.ts — mutation-origin tagging for Collection._onRecordMutated.
//
// `_onRecordMutated` is the origin-tagged mutation choke point every
// put/delete path funnels through after its own store write. TODAY it only
// performs the exact side-effect set each origin already performs (see the
// seam-map Part-3 table, `.superpowers/sdd/seam-map-i18n-pipeline.md`) — a
// pure parity extraction, not a behavior change. Phase C (#621, #622) plugs
// the dependency-graph dispatch into this socket, keyed off `origin`,
// without every call site having to learn the graph.

/**
 * Where a record mutation originated. Determines which side-effects
 * {@link Collection._onRecordMutated} performs for a given `put`/`delete`.
 *
 * - `local-write` — `Collection.put` (user write; includes the CRDT branch).
 * - `local-delete` — `Collection.delete` / `_internalDelete` (`_doDelete`).
 * - `tab-mirror` — cross-tab BroadcastChannel relay (`_applyRemoteChange`).
 * - `sync-apply` — `SyncEngine#applyRemote` (pull/push conflict winners,
 *   CRDT merges, tombstone reasserts), routed via `Vault#_invalidateSyncApplied`.
 * - `cutover` — `Collection._applyCutoverTransform` (coordinated schema migration).
 * - `restore` — `Vault.load` / `backup.ts#loadVault`. Reserved: restore drops
 *   the whole `collectionCache` and never reaches per-record dispatch today.
 */
export type MutationOrigin =
  | 'local-write'
  | 'local-delete'
  | 'tab-mirror'
  | 'sync-apply'
  | 'cutover'
  | 'restore'
