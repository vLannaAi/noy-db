import { SatelliteConfigError } from '../../kernel/errors.js'
import { isBaseLive, liveBaseIdSet } from './existence.js'
import type { SatelliteSpec } from './types.js'
import type { SatelliteRegistry } from './registry.js'

/**
 * Escape hatch: `proxied[RAW_TARGET]` returns the unwrapped collection —
 * no existence check, no pair lock. Needed by callers (e.g. a later
 * fan-out task's joined-handle writes) that already hold the pair mutex
 * themselves; going back through the proxy's `put` would re-enter
 * `registry.withPairLock` on the same base and deadlock (the mutex is not
 * reentrant — see `registry.ts:withPairLock`).
 */
export const RAW_TARGET: unique symbol = Symbol('noydb.satellite.rawTarget')

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
    throw new Error(
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
      const records = await target.list()
      // `list()` returns bare records (no `id` field unless the caller put
      // one) — correlate by position against the cache's own key order
      // instead. Read AFTER `target.list()` resolves, so a not-yet-hydrated
      // cache on the first read doesn't race a still-empty key snapshot.
      const ids = [...(target.cache as Map<string, unknown>).keys()]
      return records.filter((_: unknown, i: number) => { const id = ids[i]; return id !== undefined && live.has(id) })
    },
    query: queryNotExistenceFiltered,
    async put(id: string, record: unknown) {
      registry.assertNotPoisoned(spec.satellite)
      return registry.withPairLock(spec.base, async () => {
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
