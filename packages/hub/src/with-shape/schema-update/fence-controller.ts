/**
 * Vault-level schema-fence controller.
 *
 * Owns the open-time generation snapshot, the pending-cutover registry,
 * and the cutover orchestration. 3a: single-client (the caller is the
 * migrator). 3b: a cooperative ack-barrier — after `draining`, the
 * migrator waits for the active client set (registry heartbeats) to ack
 * the draining generation before transforming. No leader election.
 *
 * The transport is the injected {@link CoordinationProvider} port: the
 * default {@link StoreCoordinationProvider} maps it onto today's
 * `_meta/schema-fence` store ops, so behavior is byte-for-byte the same;
 * `by-tabs` / `by-peer` swap in real-time push transports.
 */
import { type FenceState } from './fence.js'
import { SchemaFenceError, MigrationRequiredError } from '../../kernel/errors.js'
import type { TransformFn } from './types.js'
import { runDrainBarrier, type CoordinationProvider } from '../../port/by/index.js'

/** Runs one collection's transform; supplied by the Vault (binds to a Collection). */
export type RunTransform = (collection: string, transform: TransformFn) => Promise<void>

/** Structural (no static import — kernel-spine port-layering carve-out, same rationale as
 *  `kernel/via/dispatch.ts`'s `AuditLedgerLike`) shape of the with-history `LedgerStore.append`
 *  seam {@link schemaBumpAuditHook} needs. */
interface AuditLedgerLike {
  append(input: {
    readonly op: 'lifecycle'
    readonly collection: string
    readonly id: string
    readonly version: number
    readonly actor: string
    readonly payloadHash: string
    readonly reason?: string
  }): Promise<unknown>
}

/**
 * #965 — a bare `runCutover` generation bump (no re-declare, no per-record
 * migrations) otherwise leaves zero ledger evidence: per-record `migration`
 * entries only fire from `applyCutoverTransform` when records + a transform
 * exist. Mirrors `ledgerAuditHook` (`kernel/via/dispatch.ts`): encoded as a
 * `'lifecycle'` entry (no ciphertext to hash, `payloadHash: ''`), distinct
 * from the per-record `op: 'migration'` entries via its
 * `reason: 'schema:generation-bump=<n>'`. Fires once per successful bump,
 * always — even when the same cutover also produced per-record entries —
 * so "one bump entry per generation bump" stays a simple, unconditional
 * invariant to audit against.
 *
 * `getLedger` is called lazily (at bump time, not at wiring time) — same
 * lazy-init contract as `Vault.getLedgerOrNull`; calling it eagerly during
 * `Vault` construction (before `this.strategies` is assigned) would throw.
 */
export function schemaBumpAuditHook(
  getLedger: () => AuditLedgerLike | null, actor: string,
): (generation: number) => Promise<void> {
  return async (generation) => {
    const ledger = getLedger()
    if (!ledger) return
    await ledger.append({
      op: 'lifecycle', collection: '', id: '', version: 0, actor, payloadHash: '',
      reason: `schema:generation-bump=${generation}`,
    })
  }
}

export class SchemaFenceController {
  readonly #coordination: CoordinationProvider
  readonly #vault: string
  readonly #onFlush: () => Promise<void>
  readonly #writerId: string
  readonly #now: () => number
  readonly #staleMs: number
  readonly #quiesceTimeoutMs: number
  readonly #emit: (e: { currentSchemaVersion: number; fenceState: FenceState }) => void
  readonly #auditBump: ((generation: number) => Promise<void>) | undefined
  #snapshot = 0
  readonly #pending = new Map<string, TransformFn>()

