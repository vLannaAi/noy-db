import type { SnapshotPolicy } from './policy.js'

export interface SnapshotMeta {
  readonly version: string
  readonly label?: string
  readonly note?: string
  readonly exportedAt: string
  readonly exportedBy: string
  readonly size: number
  /**
   * `'verified'` — bundle was produced by `writePod(vault, {})`, which embeds
   * ledgerHead metadata; `vault.load()` runs `verifyBackupIntegrity()` on restore.
   * `'legacy-unverifiable'` — reserved for v2 import paths that read pre-existing bundles
   * lacking a ledgerHead; not produced by the current engine.
   */
  readonly integrity: 'verified' | 'legacy-unverifiable'
  /** `true` for the rolling auto-snapshot; absent on on-demand checkpoints. */
  readonly auto?: true
}

export interface RetentionPolicy {
  readonly keepLast?: number
  readonly maxAgeDays?: number
  readonly prune?: boolean
}

/** @internal */
export interface SnapshotIndex {
  snapshots: SnapshotMeta[]
  nextCounter: number
  /** Single rolling auto-snapshot slot, separate from the immutable `snapshots` pool. */
  auto?: SnapshotMeta
}

/** @internal */
export interface SnapshotStrategy {
  snapshot(vault: unknown, by: string, opts?: { label?: string; note?: string }): Promise<SnapshotMeta>
  listSnapshots(vaultId: string): Promise<SnapshotMeta[]>
  restoreSnapshot(vault: unknown, version: string): Promise<void>
  /** Rolling auto-snapshot to the fixed `<vault>__auto` key. */
  autoSnapshot(vault: unknown, by: string, opts?: { label?: string; note?: string }): Promise<SnapshotMeta>
  /** Configured cadence policy. Undefined or `mode:'manual'` ⇒ no scheduler is wired. */
  readonly policy?: SnapshotPolicy
}

const NOT_ENABLED = new Error(
  'Snapshots require the snapshot strategy. Import `{ withSnapshots }` from ' +
  '"@noy-db/hub/snapshots" and pass it to ' +
  '`createNoydb({ snapshotStrategy: withSnapshots({ store }) })`.',
)

/** No-op stub. @internal */
export const NO_SNAPSHOTS: SnapshotStrategy = {
  async snapshot() { throw NOT_ENABLED },
  async listSnapshots() { throw NOT_ENABLED },
  async restoreSnapshot() { throw NOT_ENABLED },
  async autoSnapshot() { throw NOT_ENABLED },
}
