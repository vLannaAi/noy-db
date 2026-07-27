/**
 * Materialized-view dispatch, lifted out of the kernel spine (#842 part b).
 *
 * Reached from `Collection` by dynamic `import()` only — `port-layering`
 * forbids a static spine→`with-*` import, and rejects a type-only one too
 * (it scans import statements, not their erasure). See
 * `with-formula/derivations/dispatch.ts` for the same note.
 *
 * The `Collection` reference below is TYPE-ONLY and points inward
 * (service → kernel), so it is both allowed and erased at build.
 *
 * @internal
 */

import type { TxContext } from '../../with-commit/tx/transaction.js'
import type { Collection } from '../../kernel/collection.js'
import type { ledgerAuditHook } from '../../kernel/via/dispatch.js'
import type { MaterializedViewExecutor } from './executor.js'
import type * as MVStale from './stale.js'
import type { MaterializedViewRegistry } from './registry.js'
import type { MVQueryContext } from './types.js'

/** The per-write dispatch context the MV executor threads through. */
interface DispatchCtx {
  emit: (e: string, p: unknown) => void
  source: { readonly collection: string; readonly id: string }
  audit: ReturnType<typeof ledgerAuditHook>
}

/** What the MV dispatchers need from the collection that owns them. */
export interface MvDispatchCtx {
  readonly materializedViewSource: {
    registry(): MaterializedViewRegistry
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getCollection(name: string): Collection<any>
    getActiveTxContext(): TxContext | null
    getQueryContext(): MVQueryContext
  }
  /** The collection the delete happened in. */
  readonly collectionName: string
  /** Builds the per-write dispatch context the executor threads through. */
  readonly dispatchCtx: (source: { readonly collection: string; readonly id: string }) => DispatchCtx
}

/**
 * Mirror of `dispatchMaterializedViews` for the delete/forget path. There is
 * no `_materializedFrom` skip — the record is gone — and the `internal` gate
 * at `_doDelete` is the recursion guard.
 *
 * @returns rows TOMBSTONED across every MV sourced here (#638 T6). Eager and
 *   lazy/manual `invalidateMVAtRest` purges both contribute (#761 item 1,
 *   previously eager-only): lazy persists a stale mark for cold-session
 *   recompute, manual serves empty until `refreshView()`.
 *   `residueUndecodable` / `residueDeclined` (#776/#785) carry
 *   `outputCollection:id` entries whose ownership stamp `invalidateMVAtRest`
 *   could not decode, respectively decoded and stamp-matched but declined to
 *   erase — surfaced, not erased.
 */
export async function dispatchMaterializedViewsOnDelete(
  ctx: MvDispatchCtx,
  id: string,
): Promise<{ deleted: number; residueUndecodable: string[]; residueDeclined: string[] }> {
  const { materializedViewSource: source, collectionName, dispatchCtx } = ctx

  const mvs = source.registry().mvsForSource(collectionName)
  const empty = { deleted: 0, residueUndecodable: [], residueDeclined: [] }
  if (mvs.length === 0) return empty

  let executor: typeof MaterializedViewExecutor | null = null
  let staleHelpers: typeof MVStale | null = null

  let deleted = 0
  const residueUndecodable: string[] = []
  const residueDeclined: string[] = []

  for (const reg of mvs) {
    const mode = reg.spec.refresh

    if (mode === 'eager') {
      if (executor === null) {
        ;({ MaterializedViewExecutor: executor } = await import('./executor.js'))
      }
      const rr = await executor.refresh(reg, {
        getCollection: (name) => source.getCollection(name),
        getActiveTxContext: () => source.getActiveTxContext(),
        getQueryContext: () => source.getQueryContext(),
        dispatchCtx: dispatchCtx({ collection: collectionName, id }),
      })
      // #782/#785 — the eager leg reports both residue channels.
      deleted += rr.deleted
      residueUndecodable.push(...rr.residueUndecodable)
      residueDeclined.push(...rr.residueDeclined)
      continue
    }

    if (staleHelpers === null) staleHelpers = await import('./stale.js')
    const inv = await staleHelpers.invalidateMVAtRest(source, reg, mode)
    deleted += inv.deleted
    residueUndecodable.push(...inv.residueUndecodable.map((rid) => `${reg.outputCollection}:${rid}`))
    residueDeclined.push(...inv.residueDeclined.map((rid) => `${reg.outputCollection}:${rid}`))
  }

  return { deleted, residueUndecodable, residueDeclined }
}
