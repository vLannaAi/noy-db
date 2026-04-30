import { ref, onUnmounted, type Ref } from 'vue'
import type { Noydb, ChangeEvent } from '@noy-db/hub'

/**
 * Return value of `useCollection<T>()`.
 *
 * All `Ref` values are reactive — bind them directly to Vue templates.
 * The collection subscribes to NOYDB change events and auto-refreshes
 * `data` when the underlying collection is mutated by any code path.
 */
export interface UseCollectionReturn<T> {
  /** Reactive list of all records in the collection. */
  data: Ref<T[]>
  /** Loading state — true during initial hydration. */
  loading: Ref<boolean>
  /** Error state — set if hydration or refresh fails. */
  error: Ref<Error | null>
  /** Manually refresh data from the adapter. */
  refresh: () => Promise<void>
}

/**
 * Composable for reactive collection data.
 * Auto-refreshes when the collection changes (via NOYDB change events).
 */
export function useCollection<T>(
  db: Noydb,
  compartmentName: string,
  collectionName: string,
): UseCollectionReturn<T> {
  const data = ref<T[]>([]) as Ref<T[]>
  const loading = ref(true)
  const error = ref<Error | null>(null)

  let compartmentPromise: ReturnType<Noydb['openVault']> | null = null

  async function refresh(): Promise<void> {
    try {
      if (!compartmentPromise) {
        compartmentPromise = db.openVault(compartmentName)
      }
      const comp = await compartmentPromise
      const coll = comp.collection<T>(collectionName)
      data.value = await coll.list()
      error.value = null
    } catch (err) {
      error.value = err instanceof Error ? err : new Error(String(err))
    } finally {
      loading.value = false
    }
  }

  // Listen for changes to auto-refresh
  const handler = (event: ChangeEvent) => {
    if (event.collection === collectionName) {
      void refresh()
    }
  }
  db.on('change', handler)

  onUnmounted(() => {
    db.off('change', handler)
  })

  // Initial load
  void refresh()

  return { data, loading, error, refresh }
}
