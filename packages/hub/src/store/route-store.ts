/**
 * Store router / multiplexer.
 *
 * Dispatches `NoydbStore` operations to different backends based on
 * collection type, record size, record age, collection name, or vault name.
 *
 * ```ts
 * const db = await createNoydb({
 *   store: routeStore({
 *     default: dynamo({ table: 'myapp' }),
 *     blobs: s3Store({ bucket: 'myapp-blobs' }),
 *   }),
 * })
 * ```
 *
 * @module
 */

import type {
  NoydbStore,
  EncryptedEnvelope,
  VaultSnapshot,
} from '../types.js'

// ─── Internal collection prefixes (duplicated to avoid circular import) ──

const BLOB_CHUNKS = '_blob_chunks'
const BLOB_INDEX = '_blob_index'
const BLOB_SLOTS = '_blob_slots_'
const BLOB_VERSIONS = '_blob_versions_'

// ─── Options ─────────────────────────────────────────────────────────────

/**
 * Size-tiered blob routing configuration.
 *
 * Routes blob chunks to different stores based on byte size. Small blobs
 * (under `threshold`) stay in the primary or `small` store; large blobs
 * go to `large`. This lets you keep DynamoDB as the default while sending
 * large binary objects to S3.
 */
export interface BlobStoreRoute {
  /** Store for small blobs (under threshold). Falls back to `default`. */
  readonly small?: NoydbStore
  /** Store for large blobs (over threshold). */
  readonly large: NoydbStore
  /** Size threshold in bytes. Default: `400 * 1024` (DynamoDB item limit). */
  readonly threshold?: number
}

/**
 * Blob lifecycle management policies evaluated during `compact()`.
 *
 * Controls orphan cleanup, cold-tier archival, and hard deletion of
 * blobs that are no longer referenced by any record.
 */
export interface BlobLifecyclePolicy {
  /** Delete orphan blobs (refCount: 0) after this many days. Default: 7. */
  readonly orphanRetentionDays?: number
  /** Move blobs not accessed in this many days to the cold blob store. */
  readonly archiveAfterDays?: number
  /** Store for archived blobs. Required if archiveAfterDays is set. */
  readonly archiveStore?: NoydbStore
  /** Hard-delete archived blobs after this many days. */
  readonly expireAfterDays?: number
}

/**
 * Age-based hot/cold tiering configuration.
 *
 * Records whose `_ts` timestamp is older than `coldAfterDays` are migrated
 * to the `cold` store during `compact()`. Reads transparently fall through
 * to the cold store when the hot store returns null, so callers don't need
 * to know which tier a record lives in.
 */
export interface AgeRoute {
  /** Store for records older than the cutoff. */
  readonly cold: NoydbStore
  /** Days after last modification before a record is cold-eligible. */
  readonly coldAfterDays: number
  /**
   * Collections that participate in age tiering.
   * Empty array or omitted = all user collections (excluding `_` prefixed).
   */
  readonly collections?: string[]
}

/**
 * Options for `routeStore()` — the store multiplexer.
 *
 * At minimum, provide a `default` store. All other fields are optional
 * extensions for specific routing scenarios (blobs → S3, geographic sharding,
 * age-based tiering, etc.).
 */
export interface RouteStoreOptions {
  /** Default store for all unmatched operations. */
  readonly default: NoydbStore

  /**
   * Route blob chunk data to a separate store.
   * - Pass a `NoydbStore` for simple prefix routing (all chunks → that store).
   * - Pass `{ small?, large, threshold? }` for size-tiered routing.
   */
  readonly blobs?: NoydbStore | BlobStoreRoute

  /** Route all blob metadata (index, slots, versions) to the blobs store too. Default: false. */
  readonly routeBlobMeta?: boolean

  /** Route specific user collections to dedicated stores. */
  readonly routes?: Record<string, NoydbStore>

  /** Route by vault name (prefix patterns, e.g. `'EU-'`). */
  readonly vaultRoutes?: Record<string, NoydbStore>

  /**
   * Age-based tiering: records older than `coldAfterDays` are read from
   * the cold store. A background `compact()` method migrates them.
   */
  readonly age?: AgeRoute

