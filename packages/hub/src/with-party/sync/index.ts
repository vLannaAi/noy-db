/**
 * `@noy-db/hub/sync` — subpath export for the optional sync engine +
 * presence subsystem (~856 LOC).
 *
 * Solo / single-device apps that never replicate to a remote peer
 * and never call `collection.presence()` exclude this subpath
 * entirely; the constructors are routed through the `SyncStrategy`
 * seam in core, and the `NO_SYNC` stub keeps the whole module out
 * of the bundle.
 *
 * Opt in via:
 *
 * ```ts
 * import { createNoydb } from '@noy-db/hub'
 * import { withSync } from '@noy-db/hub/sync'
 *
 * const db = await createNoydb({
 *   store: localStore,
 *   sync: remoteStore,
 *   user: ...,
 *   syncStrategy: withSync(),
 * })
 * ```
 *
 * Note: the `SyncEngine`, `SyncTransaction`, and `PresenceHandle`
 * classes themselves still live under `team/` and remain exposed
 * via `@noy-db/hub/team` for advanced consumers that construct them
 * directly. This subpath is the clean LTS factory entry point.
 */

export { withSync } from '../team/sync-active.js'
export type { SyncStrategy } from '../team/sync-strategy.js'
