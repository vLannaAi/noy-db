import type { Collection } from '../../kernel/collection.js'
import type { DerivationExecutor as DerivationExecutorType } from './executor.js'
import type { ReadOnlyVaultFacade } from '../../with-audit/guards/types.js'
import type { TxContext } from '../../with-commit/tx/transaction.js'
import type { DerivationRegistry } from './registry.js'
// Type-only — runtime class loaded via dynamic import in
// `resolveStaleOnRead` only when a stale flag actually fires. Keeps
// the executor chunk out of the floor bundle.
import type { DerivationSpec } from './types.js'

import { lazy } from '../../kernel/lazy.js'

/** #846c — one memoized binding instead of a cast at the call site. */
const loadDerivationExecutor = lazy(() => import('./executor.js'))

/**
 * Accessor shape passed through from the owning Vault. Provides the
 * registry (used to look up strategies and as the WeakMap key) and a
 * resolver from collection name to the live `Collection` instance.
 * Same shape as `Collection.derivationSource` so callers can pass it
 * through directly.
 */
export interface DerivationStaleAccessor {
  registry(): DerivationRegistry
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getCollection(name: string): Collection<any>
  /**
   * Read-only vault facade handed to `derive(source, ctx)` on the lazy
   * resolve-on-read path. Same instance/shape as the eager path uses.
   */
  getReadOnlyFacade(): ReadOnlyVaultFacade
  /**
   * Active multi-record TxContext or `null`. The lazy resolve-on-read
   * path uses this to register tombstone deletes on `_executed` so a
   * later rollback restores the prior emission. Mirrors the eager
   * path's rollback tracking; the lazy `put` was historically
   * unregistered but the tombstone delete (a NEW write path)
   * matches the eager registration for symmetry.
   */
  getActiveTxContext(): TxContext | null
}

/**
 * In-memory stale map keyed by `DerivationRegistry` instance (stable
 * per vault). Maps `${source}/${sourceId}` → set of pending strategies.
 *
 * Persistence across vault close is NOT implemented in v1 (concern
 * flagged in the dim14 spec). On vault re-open, derived records'
 * `_derivedFrom.strategyHash` will still match the registered
 * strategies' hash, so an unset stale flag is interpreted as "fresh."
 * `vault.deriveAll()` (Task D13) is the explicit recompute escape
 * hatch.
 *
 * @internal
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _staleByRegistry = new WeakMap<DerivationRegistry, Map<string, Set<DerivationSpec<any, any>>>>()

const keyFor = (source: string, sourceId: string): string => `${source}/${sourceId}`

/** Mark every output of (strategy, sourceId) as stale. */
export async function markStale(
  registry: DerivationRegistry,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  strategy: DerivationSpec<any, any>,
  sourceId: string,
): Promise<void> {
  let map = _staleByRegistry.get(registry)
  if (!map) {
    map = new Map()
    _staleByRegistry.set(registry, map)
  }
  const k = keyFor(strategy.source, sourceId)
  let set = map.get(k)
  if (!set) {
    set = new Set()
    map.set(k, set)
  }
  set.add(strategy)
}

/**
 * Called from `Collection.get` on lazy-mode output collections. If the
 * id has a pending stale flag for any strategy producing this output
 * collection, re-derive before returning the record. No-op when there
 * is no pending work — keeps the read fast path negligible.
 */
export async function resolveStaleOnRead(
  accessor: DerivationStaleAccessor,
  outputCollection: string,
  id: string,
): Promise<void> {
  const registry = accessor.registry()
  const producers = registry.strategiesProducingOutput(outputCollection)
  if (producers.length === 0) return

  const map = _staleByRegistry.get(registry)
  if (!map) return

  // Dynamic-import the executor only when at least one stale flag
  // actually fires. Vaults with no derivation strategies never call
  // this function (gated on `derivationSource` in `Collection.get`);
  // vaults with strategies but no pending stale ids reach the
  // `pending.has(spec)` short-circuit below without ever touching
  // the executor chunk.
  let DerivationExecutor: typeof DerivationExecutorType | null = null

  for (const { spec, strategyHash } of producers) {
    const k = keyFor(spec.source, id)
    const pending = map.get(k)
    if (!pending || !pending.has(spec)) continue

    // Consume the pending flag BEFORE the source read, not after: for a
    // self-write output (output.collection === spec.source, e.g. a
    // reverse-denorm patch), `sourceColl.get(id)` below re-enters this
    // same collection/id and would otherwise still see this spec pending
    // — infinite recursion. Restored on a strict failure below so a
    // future read still retries.
    pending.delete(spec)

    // Read the source record from the source collection and re-derive.
    // We use the same getCollection accessor that eager dispatch uses
    // — it returns the live `Collection<any>` instance with full
    // crypto / keyring wiring.
    const sourceColl = accessor.getCollection(spec.source)
    const source = await sourceColl.get(id)
    if (!source) {
      continue
    }
    const sourceWithId = { ...(source as Record<string, unknown>), id } as Record<string, unknown> & { id: string }
    // sourceVersion: not tracked in v1 stale map; pass 0 — matches the
    // forthcoming v0 semantics, `_derivedFrom.sourceVersion` is
    // informational, not load-bearing for correctness.
    DerivationExecutor ??= (await loadDerivationExecutor()).DerivationExecutor
    const ctx = { vault: accessor.getReadOnlyFacade() }
    const result = await DerivationExecutor.run(spec, sourceWithId, 0, strategyHash, ctx)
    for (const key of Object.keys(spec.outputs)) {
      const out = result.outputs[key]
      if (!out) continue
      if (out.kind === 'failed') {
        const err = out.error
        if (spec.strict) {
          // Restore the stale flag (consumed above) so a future read retries.
          pending.add(spec)
          throw err
        }
        console.warn(
          `[derivation] lazy output "${key}" for source "${spec.source}" id="${id}" failed:`,
          err,
        )
        continue
      }
      if (out.kind === 'array') {
        // Defensive — array-shape requires `lifecycle: 'eager'`
        // (validated at withDerivation registration).
        // Reaching the lazy-resolve path for array-shape would mean
        // a registration check was bypassed. Log and skip.
        console.warn(
          `[derivation] unexpected array-shape output "${key}" in lazy resolve path; `
          + 'array-shape derivations require lifecycle: "eager".',
        )
        continue
      }
      const outSpec = spec.outputs[key]
      if (!outSpec) continue
      const outputColl = accessor.getCollection(outSpec.collection)
      if (out.skipped === true) {
        // Optional output skipped on lazy resolve — delete any
        // prior emission so the read returns null (matches eager-path
        // tombstone semantics). Routed through `_internalDelete` so a
        // user-registered `onDelete` on the output collection
        // does NOT fire. The active TxContext (if any) is forwarded:
        // `resolveStaleOnRead` is reachable from `Collection.get()`
        // which can be called from inside a transaction, so the
        // tombstone must be observable to `revertExecuted` on
        // rollback.
        await outputColl._internalDelete(id, accessor.getActiveTxContext())
        continue
      }
      await outputColl.put(id, out.value)
    }
    pending.delete(spec)
  }
}
