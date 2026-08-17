import type { Collection } from '../../kernel/collection.js'
import type { MaterializedViewExecutor as MVExecutorType } from './executor.js'
import type { TxContext } from '../../with-commit/tx/transaction.js'
import type { PutDerivedOutputCtx } from '../../kernel/via/dispatch.js'
import type { MaterializedViewRegistry, RegisteredMV } from './registry.js'
// Type-only — runtime class loaded via dynamic import in
// `resolveStaleMVOnRead` only when a stale flag actually fires.
// Keeps the executor chunk out of the floor bundle (mirrors v1 floor-bundle isolation).
import type { MVQueryContext } from './types.js'
import type { NoydbStore } from '../../kernel/types.js'
import { RecordCodec } from '../../kernel/enclave/index.js'

import { lazy } from '../../kernel/lazy.js'

/** #846c — one memoized binding instead of a cast at the call site. */
const loadMVExecutor = lazy(() => import('./executor.js'))

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

/**
 * Once-per-registry hydrate guard for `resolveStaleMVOnRead`'s persisted-marker fold-in.
 * Stores the in-flight/settled PROMISE (not a boolean) — a concurrent cold first read that
 * arrives while the hydrate is still awaiting `adapter.list` must await the SAME promise
 * rather than observing "already hydrating" and reading an empty pending set (#736
 * whole-branch review).
 */
const _hydratedByRegistry = new WeakMap<MaterializedViewRegistry, Promise<void>>()

/** The adapter + vault name backing any collection in this vault (all collections share both). */
function storeOf(accessor: MVStaleAccessor, collectionName: string): { adapter: NoydbStore; vault: string } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c = accessor.getCollection(collectionName) as any
  return { adapter: c.adapter as NoydbStore, vault: c.vault as string }
}

