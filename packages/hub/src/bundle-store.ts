import type { NoydbStore, NoydbBundleStore, VaultSnapshot, EncryptedEnvelope } from './types.js'
import { ConflictError, BundleVersionConflictError } from './errors.js'

// ─── Bundle format ─────────────────────────────────────────────────────

const BUNDLE_STORE_VERSION = 1 as const

/**
 * Wire format written by `wrapBundleStore`. A JSON-serialised object that
 * contains the entire `VaultSnapshot` (all encrypted envelopes) plus a small
 * header for integrity checking. The envelopes inside are already AES-GCM
 * encrypted by core — the bundle bytes themselves are not additionally
 * encrypted, but they are safe to store on untrusted blob hosts because
 * every record inside is already ciphertext.
 *
 * @internal
 */
interface BundleStoreData {
  readonly _noydb_bundle_store: typeof BUNDLE_STORE_VERSION
  readonly vault: string
  readonly ts: string
  readonly data: VaultSnapshot
}

// ─── Options ───────────────────────────────────────────────────────────

export interface WrapBundleStoreOptions {
  /**
   * When `true` (default), every `put()` and `delete()` flushes the full
   * vault snapshot to the bundle backend. Set to `false` for bulk operations
   * and call `store.flush(vaultId)` manually.
   */
  autoFlush?: boolean
}

// ─── Extended NoydbStore with flush/batch ───────────────────────────────

export interface WrappedBundleNoydbStore extends NoydbStore {
  /** Manually flush the in-memory snapshot to the bundle backend. */
  flush(vaultId: string): Promise<void>
  /**
   * Run a batch of mutations without flushing until the callback completes.
   * A single flush is performed at the end.
   */
  batch(vaultId: string, fn: () => Promise<void>): Promise<void>
}

// ─── wrapBundleStore ───────────────────────────────────────────────────

const MAX_CONFLICT_RETRIES = 3

/**
 * Convert a `NoydbBundleStore` (blob-oriented read/write with OCC) into the
 * standard six-method `NoydbStore` interface expected by `createNoydb({ store })`.
 *
 * Bundle stores operate on the entire vault as a single serialised unit —
 * ideal for backends like Google Drive, WebDAV, or iCloud Drive that work
 * best with whole-file I/O rather than per-record KV operations.
 *
 * ## Optimistic concurrency
 *
 * The wrapper tracks the `version` token from the last `readBundle` and
 * passes it as `expectedVersion` on every flush. On
 * `BundleVersionConflictError`, it re-reads, merges the remote snapshot
 * (last-write-wins per record key), and retries (max 3 attempts).
 *
 * ## Flush modes
 *
 * By default, flushes on every mutation (O(vault size) per write). Options:
 * - `autoFlush: false` + explicit `store.flush(vaultId)` calls
 * - `store.batch(vaultId, async () => { ... })` — defers flush until end
 * - Pair with `syncPolicy: { push: { mode: 'debounce' } }` from #101
 */
