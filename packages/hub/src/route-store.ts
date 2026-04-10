/**
 * Store router / multiplexer (v0.12 #162).
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
  ListPageResult,
} from './types.js'

// ─── Internal collection prefixes (duplicated to avoid circular import) ──

const BLOB_CHUNKS = '_blob_chunks'
const BLOB_INDEX = '_blob_index'
const BLOB_SLOTS = '_blob_slots_'
const BLOB_VERSIONS = '_blob_versions_'

// ─── Options ─────────────────────────────────────────────────────────────

export interface BlobStoreRoute {
  /** Store for small blobs (under threshold). Falls back to `default`. */
  readonly small?: NoydbStore
  /** Store for large blobs (over threshold). */
  readonly large: NoydbStore
  /** Size threshold in bytes. Default: `400 * 1024` (DynamoDB item limit). */
  readonly threshold?: number
}

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
}

// ─── Types ───────────────────────────────────────────────────────────────

export interface RoutedNoydbStore extends NoydbStore {
  /**
   * Migrate records older than the age cutoff from the hot store to the
   * cold store. Only applies when `age` is configured. Returns the number
   * of records migrated.
   */
  compact(vault: string): Promise<number>
}

// ─── Implementation ──────────────────────────────────────────────────────

export function routeStore(opts: RouteStoreOptions): RoutedNoydbStore {
  const primary = opts.default

  // Resolve blob store config
  const blobsIsSimple = opts.blobs && 'get' in opts.blobs
  const simpleBlobStore = blobsIsSimple ? (opts.blobs as NoydbStore) : undefined
  const tieredBlobs = !blobsIsSimple ? (opts.blobs as BlobStoreRoute | undefined) : undefined
  const blobThreshold = tieredBlobs?.threshold ?? 400 * 1024

  // Collect all stores for loadAll/saveAll/listVaults composition
  const allStores = new Set<NoydbStore>([primary])
  if (simpleBlobStore) allStores.add(simpleBlobStore)
  if (tieredBlobs?.large) allStores.add(tieredBlobs.large)
  if (tieredBlobs?.small) allStores.add(tieredBlobs.small)
  if (opts.age?.cold) allStores.add(opts.age.cold)
  if (opts.routes) for (const s of Object.values(opts.routes)) allStores.add(s)
  if (opts.vaultRoutes) for (const s of Object.values(opts.vaultRoutes)) allStores.add(s)

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
   * Resolution order: vaultRoutes → routes → blobs → default
   */
  function storeFor(vault: string, collection: string): NoydbStore {
    // 1. Vault-based geographic routing
    if (opts.vaultRoutes) {
      for (const [prefix, store] of Object.entries(opts.vaultRoutes)) {
        if (vault.startsWith(prefix)) return store
      }
    }

    // 2. Per-collection routing (user collections only)
    if (opts.routes && !isInternal(collection) && opts.routes[collection]) {
      return opts.routes[collection]!
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

    // 5. Default
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
      // Size-tiered blob routing
      if (isBlobChunks(collection) && tieredBlobs) {
        const dataSize = envelope._data.length // base64 length ≈ 4/3 of raw bytes
        const s = blobStoreForSize(dataSize)
        return s.put(vault, collection, id, envelope, expectedVersion)
      }

      const s = storeFor(vault, collection)

      // Age tiering: if a cold record is being updated, it goes to hot.
      // Delete from cold store (best-effort, compact() will clean up).
      if (opts.age && !isInternal(collection)) {
        opts.age.cold.delete(vault, collection, id).catch(() => {})
      }

      return s.put(vault, collection, id, envelope, expectedVersion)
    },

    async delete(vault, collection, id) {
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
  }

  // ── Optional method forwarding ─────────────────────────────────────

  // Forward listVaults from all stores, deduplicated
  if (anyHas('listVaults')) {
    store.listVaults = async () => {
      const results = await Promise.all(
        [...allStores]
          .filter(s => s.listVaults)
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
          .filter(s => s.ping)
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
    return [...allStores].some(s => (s as Record<string, unknown>)[method])
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
        const existing = merged[collection]![id]
        // Last-write-wins by _ts
        if (!existing || envelope._ts >= existing._ts) {
          merged[collection]![id] = envelope
        }
      }
    }
  }

  return merged
}
