/**
 * `createNoydbPiniaPlugin` — augmentation path for existing Pinia stores.
 *
 * Lets a developer take any existing `defineStore()` call and opt into NOYDB
 * persistence by adding a single `noydb:` option, without touching component
 * code. The plugin watches the chosen state key(s), encrypts on change, syncs
 * to a NOYDB collection, and rehydrates on store init.
 *
 * @example
 * ```ts
 * import { createPinia } from 'pinia';
 * import { createNoydbPiniaPlugin } from '@noy-db/in-pinia';
 * import { jsonFile } from '@noy-db/to-file';
 *
 * const pinia = createPinia();
 * pinia.use(createNoydbPiniaPlugin({
 *   adapter: jsonFile({ dir: './data' }),
 *   user: 'owner-01',
 *   secret: () => promptPassphrase(),
 * }));
 *
 * // existing store — add one option, no component changes:
 * export const useClients = defineStore('clients', {
 *   state: () => ({ list: [] as Client[] }),
 *   noydb: { vault: 'C101', collection: 'clients', persist: 'list' },
 * });
 * ```
 *
 * Design notes
 * ------------
 * - Each augmented store persists a SINGLE document at id `__state__`
 *   containing the picked keys. We don't try to map state arrays onto
 *   per-element records — that's `defineNoydbStore`'s territory.
 * - The Noydb instance is constructed lazily on first store-with-noydb
 *   instantiation, then memoized for the lifetime of the Pinia app.
 *   This means apps that don't actually use any noydb-augmented stores
 *   pay zero crypto cost.
 * - `secret` is a function so the passphrase can come from a prompt,
 *   biometric unlock, or session token — never stored in config.
 * - The plugin sets `store.$noydbReady` (a `Promise<void>`) and
 *   `store.$noydbError` (an `Error | null`) on every augmented store
 *   so components can await hydration and surface failures.
 */

import type { PiniaPluginContext, PiniaPlugin, StateTree } from 'pinia'
import { createNoydb, type Noydb, type NoydbOptions, type NoydbStore, type Vault, type Collection } from '@noy-db/hub'

/**
 * Per-store NOYDB configuration. Attached to a Pinia store via the `noydb`
 * option inside `defineStore({ ..., noydb: {...} })`.
 *
 * `persist` selects which top-level state keys to mirror into NOYDB.
 * Pass a single key, an array of keys, or `'*'` to mirror the entire state.
 */
export interface StoreNoydbOptions<S extends StateTree = StateTree> {
  /** Vault (tenant) name. */
  vault: string
  /** Collection name within the vault. */
  collection: string
  /**
   * Which state keys to persist. Defaults to `'*'` (the entire state object).
   * Pass a string or string[] to scope to specific keys.
   */
  persist?: keyof S | (keyof S)[] | '*'
  /**
   * Optional schema validator applied at the document level (the persisted
   * subset of state, not individual records). Throws if validation fails on
   * hydration — the store stays at its initial state and `$noydbError` is set.
   */
  schema?: { parse: (input: unknown) => unknown }
}

/**
 * Configuration for `createNoydbPiniaPlugin`. Mirrors `NoydbOptions` but
 * makes `secret` a function so the passphrase can come from a prompt
 * rather than being stored in config.
 */
export interface NoydbPiniaPluginOptions {
  /** The NOYDB store to use for persistence. */
  adapter: NoydbStore
  /** User identifier (matches the keyring file). */
  user: string
  /**
   * Passphrase provider. Called once on first noydb-augmented store
   * instantiation. Return a string or a Promise that resolves to one.
   */
  secret: () => string | Promise<string>
  /** Optional Noydb open-options forwarded to `createNoydb`. */
  noydbOptions?: Partial<Omit<NoydbOptions, 'store' | 'user' | 'secret'>>
}

// The fixed document id under which a store's persisted state lives. Using a
// reserved prefix so it can't collide with any user-chosen record id.
const STATE_DOC_ID = '__state__'

/**
 * Create a Pinia plugin that wires NOYDB persistence into any store
 * declaring a `noydb:` option.
 *
 * Returns a `PiniaPlugin` directly usable with `pinia.use(...)`.
 */
