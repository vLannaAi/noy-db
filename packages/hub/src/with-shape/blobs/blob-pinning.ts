/**
 * #808 — device-local blob pin registry + external side-cache + KPI counters.
 *
 * Pinning marks a blob slot "keep this available offline" **for this device
 * only**. Pin state is intentionally NEVER written to the vault's
 * `NoydbStore` — the vault store is the synced/shared substrate, and each
 * device pins for itself. Instead, `withBlobs()` owns one {@link BlobPinCache}
 * per strategy instance and threads it into every `BlobSet` it opens; the
 * registry rows live in a pluggable {@link BlobPinStore}.
 *
 * The default backend is in-memory ({@link memoryBlobPinStore}) — the hub has
 * NO device-persistence idiom of its own (it never touches IndexedDB or any
 * Node fs API; persistence backends are the `to-*` package family), so a
 * durable registry is supplied by the consumer:
 * `withBlobs({ pinStore: myIdbBackedStore })`. The interface is four async
 * methods, deliberately trivial to implement over IndexedDB / SQLite / a file.
 *
 * ## What a registry row holds
 *
 * One row per `{vault, collection, record, slot}` ({@link blobPinKey}):
 *  - the pin flag + timestamps (LRU input for the cache-budget pass), and
 *  - for `external: true` slots, the **local encrypted copy** of the object's
 *    bytes ({@link BlobPinEntry.cipher}). The object-store copy of an external
 *    blob lives OUTSIDE the zero-knowledge envelope by design; the local copy
 *    does NOT — it is AES-256-GCM-encrypted under the vault's `_blob` DEK
 *    through the same enclave path that encrypts blob chunks
 *    (`encryptBytesWithAAD`, AAD-bound to the row's pin key), so a stolen
 *    device store leaks nothing the vault store wouldn't.
 *
 * Internal (chunked) blobs never store bytes here — their ciphertext already
 * lives in `_blob_chunks`; the registry only carries their pin flag and
 * access times.
 *
 * @module
 */

/** One device-local registry row — see the module doc for the field posture. */
export interface BlobPinEntry {
  /** Slot is pinned for offline on THIS device. */
  readonly pinned: boolean
  /** ISO timestamp of the pin (absent when not pinned). */
  readonly pinnedAt?: string
  /** ISO timestamp of the last local read — LRU input for the budget pass. */
  readonly lastAccessAt?: string
  /** Plaintext byte length of the cached external copy (external slots only). */
  readonly cachedBytes?: number
  /**
   * Encrypted local copy of an external slot's bytes: base64 IV + base64
   * AES-256-GCM ciphertext under the vault's `_blob` DEK, AAD-bound to the
   * row's {@link blobPinKey}. On an UNENCRYPTED vault (`encrypt: false`) the
   * fallback mirrors the envelope convention: `iv === ''`, `data` = base64
   * plaintext.
   */
  readonly cipher?: { readonly iv: string; readonly data: string }
}

/**
 * Pluggable device-local backend for the pin registry (#808). Implementations
 * MUST be device-local (never synced) — an IndexedDB- or file-backed store is
 * the expected production shape; {@link memoryBlobPinStore} is the default.
 */
export interface BlobPinStore {
  get(key: string): Promise<BlobPinEntry | null>
  set(key: string, entry: BlobPinEntry): Promise<void>
  delete(key: string): Promise<void>
  /** All rows whose key starts with `prefix` (`''` = every row). */
  entries(prefix: string): Promise<Array<{ key: string; entry: BlobPinEntry }>>
}

/**
 * In-memory {@link BlobPinStore} — the default. Pin state then lasts for the
 * strategy instance's lifetime (one app session); pass a durable store to
 * `withBlobs({ pinStore })` to keep pins across restarts.
 */
export function memoryBlobPinStore(): BlobPinStore {
  const rows = new Map<string, BlobPinEntry>()
  return {
    async get(key) {
      return rows.get(key) ?? null
    },
    async set(key, entry) {
      rows.set(key, entry)
    },
    async delete(key) {
      rows.delete(key)
    },
    async entries(prefix) {
      const out: Array<{ key: string; entry: BlobPinEntry }> = []
      for (const [key, entry] of rows) {
        if (key.startsWith(prefix)) out.push({ key, entry })
      }
      return out
    },
  }
}

/**
 * Device-local blob-cache KPI counters (#808) — read via
 * `withBlobs().cacheStats()`. "Local" reads (internal chunks, cached external
 * copies) count as hits; network fetches from the object store count as
 * misses and add to `bytesDownloaded` (the 4G-budget number).
 */
export interface BlobCacheStats {
  readonly hits: number
  readonly misses: number
  readonly bytesDownloaded: number
}

/**
 * The per-strategy bundle `withBlobs()` threads into every `BlobSet`: the
 * registry backend plus the shared mutable KPI counters.
 *
 * @internal
 */
export interface BlobPinCache {
  readonly store: BlobPinStore
  readonly stats: { hits: number; misses: number; bytesDownloaded: number }
}

/** @internal */
export function createBlobPinCache(store?: BlobPinStore): BlobPinCache {
  return {
    store: store ?? memoryBlobPinStore(),
    stats: { hits: 0, misses: 0, bytesDownloaded: 0 },
  }
}

/**
 * Registry key for one slot's row: `{vault}::{collection}::{record}::{slot}`
 * (the blobs' established `::` separator — record ids and slot names are
 * already `::`-refused at the write surface, see `assertKeyPartSafe`).
 * Omitting `slotName` yields the record's row PREFIX (for per-record scans).
 */
export function blobPinKey(vault: string, collection: string, recordId: string, slotName?: string): string {
  const prefix = `${vault}::${collection}::${recordId}::`
  return slotName === undefined ? prefix : prefix + slotName
}
