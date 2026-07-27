/**
 * Noydb-side snapshot facade.
 *
 * Holds the on-demand checkpoint (`snapshot`), listing (`listSnapshots`),
 * restore (`restoreSnapshot`), the automatic-snapshot cadence wiring
 * (`initCadence`), the dirty-vault set, and the cadence scheduler;
 * `Noydb.close()` calls {@link stop}. Every `Noydb` dependency arrives via
 * {@link NoydbSnapshotsDeps}.
 *
 * Internal service — reached through `noydb.snapshot(...)` etc.
 */
import { NO_SNAPSHOTS, type SnapshotsStrategy, type SnapshotMeta } from './strategy.js'
import { SnapshotScheduler } from './scheduler.js'
import { ValidationError } from '../../kernel/errors.js'
import type { Vault } from '../../kernel/vault.js'
import type { WriteHook, Unsubscribe } from '../../port/with/write-hooks.js'

/** Everything the moving snapshot methods touched on the Noydb instance's `this.*`. */
export interface NoydbSnapshotsDeps {
  /** Resolved snapshot strategy (NO_SNAPSHOTS when not configured). */
  readonly strategy: SnapshotsStrategy
  /** Acting user id, used as the snapshot `by`. */
  readonly user: string
  /** Whether the owning instance has been closed. */
  isClosed(): boolean
  /** Resolve an open vault from the instance's vault cache. */
  getVault(name: string): Vault | undefined
  /** Subscribe to post-write events (cadence dirty-marking). */
  onAfterWrite(handler: WriteHook): Unsubscribe
}

export class NoydbSnapshots {
  private scheduler: SnapshotScheduler | null = null
  private readonly dirtyVaults = new Set<string>()

  constructor(private readonly deps: NoydbSnapshotsDeps) {
    this.initCadence()
  }

  /**
   * Take an on-demand checkpoint of the given vault.
   * Requires `snapshotsStrategy: withSnapshots({ store })` in `createNoydb`.
   * @throws ValidationError when the vault is not open
   */
  async snapshot(vault: string, opts?: { label?: string; note?: string }): Promise<SnapshotMeta> {
    if (this.deps.isClosed()) throw new ValidationError('Instance is closed')
    const v = this.deps.getVault(vault)
    if (!v) {
      throw new ValidationError(
        `Vault "${vault}" is not open. Call openVault() first.`,
      )
    }
    return this.deps.strategy.snapshot(v, this.deps.user, opts)
  }

  /**
   * Wire the automatic-snapshot cadence when a non-manual `snapshotPolicy` is
   * configured. Subscribes to `onAfterWrite` to mark the written vault dirty and
   * nudge the scheduler; the scheduler fires `autoSnapshot()` per dirty vault.
   * No-op for `mode:'manual'` or no policy.
   */
  private initCadence(): void {
    const policy = this.deps.strategy.policy
    if (!policy || !policy.mode || policy.mode === 'manual') return

    const scheduler = new SnapshotScheduler(policy, {
      fire: async () => {
        const names = [...this.dirtyVaults]
        this.dirtyVaults.clear()
        for (const name of names) {
          const v = this.deps.getVault(name)
          if (!v) continue
          try {
            await this.deps.strategy.autoSnapshot(v, this.deps.user)
          } catch (err) {
            // Keep the vault pending so a later cadence tick (interval) or the
            // next write (debounce) retries; a failed auto-snapshot is logged,
            // never thrown (it runs inside the after-write hook contract).
            this.dirtyVaults.add(name)
            console.warn(
              `[noy-db] auto-snapshot failed for vault "${name}": ` +
              (err instanceof Error ? err.message : String(err)),
            )
          }
        }
      },
      pendingCount: () => this.dirtyVaults.size,
    })

    this.deps.onAfterWrite((event) => {
      this.dirtyVaults.add(event.vault)
      scheduler.notifyChange()
    })
    scheduler.start()
    this.scheduler = scheduler
  }

  /**
   * List all snapshots for the given vault, newest first.
   * Reads only the sidecar index — does not download snapshot bytes.
   */
  async listSnapshots(vault: string): Promise<SnapshotMeta[]> {
    if (this.deps.isClosed()) throw new ValidationError('Instance is closed')
    return this.deps.strategy.listSnapshots(vault)
  }

  /**
   * Restore the vault to a previously snapshotted state.
   * Runs `verifyBackupIntegrity()` automatically on restore.
   * @throws SnapshotNotFoundError when `version` doesn't exist in the store
   * @throws ValidationError when the vault is not open
   */
  async restoreSnapshot(vault: string, version: string): Promise<void> {
    if (this.deps.isClosed()) throw new ValidationError('Instance is closed')
    const v = this.deps.getVault(vault)
    if (!v) {
      throw new ValidationError(
        `Vault "${vault}" is not open. Call openVault() first.`,
      )
    }
    return this.deps.strategy.restoreSnapshot(v, version)
  }

  /** Stop the cadence scheduler (called from `Noydb.close()`). */
  stop(): void {
    this.scheduler?.stop()
    this.scheduler = null
  }
}

export { NO_SNAPSHOTS }
