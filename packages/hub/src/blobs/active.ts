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

import { BlobSet } from './blob-set.js'
import type { BlobStrategy } from './strategy.js'

/**
 * Build a default `BlobStrategy` ready to pass into `createNoydb`.
 *
 * Named `withBlobs` (plugin-pattern canonical) rather than `blobs` to
 * avoid shadowing the very common local idiom
 * `const blobs = invoices.blob(id)` in user code.
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
export function withBlobs(): BlobStrategy {
  return {
    openSlot(args) {
      return new BlobSet(args)
    },
  }
}