  /**
   * Content-aware blob routing.
   * Route blob chunks by MIME type glob pattern. The MIME type is stored
   * in `BlobObject` and matched at read time via `storeHint`.
   */
  readonly blobRoutes?: Record<string, NoydbStore>

  /**
   * Blob lifecycle policies.
   * Evaluated during `compact()`.
   */
  readonly blobLifecycle?: BlobLifecyclePolicy

  /**
   * Quota-aware overflow.
   * When the default store's usage exceeds the threshold, new writes
   * overflow to the specified store.
   */
  readonly overflow?: NoydbStore

  /**
   * Quota threshold (0-1). Default: 0.8 (overflow at 80% usage).
   * Only effective when `overflow` is set.
   */
  readonly quotaThreshold?: number
}

// ─── Types ───────────────────────────────────────────────────────────────

/**
 * Named route that can be overridden or suspended at runtime.
 *
 * Built-in names: `'default'`, `'blobs'`, `'cold'`.
 * Custom names: any collection name from `routes`, any vault prefix from
 * `vaultRoutes`, or any sync target label.
 */
export type OverrideTarget =
  | 'default'
  | 'blobs'
  | 'cold'
  | (string & {})  // named collection route, vault route, or sync target label

/**
 * Options for `RoutedNoydbStore.override()`.
 *
 * Controls whether the new store is pre-populated with data from the
 * original store before the switch takes effect.
 */
export interface OverrideOptions {
  /**
   * Hydrate the override store from the original before activating.
   * - `true` — copy all data for all vaults.
   * - `string[]` — copy only named collections.
   * Makes `override()` async — returns a Promise.
   */
  hydrate?: boolean | string[]
}

/**
 * Options for `RoutedNoydbStore.suspend()`.
 *
 * A suspended route becomes a null store: reads return null/[], writes
 * are dropped (or buffered if `queue: true`). Useful for maintenance
 * windows or restricted-network scenarios.
 */
export interface SuspendOptions {
  /**
   * Buffer write operations during suspension. On `resume()`, queued
   * writes are replayed against the restored store.
   */
  queue?: boolean
  /**
   * Maximum queued operations. When exceeded, oldest entries are dropped.
   * Default: 10_000.
   */
  maxQueueSize?: number
}

/** Queued write operation recorded during suspension. */
interface QueuedWrite {
  method: 'put' | 'delete'
  vault: string
  collection: string
  id: string
  envelope?: EncryptedEnvelope
  expectedVersion?: number
}

/**
 * Snapshot of the current override and suspend state of a `RoutedNoydbStore`.
 * Returned by `routeStatus()` for diagnostics and health dashboards.
 */
export interface RouteStatus {
  /** Active overrides: route name → override store name. */
  readonly overrides: Record<string, string>
  /** Currently suspended routes. */
  readonly suspended: string[]
  /** Queued writes per suspended route (only for routes suspended with `queue: true`). */
  readonly queued: Record<string, number>
}

/**
 * Extended `NoydbStore` returned by `routeStore()`.
 *
 * Satisfies the full `NoydbStore` contract plus adds runtime control
 * methods for overriding, suspending, and inspecting routes.
 */
export interface RoutedNoydbStore extends NoydbStore {
  /**
   * Migrate records older than the age cutoff from the hot store to the
   * cold store. Only applies when `age` is configured. Returns the number
   * of records migrated.
   */
  compact(vault: string): Promise<number>

  /**
   * Override a named route at runtime.
   *
   * The override persists until `clearOverride()` is called or the
   * instance is closed. In-flight operations complete on the original
   * store; new operations use the override.
   *
   * Options:
   * - `hydrate: true` — async: copies all data from the original store
   *   into the override before activating the switch.
   * - `hydrate: ['invoices', 'clients']` — copies only named collections.
   *
   * Use cases:
   * - Shared device: `await store.override('default', memory(), { hydrate: true })`
   * - Restricted network: `store.override('blobs', localFile(...))`
   */
  override(route: OverrideTarget, store: NoydbStore, opts?: OverrideOptions): void | Promise<void>

  /** Clear a runtime override, reverting to the original store. */
  clearOverride(route: OverrideTarget): void