export function wrapBundleStore(
  bundle: NoydbBundleStore,
  options?: WrapBundleStoreOptions,
): WrappedBundleNoydbStore {
  const autoFlush = options?.autoFlush !== false

  // Per-vault state
  const snapshots = new Map<string, VaultSnapshot>()
  const versions = new Map<string, string | null>()
  const loaded = new Set<string>()

  // Batch mode: when > 0, suppress auto-flush
  let batchDepth = 0

  async function load(vault: string): Promise<VaultSnapshot> {
    if (loaded.has(vault)) return snapshots.get(vault)!

    const result = await bundle.readBundle(vault)
    if (result) {
      const text = new TextDecoder().decode(result.bytes)
      const format = JSON.parse(text) as BundleStoreData
      snapshots.set(vault, format.data)
      versions.set(vault, result.version)
    } else {
      snapshots.set(vault, {})
      versions.set(vault, null)
    }

    loaded.add(vault)
    return snapshots.get(vault)!
  }

  async function flush(vault: string): Promise<void> {
    const snapshot = snapshots.get(vault) ?? {}
    const format: BundleStoreData = {
      _noydb_bundle_store: BUNDLE_STORE_VERSION,
      vault,
      ts: new Date().toISOString(),
      data: snapshot,
    }
    const bytes = new TextEncoder().encode(JSON.stringify(format))
    const expectedVersion = versions.get(vault) ?? null

    for (let attempt = 0; attempt < MAX_CONFLICT_RETRIES; attempt++) {
      try {
        const { version: newVersion } = await bundle.writeBundle(vault, bytes, expectedVersion)
        versions.set(vault, newVersion)
        return
      } catch (err) {
        if (err instanceof BundleVersionConflictError && attempt < MAX_CONFLICT_RETRIES - 1) {
          // Pull remote, merge (last-write-wins by record key), retry
          const remote = await bundle.readBundle(vault)
          if (remote) {
            const remoteText = new TextDecoder().decode(remote.bytes)
            const remoteFormat = JSON.parse(remoteText) as BundleStoreData
            const localSnap = snapshots.get(vault) ?? {}
            const mergedSnap = mergeSnapshots(remoteFormat.data, localSnap)
            snapshots.set(vault, mergedSnap)
            versions.set(vault, remote.version)
          }
          // Re-encode with merged data for the retry
          continue
        }
        throw err
      }
    }
  }

  async function maybeFlush(vault: string): Promise<void> {
    if (autoFlush && batchDepth === 0) {
      await flush(vault)
    }
  }

  const store: WrappedBundleNoydbStore = {
    name: bundle.name ?? 'bundle',

    async flush(vaultId: string): Promise<void> {
      await flush(vaultId)
    },

    async batch(vaultId: string, fn: () => Promise<void>): Promise<void> {
      await load(vaultId) // ensure loaded before batch
      batchDepth++
      try {
        await fn()
      } finally {
        batchDepth--
      }
      await flush(vaultId)
    },

    async get(vault: string, collection: string, id: string): Promise<EncryptedEnvelope | null> {
      const snap = await load(vault)
      return snap[collection]?.[id] ?? null
    },

    async put(
      vault: string,
      collection: string,
      id: string,
      envelope: EncryptedEnvelope,
      expectedVersion?: number,
    ): Promise<void> {
      const snap = await load(vault)

      if (expectedVersion !== undefined) {
        const current = snap[collection]?.[id]
        const currentVersion = current?._v ?? 0
        if (currentVersion !== expectedVersion) {
          throw new ConflictError(
            currentVersion,
            `Expected version ${expectedVersion} but found ${currentVersion} on ${collection}/${id}`,
          )
        }
      }

      snap[collection] ??= {}
      snap[collection]![id] = envelope
      await maybeFlush(vault)
    },

    async delete(vault: string, collection: string, id: string): Promise<void> {
      const snap = await load(vault)
      if (snap[collection]) {
        delete snap[collection]![id]
        await maybeFlush(vault)
      }
    },

    async list(vault: string, collection: string): Promise<string[]> {
      const snap = await load(vault)
      return Object.keys(snap[collection] ?? {})
    },

    async loadAll(vault: string): Promise<VaultSnapshot> {
      return await load(vault)
    },

    async saveAll(vault: string, data: VaultSnapshot): Promise<void> {
      snapshots.set(vault, data)
      loaded.add(vault)
      await flush(vault)
    },
  }

  return store
}

// ─── Snapshot merge (last-write-wins per record) ────────────────────────

function mergeSnapshots(remote: VaultSnapshot, local: VaultSnapshot): VaultSnapshot {
  const merged: VaultSnapshot = {}

  // Start with all remote collections
  for (const [coll, records] of Object.entries(remote)) {
    merged[coll] = { ...records }
  }

  // Overlay local collections — LWW by _ts per record
  for (const [coll, records] of Object.entries(local)) {
    if (!merged[coll]) {
      merged[coll] = { ...records }
      continue
    }
    for (const [id, envelope] of Object.entries(records)) {
      const existing = merged[coll]![id]
      if (!existing || envelope._ts >= existing._ts) {
        merged[coll]![id] = envelope
      }
    }
  }

  return merged
}

// ─── Factory helper ─────────────────────────────────────────────────────

/**
 * Type-safe factory helper for `NoydbBundleStore` implementations,
 * analogous to `createStore` for KV stores.
 */
export function createBundleStore<TOptions>(
  factory: (options: TOptions) => NoydbBundleStore,
): (options: TOptions) => NoydbBundleStore {
  return factory
}
