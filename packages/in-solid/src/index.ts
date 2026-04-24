/**
 * **@noy-db/in-solid** — SolidJS signal primitives for noy-db.
 *
 *   - {@link createCollectionSignal} — reactive record list
 *   - {@link createQuerySignal}      — reactive query result
 *   - {@link createSyncSignal}       — Noydb-level change feed
 *
 * Uses `createSignal` + `createRenderEffect` + `onCleanup` from `solid-js`.
 * No DOM dependency — works in SSR and test environments via `createRoot`.
 *
 * @packageDocumentation
 */

import { createSignal, createRenderEffect, onCleanup } from 'solid-js'
import type { Accessor } from 'solid-js'
import type { Noydb, Vault, ChangeEvent, Query } from '@noy-db/hub'

export function createCollectionSignal<T>(
  vault: Vault,
  collectionName: string,
): [records: Accessor<T[]>, loading: Accessor<boolean>, error: Accessor<Error | null>] {
  const [records, setRecords] = createSignal<T[]>([])
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal<Error | null>(null)

  // createRenderEffect runs synchronously (no scheduler deferral), ensuring
  // the subscription is registered before the first async flush can fire events.
  createRenderEffect(() => {
    const coll = vault.collection<T>(collectionName)

    async function refresh(): Promise<void> {
      try {
        const list = await coll.list()
        setRecords(list)
        setError(null)
      } catch (err) {
        setError(err as Error)
      } finally {
        setLoading(false)
      }
    }

    void refresh()
    const unsub = coll.subscribe(() => { void refresh() })
    onCleanup(unsub)
  })

  return [records, loading, error]
}

export function createQuerySignal<T, R>(
  vault: Vault,
  collectionName: string,
  builder: (q: Query<T>) => R | Promise<R>,
): [data: Accessor<R | null>, loading: Accessor<boolean>, error: Accessor<Error | null>] {
  const [data, setData] = createSignal<R | null>(null)
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal<Error | null>(null)

  // createRenderEffect runs synchronously (no scheduler deferral), ensuring
  // the subscription is registered before the first async flush can fire events.
  createRenderEffect(() => {
    const coll = vault.collection<T>(collectionName)

    async function refresh(): Promise<void> {
      try {
        const result = await Promise.resolve(builder(coll.query() as unknown as Query<T>))
        setData(() => result)
        setError(null)
      } catch (err) {
        setError(err as Error)
      } finally {
        setLoading(false)
      }
    }

    void refresh()
    const unsub = coll.subscribe(() => { void refresh() })
    onCleanup(unsub)
  })

  return [data, loading, error]
}

export function createSyncSignal(db: Noydb): Accessor<ChangeEvent | null> {
  const [lastEvent, setLastEvent] = createSignal<ChangeEvent | null>(null)

  // createRenderEffect runs synchronously (no scheduler deferral), ensuring
  // the subscription is registered before the first async flush can fire events.
  createRenderEffect(() => {
    const handler = (event: ChangeEvent): void => { setLastEvent(() => event) }
    db.on('change', handler)
    onCleanup(() => db.off('change', handler))
  })

  return lastEvent
}

export type { Noydb, Vault, ChangeEvent } from '@noy-db/hub'
