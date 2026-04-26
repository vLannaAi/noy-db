/**
 * **@noy-db/in-svelte** — Svelte stores for noy-db.
 *
 * Three store factories that conform to Svelte's standard store
 * contract (`subscribe(fn) → unsubscribe`). Works with:
 *
 *   - Svelte 4 components via the `$store` auto-subscription syntax
 *   - Svelte 5 runes via `$state(await fromStore(s).current)` or a
 *     small `fromStore()` shim
 *   - Any framework that consumes the Svelte store contract
 *     (e.g. `@gradio/client`, non-Svelte integrations)
 *
 * ## Factories
 *
 *   - {@link collectionStore} — reactive list of records.
 *   - {@link queryStore}      — reactive result of a query builder.
 *   - {@link syncStore}       — reactive Noydb-level change feed.
 *
 * ## Zero dependencies
 *
 * Svelte's store contract is ~10 lines of TypeScript. We re-implement
 * it inline rather than take a `svelte` peer-dep — the contract is
 * stable across Svelte 4/5 and the extra dependency is unnecessary
 * for store-only consumers (e.g. SvelteKit load functions).
 *
 * @packageDocumentation
 */

import type { Noydb, Vault, ChangeEvent, Query } from '@noy-db/hub'

// ─── Svelte store contract (re-implemented, no svelte peer dep) ─────────

type Subscriber<T> = (value: T) => void
type Unsubscriber = () => void

export interface Readable<T> {
  subscribe(run: Subscriber<T>): Unsubscriber
}

function writable<T>(initial: T): {
  set(value: T): void
  subscribe(run: Subscriber<T>): Unsubscriber
} {
  let value = initial
  const subscribers = new Set<Subscriber<T>>()
  return {
    set(next) {
      value = next
      for (const s of subscribers) s(next)
    },
    subscribe(run) {
      subscribers.add(run)
      run(value)
      return () => { subscribers.delete(run) }
    },
  }
}

// ─── collectionStore ───────────────────────────────────────────────────

export interface CollectionStoreState<T> {
  readonly records: readonly T[]
  readonly loading: boolean
  readonly error: Error | null
}

/**
 * Reactive collection records. Re-emits on every change event from
 * the collection (put / delete / sync).
 *
 * ```svelte
 * <script>
 *   import { collectionStore } from '@noy-db/in-svelte'
 *   const invoices = collectionStore(vault, 'invoices')
 * </script>
 *
 * {#each $invoices.records as invoice}
 *   {invoice.id}
 * {/each}
 * ```
 */
export function collectionStore<T>(
  vault: Vault,
  collectionName: string,
): Readable<CollectionStoreState<T>> & { refresh(): Promise<void>; stop(): void } {
  const inner = writable<CollectionStoreState<T>>({ records: [], loading: true, error: null })
  const coll = vault.collection<T>(collectionName)

  async function refresh(): Promise<void> {
    try {
      const records = await coll.list()
      inner.set({ records, loading: false, error: null })
    } catch (err) {
      inner.set({ records: [], loading: false, error: err as Error })
    }
  }

  void refresh()
  const unsubscribe = coll.subscribe(() => { void refresh() })

  return {
    subscribe: (run) => inner.subscribe(run),
    refresh,
    stop: unsubscribe,
  }
}

// ─── queryStore ────────────────────────────────────────────────────────

export interface QueryStoreState<R> {
  readonly data: R | null
  readonly loading: boolean
  readonly error: Error | null
}

/**
 * Reactive result of a query builder. The builder is re-run on every
 * change event — useful for aggregates, joins, and filtered lists.
 *
 * ```svelte
 * <script>
 *   import { queryStore } from '@noy-db/in-svelte'
 *   const paid = queryStore(vault, 'invoices', q => q.where('status', '==', 'paid').toArray())
 * </script>
 *
 * {#if $paid.loading} Loading… {:else} {$paid.data?.length} paid {/if}
 * ```
 */
export function queryStore<T, R>(
  vault: Vault,
  collectionName: string,
  builder: (q: Query<T>) => Promise<R> | R,
): Readable<QueryStoreState<R>> & { refresh(): Promise<void>; stop(): void } {
  const inner = writable<QueryStoreState<R>>({ data: null, loading: true, error: null })
  const coll = vault.collection<T>(collectionName)

  async function refresh(): Promise<void> {
    try {
      const result = await Promise.resolve(builder(coll.query() as unknown as Query<T>))
      inner.set({ data: result, loading: false, error: null })
    } catch (err) {
      inner.set({ data: null, loading: false, error: err as Error })
    }
  }

  void refresh()
  const unsubscribe = coll.subscribe(() => { void refresh() })

  return {
    subscribe: (run) => inner.subscribe(run),
    refresh,
    stop: unsubscribe,
  }
}

// ─── syncStore ─────────────────────────────────────────────────────────

export interface SyncStoreState {
  readonly lastEvent: ChangeEvent | null
  readonly error: Error | null
}

/**
 * Reactive Noydb-level change feed. Useful for top-level status
 * indicators (last-update-time, "unsynced changes", offline banners).
 */
export function syncStore(db: Noydb): Readable<SyncStoreState> & { stop(): void } {
  const inner = writable<SyncStoreState>({ lastEvent: null, error: null })

  const handler = (event: ChangeEvent): void => {
    inner.set({ lastEvent: event, error: null })
  }
  db.on('change', handler)

  return {
    subscribe: (run) => inner.subscribe(run),
    stop: () => db.off('change', handler),
  }
}
