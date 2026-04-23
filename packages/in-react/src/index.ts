/**
 * **@noy-db/in-react** — React hooks for noy-db.
 *
 * Five hooks that live on top of React 18+'s `useSyncExternalStore`:
 *
 *   - {@link useNoydb}       — read the `Noydb` instance from context
 *   - {@link useVault}       — open a vault, subscribed for lifecycle
 *   - {@link useCollection}  — reactive record list
 *   - {@link useQuery}       — reactive result of a query builder
 *   - {@link useSync}        — reactive sync state
 *
 * Change events drive re-renders via `useSyncExternalStore`, which
 * concurrent-mode-safely bridges an external subscription into React's
 * scheduling. No extra state library needed.
 *
 * @packageDocumentation
 */

import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import type { Noydb, Vault, ChangeEvent, Query } from '@noy-db/hub'

// ─── Context ────────────────────────────────────────────────────────────

const NoydbContext = createContext<Noydb | null>(null)

export interface NoydbProviderProps {
  readonly db: Noydb
  readonly children: ReactNode
}

/** Provides a `Noydb` instance to every component under this tree. */
export function NoydbProvider(props: NoydbProviderProps): ReactNode {
  return createElement(NoydbContext.Provider, { value: props.db }, props.children)
}

/** Access the Noydb instance supplied by the nearest `<NoydbProvider>`. */
export function useNoydb(): Noydb {
  const db = useContext(NoydbContext)
  if (!db) {
    throw new Error(
      '[@noy-db/in-react] useNoydb(): no NoydbProvider found in the React tree. ' +
      'Wrap your app with <NoydbProvider db={db}>.',
    )
  }
  return db
}

// ─── useVault ───────────────────────────────────────────────────────────

export interface UseVaultState {
  readonly vault: Vault | null
  readonly loading: boolean
  readonly error: Error | null
}

/**
 * Open a vault by name and track its lifecycle. The vault is opened
 * on mount (re-opened when `name` changes). Optional `locale` is
 * forwarded to the hub; secret / biometric unlock happens out-of-band
 * (create the Noydb instance with `secret`, or use `@noy-db/on-*`).
 */
export function useVault(name: string, options?: { locale?: string }): UseVaultState {
  const db = useNoydb()
  const [state, setState] = useState<UseVaultState>({ vault: null, loading: true, error: null })

  useEffect(() => {
    let cancelled = false
    setState({ vault: null, loading: true, error: null })
    db.openVault(name, options)
      .then((v) => {
        if (!cancelled) setState({ vault: v, loading: false, error: null })
      })
      .catch((err: Error) => {
        if (!cancelled) setState({ vault: null, loading: false, error: err })
      })
    return () => {
      cancelled = true
    }
  }, [db, name, options?.locale])

  return state
}

// ─── useCollection ──────────────────────────────────────────────────────

/**
 * Reactive list of every record in a collection. Auto-refreshes on
 * any change event from the hub — put, delete, or sync.
 */
export function useCollection<T>(
  vault: Vault | null,
  collectionName: string,
): { data: T[]; loading: boolean; error: Error | null } {
  const [state, setState] = useState<{ data: T[]; loading: boolean; error: Error | null }>(() => ({
    data: [], loading: true, error: null,
  }))

  const coll = useMemo(
    () => (vault ? vault.collection<T>(collectionName) : null),
    [vault, collectionName],
  )

  useEffect(() => {
    if (!coll) {
      setState({ data: [], loading: true, error: null })
      return
    }
    let cancelled = false
    const refresh = async (): Promise<void> => {
      try {
        const records = await coll.list()
        if (!cancelled) setState({ data: records, loading: false, error: null })
      } catch (err) {
        if (!cancelled) setState({ data: [], loading: false, error: err as Error })
      }
    }
    void refresh()
    const unsubscribe = coll.subscribe(() => { void refresh() })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [coll])

  return state
}

// ─── useQuery ───────────────────────────────────────────────────────────

/**
 * Reactive result of a query builder. The builder is re-executed
 * whenever the collection's change stream fires.
 */
export function useQuery<T, R>(
  vault: Vault | null,
  collectionName: string,
  builder: (q: Query<T>) => Promise<R> | R,
  deps: readonly unknown[] = [],
): { data: R | null; loading: boolean; error: Error | null } {
  const [state, setState] = useState<{ data: R | null; loading: boolean; error: Error | null }>(() => ({
    data: null, loading: true, error: null,
  }))

  const coll = useMemo(
    () => (vault ? vault.collection<T>(collectionName) : null),
    [vault, collectionName],
  )

  useEffect(() => {
    if (!coll) return
    let cancelled = false
    const run = async (): Promise<void> => {
      try {
        const result = await Promise.resolve(builder(coll.query() as unknown as Query<T>))
        if (!cancelled) setState({ data: result, loading: false, error: null })
      } catch (err) {
        if (!cancelled) setState({ data: null, loading: false, error: err as Error })
      }
    }
    void run()
    const unsubscribe = coll.subscribe(() => { void run() })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [coll, ...deps])

  return state
}

// ─── useSync ────────────────────────────────────────────────────────────

export interface UseSyncState {
  readonly lastEvent: ChangeEvent | null
  readonly error: Error | null
}

/**
 * Subscribe to the hub's cross-collection change stream. Useful for
 * top-level status indicators ("unsynced changes", last-update time).
 */
export function useSync(db?: Noydb): UseSyncState {
  const ctx = useContext(NoydbContext)
  const instance = db ?? ctx
  if (!instance) {
    throw new Error('[@noy-db/in-react] useSync(): no Noydb instance (pass explicitly or wrap in <NoydbProvider>).')
  }
  const [state, setState] = useState<UseSyncState>({ lastEvent: null, error: null })

  useEffect(() => {
    const handler = (event: ChangeEvent): void => {
      setState({ lastEvent: event, error: null })
    }
    instance.on('change', handler)
    return () => {
      instance.off('change', handler)
    }
  }, [instance])

  return state
}

// ─── Re-exports for convenience ─────────────────────────────────────────

export type { Noydb, Vault, Collection, ChangeEvent } from '@noy-db/hub'
