/**
 * Vault-level schema-fence controller (#232).
 *
 * Owns the open-time generation snapshot, the pending-cutover registry,
 * and the cutover orchestration. 3a: single-client (the caller is the
 * migrator). 3b: a cooperative ack-barrier — after `draining`, the
 * migrator waits for the active client set (registry heartbeats) to ack
 * the draining generation before transforming. No leader election.
 */
import type { NoydbStore } from '../types.js'
import { loadFence, saveFence, type FenceState } from './fence.js'
import { SchemaFenceError, MigrationRequiredError, QuiesceTimeoutError } from '../errors.js'
import { activeQuiesced } from './client-registry.js'
import type { TransformFn } from './types.js'

/** Runs one collection's transform; supplied by the Vault (binds to a Collection). */
export type RunTransform = (collection: string, transform: TransformFn) => Promise<void>

export class SchemaFenceController {
  readonly #store: NoydbStore
  readonly #vault: string
  readonly #onFlush: () => Promise<void>
  readonly #clientId: string
  readonly #now: () => number
  readonly #staleMs: number
  readonly #quiesceTimeoutMs: number
  readonly #emit: (e: { currentSchemaVersion: number; fenceState: FenceState }) => void
  #snapshot = 0
  readonly #pending = new Map<string, TransformFn>()

  constructor(opts: {
    store: NoydbStore
    vault: string
    onFlush: () => Promise<void>
    clientId?: string
    now?: () => number
    staleMs?: number
    quiesceTimeoutMs?: number
    emit?: (e: { currentSchemaVersion: number; fenceState: FenceState }) => void
  }) {
    this.#store = opts.store
    this.#vault = opts.vault
    this.#onFlush = opts.onFlush
    this.#clientId = opts.clientId ?? 'migrator'
    this.#now = opts.now ?? (() => Date.now())
    this.#staleMs = opts.staleMs ?? 30_000
    this.#quiesceTimeoutMs = opts.quiesceTimeoutMs ?? 60_000
    this.#emit = opts.emit ?? (() => {})
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

  /**
   * Admin trigger. Drain → wait for the active set to quiesce (or time out)
   * → migrate each pending transform → bump → complete → normal. The
   * migrator excludes itself from the barrier (it drained synchronously
   * here). `onPoll` (tests) advances other clients between barrier checks;
   * production falls back to a short real delay.
   */
  async runCutover(
    run: RunTransform,
    opts?: { onPoll?: () => Promise<void> },
  ): Promise<{ migrated: number }> {
    if (this.#pending.size === 0) return { migrated: 0 }
    const base = await loadFence(this.#store, this.#vault)
    const generation = base.currentSchemaVersion

    await this.#setState(generation, 'draining')
    await this.#onFlush() // drain THIS client first

    const deadline = this.#now() + this.#quiesceTimeoutMs
    while (!(await activeQuiesced(this.#store, this.#vault, {
      generation, now: this.#now(), staleMs: this.#staleMs, excludeClientId: this.#clientId,
    }))) {
      if (this.#now() >= deadline) {
        throw new QuiesceTimeoutError(
          `Cutover on "${this.#vault}" timed out waiting for clients to quiesce at generation ${generation}.`,
        )
      }
      await (opts?.onPoll ? opts.onPoll() : delay(50))
    }

    await this.#setState(generation, 'migrating')
    let migrated = 0
    for (const [collection, transform] of this.#pending) {
      await run(collection, transform)
      migrated++
    }

    const nextVersion = generation + 1
    await this.#setState(nextVersion, 'complete')
    this.#pending.clear()
    await this.#setState(nextVersion, 'normal')
    this.#snapshot = nextVersion
    return { migrated }
  }

  /** Recover a stuck drain: reset fenceState to normal at the current version (no bump). */
  async abort(): Promise<void> {
    const fence = await loadFence(this.#store, this.#vault)
    await this.#setState(fence.currentSchemaVersion, 'normal')
  }

  async #setState(currentSchemaVersion: number, fenceState: FenceState): Promise<void> {
    await saveFence(this.#store, this.#vault, { currentSchemaVersion, fenceState })
    this.#emit({ currentSchemaVersion, fenceState })
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
