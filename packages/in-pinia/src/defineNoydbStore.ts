/**
 * `defineNoydbStore` — drop-in `defineStore` that wires a Pinia store to a
 * NOYDB vault + collection.
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
import {
  computed,
  getCurrentScope,
  onScopeDispose,
  isRef,
  ref,
  shallowRef,
  watch,
  type Ref,
  type ShallowRef,
  type ComputedRef,
} from 'vue'
import type {
  Noydb,
  Vault,
  Collection,
  Query,
  StandardSchemaV1,
  I18nTextDescriptor,
  DictKeyDescriptor,
} from '@noy-db/hub'
import { resolveNoydb } from './context.js'
import { useNoydbI18n } from './useNoydbI18n.js'

/**
 * i18n resolution mode for a store's reads.
 * - `'raw'` (default) — items keep `{ [locale]: string }` maps (today's behavior).
 * - `'follow'` — resolve to the global `useNoydbI18n` locale; re-read on flip.
 * - `{ locale, fallback? }` — pin to a fixed locale or own ref.
 */
export type NoydbStoreI18nMode =
  | 'raw'
  | 'follow'
  | { locale: string | Ref<string>; fallback?: string | readonly string[] }

/**
 * Reactive handle returned by `store.liveQuery(fn)`. Mirrors a hub
 * `LiveQuery<R>` into Vue refs; `items` updates on every left- or
 * joined-right-side mutation, `error` carries re-run errors as state
 * (a `DanglingReferenceError` in strict join mode is the common case),
 * `stop()` tears down upstream subscriptions. Auto-disposed on scope
 * teardown when called inside a Vue setup / Pinia store body.
 */
export interface NoydbLiveQuery<R> {
  items: ShallowRef<readonly R[]>
  error: Ref<Error | null>
  stop(): void
}

/**
 * Options accepted by `defineNoydbStore`.
 *
 * Generic `T` is the record shape — defaults to `unknown` if the caller
 * doesn't supply a type. Use `defineNoydbStore<Invoice>('invoices', {...})`
 * for full type safety.
 */
