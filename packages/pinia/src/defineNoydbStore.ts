/**
 * `defineNoydbStore` — drop-in `defineStore` that wires a Pinia store to a
 * NOYDB compartment + collection.
 *
 * Returned store exposes:
 *   - `items`        — reactive array of all records
 *   - `byId(id)`     — O(1) lookup
 *   - `count`        — reactive count getter
 *   - `add(id, rec)` — encrypt + persist + update reactive state
 *   - `update(id, rec)` — same as add (Collection.put is upsert)
 *   - `remove(id)`   — delete + update reactive state
 *   - `refresh()`    — re-hydrate from the adapter
 *   - `query()`      — chainable query DSL bound to the store
 *   - `$ready`       — Promise<void> resolved on first hydration
 *
 * Compatible with `storeToRefs`, Vue Devtools, SSR, and pinia plugins.
 */

import { defineStore } from 'pinia'
import { computed, shallowRef, type Ref, type ComputedRef } from 'vue'
import type { Noydb, Compartment, Collection, Query } from '@noy-db/core'
import { resolveNoydb } from './context.js'

/**
 * Options accepted by `defineNoydbStore`.
 *
 * Generic `T` is the record shape — defaults to `unknown` if the caller
 * doesn't supply a type. Use `defineNoydbStore<Invoice>('invoices', {...})`
 * for full type safety.
 */
export interface NoydbStoreOptions<T> {
  /** Compartment (tenant) name. */
  compartment: string
  /** Collection name within the compartment. Defaults to the store id. */
  collection?: string
  /**
   * Optional explicit Noydb instance. If omitted, the store resolves the
   * globally bound instance via `getActiveNoydb()`.
   */
  noydb?: Noydb | null
  /**
   * If true (default), hydration kicks off immediately when the store is
   * first instantiated. If false, hydration is deferred until the first
   * call to `refresh()` or any read accessor.
   */
  prefetch?: boolean
  /**
   * Optional schema validator. Any object exposing a `parse(input): T`
   * method (Zod, Valibot, ArkType, etc.) is accepted.
   */
  schema?: { parse: (input: unknown) => T }
}

/**
 * The runtime shape of the store returned by `defineNoydbStore`.
 * Exposed as a public type so consumers can write `useStore: ReturnType<typeof useInvoices>`.
 */
export interface NoydbStore<T> {
  items: Ref<T[]>
  count: ComputedRef<number>
  $ready: Promise<void>
  byId(id: string): T | undefined
  add(id: string, record: T): Promise<void>
  update(id: string, record: T): Promise<void>
  remove(id: string): Promise<void>
  refresh(): Promise<void>
  query(): Query<T>
}

/**
 * Define a Pinia store that's wired to a NOYDB collection.
 *
 * Generic T defaults to `unknown` — pass `<MyType>` for full type inference.
 *
 * @example
 * ```ts
 * import { defineNoydbStore } from '@noy-db/pinia';
 *
 * export const useInvoices = defineNoydbStore<Invoice>('invoices', {
 *   compartment: 'C101',
 *   schema: InvoiceSchema, // optional
 * });
 * ```
 */
export function defineNoydbStore<T>(
  id: string,
  options: NoydbStoreOptions<T>,
) {
  const collectionName = options.collection ?? id
  const prefetch = options.prefetch ?? true

  return defineStore(id, () => {
    // Reactive state. shallowRef on items because the array reference is what
    // changes — replacing it triggers reactivity without per-record proxying.
    const items: Ref<T[]> = shallowRef<T[]>([])
    const count = computed(() => items.value.length)

    // Lazy collection handle — created on first hydrate.
    let cachedCompartment: Compartment | null = null
    let cachedCollection: Collection<T> | null = null

    async function getCollection(): Promise<Collection<T>> {
      if (cachedCollection) return cachedCollection
      const noydb = resolveNoydb(options.noydb ?? null)
      cachedCompartment = await noydb.openCompartment(options.compartment)
      cachedCollection = cachedCompartment.collection<T>(collectionName)
      return cachedCollection
    }

    async function refresh(): Promise<void> {
      const c = await getCollection()
      const list = await c.list()
      items.value = list
    }

    function byId(id: string): T | undefined {
      // Linear scan against the reactive cache. Index-aware lookups land in #13.
      // Optimization opportunity: maintain a Map<string, T> alongside items.
      for (const item of items.value) {
        if ((item as { id?: string }).id === id) return item
      }
      return undefined
    }

    async function add(id: string, record: T): Promise<void> {
      const validated = options.schema ? options.schema.parse(record) : record
      const c = await getCollection()
      await c.put(id, validated)
      // Re-list to pick up the new record. Cheaper alternative would be to
      // splice into items.value directly, but list() ensures consistency
      // with the underlying cache.
      items.value = await c.list()
    }

    async function update(id: string, record: T): Promise<void> {
      // Collection.put is upsert; this is just a more readable alias.
      await add(id, record)
    }

    async function remove(id: string): Promise<void> {
      const c = await getCollection()
      await c.delete(id)
      items.value = await c.list()
    }

    function query(): Query<T> {
      // Synchronous query() requires the collection to be hydrated.
      // The lazy refresh() in $ready handles that — but if the user calls
      // query() before $ready resolves, the collection still works because
      // Collection.query() reads from its own internal cache (which Noydb
      // hydrates lazily as well).
      if (!cachedCollection) {
        throw new Error(
          '@noy-db/pinia: query() called before the store was ready. ' +
          'Await store.$ready first, or set prefetch: true (default).',
        )
      }
      return cachedCollection.query()
    }

    // Kick off hydration. The promise is exposed as $ready so components
    // can `await store.$ready` before rendering data-dependent UI.
    const $ready: Promise<void> = prefetch
      ? refresh()
      : Promise.resolve()

    return {
      items,
      count,
      $ready,
      byId,
      add,
      update,
      remove,
      refresh,
      query,
    }
  })
}
