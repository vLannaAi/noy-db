/**
 * Active blob strategy factory. Calling `blobs()` returns a
 * `BlobStrategy` whose `openSlot` constructs a real `BlobSet` bound
 * to the caller's record. The returned strategy is passed into
 * `createNoydb({ blobStrategy: blobs() })` to light up the
 * `collection.blob(id)` path.
 *
 * This module is only reachable through the `@noy-db/hub/blobs`
 * subpath — a consumer that never imports the subpath ships none of
 * this (ESM tree-shaking + hub's `"sideEffects": false`).
 */

import { BlobSet } from '../../with-shape/blobs/blob-set.js'
import type { BlobStrategy } from '../../port/with/blob-strategy.js'
import { createBlobPinCache } from '../../with-shape/blobs/blob-pinning.js'
import type { BlobPinStore, BlobCacheStats } from '../../with-shape/blobs/blob-pinning.js'

/** Options for {@link withBlobs} (#808). */
export interface WithBlobsOptions {
  /**
   * Device-local backend for the offline-pin registry + external side-cache
   * (`collection.blob(id).pin()`, the `cacheBudget` LRU stamps). Default:
   * in-memory — pins then last one app session. Supply a durable,
   * DEVICE-LOCAL store (IndexedDB-backed on the web; it must never sync) to
   * keep pins across restarts. See `BlobPinStore`'s doc for the posture.
   */
  readonly pinStore?: BlobPinStore
}

/**
 * The strategy `withBlobs()` returns — a `BlobStrategy` plus the device-local
 * blob-cache KPI surface (#808).
 */
export interface BlobsService extends BlobStrategy {
  /**
   * Snapshot of this device's blob-cache KPI counters: local-read hits,
   * network misses, and total bytes downloaded from the object store.
   */
  cacheStats(): BlobCacheStats
}

/**
 * Build a default `BlobStrategy` ready to pass into `createNoydb`.
 *
 * Named `withBlobs` (plugin-pattern canonical) rather than `blobs` to
 * avoid shadowing the very common local idiom
 * `const blobs = invoices.blob(id)` in user code.
 *
 * One `withBlobs()` instance owns one device-local pin registry + KPI
 * counter set (#808) — treat it as "this device's" blob service.
 *
 * @example
 * ```ts
 * import { createNoydb } from '@noy-db/hub'
 * import { withBlobs } from '@noy-db/hub/blobs'
 *
 * const db = await createNoydb({
 *   store, user, secret,
 *   blobStrategy: withBlobs(),
 * })
 *
 * // Now live — delegates to BlobSet.
 * await db.vault('acme').collection('invoices').blob('inv-1').put('receipt.pdf', bytes)
 * ```
 */
export function withBlobs(options: WithBlobsOptions = {}): BlobsService {
  const pinCache = createBlobPinCache(options.pinStore)
  return {
    openSlot(args) {
      return new BlobSet({ ...args, pinCache })
    },
    cacheStats() {
      return { ...pinCache.stats }
    },
  }
}
