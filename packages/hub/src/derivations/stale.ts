import type { Collection } from '../collection.js'
import type { ReadOnlyVaultFacade } from '../guards/types.js'
import type { DerivationRegistry } from './registry.js'
// Type-only — runtime class loaded via dynamic import in
// `resolveStaleOnRead` only when a stale flag actually fires. Keeps
// the executor chunk out of the floor bundle (#130).
import type { DerivationExecutor as DerivationExecutorType } from './executor.js'
import type { DerivationStrategy } from './types.js'

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
   * resolve-on-read path. Same instance/shape as the eager path uses
   * (#147).
   */
  getReadOnlyFacade(): ReadOnlyVaultFacade
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
const _staleByRegistry = new WeakMap<DerivationRegistry, Map<string, Set<DerivationStrategy<any, any>>>>()

const keyFor = (source: string, sourceId: string): string => `${source}/${sourceId}`

/** Mark every output of (strategy, sourceId) as stale. */
export async function markStale(
  registry: DerivationRegistry,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  strategy: DerivationStrategy<any, any>,
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
  // the executor chunk. See #130.
  let DerivationExecutor: typeof DerivationExecutorType | null = null

  for (const { spec, strategyHash } of producers) {
    const k = keyFor(spec.source, id)
    const pending = map.get(k)
    if (!pending || !pending.has(spec)) continue

    // Read the source record from the source collection and re-derive.
    // We use the same getCollection accessor that eager dispatch uses
    // — it returns the live `Collection<any>` instance with full
    // crypto / keyring wiring.
    const sourceColl = accessor.getCollection(spec.source)
    const source = await sourceColl.get(id)
    if (!source) {
      pending.delete(spec)
      continue
    }
    const sourceWithId = { ...(source as Record<string, unknown>), id } as Record<string, unknown> & { id: string }
    // sourceVersion: not tracked in v1 stale map; pass 0 — matches the
    // forthcoming v0 semantics, `_derivedFrom.sourceVersion` is
    // informational, not load-bearing for correctness.
    if (DerivationExecutor === null) {
      ({ DerivationExecutor } = (await import('./executor.js')) as { DerivationExecutor: typeof DerivationExecutorType })
    }
    const ctx = { vault: accessor.getReadOnlyFacade() }
    const result = await DerivationExecutor.run(spec, sourceWithId, 0, strategyHash, ctx)
    for (const key of Object.keys(spec.outputs)) {
      const out = result.outputs[key]
      if (!out) continue
      if (!out.ok) {
        const err = out.error ?? new Error(`derivation output "${key}" failed`)
        if (spec.strict) {
          // Leave the stale flag set so a future read retries.
          throw err
        }
        console.warn(
          `[derivation] lazy output "${key}" for source "${spec.source}" id="${id}" failed:`,
          err,
        )
        continue
      }
      const outSpec = spec.outputs[key]
      if (!outSpec) continue
      const outputColl = accessor.getCollection(outSpec.collection)
      if (out.skipped === true) {
        // #144: optional output skipped on lazy resolve — delete any
        // prior emission so the read returns null (matches eager-path
        // tombstone semantics).
        await outputColl.delete(id)
        continue
      }
      await outputColl.put(id, out.value)
    }
    pending.delete(spec)
  }
}
