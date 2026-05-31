/**
 * Vault-level schema-fence controller (#232, sub-slice 3a).
 *
 * Owns the open-time generation snapshot, the pending-cutover registry,
 * and the local cutover orchestration. Single-client: the caller IS the
 * migrator (sub-slice 3b adds presence + election). `assertWritable` is
 * the write-path gate; `runCutover` is the admin trigger.
 */
import type { NoydbStore } from '../types.js'
import { loadFence, saveFence, type FenceState } from './fence.js'
import { SchemaFenceError, MigrationRequiredError } from '../errors.js'
import type { TransformFn } from './types.js'

/** Runs one collection's transform; supplied by the Vault (binds to a Collection). */
export type RunTransform = (collection: string, transform: TransformFn) => Promise<void>

export class SchemaFenceController {
  readonly #store: NoydbStore
  readonly #vault: string
  readonly #onFlush: () => Promise<void>
  #snapshot = 0
  readonly #pending = new Map<string, TransformFn>()

  constructor(opts: { store: NoydbStore; vault: string; onFlush: () => Promise<void> }) {
    this.#store = opts.store
    this.#vault = opts.vault
    this.#onFlush = opts.onFlush
  }

  /** Capture the generation snapshot at vault-open. */
  async init(): Promise<void> {
    this.#snapshot = (await loadFence(this.#store, this.#vault)).currentSchemaVersion
  }

  /** Record a per-collection pending cutover (from a registration `cutover` decision). */
  registerPendingCutover(collection: string, transform: TransformFn): void {
    this.#pending.set(collection, transform)
  }

  /** Write-path gate. Throws when behind, fenced, or this collection is cutover-pending. */
  async assertWritable(collection: string): Promise<void> {
    const fence = await loadFence(this.#store, this.#vault)
    if (fence.currentSchemaVersion > this.#snapshot) {
      throw new MigrationRequiredError(
        `Vault "${this.#vault}" advanced to schema generation ${fence.currentSchemaVersion} ` +
          `(this client opened at ${this.#snapshot}). Reload to continue.`,
      )
    }
    if (fence.fenceState === 'draining' || fence.fenceState === 'migrating') {
      throw new SchemaFenceError(`Vault "${this.#vault}" is mid-cutover (${fence.fenceState}); writes are paused.`)
    }
    if (this.#pending.has(collection)) {
      throw new SchemaFenceError(
        `Collection "${collection}" has a pending schema cutover; run vault.runSchemaCutover() before writing.`,
      )
    }
  }

  /** Admin trigger (single-client). Drain → migrate each pending transform → bump → complete → normal. */
  async runCutover(run: RunTransform): Promise<{ migrated: number }> {
    if (this.#pending.size === 0) return { migrated: 0 }
    const base = await loadFence(this.#store, this.#vault)

    await this.#setState(base.currentSchemaVersion, 'draining')
    await this.#onFlush() // local quiesce; 3b adds other clients' acks

    await this.#setState(base.currentSchemaVersion, 'migrating')
    let migrated = 0
    for (const [collection, transform] of this.#pending) {
      await run(collection, transform)
      migrated++
    }

    const nextVersion = base.currentSchemaVersion + 1
    await saveFence(this.#store, this.#vault, { currentSchemaVersion: nextVersion, fenceState: 'complete' })
    this.#pending.clear()
    await saveFence(this.#store, this.#vault, { currentSchemaVersion: nextVersion, fenceState: 'normal' })
    // The migrator advances its OWN snapshot — it just produced this generation.
    this.#snapshot = nextVersion
    return { migrated }
  }

  async #setState(currentSchemaVersion: number, fenceState: FenceState): Promise<void> {
    await saveFence(this.#store, this.#vault, { currentSchemaVersion, fenceState })
  }
}
