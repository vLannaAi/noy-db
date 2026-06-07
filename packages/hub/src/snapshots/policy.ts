/**
 * Cadence policy for automatic snapshots. Borrows the vocabulary of the sync
 * `SyncPolicy` (debounce / interval / minInterval / onUnload) but is a separate,
 * snapshot-specific shape — automatic snapshots write the single rolling
 * `<vault>__auto` key, never the immutable on-demand pool.
 *
 * Default mode is `'manual'`: no timers, snapshots stay on-demand.
 */
export type SnapshotMode = 'manual' | 'debounce' | 'interval'

export interface SnapshotPolicy {
  /** Trigger mode. Default `'manual'` — no automatic snapshots. */
  readonly mode?: SnapshotMode
  /** Idle delay (ms) after a write before an auto-snapshot fires. `mode:'debounce'`. Default 30_000. */
  readonly debounceMs?: number
  /** Fixed interval (ms). `mode:'interval'`. Default 300_000. */
  readonly intervalMs?: number
  /** Hard floor (ms) between auto-snapshots regardless of mode. Default 0. */
  readonly minIntervalMs?: number
  /** Flush a pending auto-snapshot on tab-hide / process exit. Default true for non-manual modes. */
  readonly onUnload?: boolean
  /** Label applied to each auto-snapshot. Default `'auto'`. */
  readonly label?: string
}
