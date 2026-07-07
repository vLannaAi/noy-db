import { SatelliteConfigError } from '../../kernel/errors.js'
import { isBaseLive, liveBaseIdSet } from './existence.js'
import { pairDelete } from './fanout.js'
import { RAW_TARGET } from './raw-target.js'
import type { SatelliteSpec } from './types.js'
import type { SatelliteRegistry } from './registry.js'

export { RAW_TARGET }

/**
 * Correlates a collection handle's `list()` output with the ids implied by
 * cache-insertion order — `list()` returns bare records (no `id` field
 * unless the caller put one), so ids are recovered positionally against the
 * cache's own key order instead. Read AFTER `target.list()` resolves, so a
 * not-yet-hydrated cache on the first read doesn't race a still-empty key
 * snapshot. Invariant: `list()` must preserve cache-insertion order
 * (collection.ts `list()` maps `[...cache.values()]`) — positional
 * correlation depends on it. Drops any record whose position has no
 * corresponding cache key (should not happen in practice; defensive only).
 * Exported so `joined.ts` (#591, Task 7) can get the same [id, record]
 * correlation for the base side without duplicating this logic.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function listWithIds(target: any): Promise<Array<[string, unknown]>> {
  const records = await target.list()
  const ids = [...(target.cache as Map<string, unknown>).keys()]
  const out: Array<[string, unknown]> = []
  for (let i = 0; i < records.length; i++) {
    const id = ids[i]
    if (id !== undefined) out.push([id, records[i]])
  }
  return out
}

/**
 * Wraps a satellite's real `Collection<T>` in a `Proxy` that enforces
 * existence authority (spec § Convergence & existence authority, rule 1)
 * and R-S6 on top of it. Every member not explicitly overridden below
 * falls through to the real collection unchanged — this is why the full
 * ~50-member surface (describe, count, putMany, …) survives without
 * hand-stubbing. Caches nothing: every call re-checks live base state.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function makeSatelliteProxy(target: any, spec: SatelliteSpec, registry: SatelliteRegistry): any {
  // Same private internals `Collection.putManyAtomic` reaches for
  // (collection.ts:3223) — TypeScript `private` is compile-time only.
  const adapter = target.adapter
  const vaultName = target.vault

  const queryNotExistenceFiltered = (): never => {
    throw new SatelliteConfigError(
      `satellite "${spec.satellite}": query() is not existence-filtered. Query's terminal ` +
      `methods (toArray/first/count) read the in-memory cache synchronously, while existence ` +
      `authority (§ Convergence & existence authority, rule 1) requires an async, undecrypted ` +
      `check against live base state — the two shapes don't compose without either breaking ` +
      `query()'s synchronous contract or accepting a check that misses out-of-band base ` +
      `mutations. Use list() (or get()) for existence-safe reads on satellite collections.`,
    )
  }

  const overrides: Record<string, unknown> = {
    async get(id: string) {
      if (!(await isBaseLive(adapter, vaultName, spec.base, id))) return null
      return target.get(id)
    },
    async list() {
      const live = await liveBaseIdSet(adapter, vaultName, spec.base)
      const pairs = await listWithIds(target)
      return pairs.filter(([id]) => live.has(id)).map(([, record]) => record)
    },
    query: queryNotExistenceFiltered,
    async put(id: string, record: unknown) {
      return registry.withPairLock(spec.base, async () => {
        // Poison check INSIDE the lock: a put queued behind a section that
        // poisons the pair (e.g. a fan-out's failure path) must observe the
        // poison after acquiring, not race past a pre-lock check.
        registry.assertNotPoisoned(spec.satellite)
        if (!(await isBaseLive(adapter, vaultName, spec.base, id))) {
          throw new SatelliteConfigError(
            `R-S6: satellite "${spec.satellite}" put for "${id}" with no live base record in ` +
            `"${spec.base}" — create the base first (or write through the joined handle).`,
          )
        }
        return target.put(id, record)
      })
    },
  }

  return new Proxy(target, {
    get(t, prop, _recv) {
      if (prop === RAW_TARGET) return t
      if (typeof prop === 'string' && prop in overrides) return overrides[prop]
      const v = Reflect.get(t, prop, t)
      return typeof v === 'function' ? v.bind(t) : v
    },
  })
}

/**
 * Wraps a satellite's BASE collection in a `Proxy` whose only override is
 * `delete` — routed through `pairDelete` (this task) so removing a base
 * record also removes its satellite row, in order, with revert-on-failure.
 * `satellite()` is a thunk, not a resolved handle: at the moment a base is
 * first requested the paired satellite may not exist yet in some call
 * orders, and `fanout.ts` re-resolves + unwraps it lazily per call anyway.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function makeBaseProxy(target: any, spec: SatelliteSpec, registry: SatelliteRegistry, satellite: () => unknown): any {
  const adapter = target.adapter
  const vaultName = target.vault

  const overrides: Record<string, unknown> = {
    async delete(id: string) {
      return pairDelete({ spec, base: () => target, satellite, adapter, vaultName, registry }, id)
    },
  }

  return new Proxy(target, {
    get(t, prop, _recv) {
      if (prop === RAW_TARGET) return t
      if (typeof prop === 'string' && prop in overrides) return overrides[prop]
      const v = Reflect.get(t, prop, t)
      return typeof v === 'function' ? v.bind(t) : v
    },
  })
}