async function writeMVStaleMarker(adapter: NoydbStore, vault: string, mvName: string): Promise<void> {
  // Content-free — the marker's only payload is its key (the MV name).
  const env = RecordCodec.buildPlaintextEnvelope({ collection: MV_STALE_COLLECTION, id: mvName, version: 1 }, { data: '{}' })
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
 * serves empty until an explicit `vault.refreshView()` (erasure wins). Deletion is
 * stamp-scoped (`_materializedFrom.mvName === reg.spec.name` — see the loop below),
 * so another registered MV sharing this output collection keeps its own rows intact:
 * no cross-MV re-marking is needed here, only `reg` itself is marked stale.
 *
 * Returns the count of rows actually `_internalDelete`d (#761 item 1) — folded by the
 * caller into `dispatchMaterializedViewsOnDelete`'s `deleted` so `ForgetResult.derivedRecordsErased`
 * counts lazy/manual purges too, not just the eager executor's tombstone leg — plus
 * `residueUndecodable`, the bare ids whose ownership stamp could NOT be decoded (#776): a
 * candidate row that fails to decode under the collection's default DEK (e.g. elevated above
 * tier 0 on a tiered output collection) has UNKNOWN ownership — it might be this MV's own
 * output, or (same-collection shape) a plain user record — so it is never erased, but it must
 * be SURFACED rather than silently skipped (the #724 posture), since it may still hold the
 * forgotten/pre-elevation contribution, decryptable by tier-holders — and `residueDeclined`
 * (#785), the bare ids that DID decode and stamp-match but whose `_internalDelete` declined
 * (ownership CONFIRMED, erasure declined).
 *
 * @internal
 */
export async function invalidateMVAtRest(
  accessor: MVStaleAccessor,
  reg: RegisteredMV,
  mode: 'lazy' | 'manual',
): Promise<{ deleted: number; residueUndecodable: string[]; residueDeclined: string[] }> {
  const outputColl = accessor.getCollection(reg.outputCollection)
  const txCtx = accessor.getActiveTxContext()
  const { adapter, vault } = storeOf(accessor, reg.outputCollection)
  let deleted = 0
  const residueUndecodable: string[] = []
  const residueDeclined: string[] = []
  for (const id of await adapter.list(vault, reg.outputCollection)) {
    // A same-collection partition MV (`output: { collection: <source>, partition }`,
    // the DERIV-PP30-001 shape) writes INTO its own source collection — `adapter.list`
    // over `reg.outputCollection` then also returns untouched user source records.
    // Decode each candidate row (the invalidation path is rare; this cost is fine
    // here) and only erase rows THIS MV stamped via `_materializedFrom.mvName` —
    // an unstamped row, or one stamped by a different MV, is never this MV's to
    // delete (#736 whole-branch review, Critical).
    const envelope = await adapter.get(vault, reg.outputCollection, id)
    if (envelope === null) continue
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const decoded = await (outputColl as any)._decodeEnvelope(envelope, id)
    if (decoded === null) { residueUndecodable.push(id); continue } // #776 — ownership unknown, surfaced not skipped
    const stampedBy = (decoded as Record<string, unknown>)._materializedFrom as { mvName?: string } | undefined
    if (stampedBy?.mvName !== reg.spec.name) continue
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (await (outputColl as any)._internalDelete(id, txCtx)) {
      deleted++
    } else {
      // #782 part b — decoded AND stamp-owned, but erasure declined (#718 tier-elevation
      // gate). Ownership IS confirmed — a real silent survival, not a legit stamp-mismatch
      // skip. Surface it too, in its own channel (#785 — distinct from the decode-null case).
      residueDeclined.push(id)
    }
  }

  // `mode: 'manual'` gets the purge only (erasure wins, no auto-recompute promise);
  // `'lazy'` also marks + persists ITS OWN stale bit for cold-session recompute. No
  // sibling MV on the same output collection is touched here — the stamp-scoped
  // deletion above never erased sibling rows in the first place (#736 re-review).
  if (mode === 'lazy') {
    const registry = accessor.registry()
    markMVStale(registry, reg.spec.name)
    await writeMVStaleMarker(adapter, vault, reg.spec.name)
  }
  return { deleted, residueUndecodable, residueDeclined }
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
  // before reading the pending set, once per registry (#736). Memoize the
  // PROMISE, not a boolean: a concurrent first read arriving while the
  // hydrate is still awaiting `adapter.list` must await the SAME promise —
  // otherwise it observes "already hydrating", skips straight to an empty
  // pending set, and serves the purged/stale view as fresh (#736
  // whole-branch review, hydrate-once race). On rejection, evict the entry
  // BEFORE rethrowing — a cached rejected promise would otherwise poison the
  // MV read surface for the rest of the session (every later read re-awaits
  // the same rejection instead of retrying the store call) (#736 re-review).
  let hydrate = _hydratedByRegistry.get(registry)
  if (!hydrate) {
    hydrate = hydratePersistedStaleMarkers(accessor, registry).catch((err: unknown) => {
      _hydratedByRegistry.delete(registry)
      throw err
    })
    _hydratedByRegistry.set(registry, hydrate)
  }
  await hydrate
  const pending = _staleByRegistry.get(registry)
  if (!pending || pending.size === 0) return

  const { adapter, vault } = storeOf(accessor, outputCollection)

  // Clean up persisted markers for MV names no longer registered (renamed or
  // removed since the marker was written). Without this sweep an orphaned name
  // can never become a `candidate` below — `candidates` is built from
  // `registry.all()`, which no longer lists it — so both the in-memory pending
  // entry and the persisted `_mv_stale` row would linger forever, re-hydrating
  // on every cold session (#736 whole-branch review).
  for (const name of pending) {
    if (registry.byName(name)) continue
    pending.delete(name)
    await deleteMVStaleMarker(adapter, vault, name)
  }
  if (pending.size === 0) return

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
      // Unreachable in practice — `candidates` is drawn from `registry.all()`,
      // and the orphan sweep above already cleared any name absent from it.
      // Kept as a defensive fallback; also clears the persisted marker so it
      // can't linger if this ever does fire.
      pending.delete(name)
      await deleteMVStaleMarker(adapter, vault, name)
      continue
    }
    executor ??= (await loadMVExecutor()).MaterializedViewExecutor
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
    // Runs even when no marker was ever persisted for this name (an in-session-only
    // stale bit — e.g. the cheap ordinary-write path never writes one, see the
    // "cheap-path guarantee" test). `adapter.delete` on an absent key is a harmless
    // void — keeping this unconditional avoids branching on marker origin here.
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
