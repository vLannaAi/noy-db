import type { Collection } from '../../kernel/collection.js'
import type { TxContext } from '../../with-commit/tx/transaction.js'
import type { PutDerivedOutputCtx } from '../../kernel/via/dispatch.js'
import type { MaterializedViewRegistry, RegisteredMV } from './registry.js'
// Type-only — runtime class loaded via dynamic import in
// `resolveStaleMVOnRead` only when a stale flag actually fires.
// Keeps the executor chunk out of the floor bundle (mirrors v1 floor-bundle isolation).
import type { MaterializedViewExecutor as MVExecutorType } from './executor.js'
import type { MVQueryContext } from './types.js'
import type { NoydbStore } from '../../kernel/types.js'
import { RecordCodec } from '../../kernel/enclave/index.js'

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
 * Reserved collection holding CONTENT-FREE lazy-stale markers (record id =
 * MV name, plaintext `_iv: ''` envelope, no payload) — mirrors the
 * `_meta`/schema-fence marker envelope shape. Written only from the
 * delete/forget/elevate dispatcher (#736); ordinary source writes stay
 * in-memory-only (the cheap path). Read via the adapter directly, never
 * through `vault.collection()` — same reserved-collection convention as
 * `_subject_index`/`_meta`.
 */
export const MV_STALE_COLLECTION = '_mv_stale'

/** Once-per-registry hydrate guard for `resolveStaleMVOnRead`'s persisted-marker fold-in. */
const _hydratedByRegistry = new WeakMap<MaterializedViewRegistry, true>()

/** The adapter + vault name backing any collection in this vault (all collections share both). */
function storeOf(accessor: MVStaleAccessor, collectionName: string): { adapter: NoydbStore; vault: string } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c = accessor.getCollection(collectionName) as any
  return { adapter: c.adapter as NoydbStore, vault: c.vault as string }
}

async function writeMVStaleMarker(adapter: NoydbStore, vault: string, mvName: string): Promise<void> {
  // Content-free — the marker's only payload is its key (the MV name).
  const env = RecordCodec.buildPlaintextEnvelope({ version: 1, data: '{}' })
  await adapter.put(vault, MV_STALE_COLLECTION, mvName, env)
}

async function deleteMVStaleMarker(adapter: NoydbStore, vault: string, mvName: string): Promise<void> {
  await adapter.delete(vault, MV_STALE_COLLECTION, mvName)
}

/**
 * On first `resolveStaleMVOnRead` call for a (cold-reopened) registry, fold every
 * persisted `_mv_stale` marker into the in-memory pending set — otherwise a cold
 * session's empty `WeakMap` entry reads as "fresh" and serves the emptied output
 * collection forever.
 */
async function hydratePersistedStaleMarkers(accessor: MVStaleAccessor, registry: MaterializedViewRegistry): Promise<void> {
  const mvs = registry.all()
  if (mvs.length === 0) return
  const { adapter, vault } = storeOf(accessor, mvs[0]!.outputCollection)
  // No try/catch: a genuine store failure here must surface, not be read as
  // "nothing pending" — silently treating it as fresh is the exact leak class
  // this module closes (mirrors `subject-index.ts`'s bare `adapter.list` reads).
  for (const name of await adapter.list(vault, MV_STALE_COLLECTION)) markMVStale(registry, name)
}

/**
 * Invalidate an MV from the delete/forget/elevate dispatcher (#736) — the ordinary
 * source-write path (`dispatchMaterializedViews`) never calls this. Deletes EVERY
 * persisted row in `reg.outputCollection` via `_internalDelete` (the at-rest law: a
 * stale mark alone leaves the elevated/forgotten source's plaintext sitting in the
 * output row) using the adapter directly so the read-path's `resolveStaleMVOnRead`
 * isn't triggered mid-invalidation. `mode: 'lazy'` also persists the stale mark so a
 * cold session recomputes on next read; `'manual'` gets the purge only — the MV
 * serves empty until an explicit `vault.refreshView()` (erasure wins). If another
 * registered MV shares this output collection, it just lost its rows too without a
 * write of its own — every OTHER `lazy` sibling on the same output is re-marked
 * stale (persisted) as well.
 *
 * @internal
 */
export async function invalidateMVAtRest(
  accessor: MVStaleAccessor,
  reg: RegisteredMV,
  mode: 'lazy' | 'manual',
): Promise<void> {
  const outputColl = accessor.getCollection(reg.outputCollection)
  const txCtx = accessor.getActiveTxContext()
  const { adapter, vault } = storeOf(accessor, reg.outputCollection)
  for (const id of await adapter.list(vault, reg.outputCollection)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (outputColl as any)._internalDelete(id, txCtx)
  }

  const registry = accessor.registry()
  const toMark = new Set<string>(mode === 'lazy' ? [reg.spec.name] : [])
  for (const other of registry.all()) {
    if (other.spec.name === reg.spec.name) continue
    if (other.outputCollection !== reg.outputCollection) continue
    if (other.spec.refresh !== 'lazy') continue
    toMark.add(other.spec.name)
  }
  for (const name of toMark) {
    markMVStale(registry, name)
    await writeMVStaleMarker(adapter, vault, name)
  }
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
  // Cold session: the in-memory WeakMap has no entry for this (freshly
  // constructed) registry yet — fold any persisted `_mv_stale` markers in
  // before reading the pending set, once per registry (#736).
  if (!_hydratedByRegistry.has(registry)) {
    _hydratedByRegistry.set(registry, true)
    await hydratePersistedStaleMarkers(accessor, registry)
  }
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
  const { adapter, vault } = storeOf(accessor, outputCollection)
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
    // A cold-hydrated stale flag (unlike an in-session one) can fire with
    // NONE of the MV's dependency collections touched yet this session —
    // the sync `Query.toArray()` `spec.query()` runs reads straight off
    // `Collection`'s in-memory cache, populated only by a prior async
    // touch (`ensureHydrated()`, called from `get`/`list`/`put`, never
    // from `query()` itself). Warm every dependency first so the recompute
    // sees the live persisted state instead of an empty cache (#736).
    for (const dep of reg.dependencies) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (accessor.getCollection(dep) as any).ensureHydrated()
    }
    await executor.refresh(reg, {
      getCollection: (n) => accessor.getCollection(n),
      getActiveTxContext: () => accessor.getActiveTxContext(),
      getQueryContext: () => accessor.getQueryContext(),
      ...(dispatchCtx !== undefined ? { dispatchCtx } : {}),
    })
    pending.delete(name)
    await deleteMVStaleMarker(adapter, vault, name)
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

/**
 * `clearMVStale` plus the persisted marker (#736) — `Vault.refreshView()`'s
 * completion path. A lingering persisted marker after a manual refresh would
 * make the NEXT cold session recompute redundantly.
 *
 * @internal
 */
export async function clearMVStaleFully(
  adapter: NoydbStore,
  vault: string,
  registry: MaterializedViewRegistry,
  mvName: string,
): Promise<void> {
  clearMVStale(registry, mvName)
  await deleteMVStaleMarker(adapter, vault, mvName)
}