export function createNoydbPiniaPlugin(opts: NoydbPiniaPluginOptions): PiniaPlugin {
  // Single Noydb instance shared across all augmented stores in this Pinia
  // app. Created lazily on first use so apps that never instantiate a
  // noydb-augmented store pay zero crypto cost.
  let dbPromise: Promise<Noydb> | null = null
  function getDb(): Promise<Noydb> {
    if (!dbPromise) {
      dbPromise = (async (): Promise<Noydb> => {
        const secret = await opts.secret()
        return createNoydb({
          store: opts.adapter,
          user: opts.user,
          secret,
          ...opts.noydbOptions,
        })
      })()
    }
    return dbPromise
  }

  // Vault cache so opening a vault is a one-time cost per app.
  const vaultCache = new Map<string, Promise<Vault>>()
  function getCompartment(name: string): Promise<Vault> {
    let p = vaultCache.get(name)
    if (!p) {
      p = getDb().then((db) => db.openVault(name))
      vaultCache.set(name, p)
    }
    return p
  }

  return (context: PiniaPluginContext) => {
    // Pinia stores can declare arbitrary options on `defineStore`, but the
    // plugin context only exposes them via `context.options`. Pull our
    // `noydb` option out and bail early if it's not present — that's
    // the "store is untouched" path for non-augmented stores.
    const noydbOption = (context.options as { noydb?: StoreNoydbOptions }).noydb
    if (!noydbOption) {
      // Mark the store as opted-out so devtools / consumers can detect it.
      context.store.$noydbAugmented = false
      return
    }

    context.store.$noydbAugmented = true
    context.store.$noydbError = null as Error | null

    // Track in-flight persistence promises so tests (and consumers) can
    // await deterministic flushes via `$noydbFlush()`. Plain Set-of-Promises
    // — entries auto-remove on settle.
    const pending = new Set<Promise<void>>()

    // Hydrate-then-subscribe. Both happen inside an async closure so the
    // store can be awaited via `$noydbReady`.
    const ready = (async (): Promise<void> => {
      try {
        const vault = await getCompartment(noydbOption.vault)
        const collection: Collection<StateTree> = vault.collection<StateTree>(
          noydbOption.collection,
        )

        // 1. Hydration: read the persisted document (if any) and apply
        //    the picked keys onto the store's current state. We use
        //    `$patch` so reactivity fires correctly.
        const persisted = await collection.get(STATE_DOC_ID)
        if (persisted) {
          const validated = noydbOption.schema
            ? (noydbOption.schema.parse(persisted) as StateTree)
            : persisted
          const picked = pickKeys(validated, noydbOption.persist)
          context.store.$patch(picked)
        }

        // 2. Subscribe: every state mutation triggers an encrypted write
        //    of the picked subset back to NOYDB. The subscription captures
        //    `collection` so it doesn't re-resolve on every event.
        context.store.$subscribe(
          (_mutation, state) => {
            const subset = pickKeys(state, noydbOption.persist)
            const p = collection.put(STATE_DOC_ID, subset)
              .catch((err: unknown) => {
                context.store.$noydbError = err instanceof Error ? err : new Error(String(err))
              })
              .finally(() => {
                pending.delete(p)
              })
            pending.add(p)
          },
          { detached: true }, // outlive the component that triggered the mutation
        )
      } catch (err) {
        context.store.$noydbError = err instanceof Error ? err : new Error(String(err))
      }
    })()

    context.store.$noydbReady = ready
    /**
     * Wait for all in-flight persistence puts to settle. Use this in tests
     * to deterministically observe the encrypted state on the adapter, and
     * in app code before unmounting components that mutated the store.
     */
    context.store.$noydbFlush = async (): Promise<void> => {
      await ready
      // Snapshot the current pending set; new puts added during await
      // are picked up by the next $noydbFlush() call.
      while (pending.size > 0) {
        await Promise.all([...pending])
      }
    }
  }
}

/**
 * Pick the configured subset of keys from a state object.
 *
 * Behaviors:
 *   - `undefined` or `'*'` → returns the entire state shallow-copied
 *   - single key string → returns `{ [key]: state[key] }`
 *   - key array → returns `{ [k1]: state[k1], [k2]: state[k2], ... }`
 *
 * The result is always a fresh object so callers can mutate it without
 * touching the store's reactive state.
 */
function pickKeys(state: StateTree, persist: StoreNoydbOptions['persist']): StateTree {
  if (persist === undefined || persist === '*') {
    return { ...state }
  }
  if (typeof persist === 'string') {
    return { [persist]: state[persist] } as StateTree
  }
  if (Array.isArray(persist)) {
    const out: StateTree = {}
    for (const key of persist) {
      out[key as string] = state[key as string]
    }
    return out
  }
  // Should be unreachable thanks to the type, but defensive default.
  return { ...state }
}

// ─── Pinia module augmentation ─────────────────────────────────────
//
// Pinia exposes `DefineStoreOptionsBase` as the place where third-party
// plugins are expected to attach their custom option types. Augmenting it
// here means `defineStore('x', { ..., noydb: {...} })` autocompletes inside
// the IDE and type-checks correctly without forcing users to import
// anything from `@noy-db/pinia`.
//
// We also augment `PiniaCustomProperties` so the runtime fields we add to
// every store (`$noydbReady`, `$noydbError`, `$noydbAugmented`) are typed.

declare module 'pinia' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  export interface DefineStoreOptionsBase<S extends StateTree, Store> {
    /**
     * Opt this store into NOYDB persistence via the
     * `createNoydbPiniaPlugin` augmentation plugin.
     *
     * The chosen state keys are encrypted and persisted to the configured
     * vault + collection on every mutation, and rehydrated on first
     * store access.
     */
    noydb?: StoreNoydbOptions<S>
  }

  export interface PiniaCustomProperties {
    /**
     * Resolves once this store has finished its initial hydration from
     * NOYDB. `undefined` for stores that don't declare a `noydb:` option.
     */
    $noydbReady?: Promise<void>
    /**
     * Set when hydration or persistence fails. `null` while healthy.
     * Plugins (and devtools) can poll this to surface storage errors.
     */
    $noydbError?: Error | null
    /**
     * `true` if this store opted into NOYDB persistence via the `noydb:`
     * option, `false` otherwise. Useful for debugging and devtools.
     */
    $noydbAugmented?: boolean
    /**
     * Wait for all in-flight encrypted persistence puts to complete.
     * Useful in tests for deterministic flushing, and in app code before
     * unmounting components that just mutated the store.
     */
    $noydbFlush?: () => Promise<void>
  }
}
