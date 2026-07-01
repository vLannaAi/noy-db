import { SnapshotEngine } from './engine.js'
import type { SnapshotStrategy, RetentionPolicy } from './strategy.js'
import type { SnapshotPolicy } from './policy.js'
import type { NoydbBundleStore } from '../../kernel/types.js'
import type { Vault } from '../../vault.js'

export interface WithSnapshotsOptions {
  /** Bundle store where snapshot blobs and the sidecar index are written. */
  store: NoydbBundleStore
  /**
   * Declarative retention policy. Enforced eagerly after each on-demand `snapshot()`.
   * Defaults to no retention (all on-demand snapshots kept forever). Never affects
   * the rolling auto-snapshot.
   */
  retention?: RetentionPolicy
  /**
   * Automatic-snapshot cadence. Default `mode:'manual'` ⇒ no timers; snapshots
   * stay on-demand. Set `mode:'debounce'`/`'interval'` to enable auto-snapshots
   * to the rolling `<vault>__auto` key.
   */
  snapshotPolicy?: SnapshotPolicy
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
    autoSnapshot(vault, by, snapOpts) {
      return engine.autoSnapshot(vault as Vault, by, snapOpts)
    },
    ...(opts.snapshotPolicy ? { policy: opts.snapshotPolicy } : {}),
  }
}
