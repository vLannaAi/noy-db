/**
 * `withForget` — declaration surface for GDPR right-to-erasure via
 * per-record CEK crypto-shred.
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
import type { LedgerEntry } from '../../with-commit/history/ledger/entry.js'

/**
 * User-supplied declaration passed to {@link withForget}. Maps a
 * collection name to the record field (dotted path supported, e.g.
 * `'billing.buyerId'`) that identifies the data subject for erasure.
 *
 * ```ts
 * withForget({ subjects: { invoices: 'buyerId', contacts: 'id' } })
 * ```
 */
export interface SubjectDeclaration {
  readonly subjects: Record<string, string>
  /**
   * #633 — opt-in: gate the vault-level `_sealed_cek` and blob purges on
   * per-collection via declarations instead of running them unconditionally
   * for every forgotten ref. Default `false`/absent = today's unconditional
   * behavior (byte-identical). See `purge-scope.ts` for the partition logic
   * and the `scopedPurgeResidue` skip-reporting this enables.
   *
   * **Footgun:** a bare `sensitive: [...]` collection — no `classifiedFields`
   * (no classified via binder compiled in) — counts as UNDECLARED for the
   * sealed-CEK arm. Under `scopedPurge: true`, its `_sealed_cek` host-delivery
   * envelopes are SKIPPED, not purged (reported via `scopedPurgeResidue`,
   * reason `'skipped-undeclared-sealed-cek'`) even if that collection called
   * `sealRecordToHost()` — the sealed CEK stays recoverable by that granted
   * host until purged. Add a `classifiedFields` binding to close the gap, or
   * leave `scopedPurge` off/false for the unconditional (always-purged) default.
   * The declaration signal is session-local: a declared collection never opened
   * (with its config) before `forget()` in this session counts as UNDECLARED —
   * open it first, or its entries are skipped-and-reported.
   */
  readonly scopedPurge?: boolean
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
  /** #633 — see {@link SubjectDeclaration.scopedPurge}. */
  readonly scopedPurge?: boolean
}

/**
 * Disabled sentinel — no collections declare a subject field. `vault.forget()`
 * refuses with `ForgetStrategyNotConfiguredError`; no write hooks register; no
 * collection is forced into `perRecordKeys`. Non-adopters pay nothing.
 */
export const NO_FORGET: ForgetStrategy = { subjects: {} }

