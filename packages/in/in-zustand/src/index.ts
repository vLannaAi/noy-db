/**
 * **@noy-db/in-zustand** — Zustand adapter for noy-db.
 *
 * Factory that creates a Zustand store backed by a noy-db
 * `Collection<T>`. Reads hydrate from the collection on first access
 * and auto-refresh on every change event; writes go through the
 * collection (and are therefore encrypted + replicated by the sync
 * engine).
 *
 * ```ts
 * import { create } from 'zustand'
 * import { createNoydbStore } from '@noy-db/in-zustand'
 *
 * const useInvoices = create(createNoydbStore(() => db.vault('acme').collection<Invoice>('invoices')))
 * ```
 *
 * The returned state slice shape:
 *
 * ```ts
 * {
 *   records: Record<string, T>
 *   loading: boolean
 *   error: Error | null
 *   put: (id, value) => Promise<void>
 *   remove: (id) => Promise<void>
 *   refresh: () => Promise<void>
 * }
 * ```
 *
 * @packageDocumentation
 */

import type { StateCreator } from 'zustand'
import type { Collection } from '@noy-db/hub'

export interface NoydbZustandSlice<T> {
  /** Current records keyed by id. */
  records: Record<string, T>
  /** True during the initial hydration. */
  loading: boolean
  /** Error from hydration or a mutation. */
  error: Error | null
  /** Put a record — encrypts + writes + fires the auto-refresh. */
  put(id: string, value: T): Promise<void>
  /** Delete a record. */
  remove(id: string): Promise<void>
  /** Re-hydrate from the underlying collection. */
  refresh(): Promise<void>
}

/**
 * Produce a Zustand `StateCreator` backed by a noy-db collection.
 *
 * The `getCollection` factory is called lazily on first access so
 * consumers can wire the store while the `Noydb` instance is still
 * being opened asynchronously — the first `refresh()` waits for the
 * factory to succeed before hydrating.
 */
export function createNoydbStore<T>(
  getCollection: () => Collection<T> | Promise<Collection<T>>,
): StateCreator<NoydbZustandSlice<T>> {
  return (set, get) => {
    let subscribed = false
    let unsubscribe: (() => void) | null = null

    async function ensureSubscribed(coll: Collection<T>): Promise<void> {
      if (subscribed) return
      subscribed = true
      unsubscribe = coll.subscribe(() => {
        void get().refresh()
      })
    }

    async function load(): Promise<void> {
      try {
        const coll = await Promise.resolve(getCollection())
        await ensureSubscribed(coll)
        const list = await coll.list()
        const ids = await coll.list().then(rows => rows.map((_r, i) => String(i)))
        // Derive an id map. list() returns records; get the id via the envelope round-trip.
        // Fallback: use each record's own `id` field when present; else use string index.
        const records: Record<string, T> = {}
        list.forEach((rec, idx) => {
          const maybeId = (rec as unknown as { id?: string }).id
          records[maybeId ?? ids[idx]!] = rec
        })
        set({ records, loading: false, error: null })
      } catch (err) {
        set({ records: {}, loading: false, error: err as Error })
      }
    }

    // Trigger initial load on first read.
    void load()

    return {
      records: {},
      loading: true,
      error: null,

      async put(id, value) {
        try {
          const coll = await Promise.resolve(getCollection())
          await coll.put(id, value)
          // `subscribe()` will trigger refresh; no manual state update needed here.
        } catch (err) {
          set({ error: err as Error })
          throw err
        }
      },

      async remove(id) {
        try {
          const coll = await Promise.resolve(getCollection())
          await coll.delete(id)
        } catch (err) {
          set({ error: err as Error })
          throw err
        }
      },

      async refresh() {
        await load()
      },

      // Internal cleanup helper — Zustand stores don't have a native
      // unmount hook, so framework bindings can call this when
      // tearing down.
      ...({
        _unsubscribe(): void {
          unsubscribe?.()
          subscribed = false
        },
      } as Record<string, () => void>),
    }
  }
}
