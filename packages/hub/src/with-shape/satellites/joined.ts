/**
 * JoinedHandle — the full-record access point for a base↔satellite pair
 * declared with `joined:` (#591, Task 7). Deliberately narrow (spec § The
 * model): get/put/delete/list/describe only, never a `Collection<T>` cast —
 * reactive members (`subscribe`, `live`, …) are simply absent from the
 * returned object, not stubbed.
 *
 * Reads compose under existence authority (spec § Convergence & existence
 * authority, rule 1): the base row alone decides whether a record exists at
 * all — `get`/`list` check it via an undecrypted adapter read
 * (`isBaseLive`/`liveBaseIdSet`) before merging in the satellite side, so a
 * base-absent-or-tombstoned id reads as fully gone even if a satellite
 * envelope still lingers. Writes/deletes delegate wholesale to the Task 6
 * fan-out (`joinedPut`/`pairDelete`), which already holds the pair lock and
 * reverts on partial failure — this module adds no write logic of its own.
 */
import type { JoinedHandle, SatelliteSpec } from './types.js'
import type { FanoutDeps } from './fanout.js'
import { joinedPut, pairDelete } from './fanout.js'
import { isBaseLive, liveBaseIdSet } from './existence.js'
import { listWithIds } from './proxy.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CollectionHandle = any

export function makeJoinedHandle<T extends Record<string, unknown>>(spec: SatelliteSpec, deps: FanoutDeps): JoinedHandle<T> {
  const base = (): CollectionHandle => deps.base()
  const satellite = (): CollectionHandle => deps.satellite()
  const adapter = deps.adapter // `FanoutDeps.adapter` is the full `NoydbStore` (#591 review M2)

  // Every declared satellite field defaults to null — a record with no
  // satellite row yet (or a not-yet-populated field) reads as null rather
  // than simply missing.
  const nullSat = (): Record<string, null> => Object.fromEntries(spec.fields.map(f => [f, null]))
  // Base spread last: R-S1 guarantees satellite `fields` never overlap the
  // base schema (postRegister's cross-check), so this is inert on satellite
  // keys — base wins ties defensively only.
  const merge = (b: Record<string, unknown>, s: Record<string, unknown> | null): T =>
    ({ ...nullSat(), ...(s ?? {}), ...b }) as T

  return {
    async get(id) {
      if (!(await isBaseLive(adapter, deps.vaultName, spec.base, id))) return null
      const b = await base().get(id)
      if (b === null) return null
      const s = await satellite().get(id) // proxied handle: existence-safe, lock-free
      return merge(b, s)
    },
    async put(id, record) {
      await joinedPut(deps, id, record)
    },
    async delete(id) {
      await pairDelete(deps, id)
    },
    async list() {
      const live = await liveBaseIdSet(adapter, deps.vaultName, spec.base)
      const pairs = await listWithIds(base())
      const out: T[] = []
      for (const [id, b] of pairs) {
        if (!live.has(id)) continue
        out.push(merge(b as Record<string, unknown>, await satellite().get(id)))
      }
      return out
    },
    async describe() {
      const [b, s] = await Promise.all([base().describe({}), satellite().describe({})])
      return {
        collection: spec.joined ?? `${spec.base}+${spec.satellite}`,
        fields: [...b.fields, ...s.fields],
        meta: { label: spec.joined ?? spec.base },
      }
    },
  }
}