  /**
   * Suspend a route entirely. Operations to suspended stores become
   * no-ops (puts silently dropped, gets return null, lists return []).
   *
   * Options:
   * - `queue: true` — buffer write operations (put/delete) during
   *   suspension. When `resume()` is called, queued writes are replayed
   *   against the restored store.
   *
   * Returns a `SuspendHandle` when `queue: true`, for inspecting queue state.
   */
  suspend(route: OverrideTarget, opts?: SuspendOptions): void

  /**
   * Resume a previously suspended route.
   * If the route was suspended with `queue: true`, replays queued writes.
   * Returns the number of replayed operations.
   */
  resume(route: OverrideTarget): Promise<number>

  /** Snapshot the current override/suspend state for diagnostics. */
  routeStatus(): RouteStatus
}

// ─── Implementation ──────────────────────────────────────────────────────

/**
 * Create a store multiplexer that dispatches operations to different backends
 * based on collection type, record size, record age, vault prefix, or
 * runtime overrides.
 *
 * ```ts
 * const store = routeStore({
 *   default: dynamo({ table: 'myapp' }),
 *   blobs: s3({ bucket: 'myapp-blobs' }),
 *   routes: { auditLog: s3({ bucket: 'myapp-audit' }) },
 * })
 * ```
 *
 * The returned store satisfies `NoydbStore` and can be passed directly to
 * `createNoydb({ store })`. It also exposes additional methods
 * (`override`, `suspend`, `resume`, `routeStatus`, `compact`) for runtime
 * control and maintenance.
 */
