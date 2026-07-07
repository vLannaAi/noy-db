/**
 * Fan-out writes for a base↔satellite pair (#591, Task 6): a joined `put`
 * splits the record across both collections and writes base-then-satellite;
 * a pair `delete` removes satellite-then-base. Either function reverts every
 * already-executed leg (best-effort, raw adapter writes) and compensates
 * each reverted collection's cache/dirty-tracking/change-stream on failure.
 *
 * Both legs are driven through `Collection.put`/`.delete` (encryption,
 * ledger, history, cache, sync-dirty, change-emit all fire normally); only
 * the REVERT writes go straight to the raw adapter, mirroring
 * `revertExecuted` (`with-commit/tx/transaction.ts:610`) — re-implemented
 * locally rather than imported, since with-commit is a gated service this
 * always-on satellite path must not depend on.
 *
 * `deps.base()`/`deps.satellite()` may return either a raw `Collection` or
 * one of this package's proxies (`makeSatelliteProxy` / `makeBaseProxy`) —
 * every handle is unwrapped via `RAW_TARGET` before use so fan-out never
 * re-enters a proxy's own `put`/`delete` override. Re-entering would either
 * deadlock (the satellite proxy's `put` takes the same non-reentrant
 * `registry.withPairLock` this module already holds) or recurse forever
 * (the base proxy's `delete` calls straight back into `pairDelete`).
 */
import type { EncryptedEnvelope } from '../../kernel/types.js'
import type { SatelliteSpec } from './types.js'
import type { SatelliteRegistry } from './registry.js'
import { RAW_TARGET } from './raw-target.js'

export interface FanoutDeps {
  readonly spec: SatelliteSpec
  readonly base: () => unknown
  readonly satellite: () => unknown
  readonly adapter: { get(vault: string, collection: string, id: string): Promise<EncryptedEnvelope | null>; put(vault: string, collection: string, id: string, envelope: EncryptedEnvelope): Promise<void>; delete(vault: string, collection: string, id: string): Promise<void> }
  readonly vaultName: string
  readonly registry: SatelliteRegistry
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CollectionHandle = any

/** Escape any proxy — see file header. Plain (non-proxy) handles pass through unchanged. */
function unwrap(handle: unknown): CollectionHandle {
  return (handle as Record<symbol, unknown>)[RAW_TARGET] ?? handle
}

interface Leg {
  readonly coll: string
  readonly id: string
  readonly prior: EncryptedEnvelope | null
  readonly handle: CollectionHandle
}

/** Best-effort revert of every executed leg, in reverse order, then per-leg compensation. */
async function revertAndCompensate(deps: FanoutDeps, executed: readonly Leg[]): Promise<void> {
  for (const leg of [...executed].reverse()) {
    try {
      if (leg.prior !== null) await deps.adapter.put(deps.vaultName, leg.coll, leg.id, leg.prior)
      else await deps.adapter.delete(deps.vaultName, leg.coll, leg.id)
      await leg.handle._compensateRevertedWrite(leg.id)
    } catch {
      // best-effort, matches `revertExecuted` semantics (with-commit/tx/transaction.ts:632) —
      // surfacing a revert-path failure would mask the original error that triggered the rollback.
    }
  }
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
      executed.push({ coll, id, prior: await deps.adapter.get(deps.vaultName, coll, id), handle })
      await handle.put(id, rec)
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
      executed.push({ coll, id, prior: await deps.adapter.get(deps.vaultName, coll, id), handle })
      await handle.delete(id)
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