  constructor(opts: {
    coordination: CoordinationProvider
    vault: string
    onFlush: () => Promise<void>
    /** Stable per-instance id; the migrator excludes itself from the barrier. */
    clientId?: string
    /**
     * Accepted for wiring symmetry with {@link FenceWatcher}, but the migrator
     * never reports its own presence (it excludes itself from the barrier), so
     * it carries no session of its own.
     */
    sessionId?: string
    now?: () => number
    staleMs?: number
    quiesceTimeoutMs?: number
    emit?: (e: { currentSchemaVersion: number; fenceState: FenceState }) => void
    /** #965 — best-effort ledger audit for a bare (no-record) generation bump. See {@link schemaBumpAuditHook}. */
    auditBump?: ((generation: number) => Promise<void>) | undefined
  }) {
    this.#coordination = opts.coordination
    this.#vault = opts.vault
    this.#onFlush = opts.onFlush
    this.#writerId = opts.clientId ?? 'migrator'
    this.#now = opts.now ?? (() => Date.now())
    this.#staleMs = opts.staleMs ?? 30_000
    this.#quiesceTimeoutMs = opts.quiesceTimeoutMs ?? 60_000
    this.#emit = opts.emit ?? (() => {})
    this.#auditBump = opts.auditBump
  }

  /** Capture the generation snapshot at vault-open. */
  async init(): Promise<void> {
    this.#snapshot = (await this.#coordination.readFence(this.#vault)).currentSchemaVersion
  }

  /** Record a per-collection pending cutover (from a registration `cutover` decision). */
  registerPendingCutover(collection: string, transform: TransformFn): void {
    this.#pending.set(collection, transform)
  }

  /** Write-path gate. Throws when behind, fenced, or this collection is cutover-pending. */
  async assertWritable(collection: string): Promise<void> {
    // Fresh one-shot read (not an observeFence snapshot) — avoids a staleness
    // window and keeps the timing-sensitive cutover gate exact.
    const fence = await this.#coordination.readFence(this.#vault)
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
   * inside {@link runDrainBarrier}). `onPoll` (tests) advances other clients
   * between barrier checks; production falls back to a short real delay.
   */
  async runCutover(
    run: RunTransform,
    opts?: { onPoll?: () => Promise<void> },
  ): Promise<{ migrated: number }> {
    if (this.#pending.size === 0) return { migrated: 0 }
    const base = await this.#coordination.readFence(this.#vault)
    const generation = base.currentSchemaVersion

    // The barrier sets the fence to `draining` + flushes us internally (no
    // emit). Mirror the legacy controller's `draining` transition event so
    // same-instance subscribers (UI) still see all four states.
    this.#emit({ currentSchemaVersion: generation, fenceState: 'draining' })

    let migrated = 0
    await runDrainBarrier(
      this.#coordination,
      {
        vault: this.#vault,
        generation,
        writerId: this.#writerId,
        onFlush: this.#onFlush,
        staleMs: this.#staleMs,
        quiesceTimeoutMs: this.#quiesceTimeoutMs,
        now: this.#now,
        ...(opts?.onPoll ? { onPoll: opts.onPoll } : {}),
      },
      async () => {
        // Barrier resolved: everyone (but us) has quiesced at `generation`.
        await this.#setState(generation, 'migrating')
        for (const [collection, transform] of this.#pending) {
          await run(collection, transform)
          migrated++
        }
        const nextVersion = generation + 1
        await this.#setState(nextVersion, 'complete')
        this.#pending.clear()
        await this.#setState(nextVersion, 'normal')
        this.#snapshot = nextVersion
        if (this.#auditBump) await this.#auditBump(nextVersion).catch(() => { /* ledger is best-effort here, same as the per-record path */ })
      },
    )
    return { migrated }
  }

  /** Recover a stuck drain: reset fenceState to normal at the current version (no bump). */
  async abort(): Promise<void> {
    const fence = await this.#coordination.readFence(this.#vault)
    await this.#setState(fence.currentSchemaVersion, 'normal')
  }

  async #setState(currentSchemaVersion: number, fenceState: FenceState): Promise<void> {
    await this.#coordination.setFence(this.#vault, { currentSchemaVersion, fenceState })
    this.#emit({ currentSchemaVersion, fenceState })
  }
}
