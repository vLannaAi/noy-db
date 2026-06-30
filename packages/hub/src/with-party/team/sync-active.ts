/**
 * Active sync strategy — `withSync()` returns the real implementation
 * that wires the `SyncEngine`, `SyncTransaction`, and `PresenceHandle`
 * constructors into the Noydb / Vault / Collection hot paths.
 *
 * Consumers opt in by:
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
 * The factory delegates to the existing `sync.ts`,
 * `sync-transaction.ts`, and `presence.ts` modules. Splitting the
 * import chain through this file is what lets tsup tree-shake the
 * ~856 LOC of replication + presence machinery out of the default
 * bundle when no `withSync()` import is present.
 *
 * Keyring + grant/revoke/magic-link/delegation stay in the always-on
 * core (or tree-shake via direct named imports) — those are required
 * for any multi-user vault, even purely local ones.
 *
 * @public
 */

import type { SyncStrategy, BuildSyncEngineOptions } from './sync-strategy.js'
import type { PresenceHandleOpts } from './presence.js'
import type { Vault } from '../vault.js'
import { SyncEngine } from './sync.js'
import { SyncTransaction } from './sync-transaction.js'
import { PresenceHandle } from './presence.js'

export function withSync(): SyncStrategy {
  return {
    buildSyncEngine(opts: BuildSyncEngineOptions): SyncEngine {
      return new SyncEngine(opts)
    },
    buildSyncTransaction(vault: Vault, engine: SyncEngine): SyncTransaction {
      return new SyncTransaction(vault, engine)
    },
    buildPresence<P>(opts: PresenceHandleOpts): PresenceHandle<P> {
      return new PresenceHandle<P>(opts)
    },
  }
}
