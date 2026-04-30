/**
 * **@noy-db/in-tanstack-query** — TanStack Query adapter for noy-db.
 *
 * Three framework-agnostic pieces:
 *
 *   1. **{@link collectionQueryOptions}** — returns a
 *      `{ queryKey, queryFn }` pair ready to hand to `useQuery()` in
 *      any TanStack-supported framework (React, Vue, Solid, Svelte).
 *
 *   2. **{@link collectionMutationOptions}** — same shape for
 *      `useMutation()`, with `put`/`delete` actions against a
 *      `Collection`.
 *
 *   3. **{@link bindInvalidation}** — subscribes to a `Collection`'s
 *      change stream and invalidates the matching query keys on every
 *      mutation. Drop-in replacement for ad-hoc `invalidateQueries`
 *      calls scattered through mutation callbacks.
 *
 * Keeping these as option-factories (not custom hooks) means the
 * same code works across every TanStack framework binding — no
 * framework-specific exports needed.
 *
 * @packageDocumentation
 */

import type { Collection, Query } from '@noy-db/hub'
import type { QueryClient } from '@tanstack/query-core'

/** The canonical TanStack queryKey shape for a collection scope. */
export type CollectionQueryKey =
  | readonly ['noy-db', string, string]
  | readonly ['noy-db', string, string, string]
  | readonly ['noy-db', string, string, ...unknown[]]

export function collectionQueryKey(vault: string, collection: string, ...extra: unknown[]): CollectionQueryKey {
  return ['noy-db', vault, collection, ...extra] as CollectionQueryKey
}

/**
 * Build `{ queryKey, queryFn }` for a Collection list query. Pass the
 * returned object directly into `useQuery(options)` — works across
 * every TanStack framework binding.
 */
export function collectionListOptions<T>(
  vault: string,
  collectionName: string,
  getCollection: () => Collection<T>,
): { queryKey: CollectionQueryKey; queryFn: () => Promise<T[]> } {
  return {
    queryKey: collectionQueryKey(vault, collectionName, 'list'),
    queryFn: async () => {
      const coll = getCollection()
      return coll.list()
    },
  }
}

/**
 * Build `{ queryKey, queryFn }` for a single-record query. Returns
 * `null` when the record is absent.
 */
export function collectionGetOptions<T>(
  vault: string,
  collectionName: string,
  id: string,
  getCollection: () => Collection<T>,
): { queryKey: CollectionQueryKey; queryFn: () => Promise<T | null> } {
  return {
    queryKey: collectionQueryKey(vault, collectionName, 'get', id),
    queryFn: async () => {
      const coll = getCollection()
      return coll.get(id)
    },
  }
}

/**
 * Build `{ queryKey, queryFn }` for an arbitrary query builder. The
 * builder receives the collection's `query()` chain and returns a
 * terminal result (`.toArray()`, `.count()`, `.aggregate({...})`, …).
 */
export function collectionQueryOptions<T, R>(
  vault: string,
  collectionName: string,
  getCollection: () => Collection<T>,
  builder: (q: Query<T>) => Promise<R> | R,
  keyTag: string = 'query',
): { queryKey: CollectionQueryKey; queryFn: () => Promise<R> } {
  return {
    queryKey: collectionQueryKey(vault, collectionName, keyTag),
    queryFn: async () => {
      const coll = getCollection()
      return Promise.resolve(builder(coll.query() as unknown as Query<T>))
    },
  }
}

/**
 * Build `{ mutationFn }` for a record put. Caller's `onSuccess` is
 * where you'd usually call `invalidateQueries(collectionQueryKey(...))`
 * — or let {@link bindInvalidation} do it automatically.
 */
export function collectionPutOptions<T>(
  getCollection: () => Collection<T>,
): { mutationFn: (args: { id: string; record: T }) => Promise<void> } {
  return {
    mutationFn: async ({ id, record }) => {
      const coll = getCollection()
      await coll.put(id, record)
    },
  }
}

/** Build `{ mutationFn }` for a record delete. */
export function collectionDeleteOptions<T>(
  getCollection: () => Collection<T>,
): { mutationFn: (args: { id: string }) => Promise<void> } {
  return {
    mutationFn: async ({ id }) => {
      const coll = getCollection()
      await coll.delete(id)
    },
  }
}

/**
 * Subscribe to a Collection's change stream and invalidate the
 * corresponding query scope on every mutation. Returns an unsubscribe
 * function — call on cleanup (framework-specific).
 *
 * ```ts
 * const stop = bindInvalidation(queryClient, 'acme', 'invoices', invoices)
 * // … later, e.g. in React's useEffect cleanup:
 * stop()
 * ```
 */
export function bindInvalidation<T>(
  queryClient: QueryClient,
  vault: string,
  collectionName: string,
  collection: Collection<T>,
): () => void {
  return collection.subscribe(() => {
    void queryClient.invalidateQueries({
      queryKey: collectionQueryKey(vault, collectionName),
    })
  })
}
