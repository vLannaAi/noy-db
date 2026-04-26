/**
 * `vault.exportBlobs()` — bulk blob extraction primitive.
 *
 * Async-iterable handle over every blob attached to records in a
 * vault, optionally filtered by collection allowlist and per-record
 * predicate. Emits tuples of `{ blobId, recordRef, bytes, meta }` so
 * the consumer can pipe into any sink (zip stream, S3 multipart, USB
 * copy, cold-storage tape) without pulling the whole export into
 * memory.
 *
 * ## Auth + audit
 *
 * - Capability check runs **once** at handle creation via
 *   `Vault.assertCanExport('plaintext', 'blob')`. An operator whose
 *   keyring lacks that bit fails before a single byte of ciphertext
 *   is decrypted.
 * - Audit entry lands in `_export_audit` at handle creation: the
 *   actor, start timestamp, target collections, predicate presence,
 *   and batch mechanism. **No content hashes** — per the spec
 *   non-correlation invariant.
 *
 * ## Abort + resume
 *
 * - `handle.abort()` flips the internal signal; the next iteration
 *   boundary throws `AbortError`. Consumers already in `for await`
 *   can catch and exit cleanly.
 * - Restart after a partial failure with `{ afterBlobId }` — the
 *   iterator skips tuples up to (and including) that blob id before
 *   yielding again. Combined with a blob-count ceiling it supports
 *   idempotent batch re-runs.
 *
 * @module
 */

import type { Collection } from '../collection.js'
import type { SlotInfo } from '../types.js'

// ─── Types ──────────────────────────────────────────────────────────────

export interface ExportBlobsOptions {
  /**
   * Collection allowlist. Omit to export blobs from every collection
   * the caller has read access to.
   */
  readonly collections?: readonly string[]
  /**
   * Per-record predicate. Called on the decrypted record BEFORE any
   * blob bytes are read for that record — returning false skips the
   * record and all its slots without touching their chunks.
   */
  readonly where?: (record: unknown, context: { collection: string; id: string }) => boolean
  /**
   * Resume after a specific blob id. The iterator skips tuples up to
   * and including this id, then yields. Format of the id is the same
   * as `ExportedBlob.blobId` (the HMAC-keyed eTag).
   */
  readonly afterBlobId?: string
  /**
   * External abort signal. When fired, the next iterator tick throws
   * `ExportBlobsAbortedError`. Honored alongside `handle.abort()`.
   */
  readonly signal?: AbortSignal
}

export interface ExportedBlob {
  /** Opaque blob identifier — HMAC-keyed eTag, stable across vaults. */
  readonly blobId: string
  /** Where this blob came from in the vault. */
  readonly recordRef: {
    readonly collection: string
    readonly id: string
    readonly slot: string
  }
  /** Decrypted plaintext bytes. */
  readonly bytes: Uint8Array
  /** Best-effort metadata (from the blob slot record). */
  readonly meta: {
    readonly size: number
    /**
     * User-visible filename stored on the slot. Often equal to the
     * slot name; differs when the caller supplied an explicit
     * `filename` to `BlobSet.put()`.
     */
    readonly filename: string
    readonly mimeType?: string
    readonly createdAt?: string
  }
}

export interface ExportBlobsHandle extends AsyncIterable<ExportedBlob> {
  /** Abort the export. Safe to call multiple times. */
  abort(): void
  /** True once `abort()` has fired or the external signal aborted. */
  readonly aborted: boolean
}

export class ExportBlobsAbortedError extends Error {
  constructor(reason: string) {
    super(`exportBlobs aborted: ${reason}`)
    this.name = 'ExportBlobsAbortedError'
  }
}

// ─── Audit ──────────────────────────────────────────────────────────────

export const EXPORT_AUDIT_COLLECTION = '_export_audit'

export interface ExportBlobsAuditEntry {
  readonly id: string
  readonly mechanism: 'exportBlobs'
  readonly actor: string
  readonly startedAt: string
  readonly collections: readonly string[] | null
  readonly predicate: boolean
  readonly afterBlobId: string | null
}