export interface NoydbStoreOptions<T> {
  /**
   * Vault (tenant) name, or a **resolver** evaluated at access time for
   * federation routing (#383). A plain `string` binds the store to one
   * vault for its lifetime (unchanged behavior). A `() => string` resolver
   * is re-evaluated on every read/write and whenever its reactive
   * dependencies change — so a store can follow the app's active scope into
   * a per-client shard vault (e.g. `() => firm.shardVaultId(clientCode.value)`).
   *
   * When the resolved name changes, the store re-opens the new vault and
   * re-hydrates `items` (mirrors the `i18n: 'follow'` re-read). If the
   * resolver reads Vue reactive state, the re-hydrate is automatic; if it
   * reads non-reactive state, the next `refresh()`/`add()`/`remove()`
   * re-binds. Note: an in-flight `liveQuery()` handle stays bound to the
   * vault it was created against — recreate it after a vault change.
   */
  vault: string | (() => string)
  /** Collection name within the vault. Defaults to the store id. */
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
   * Optional schema validator.
   *
   * Accepts any [Standard Schema v1](https://standardschema.dev) validator
   * — Zod, Valibot, ArkType, Effect Schema, etc. The same validator is
   * installed on the underlying `Collection`, so every `put()` is
   * validated **before encryption** and every read is validated **after
   * decryption**. The store's `add`/`update` methods inherit this
   * validation automatically; no duplicate `.parse()` call is needed.
   *
   * Schema-less stores behave exactly as before (no validation, no
   * perf cost, backwards compatible with usage).
   */
  schema?: StandardSchemaV1<unknown, T>
  /**
   * Optional per-field attestation schema. When set, it's installed on the
   * underlying `Collection` (alongside `schema`) so `vault.issueAttestation(name, id)`
   * can commit the declared fields against the firm's signing key — see
   * `@noy-db/attestation` `AttestationFieldSchema`. Stores without it behave as before.
   */
  attestation?: NonNullable<Parameters<Vault['collection']>[1]>['attestation']
  /**
   * If true, the collection persists a JSON Schema baseline of `schema` so the
   * schema-update protocol can detect drift on later opens. Forwarded as-is to
   * the underlying `Collection`. Required for `schemaUpdate` to take effect.
   */
  persistJsonSchema?: NonNullable<Parameters<Vault['collection']>[1]>['persistJsonSchema']
  /**
   * Ordered schema-update strategies (e.g. `coordinatedCutover`, `additiveOnly`,
   * `lockSchema`) applied when a stored baseline differs from the current
   * `schema`. Forwarded as-is to the underlying `Collection`. Requires
   * `persistJsonSchema: true` (drift detection needs the persisted baseline).
   * Lets a `defineNoydbStore`-defined collection opt into migration tracking
   * declaratively, without a pre-registration `vault.collection(...)` call.
   */
  schemaUpdate?: NonNullable<Parameters<Vault['collection']>[1]>['schemaUpdate']
  /**
   * Per-field `i18nText()` descriptors. Forwarded to the underlying
   * `Collection` so locale resolution and required-translation validation
   * run declaratively without a separate `vault.collection(name, { i18nFields })`
   * pre-registration call.
   */
  i18nFields?: Record<string, I18nTextDescriptor>
  /**
   * Per-field `dictKey()` descriptors. Forwarded to the underlying
   * `Collection` so dictionary label resolution runs declaratively.
   */
  dictKeyFields?: Record<string, DictKeyDescriptor>
  /**
   * How the store resolves i18nText/dictKey fields on read.
   * Default `'raw'` — items keep `{ [locale]: string }` maps (today's
   * behavior; zero breaking change). `'follow'` resolves to the global
   * `useNoydbI18n` locale and re-reads when it changes. `{ locale }`
   * pins to a fixed locale or own ref. Set `'raw'` for stores whose maps
   * feed identity/export reads or a per-cell bilingual toggle.
   */
  i18n?: NoydbStoreI18nMode
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
  liveQuery<R = T>(build: (q: Query<T>) => Query<R>): NoydbLiveQuery<R>
}

/**
 * Define a Pinia store that's wired to a NOYDB collection.
 *
 * Generic T defaults to `unknown` — pass `<MyType>` for full type inference.
 *
 * @example
 * ```ts
 * import { defineNoydbStore } from '@noy-db/in-pinia';
 *
 * export const useInvoices = defineNoydbStore<Invoice>('invoices', {
 *   vault: 'C101',
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

    // i18n resolution mode. Default 'raw' (today's behavior): reads pass
    // { locale: 'raw' }, items keep their maps. 'follow' resolves to the
    // global useNoydbI18n locale and re-reads on flip; { locale } pins.
    const i18nMode: NoydbStoreI18nMode = options.i18n ?? 'raw'
    const i18nStore = i18nMode === 'follow' ? useNoydbI18n() : null
    function localeOpts(): { locale: string; fallback?: string | readonly string[] } {
      if (i18nMode === 'raw') return { locale: 'raw' }
      if (i18nMode === 'follow') {
        return { locale: i18nStore!.locale, fallback: i18nStore!.fallback }
      }
      const l = i18nMode.locale
      return {
        locale: typeof l === 'string' ? l : l.value,
        ...(i18nMode.fallback !== undefined ? { fallback: i18nMode.fallback } : {}),
      }
    }

    // Resolve the target vault name. A `() => string` resolver (#383) is
    // evaluated on every access so the store can follow the app's active
    // scope into a per-client shard vault; a plain string is constant.
    const resolveVaultName = (): string =>
      typeof options.vault === 'function' ? options.vault() : options.vault

    // Lazy collection handle — created on first hydrate, and re-created when
    // the resolved vault name changes (federation re-bind).
    let cachedCompartment: Vault | null = null
    let cachedCollection: Collection<T> | null = null
    let boundVaultName: string | null = null

    async function getCollection(): Promise<Collection<T>> {
      const vaultName = resolveVaultName()
      // Self-heal on vault change: a cached handle is only reused while it
      // belongs to the currently-resolved vault. When the resolver returns a
      // new name, fall through and re-open — so add()/remove()/refresh() all
      // bind to the right shard without any extra wiring.
      if (cachedCollection && boundVaultName === vaultName) return cachedCollection
      const noydb = resolveNoydb(options.noydb ?? null)
      cachedCompartment = await noydb.openVault(vaultName)
      // Pass the schema down to the Collection so validation runs at
      // the encrypt/decrypt boundary instead of only at the store
      // layer. This catches drifted stored data on read (which the
      // old `options.schema.parse(record)` call in add() could not do).
      const collOpts: Parameters<typeof cachedCompartment.collection<T>>[1] = {}
      if (options.schema !== undefined) collOpts.schema = options.schema
      if (options.attestation !== undefined) collOpts.attestation = options.attestation
      if (options.persistJsonSchema !== undefined) collOpts.persistJsonSchema = options.persistJsonSchema
      if (options.schemaUpdate !== undefined) collOpts.schemaUpdate = options.schemaUpdate
      if (options.i18nFields !== undefined) collOpts.i18nFields = options.i18nFields
      if (options.dictKeyFields !== undefined) collOpts.dictKeyFields = options.dictKeyFields
      cachedCollection = cachedCompartment.collection<T>(collectionName, collOpts)
      boundVaultName = vaultName
      return cachedCollection
    }

    async function refresh(): Promise<void> {
      const c = await getCollection()
      const list = await c.list(localeOpts())
      items.value = list
    }

    function byId(id: string): T | undefined {
      // Linear scan against the reactive cache. Index-aware lookups planned.
      // Optimization opportunity: maintain a Map<string, T> alongside items.
      for (const item of items.value) {
        if ((item as { id?: string }).id === id) return item
      }
      return undefined
    }

    async function add(id: string, record: T): Promise<void> {
      // No explicit validation here — the Collection's own schema hook
      // runs before encryption, which means we get validation AND
      // transforms applied consistently across every code path that
      // writes to the collection (add/update/remove, future batch
      // operations, raw Collection.put calls). Users who want to
      // pre-validate in the UI layer can still do so with their own
      // schema handle.
      const c = await getCollection()
      await c.put(id, record)
      // Re-list to pick up the new record. Cheaper alternative would be to
      // splice into items.value directly, but list() ensures consistency
      // with the underlying cache.
      items.value = await c.list(localeOpts())
    }

    async function update(id: string, record: T): Promise<void> {
      // Collection.put is upsert; this is just a more readable alias.
      await add(id, record)
    }

    async function remove(id: string): Promise<void> {
      const c = await getCollection()
      await c.delete(id)
      items.value = await c.list(localeOpts())
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

    function liveQuery<R = T>(
      build: (q: Query<T>) => Query<R>,
    ): NoydbLiveQuery<R> {
      if (!cachedCollection) {
        throw new Error(
          '@noy-db/pinia: liveQuery() called before the store was ready. ' +
          'Await store.$ready first, or set prefetch: true (default).',
        )
      }
      const built = build(cachedCollection.query())
      const live = built.live()

      const items = shallowRef<readonly R[]>(live.value)
      const error = ref<Error | null>(live.error)

      const unsubscribe = live.subscribe(() => {
        items.value = live.value
        error.value = live.error
      })

      let stopped = false
      const stop = (): void => {
        if (stopped) return
        stopped = true
        unsubscribe()
        live.stop()
      }

      // Auto-teardown when the calling scope (a Vue component's setup,
      // a Pinia store body, or any user-created effectScope) disposes.
      // Outside an active scope (raw test harness, SSR top-level), skip
      // registration silently — caller is responsible for stop().
      if (getCurrentScope()) onScopeDispose(stop)

      return { items, error, stop }
    }

    // Kick off hydration. The promise is exposed as $ready so components
    // can `await store.$ready` before rendering data-dependent UI.
    const $ready: Promise<void> = prefetch
      ? refresh()
      : Promise.resolve()

    // Re-read with the new locale when it changes. 'follow' tracks the
    // global store; a { locale: ref } pin tracks its own ref. 'raw' and
    // a fixed-string locale never change, so no watch.
    if (i18nMode === 'follow') {
      watch(
        () => [i18nStore!.locale, i18nStore!.fallback] as const,
        () => { void refresh() },
      )
    } else if (typeof i18nMode === 'object' && isRef(i18nMode.locale)) {
      watch(i18nMode.locale, () => { void refresh() })
    }

    // Federation re-bind (#383): when the vault resolver depends on reactive
    // state, re-hydrate as its resolved name changes. `getCollection()` already
    // self-heals to the new vault; this just drives the auto-refresh so `items`
    // follows the active scope. Only wired for a resolver (a static string
    // never changes). The value-equality guard means a reactive dependency
    // change that yields the same vault name does not re-hydrate.
    if (typeof options.vault === 'function') {
      watch(resolveVaultName, (next, prev) => {
        if (next !== prev) void refresh()
      })
    }

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
      liveQuery,
    }
  })
}
