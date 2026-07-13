import type { Collection } from '../../kernel/collection.js'
import type { TxContext } from '../../with-commit/tx/transaction.js'
import type { PutDerivedOutputCtx } from '../../kernel/via/dispatch.js'
import type { MaterializedViewRegistry } from './registry.js'
// Type-only — runtime class loaded via dynamic import in
// `resolveStaleMVOnRead` only when a stale flag actually fires.
// Keeps the executor chunk out of the floor bundle (mirrors v1 floor-bundle isolation).
import type { MaterializedViewExecutor as MVExecutorType } from './executor.js'
import type { MVQueryContext } from './types.js'

/**
 * Accessor shape passed in from the owning Vault. Provides the
 * registry (used as a stable WeakMap key + to look up MVs by output
 * collection) and the runtime context the lazy refresh needs.
 * Mirrors v1's `DerivationStaleAccessor`.
 */
export interface MVStaleAccessor {
  registry(): MaterializedViewRegistry
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getCollection(name: string): Collection<any>
  getActiveTxContext(): TxContext | null
  getQueryContext(): MVQueryContext
}

/**
 * In-memory stale map keyed by `MaterializedViewRegistry` instance
 * (stable per vault). Each registry maps to a set of MV names that
 * have at least one pending source-change requiring a re-materialize.
 *
 * Persistence across vault close is NOT implemented in this iteration
 * (concern flagged in the v2 spec, mirrors v1 derivation behavior).
 * On vault re-open, the unset stale flag is interpreted as "fresh" —
 * `vault.refreshView(name)` is the explicit recompute escape hatch.
 *
 * @internal
 */
const _staleByRegistry = new WeakMap<MaterializedViewRegistry, Set<string>>()

/**
 * Mark an MV as stale. Called from `Collection.dispatchMaterializedViews`
 * when a source-write fires for a `refresh: 'lazy'` MV.
 *
 * @internal
 */
export function markMVStale(registry: MaterializedViewRegistry, mvName: string): void {
  let set = _staleByRegistry.get(registry)
  if (!set) {
    set = new Set()
    _staleByRegistry.set(registry, set)
  }
  set.add(mvName)
}

/**
 * Test-only: check whether a given MV name is currently flagged stale
 * against a registry. Exported so the regression suite can pin the
 * stale-bit lifecycle without touching the internal `WeakMap`.
 *
 * @internal
 */
export function isMVStale(registry: MaterializedViewRegistry, mvName: string): boolean {
  return _staleByRegistry.get(registry)?.has(mvName) ?? false
}

/**
 * Called from `Collection.get` (and any reader that materializes the
 * MV's output collection). If any MV producing `outputCollection` is
 * flagged stale, runs the executor against the live source state
 * before returning. No-op when there is no pending work — keeps the
 * read fast path negligible.
 *
 * `dispatchCtx` (#641): threaded from the calling `Collection`'s
 * `#dispatchCtx({ collection: outputCollection, id: 'resolve-on-read' })` — a read has no
 * real "reacting write" record, so `'resolve-on-read'` is the sentinel id, mirroring
 * `Vault.refreshView()`'s `'refreshView'` sentinel for the same reason. Passed straight
 * through to the executor so a stale row whose output lands in a closed period follows the
 * frozen-output rule (skip + `derivation:skipped-frozen`, #637) instead of throwing
 * `PeriodClosedError` out of a read.
 *
 * Dynamic-imports the executor only when a stale flag actually fires
 * (the floor-bundle isolation pattern v1 derivations established in
 * floor-bundle isolation pattern).
 */
export async function resolveStaleMVOnRead(
  accessor: MVStaleAccessor,
  outputCollection: string,
  dispatchCtx?: PutDerivedOutputCtx,
): Promise<void> {
  const registry = accessor.registry()
  const pending = _staleByRegistry.get(registry)
  if (!pending || pending.size === 0) return

  // Find every MV that writes to this output collection AND is
  // currently flagged stale. Multiple MVs CAN share an output
  // collection in theory; in practice the registration validation +
  // cycle detection make this unusual.
  const candidates: string[] = []
  for (const mv of registry.all()) {
    if (mv.outputCollection !== outputCollection) continue
    if (!pending.has(mv.spec.name)) continue
    candidates.push(mv.spec.name)
  }
  if (candidates.length === 0) return

  let executor: typeof MVExecutorType | null = null
  for (const name of candidates) {
    const reg = registry.byName(name)
    if (!reg) {
      pending.delete(name)
      continue
    }
    if (executor === null) {
      ({ MaterializedViewExecutor: executor } = (await import('./executor.js')) as {
        MaterializedViewExecutor: typeof MVExecutorType
      })
    }
    await executor.refresh(reg, {
      getCollection: (n) => accessor.getCollection(n),
      getActiveTxContext: () => accessor.getActiveTxContext(),
      getQueryContext: () => accessor.getQueryContext(),
      ...(dispatchCtx !== undefined ? { dispatchCtx } : {}),
    })
    pending.delete(name)
  }
}

/**
 * Drop every stale flag for a registry. Used after a manual
 * `vault.refreshView(name)` runs the executor explicitly — the
 * post-refresh state matches the registered strategies, so
 * lingering stale bits would force a redundant refresh on the next
 * read.
 *
 * @internal
 */
export function clearMVStale(registry: MaterializedViewRegistry, mvName: string): void {
  _staleByRegistry.get(registry)?.delete(mvName)
}
