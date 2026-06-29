/**
 * `withForgetCascade` — declaration surface for GDPR right-to-erasure via
 * per-record CEK crypto-shred (#304, step 2 of the CEK security epic).
 *
 * This file holds only the *declaration* shape and the disabled sentinel.
 * The actual erasure machinery lives in:
 *   - `subject-index.ts` — the encrypted `_subject_index` reserved collection
 *   - `vault.ts` `forget()` — the per-record tombstone + ledger flow
 *   - `collection.ts` `_writeTombstone` — the envelope rewrite
 *
 * A `ForgetStrategy` declares which collections carry erasable subject data
 * and the (dotted-path) field on each record that names the data subject.
 * Declaring a collection here ALSO forces `perRecordKeys: true` for it (a
 * shred can only erase a record whose body is keyed off a per-record CEK),
 * so adopters opt into the CEK foundation transitively.
 *
 * @module
 */
import type { LedgerEntry } from '../history/ledger/entry.js'

/**
 * User-supplied declaration passed to {@link withForgetCascade}. Maps a
 * collection name to the record field (dotted path supported, e.g.
 * `'billing.buyerId'`) that identifies the data subject for erasure.
 *
 * ```ts
 * withForgetCascade({ subjects: { invoices: 'buyerId', contacts: 'id' } })
 * ```
 */
export interface SubjectDeclaration {
  readonly subjects: Record<string, string>
}

/**
 * Resolved forget strategy threaded through Noydb → every Vault. Carries
 * the same `subjects` map the user declared. `NO_FORGET` (empty map) is the
 * off-by-default sentinel; `vault.forget()` throws
 * `ForgetStrategyNotConfiguredError` when the map is empty.
 */
export interface ForgetStrategy {
  /** Collection → subject-field (dotted path). Empty under `NO_FORGET`. */
  readonly subjects: Readonly<Record<string, string>>
}

/**
 * Disabled sentinel — no collections declare a subject field. `vault.forget()`
 * refuses with `ForgetStrategyNotConfiguredError`; no write hooks register; no
 * collection is forced into `perRecordKeys`. Non-adopters pay nothing.
 */
export const NO_FORGET: ForgetStrategy = { subjects: {} }

/**
 * Declare GDPR crypto-shred for one or more collections.
 *
 * Each declared collection is forced to `perRecordKeys: true` (a shred can
 * only guarantee erasure of a record whose body is keyed off a per-record
 * CEK). On write, Noydb extracts `record[subjectField]` and maintains an
 * encrypted `_subject_index` mapping `subject → [{collection, id}]`, so
 * `vault.forget(subjectId)` can find every record for a subject and rewrite
 * each to a tombstone (body + history permanently undecryptable) while the
 * collection DEK and every other record stay intact.
 *
 * @example
 * ```ts
 * createNoydb({
 *   secret, user,
 *   forgetStrategy: withForgetCascade({ subjects: { invoices: 'buyerId' } }),
 * })
 * const result = await vault.forget('buyer-123')
 * // → { subject, recordsShredded, historyVersionsShredded, collections, … }
 * ```
 */
export function withForgetCascade(opts: SubjectDeclaration): ForgetStrategy {
  return { subjects: { ...opts.subjects } }
}

/**
 * The outcome of a `vault.forget(subjectId)` call.
 *
 * `unmigratedRecords` lists `collection:id` pairs that were tombstoned but
 * whose body had NOT been migrated to a per-record CEK at shred time (legacy
 * body still under the shared collection DEK). Those records are tombstoned
 * (live envelope + history stripped) but their pre-shred ciphertext, if it
 * leaked into a backup before migration, remains decryptable under the
 * collection DEK — so erasure-completeness is NOT guaranteed for them. Run
 * the per-record-CEK migration pass, then re-forget, to close the gap.
 *
 * Blob attachments (#365): a shredded record's **erasable** blobs (on a
 * `perRecordKeys` collection) are crypto-shredded inline — `blobsShredded`
 * counts those taken to refCount 0 (BlobObject deleted → chunks permanently
 * undecryptable), `blobsRetainedShared` counts those still referenced by
 * another record (shared content legitimately persists for its other owner).
 * `blobResidueCollections` now lists only collections with blobs that could
 * NOT be crypto-shredded: **legacy** blobs (no per-blob `_cek`, chunks under
 * the shared `_blob` DEK — migrate them), or a session without the blob
 * subsystem loaded. An all-erasable subject yields an empty residue list.
 */
export interface ForgetResult {
  /** The subject id passed to `forget()`. Echoed for caller convenience. */
  readonly subject: string
  /** Count of live records rewritten to a tombstone. */
  readonly recordsShredded: number
  /** Count of `_history` envelopes tombstoned across all shredded records. */
  readonly historyVersionsShredded: number
  /** Distinct collections that had at least one record shredded. */
  readonly collections: readonly string[]
  /** `collection:id` pairs shredded while still un-migrated (see type docs). */
  readonly unmigratedRecords: readonly string[]
  /** Count of erasable blobs crypto-shredded (refCount → 0, BlobObject deleted). */
  readonly blobsShredded: number
  /** Count of erasable blobs retained because still referenced elsewhere (shared). */
  readonly blobsRetainedShared: number
  /** Collections with blobs that could NOT be crypto-shredded — legacy (no `_cek`) or blobs disabled (see type docs). */
  readonly blobResidueCollections: readonly string[]
  /**
   * Count of persisted `_idx/<field>/<recordId>` index side-cars hard-deleted
   * across the shredded records (#401). These live under the retained
   * collection DEK, so crypto-shred alone would leave the indexed field VALUES
   * readable — `forget()` must delete them.
   */
  readonly indexPostingsPurged: number
  /**
   * `collection:id:field` entries whose persisted `_idx` side-car could NOT be
   * deleted (#401) — index residue that still leaks the indexed value under the
   * retained collection DEK. Non-empty means erasure is INCOMPLETE: retry, or
   * purge the side-car out of band.
   */
  readonly indexResidue: readonly string[]
  /**
   * Count of `_sealed[field]` slots dropped from the live store across the
   * shredded records (#306). For slots written under `sensitive` +
   * `perRecordKeys` (the current path), the key derives off the per-record CEK,
   * so tombstoning the record — which drops `_cek` and `_sealed` — also
   * crypto-shreds the value. A slot left over from a pre-#306 write keys off the
   * collection DEK instead, so dropping it removes it from the live store but a
   * pre-forget backup remains recoverable by a DEK holder (same caveat `_data`
   * carries); migrate by re-`put`ting before forgetting for full crypto-shred.
   */
  readonly sealedFieldsShredded: number
  /** The single `op:'forget'` ledger entry appended for this erasure. */
  readonly ledgerEntry: LedgerEntry
}
