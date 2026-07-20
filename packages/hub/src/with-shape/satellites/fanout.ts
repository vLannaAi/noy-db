/**
 * Fan-out writes for a base↔satellite pair (#591, Task 6): a joined `put`
 * splits the record across both collections and writes base-then-satellite;
 * a pair `delete` removes satellite-then-base. Either function reverts every
 * already-executed leg (best-effort, raw adapter writes) and compensates
 * each reverted collection's cache/dirty-tracking/change-stream on failure.
 *
 * Both legs are driven through `Collection.put`/`.delete` (encryption,
 * ledger, history, cache, sync-dirty, change-emit all fire normally); only
 * the REVERT writes go straight to the raw adapter, via the shared
 * `bestEffortRevert` helper (`kernel/best-effort-revert.ts`) also used by
 * `revertExecuted` (`with-commit/tx/transaction.ts`) — a neutral kernel-level
 * home so this always-on satellite path can share the revert shape without
 * depending on with-commit, a gated service.
 *
 * `deps.base()`/`deps.satellite()` may return either a raw `Collection` or
 * one of this package's proxies (`makeSatelliteProxy` / `makeBaseProxy`) —
 * every handle is unwrapped via `RAW_TARGET` before use so fan-out never
 * re-enters a proxy's own `put`/`delete` override. Re-entering would either
 * deadlock (the satellite proxy's `put` takes the same non-reentrant
 * `registry.withPairLock` this module already holds) or recurse forever
 * (the base proxy's `delete` calls straight back into `pairDelete`).
 */
import type { NoydbStore } from '../../kernel/types.js'
import type { SatelliteSpec } from './types.js'
import type { SatelliteRegistry } from './registry.js'
import { RAW_TARGET } from './raw-target.js'
import { bestEffortRevert } from '../../kernel/best-effort-revert.js'
import type { BestEffortRevertLeg } from '../../kernel/best-effort-revert.js'

export interface FanoutDeps {
  readonly spec: SatelliteSpec
  readonly base: () => unknown
  readonly satellite: () => unknown
  // Widened to the full `NoydbStore` (#591 review M2): every caller already
  // hands in the full adapter (vault.ts's `this.adapter` / a proxy's own
  // `target.adapter`) — narrowing to fan-out's own get/put/delete needs just
  // forced `joined.ts` to re-widen it back with a double cast to reach
  // `isBaseLive`/`liveBaseIdSet`, which also call `.list`.
  readonly adapter: NoydbStore
  readonly vaultName: string
  readonly registry: SatelliteRegistry
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CollectionHandle = any

/** Escape any proxy — see file header. Plain (non-proxy) handles pass through unchanged. */
function unwrap(handle: unknown): CollectionHandle {
  return (handle as Record<symbol, unknown>)[RAW_TARGET] ?? handle
}

interface Leg extends BestEffortRevertLeg {
  readonly handle: CollectionHandle
  /**
   * True once this leg's `put`/`delete` actually completed (#596). A leg is
   * snapshotted (for the raw-envelope revert) BEFORE its write is attempted,
   * so a leg whose write THROWS is still in `executed` with `wrote: false` —
   * its envelope-revert is a harmless no-op (nothing changed), but it must
   * NOT be dirty-compensated: `_compensateRevertedWrite` → `removeDirty`
   * keys only on (collection, id) and would otherwise drop a pre-existing,
   * unrelated dirty entry for the same id.
   *
   * KNOWN LIMITATION (#687), accepted: the reverse hazard is inherent. A leg
   * whose `put`/`delete` COMMITS its dirty entry (via `onDirty`) but then
   * THROWS in the post-`onDirty` dispatch phase — a strict-mode `withFormula`
   * derivation / materialized-view recompute run inside `_putInternal`/
   * `_doDelete` with no try/catch — leaves `wrote: false`, so
   * `revertAndCompensate` skips compensation and this leg's OWN just-created
   * dirty entry is orphaned (the raw envelope still reverts correctly).
   * Reachable only with satellites + a strict formula/MV on the same
   * collection whose recompute throws mid-fan-out; the sole harm is one
   * self-healing sync-push cycle (a redundant no-op push or ordinary conflict
   * resolution — no data loss; the entry is spliced out every cycle). A
   * precise fix would diff the dirty log before/after each leg regardless of
   * whether the write threw (needs `FanoutDeps` plumbing) — deferred as
   * disproportionate to the harm.
   */
  wrote: boolean
}

/** Best-effort revert of every executed leg, in reverse order, then per-leg compensation. */
async function revertAndCompensate(deps: FanoutDeps, executed: readonly Leg[]): Promise<void> {
  await bestEffortRevert(executed, deps.adapter, async (leg) => {
    // #596: only a leg whose write actually landed needs dirty-compensation.
    if (leg.wrote) await leg.handle._compensateRevertedWrite(leg.id)
  })
}

/** Split `record` across the pair by `spec.fields`, base leg first, satellite leg second. */
export async function joinedPut(deps: FanoutDeps, id: string, record: Record<string, unknown>): Promise<void> {
  deps.registry.assertNotPoisoned(deps.spec.satellite)
  const base = unwrap(deps.base())
  const satellite = unwrap(deps.satellite())
  const satFields = new Set(deps.spec.fields)
  const baseRec: Record<string, unknown> = {}
  const satRec: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(record)) (satFields.has(k) ? satRec : baseRec)[k] = v
  // Pre-validate BOTH legs before any adapter write — an invalid satellite
  // field must abort with zero writes, not a half-applied base leg.
  await base.validateInput(baseRec)
  await satellite.validateInput(satRec)
  return deps.registry.withPairLock(deps.spec.base, async () => {
    const executed: Leg[] = []
    const run = async (handle: CollectionHandle, coll: string, rec: Record<string, unknown>): Promise<void> => {
      const leg: Leg = {
        vaultName: deps.vaultName,
        collectionName: coll,
        id,
        prior: await deps.adapter.get(deps.vaultName, coll, id),
        handle,
        wrote: false,
      }
      executed.push(leg)
      await handle.put(id, rec)
      leg.wrote = true // #596: only mark dirty-compensation-eligible once the write lands
    }
    try {
      await run(base, deps.spec.base, baseRec)          // base leg FIRST (convergence rule 3)
      await run(satellite, deps.spec.satellite, satRec)
    } catch (err) {
      await revertAndCompensate(deps, executed)
      throw err
    }
  })
}

/** Remove both legs of the pair, satellite first, base second. */
export async function pairDelete(deps: FanoutDeps, id: string): Promise<void> {
  const base = unwrap(deps.base())
  const satellite = unwrap(deps.satellite())
  return deps.registry.withPairLock(deps.spec.base, async () => {
    const executed: Leg[] = []
    const run = async (handle: CollectionHandle, coll: string): Promise<void> => {
      const leg: Leg = {
        vaultName: deps.vaultName,
        collectionName: coll,
        id,
        prior: await deps.adapter.get(deps.vaultName, coll, id),
        handle,
        wrote: false,
      }
      executed.push(leg)
      await handle.delete(id)
      leg.wrote = true // #596: only mark dirty-compensation-eligible once the delete lands
    }
    try {
      await run(satellite, deps.spec.satellite)         // satellite leg FIRST (convergence rule 3)
      await run(base, deps.spec.base)
    } catch (err) {
      await revertAndCompensate(deps, executed)
      throw err
    }
  })
}