// The `withForget` factory lives in `active.ts` (canonical
// strategy.ts/active.ts/index.ts split); this file holds only the
// declaration shape + disabled sentinel.

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
 * Blob attachments: a shredded record's **erasable** blobs (on a
 * `perRecordKeys` collection) are crypto-shredded inline — `blobsShredded`
 * counts those taken to refCount 0 (BlobObject deleted → chunks permanently
 * undecryptable), `blobsRetainedShared` counts those still referenced by
 * another record (shared content legitimately persists for its other owner).
 * `blobResidueCollections` now lists only collections with blobs that could
 * NOT be crypto-shredded: **legacy** blobs (no per-blob `_cek`, chunks under
 * the shared `_blob` DEK — migrate them), or a session without the blob
 * service loaded. An all-erasable subject yields an empty residue list.
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
   * across the shredded records. These live under the retained
   * collection DEK, so crypto-shred alone would leave the indexed field VALUES
   * readable — `forget()` must delete them.
   */
  readonly indexPostingsPurged: number
  /**
   * `collection:id:field` entries whose persisted `_idx` side-car could NOT be
   * deleted — index residue that still leaks the indexed value under the
   * retained collection DEK. Non-empty means erasure is INCOMPLETE: retry, or
   * purge the side-car out of band.
   */
  readonly indexResidue: readonly string[]
  /**
   * Count of `_sealed[field]` slots dropped from the live store across the
   * shredded records. For slots written under `sensitive` +
   * `perRecordKeys` (the current path), the key derives off the per-record CEK,
   * so tombstoning the record — which drops `_cek` and `_sealed` — also
   * crypto-shreds the value. A legacy slot (written before per-record CEKs) keys
   * off the collection DEK instead, so dropping it removes it from the live store but a
   * pre-forget backup remains recoverable by a DEK holder (same caveat `_data`
   * carries); migrate by re-`put`ting before forgetting for full crypto-shred.
   */
  readonly sealedFieldsShredded: number
  /** Count of `_sealed_cek` host-delivery envelopes deleted (#H-1). A record sealed to an
   * at-* host via sealRecordToHost persists its raw CEK there; forget() must destroy them. */
  readonly sealedCekEnvelopesPurged: number
  /** `collection:id` whose `_sealed_cek` purge failed (residue — the host-recoverable CEK may survive). */
  readonly sealedCekResidue: readonly string[]
  /** `collection:id:field` sealed slots that were DEK-derived (legacy, written before per-record CEKs) and thus NOT crypto-shredded
   * by dropping `_cek` — the collection DEK is retained, so synced/backup copies stay decryptable (#M-1). */
  readonly sealedResidue: readonly string[]
  /** Count of `_ledger_deltas` rows hard-deleted across the shredded records (#734) — the
   * erasure twin of #729's elevate-side purge. Entry metadata (that the record was mutated,
   * at which version/timestamp/actor) is retained; only the plaintext delta content is removed. */
  readonly ledgerDeltasPurged: number
  /** `collection:id` refs whose `_ledger_deltas` purge failed — plaintext delta residue still
   * readable under the retained ledger DEK. Non-empty means erasure is INCOMPLETE. */
  readonly ledgerDeltaResidue: readonly string[]
  /** The single `op:'forget'` ledger entry appended for this erasure. */
  readonly ledgerEntry: LedgerEntry
  /** #622 — record-grain derived artifacts (MV rows, per-record derived copies) erased
   *  because their source subject was forgotten. Overlay outputs are intentionally out of
   *  scope here — an overlay is always sourced from an MV, never directly from a subject
   *  collection, so the personal-data-bearing MV rows it reads are already erased above. */
  readonly derivedRecordsErased: number
  /** #622 — aggregate-grain targets (rollups) recomputed without the forgotten contribution. */
  readonly derivedAggregatesRecomputed: number
  /** #622 — `collection:id` derived writes SKIPPED because the target period is frozen
   *  (recompute deferred; the aggregate retains the forgotten contribution — audited). */
  readonly derivedResidueFrozen: readonly string[]
  /** #650 Task 5 (#648) — referencing records tombstoned via a `'ref'` edge's `cascade` policy. */
  readonly lookupReferencesCascaded: number
  /** #650 Task 5 (#648) — referencing fields cleared via a `'ref'` edge's `nullify` policy. */
  readonly lookupReferencesNullified: number
  /** #650 Task 5 review (Important fix) — `'ref'` edges whose compare-key could NOT be resolved,
   *  even from the LIVE pre-shred backing row — cascade/nullify propagation was SKIPPED for these.
   *  Always empty in the ordinary case; non-empty means the skip is reported, never silent. */
  readonly lookupReferencesResidue: readonly string[]
  /** #633 — scoped-purge skip notices (opt-in `scopedPurge`, see {@link SubjectDeclaration}).
   *  Always empty under the unconditional default. Non-empty means a `_sealed_cek` entry or a
   *  blob scan was skipped for an undeclared collection — reported, never a silent skip. */
  readonly scopedPurgeResidue: readonly ScopedPurgeResidueNotice[]
  /** #776/#782/#785 — `collection:id` MV-output rows that survived erasure invalidation (eager
   *  tombstone leg AND lazy/manual `invalidateMVAtRest`) despite belonging to the forgotten
   *  subject, because the `_materializedFrom` ownership stamp could NOT be decoded (undecodable
   *  under the collection's default DEK — e.g. elevated above tier 0 on a tiered output
   *  collection; ownership unconfirmed — could be a plain user record on a same-collection
   *  partition MV). Never erased, but surfaced here rather than silently skipped (the #724
   *  posture). Non-empty means the row may still hold the forgotten/pre-elevation contribution,
   *  decryptable by tier-holders. */
  readonly derivedResidueUndecodable: readonly string[]
  /** #782/#785 — `collection:id` MV-output rows that DID decode and stamp-match via
   *  `_materializedFrom`, but whose erasure was declined by the #718 tier-elevation gate
   *  (`_internalDelete` returned false). Ownership CONFIRMED here — a real silent survival,
   *  not a stamp-mismatch skip — surfaced rather than dropped. Non-empty means a live,
   *  tier-holder-decryptable copy of the forgotten contribution was deliberately retained. */
  readonly derivedResidueDeclined: readonly string[]
}

/** #633 — the two `scopedPurgeResidue` skip reasons. Single source of truth: `purge-scope.ts`
 *  (the port-internal partition helpers) imports this rather than redeclaring it. */
export type ScopedPurgeResidueReason = 'skipped-undeclared-sealed-cek' | 'skipped-undeclared-blob-scan'

/** #633 — one `ForgetResult.scopedPurgeResidue` entry: an undeclared collection's sealed-CEK
 *  entries left unpurged, or its blob scan skipped entirely, under `scopedPurge`. `count` is the
 *  number of `_sealed_cek` entries left in place (sealed-cek reason) or the number of refs whose
 *  blob scan was skipped (blob-scan reason) — aggregated per collection across the whole call. */
export interface ScopedPurgeResidueNotice {
  readonly reason: ScopedPurgeResidueReason
  readonly collection: string
  readonly count: number
}
