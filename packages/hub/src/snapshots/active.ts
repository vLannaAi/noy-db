import { SnapshotEngine } from './engine.js'
import type { SnapshotStrategy, RetentionPolicy } from './strategy.js'
import type { NoydbBundleStore } from '../types.js'
import type { Vault } from '../vault.js'

export interface WithSnapshotsOptions {
  /** Bundle store where snapshot blobs and the sidecar index are written. */
  store: NoydbBundleStore
  /**
   * Declarative retention policy. Enforced eagerly after each `snapshot()` call.
   * Defaults to no retention (all snapshots kept forever).
   */
  retention?: RetentionPolicy
}

export function withSnapshots(opts: WithSnapshotsOptions): SnapshotStrategy {
  const engine = new SnapshotEngine(opts.store, opts.retention ?? {})
  return {
    snapshot(vault, by, snapOpts) {
      return engine.snapshot(vault as Vault, by, snapOpts)
    },
    listSnapshots(vaultId) {
      return engine.listSnapshots(vaultId)
    },
    restoreSnapshot(vault, version) {
      return engine.restoreSnapshot(vault as Vault, version)
    },
  }
}