// ─── Implementation ─────────────────────────────────────────────────────

/**
 * Build the handle. Factored out of `Vault.exportBlobs` so the
 * implementation can be unit-tested without going through the
 * compartment lifecycle.
 */
export function createExportBlobsHandle(
  actor: string,
  listAccessibleCollections: () => Promise<string[]>,
  getCollection: <T>(name: string) => Collection<T>,
  writeAudit: (entry: ExportBlobsAuditEntry) => Promise<void>,
  options: ExportBlobsOptions,
): ExportBlobsHandle {
  let aborted = false

  const abort = (): void => {
    aborted = true
  }

  if (options.signal) {
    if (options.signal.aborted) aborted = true
    options.signal.addEventListener('abort', () => { aborted = true })
  }

  function assertLive(): void {
    if (aborted) throw new ExportBlobsAbortedError('aborted by caller')
  }

  const allowlist = options.collections ? new Set(options.collections) : null

  // Write the audit entry BEFORE the first yield so a blocked
  // iteration still leaves an audit trail that the export started.
  let auditPromise: Promise<void> | null = null
  function writeAuditOnce(): Promise<void> {
    if (!auditPromise) {
      auditPromise = writeAudit({
        id: generateBatchId(),
        mechanism: 'exportBlobs',
        actor,
        startedAt: new Date().toISOString(),
        collections: options.collections ?? null,
        predicate: Boolean(options.where),
        afterBlobId: options.afterBlobId ?? null,
      })
    }
    return auditPromise
  }

  async function* generate(): AsyncGenerator<ExportedBlob> {
    await writeAuditOnce()
    assertLive()

    // Resolve target collections lazily — also keeps the call async.
    const allCollections = await listAccessibleCollections()
    const targets = allCollections.filter(name => {
      if (name.startsWith('_')) return false
      if (allowlist && !allowlist.has(name)) return false
      return true
    })

    let resumeCursorHit = options.afterBlobId === undefined

    for (const collectionName of targets) {
      if (aborted) return

      const coll = getCollection<Record<string, unknown>>(collectionName)
      const records = await coll.list().catch(() => [])
      for (const record of records) {
        if (aborted) return
        assertLive()

        const idField = (record as { id?: unknown }).id
        if (typeof idField !== 'string') continue

        if (options.where && !options.where(record, { collection: collectionName, id: idField })) continue

        const blobSet = coll.blob(idField)
        const slots = await blobSet.list().catch(() => [] as SlotInfo[])
        for (const slot of slots) {
          if (aborted) return

          if (!resumeCursorHit) {
            if (slot.eTag === options.afterBlobId) {
              resumeCursorHit = true
            }
            continue
          }

          const bytes = await blobSet.get(slot.name)
          if (!bytes) continue

          const item: ExportedBlob = {
            blobId: slot.eTag,
            recordRef: { collection: collectionName, id: idField, slot: slot.name },
            bytes,
            meta: {
              size: slot.size,
              filename: slot.filename,
              ...(slot.mimeType !== undefined && { mimeType: slot.mimeType }),
              ...(slot.uploadedAt !== undefined && { createdAt: slot.uploadedAt }),
            },
          }
          yield item
        }
      }
    }
  }

  const handle: ExportBlobsHandle = {
    abort,
    get aborted() { return aborted },
    [Symbol.asyncIterator]: () => generate(),
  }
  return handle
}

// ─── Helpers ────────────────────────────────────────────────────────────

function generateBatchId(): string {
  // 16 bytes of crypto randomness, URL-safe base64, no padding.
  const raw = globalThis.crypto.getRandomValues(new Uint8Array(16))
  let s = ''
  for (const b of raw) s += b.toString(16).padStart(2, '0')
  return `batch-${Date.now().toString(36)}-${s.slice(0, 12)}`
}
