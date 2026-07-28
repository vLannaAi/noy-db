/**
 * Best-effort reverse-revert — the shape shared by two independent rollback
 * paths that used to duplicate it: satellite fan-out
 * (`with-shape/satellites/fanout.ts`'s `revertAndCompensate`) and
 * multi-record transactions (`with-commit/tx/transaction.ts`'s
 * `revertExecuted`). Both revert a list of already-executed writes on
 * failure by walking them in REVERSE order and, per leg, restoring the
 * captured prior envelope straight through the raw adapter — `put(prior)`
 * when one existed, `delete` when the leg was a fresh insert — bypassing
 * the Collection layer so the revert itself doesn't re-fire
 * encryption/ledger/change-event machinery. Each leg's raw-adapter revert
 * is best-effort: a throw is swallowed so a revert-path failure never masks
 * the original error that triggered the rollback, and the loop moves on to
 * the next leg.
 *
 * An optional per-leg `compensate` callback runs immediately after a
 * successful raw-adapter revert (still inside the same try, so a throwing
 * callback is swallowed the same way as a throwing raw revert). What the
 * callback does is entirely caller-defined — satellites' fan-out fires
 * `_compensateRevertedWrite` only for legs whose write actually landed
 * (#596); with-commit's transaction executor invalidates the Collection
 * cache. Neither concern belongs here: this helper only knows the generic
 * reverse/best-effort/raw-revert shape.
 *
 * Lives in `kernel/` — not a `with-*` service — so both consumers (one a
 * gated service, `with-commit`; one an always-on schema feature,
 * `with-shape/satellites`) can import it without creating a
 * `with-* → with-*` edge, which would force either family to always bundle
 * the other and defeat the opt-in tree-shaking both are built around.
 *
 * @internal — implementation-sharing only, not part of the public surface.
 */
import type { EncryptedEnvelope, StoreCapabilities, TxOp } from './types.js'

/** One already-executed write a revert pass needs to unwind. */
export interface BestEffortRevertLeg {
  readonly vaultName: string
  readonly collectionName: string
  readonly id: string
  /** Envelope captured before the write, or `null` if the id didn't exist yet. */
  readonly prior: EncryptedEnvelope | null
}

/** The subset of `NoydbStore` a raw-adapter revert needs. */
export interface BestEffortRevertAdapter {
  put(vaultName: string, collectionName: string, id: string, envelope: EncryptedEnvelope): Promise<void>
  delete(vaultName: string, collectionName: string, id: string): Promise<void>
  /**
   * Optional storage-layer transaction (#886). When the store declares
   * `txAtomic`, the whole revert is submitted as ONE operation instead of a
   * per-leg loop, so a crash mid-revert can no longer leave the vault
   * half-unwound.
   */
  tx?(ops: readonly TxOp[]): Promise<void>
  readonly capabilities?: StoreCapabilities
}

/**
 * Revert `executed` in reverse order via the raw adapter, best-effort.
 * `compensate`, when supplied, runs once per leg immediately after that
 * leg's own raw revert succeeds.
 */
export async function bestEffortRevert<T extends BestEffortRevertLeg>(
  executed: readonly T[],
  adapter: BestEffortRevertAdapter,
  compensate?: (leg: T) => Promise<void> | void,
): Promise<void> {
  const legs = [...executed].reverse()

  // #886 — atomic revert when the store can do it. The legs already carry RAW
  // prior envelopes (captured pre-write), which is exactly the shape `tx()`
  // wants, so this needs none of the Collection-layer machinery that makes
  // delegating the FORWARD write path a much larger job.
  //
  // Failure stays best-effort: if the store rejects the batch we fall through
  // to the per-leg loop rather than surfacing a revert-path error, because a
  // revert failure must never mask the original error that triggered it.
  if (adapter.capabilities?.txAtomic === true && typeof adapter.tx === 'function') {
    const ops: TxOp[] = legs.map(leg =>
      leg.prior !== null
        ? { type: 'put', vault: leg.vaultName, collection: leg.collectionName, id: leg.id, envelope: leg.prior }
        : { type: 'delete', vault: leg.vaultName, collection: leg.collectionName, id: leg.id },
    )
    try {
      await adapter.tx(ops)
      if (compensate) for (const leg of legs) { try { await compensate(leg) } catch { /* best-effort */ } }
      return
    } catch {
      // fall through to the per-leg path below
    }
  }

  for (const leg of legs) {
    try {
      if (leg.prior !== null) {
        await adapter.put(leg.vaultName, leg.collectionName, leg.id, leg.prior)
      } else {
        await adapter.delete(leg.vaultName, leg.collectionName, leg.id)
      }
      if (compensate) await compensate(leg)
    } catch {
      // best-effort — a revert-path failure must not mask the original
      // error that triggered the rollback (matches both callers' prior
      // independent implementations).
    }
  }
}