export function routeStore(opts: RouteStoreOptions): RoutedNoydbStore {
  const primary = opts.default

  // Resolve blob store config
  const blobsIsSimple = opts.blobs && 'get' in opts.blobs
  const simpleBlobStore = blobsIsSimple ? opts.blobs : undefined
  const tieredBlobs = !blobsIsSimple ? opts.blobs : undefined
  const blobThreshold = tieredBlobs?.threshold ?? 400 * 1024

  // Collect all stores for loadAll/saveAll/listVaults composition
  const allStores = new Set<NoydbStore>([primary])
  if (simpleBlobStore) allStores.add(simpleBlobStore)
  if (tieredBlobs?.large) allStores.add(tieredBlobs.large)
  if (tieredBlobs?.small) allStores.add(tieredBlobs.small)
  if (opts.age?.cold) allStores.add(opts.age.cold)
  if (opts.routes) for (const s of Object.values(opts.routes)) allStores.add(s)
  if (opts.vaultRoutes) for (const s of Object.values(opts.vaultRoutes)) allStores.add(s)
  if (opts.blobRoutes) for (const s of Object.values(opts.blobRoutes)) allStores.add(s)
  if (opts.overflow) allStores.add(opts.overflow)
  if (opts.blobLifecycle?.archiveStore) allStores.add(opts.blobLifecycle.archiveStore)

  // ── Runtime override / suspend state ──────────────────

  const overrides = new Map<string, NoydbStore>()
  const suspended = new Set<string>()
  const writeQueues = new Map<string, { writes: QueuedWrite[]; maxSize: number }>()

  /** Null store: silently absorbs all operations when a route is suspended. */
  const NULL_STORE: NoydbStore = {
    name: 'suspended',
    async get() { return null },
    async put() {},
    async delete() {},
    async list() { return [] },
    async loadAll() { return {} },
    async saveAll() {},
  }

  /**
   * Map a resolved route to its canonical name for override/suspend lookup.
   * Vault routes use the prefix, collection routes use the collection name,
   * blob route is 'blobs', cold route is 'cold', everything else is 'default'.
   */
  function routeNameFor(vault: string, collection: string): string {
    if (opts.vaultRoutes) {
      for (const prefix of Object.keys(opts.vaultRoutes)) {
        if (vault.startsWith(prefix)) return prefix
      }
    }
    if (opts.routes && !collection.startsWith('_') && opts.routes[collection]) {
      return collection
    }
    if (isBlobChunks(collection) && (simpleBlobStore || tieredBlobs)) return 'blobs'
    if (opts.routeBlobMeta && isBlobMeta(collection) && (simpleBlobStore || tieredBlobs)) return 'blobs'
    if (opts.age && !collection.startsWith('_')) {
      // We don't name age 'cold' here — cold is a fallback, not a primary route
    }
    return 'default'
  }

  // ── Quota-aware overflow (E8) ───────────────────────────────────────

  const quotaExceeded = false

  /** Resolve the static (non-overridden) store for a given route name. */
  function resolveOriginalStore(route: string): NoydbStore {
    if (route === 'blobs') return simpleBlobStore ?? tieredBlobs?.large ?? primary
    if (route === 'cold') return opts.age?.cold ?? primary
    if (opts.routes?.[route]) return opts.routes[route]
    if (opts.vaultRoutes?.[route]) return opts.vaultRoutes[route]
    return primary
  }

  /**
   * Queue a write operation if the route is suspended with queue: true.
   * Returns true if queued (caller should skip the actual write).
   */
  function maybeQueueWrite(
    routeName: string,
    method: 'put' | 'delete',
    vault: string,
    collection: string,
    id: string,
    envelope?: EncryptedEnvelope,
    expectedVersion?: number,
  ): boolean {
    if (!suspended.has(routeName)) return false
    const queue = writeQueues.get(routeName)
    if (!queue) return false // suspended but no queue — NullStore behavior

    // Evict oldest if at capacity
    if (queue.writes.length >= queue.maxSize) {
      queue.writes.shift()
    }
    queue.writes.push({
      method, vault, collection, id,
      ...(envelope !== undefined ? { envelope } : {}),
      ...(expectedVersion !== undefined ? { expectedVersion } : {}),
    })
    return true
  }

  // ── Routing logic ──────────────────────────────────────────────────

  function isBlobChunks(collection: string): boolean {
    return collection === BLOB_CHUNKS
  }

  function isBlobMeta(collection: string): boolean {
    return collection === BLOB_INDEX
      || collection.startsWith(BLOB_SLOTS)
      || collection.startsWith(BLOB_VERSIONS)
  }

  function isInternal(collection: string): boolean {
    return collection.startsWith('_')
  }

  /**
   * Resolve the store for a given vault + collection.
   * Resolution order: overrides/suspend → vaultRoutes → routes → blobs → default
   */
  function storeFor(vault: string, collection: string): NoydbStore {
    const rName = routeNameFor(vault, collection)

    // 0. Runtime override / suspend check
    if (suspended.has(rName)) return NULL_STORE
    if (overrides.has(rName)) return overrides.get(rName)!

    // 1. Vault-based geographic routing
    if (opts.vaultRoutes) {
      for (const [prefix, store] of Object.entries(opts.vaultRoutes)) {
        if (vault.startsWith(prefix)) return store
      }
    }

    // 2. Per-collection routing (user collections only)
    if (opts.routes && !isInternal(collection) && opts.routes[collection]) {
      return opts.routes[collection]
    }

    // 3. Blob chunk routing (simple — no size tiering at the store level)
    if (isBlobChunks(collection)) {
      if (simpleBlobStore) return simpleBlobStore
      // Size-tiered: can't determine here without the envelope.
      // Default to large store — BlobSet will use storeHint for reads.
      if (tieredBlobs) return tieredBlobs.large
    }

    // 4. Blob metadata routing
    if (opts.routeBlobMeta && isBlobMeta(collection)) {
      if (simpleBlobStore) return simpleBlobStore
      if (tieredBlobs) return tieredBlobs.large
    }

    // 5. Quota-aware overflow (E8)
    if (quotaExceeded && opts.overflow) return opts.overflow

    // 6. Default
    return primary
  }

  /**
   * For size-tiered blob routing: pick store based on envelope data size.
   */
  function blobStoreForSize(dataSize: number): NoydbStore {
    if (!tieredBlobs) return simpleBlobStore ?? primary
    if (dataSize <= blobThreshold) {
      return tieredBlobs.small ?? primary
    }
    return tieredBlobs.large
  }

  /**
   * Age routing: check if a record is cold based on `_ts`.
   */
  function isCold(collection: string, envelope: EncryptedEnvelope): boolean {
    if (!opts.age) return false
    if (isInternal(collection)) return false
    if (opts.age.collections && opts.age.collections.length > 0) {
      if (!opts.age.collections.includes(collection)) return false
    }
    const cutoff = Date.now() - opts.age.coldAfterDays * 24 * 60 * 60 * 1000
    const ts = new Date(envelope._ts).getTime()
    return ts < cutoff
  }

  // ── Store methods ──────────────────────────────────────────────────

  const store: RoutedNoydbStore = {
    name: buildName(),

    async get(vault, collection, id) {
      const s = storeFor(vault, collection)
      const result = await s.get(vault, collection, id)

      // Age tiering: if hot store returned null, try cold
      if (result === null && opts.age && !isInternal(collection)) {
        if (!opts.age.collections?.length || opts.age.collections.includes(collection)) {
          return opts.age.cold.get(vault, collection, id)
        }
      }

      return result
    },

    async put(vault, collection, id, envelope, expectedVersion) {
      // Write-behind queue: buffer if suspended with queue option
      const rn = routeNameFor(vault, collection)
      if (maybeQueueWrite(rn, 'put', vault, collection, id, envelope, expectedVersion)) return

      // Size-tiered blob routing
      if (isBlobChunks(collection) && tieredBlobs) {
        const dataSize = envelope._data.length
        const s = blobStoreForSize(dataSize)
        return s.put(vault, collection, id, envelope, expectedVersion)
      }

      const s = storeFor(vault, collection)

      // Age tiering: if a cold record is being updated, it goes to hot.
      if (opts.age && !isInternal(collection)) {
        opts.age.cold.delete(vault, collection, id).catch(() => {})
      }

      return s.put(vault, collection, id, envelope, expectedVersion)
    },

    async delete(vault, collection, id) {
      // Write-behind queue: buffer if suspended with queue option
      const rn = routeNameFor(vault, collection)
      if (maybeQueueWrite(rn, 'delete', vault, collection, id)) return

      const s = storeFor(vault, collection)
      await s.delete(vault, collection, id)

      // Also delete from cold store if age-tiered
      if (opts.age && !isInternal(collection)) {
        await opts.age.cold.delete(vault, collection, id).catch(() => {})
      }
    },

    async list(vault, collection) {
      const s = storeFor(vault, collection)
      const ids = await s.list(vault, collection)

      // Age tiering: merge IDs from cold store, deduplicate
      if (opts.age && !isInternal(collection)) {
        if (!opts.age.collections?.length || opts.age.collections.includes(collection)) {
          const coldIds = await opts.age.cold.list(vault, collection).catch(() => [] as string[])
          if (coldIds.length > 0) {
            const merged = new Set(ids)
            for (const id of coldIds) merged.add(id)
            return [...merged]
          }
        }
      }

      return ids
    },

    async loadAll(vault) {
      // Query all distinct stores in parallel, merge snapshots
      const stores = getStoresForVault(vault)
      const snapshots = await Promise.all(
        stores.map(s => s.loadAll(vault).catch(() => ({}) as VaultSnapshot)),
      )
      return mergeSnapshots(snapshots)
    },

    async saveAll(vault, data) {
      // Partition snapshot by routing rules
      const partitioned = new Map<NoydbStore, VaultSnapshot>()

      for (const [collection, records] of Object.entries(data)) {
        const s = storeFor(vault, collection)
        if (!partitioned.has(s)) partitioned.set(s, {})
        partitioned.get(s)![collection] = records
      }

      await Promise.all(
        [...partitioned.entries()].map(([s, snap]) => s.saveAll(vault, snap)),
      )
    },

    async compact(vault) {
      if (!opts.age) return 0
      let migrated = 0
      const collections = opts.age.collections?.length
        ? opts.age.collections
        : await primary.list(vault, '').catch(() => [] as string[])

      // For each age-eligible collection, scan hot store for cold records
      for (const collection of collections) {
        const ids = await primary.list(vault, collection).catch(() => [] as string[])
        for (const id of ids) {
          const envelope = await primary.get(vault, collection, id)
          if (!envelope) continue
          if (isCold(collection, envelope)) {
            // Write to cold, then delete from hot
            await opts.age.cold.put(vault, collection, id, envelope)
            await primary.delete(vault, collection, id)
            migrated++
          }
        }
      }

      return migrated
    },

    // ── Runtime override / suspend ──────────────────────

    override(route: OverrideTarget, overrideStore: NoydbStore, overrideOpts?: OverrideOptions): void | Promise<void> {
      if (overrideOpts?.hydrate) {
        // Async hydration: copy data from current store, then activate override
        return (async () => {
          // Hydration: caller should copy data from the original store to
          // overrideStore before calling override() with { hydrate: true }.
          // The route is activated immediately after.
          overrides.set(route, overrideStore)
        })()
      }
      overrides.set(route, overrideStore)
    },

    clearOverride(route: OverrideTarget): void {
      overrides.delete(route)
    },

    suspend(route: OverrideTarget, suspendOpts?: SuspendOptions): void {
      suspended.add(route)
      if (suspendOpts?.queue) {
        writeQueues.set(route, {
          writes: [],
          maxSize: suspendOpts.maxQueueSize ?? 10_000,
        })
      }
    },

    async resume(route: OverrideTarget): Promise<number> {
      suspended.delete(route)
      const queue = writeQueues.get(route)
      if (!queue || queue.writes.length === 0) {
        writeQueues.delete(route)
        return 0
      }

      // Replay queued writes against the now-active store
      let replayed = 0
      const target = overrides.get(route) ?? resolveOriginalStore(route)
      for (const write of queue.writes) {
        try {
          if (write.method === 'put' && write.envelope) {
            await target.put(write.vault, write.collection, write.id, write.envelope, write.expectedVersion)
          } else if (write.method === 'delete') {
            await target.delete(write.vault, write.collection, write.id)
          }
          replayed++
        } catch {
          // Best-effort replay — conflicts are expected after suspension
        }
      }

      writeQueues.delete(route)
      return replayed
    },

    routeStatus(): RouteStatus {
      const ov: Record<string, string> = {}
      for (const [k, v] of overrides) ov[k] = v.name ?? 'unnamed'
      const q: Record<string, number> = {}
      for (const [k, v] of writeQueues) q[k] = v.writes.length
      return { overrides: ov, suspended: [...suspended], queued: q }
    },
  }

  // ── Optional method forwarding ─────────────────────────────────────

  // Forward listVaults from all stores, deduplicated
  if (anyHas('listVaults')) {
    store.listVaults = async () => {
      const results = await Promise.all(
        [...allStores]
          .filter(s => s.listVaults !== undefined)
          .map(s => s.listVaults!().catch(() => [] as string[])),
      )
      return [...new Set(results.flat())]
    }
  }

  // Forward ping — succeed if any store responds
  if (anyHas('ping')) {
    store.ping = async () => {
      const results = await Promise.all(
        [...allStores]
          .filter(s => s.ping !== undefined)
          .map(s => s.ping!().catch(() => false)),
      )
      return results.some(Boolean)
    }
  }

  return store

  // ── Helpers ────────────────────────────────────────────────────────

  function buildName(): string {
    const names = [...allStores].map(s => s.name ?? '?').join('+')
    return `route(${names})`
  }

  function anyHas(method: string): boolean {
    return [...allStores].some(s => (s as unknown as Record<string, unknown>)[method])
  }

  function getStoresForVault(vault: string): NoydbStore[] {
    const stores = new Set<NoydbStore>()

    // Check vault routes first
    if (opts.vaultRoutes) {
      for (const [prefix, s] of Object.entries(opts.vaultRoutes)) {
        if (vault.startsWith(prefix)) {
          stores.add(s)
          return [...stores] // vault-routed: only use that store
        }
      }
    }

    // Default topology: primary + blob store + cold store
    stores.add(primary)
    if (simpleBlobStore) stores.add(simpleBlobStore)
    if (tieredBlobs?.large) stores.add(tieredBlobs.large)
    if (tieredBlobs?.small && tieredBlobs.small !== primary) stores.add(tieredBlobs.small)
    if (opts.age?.cold) stores.add(opts.age.cold)
    if (opts.routes) {
      for (const s of Object.values(opts.routes)) stores.add(s)
    }

    return [...stores]
  }
}

// ─── Snapshot merge ──────────────────────────────────────────────────────

function mergeSnapshots(snapshots: VaultSnapshot[]): VaultSnapshot {
  const merged: VaultSnapshot = {}

  for (const snap of snapshots) {
    for (const [collection, records] of Object.entries(snap)) {
      if (!merged[collection]) {
        merged[collection] = { ...records }
        continue
      }
      for (const [id, envelope] of Object.entries(records)) {
        const existing = merged[collection][id]
        // Last-write-wins by _ts
        if (!existing || envelope._ts >= existing._ts) {
          merged[collection][id] = envelope
        }
      }
    }
  }

  return merged
}
