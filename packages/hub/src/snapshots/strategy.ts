export interface SnapshotMeta {
  readonly version: string
  readonly label?: string
  readonly note?: string
  readonly exportedAt: string
  readonly exportedBy: string
  readonly size: number
  readonly integrity: 'verified' | 'legacy-unverifiable'
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
}

/** @internal */
export interface SnapshotStrategy {
  snapshot(vault: unknown, by: string, opts?: { label?: string; note?: string }): Promise<SnapshotMeta>
  listSnapshots(vaultId: string): Promise<SnapshotMeta[]>
  restoreSnapshot(vault: unknown, version: string): Promise<void>
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
}
