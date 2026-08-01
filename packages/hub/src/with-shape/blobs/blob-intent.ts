/**
 * `_blob_intent` — the blob durability journal marker (#753, spec §7).
 *
 * One row per in-flight multi-step blob operation (`shred` | `rehome`),
 * written BEFORE the first destructive/movement step and deleted as the
 * operation's LAST step. An absent marker means "no operation in flight"
 * (the normal state, zero cost on every path that doesn't crash); a present
 * marker means the operation MUST be resumed before any other blob work on
 * that record proceeds.
 *
 * **Pattern honesty (C9):** this is the family's FIRST content-bearing
 * ENCRYPTED reserved marker. The prior reserved-collection precedent,
 * `_mv_stale` (`with-formula/materialized-views/stale.ts`), is
 * content-free plaintext (`{ _iv: '', _data: '{}' }` — the row's only
 * payload is its key). `_blob_intent` carries real operational metadata
 * (op, tiers, eTags + counts) and is encrypted, so its codec/CAS/backup/
 * sweep conventions below are new to the codebase, not a copy of an
 * existing pattern.
 *
 * **Key management (spec §4):** encrypted under the record's OWNING
 * collection's tier-0 DEK — `getDEK(collection)`, which resolves to
 * `dekKey(collection, 0) === collection` (see `with-party/team/tiers.ts`).
 * Every legitimate resumer (forget()-retry, blob write entry points,
 * tier ops) already holds this DEK; minting an elevated DEK for the
 * marker itself would make resume impossible for a tier-0-only resumer.
 * Documented residue: a tier-0 DEK holder can learn that an elevated
 * record's shred/rehome was in flight and which eTags it touched —
 * existence-adjacent, consistent with the already-documented
 * dedup-policy residue (#741).
 *
 * **Key grammar (C11):** `{collection}::{recordId}`. Blob-bearing record
 * ids already refuse `::` at the write surface (`blob-set.ts`'s
 * `assertKeyPartSafe`, #752) — re-validated here defensively so the
 * sweep's prefix-free key list stays unambiguous regardless of caller.
 *
 * Wired by `shredAllForRecord`/`forget()` (PR-1 Task 3, shred) and by
 * `BlobSet.syncTierMove`/`rehomeForTier`/`resolvePendingIntent` (PR-2 Task
 * 2, rehome — mint/resume/consume for `op:'rehome'` markers).
 */
import type { NoydbStore, EncryptedEnvelope } from '../../kernel/types.js'
import { NOYDB_FORMAT_VERSION } from '../../kernel/types.js'
import { writeEnvelopeBody, openEnvelopeJson, type EnclaveKey } from '../../kernel/enclave/index.js'
import { isConflictError, BlobIntentPendingError, ValidationError } from '../../kernel/errors.js'

/** Reserved collection holding `_blob_intent` marker rows. */
export const BLOB_INTENT_COLLECTION = '_blob_intent'

/**
 * One captured refCount hold on an eTag, authoritative on resume (spec §2a,
 * amended by C5). `chunkCount` lets a resumed release complete chunk
 * cleanup even if the `_blob_index` row itself is already gone (mirrors
 * `releaseRef`'s `chunkCountHint` parameter, Task 1).
 */
export interface BlobIntentHold {
  readonly eTag: string
  readonly n: number
  readonly chunkCount: number
}

/**
 * The intent marker's decrypted payload (spec §2a, amended by C5: `holds`
 * entries carry `{ eTag, n, chunkCount }` rather than the original bare
 * `{ eTag, n }`).
 */
export interface BlobIntent {
  readonly op: 'shred' | 'rehome'
  /** Random nonce minted at marker creation (`crypto.getRandomValues`) — the op-stamp identity. */
  readonly opId: string
  // shred:
  /** Captured ONCE at marker creation; authoritative on every resume. */
  readonly holds?: readonly BlobIntentHold[]
  readonly ownerTier?: number
  // rehome:
  readonly fromTier?: number
  readonly toTier?: number
  readonly policy?: 'isolate' | 'dedup'
  /**
   * Rehome destination `+1` row-stamps (`${opId}:${slotName}` /
   * `${opId}:${versionKey}`) CONFIRMED applied — #746 whole-branch review
   * (K=8 stamp-ring blocker). `BlobObject.lastOps` is a BOUNDED ring (K=8,
   * spec C2) — correct as the sole idempotency source for SHRED (one
   * decrement per eTag, count captured in `holds`) but not for REHOME,
   * whose row-scoped increments can exceed K on a single destination via
   * either ≥9 rows of identical content on ONE record, or ≥8 CONCURRENT
   * rehomes converging on one shared destination between a crashed op's
   * stamp-write and its resume — either way, an evicted-but-unapplied-
   * looking stamp gets re-applied, over-counting the destination's
   * refCount and permanently stranding it above 0. This field is THIS
   * op's own UNBOUNDED, per-record backstop: appended (via
   * {@link recordAppliedStamp}) immediately after a stamped `+1` lands
   * (whether freshly applied or found already in the ring), consulted
   * BEFORE attempting the CAS so a resume that finds its own row-stamp
   * here skips the increment entirely — independent of the shared
   * destination object's bounded ring and of how many OTHER ops have
   * touched it since. Absent/empty is the normal case (no rehome — or no
   * increments yet — in flight).
   */
  readonly appliedStamps?: readonly string[]
}

/** Resume callback signature for {@link sweepBlobIntents} — supplied by the caller (Task 3 / PR-2). */
export type BlobIntentResume = (collection: string, recordId: string, intent: BlobIntent) => Promise<void>

/** C11: refuse a key part that would make the `::` marker-key grammar ambiguous. */
function assertIntentKeyPartSafe(part: string, what: 'collection' | 'record id'): void {
  if (part.includes('::') || part.startsWith(':') || part.endsWith(':')) {
    throw new ValidationError(
      `Blob intent ${what} "${part}" must not contain '::' nor start/end with ':' ` +
        `(reserved as the _blob_intent marker-key separator; #753)`,
    )
  }
}

/** Build the marker's store key, `{collection}::{recordId}` (C11). */
function intentKey(collection: string, recordId: string): string {
  assertIntentKeyPartSafe(collection, 'collection')
  assertIntentKeyPartSafe(recordId, 'record id')
  return `${collection}::${recordId}`
}

/** Split a marker key back into `{collection, recordId}`. `null` on a key that doesn't match the grammar. */
function parseIntentKey(key: string): { collection: string; recordId: string } | null {
  const idx = key.indexOf('::')
  if (idx === -1) return null
  return { collection: key.slice(0, idx), recordId: key.slice(idx + 2) }
}

/**
 * Encrypt a `BlobIntent` into an envelope, mirroring the version-record
 * write shape (`blob-set.ts`'s `writeVersionRecordAtKey`): fresh IV per
 * write. `newVersion` defaults to `1` (the marker's original create-once
 * shape — `createIntent`'s only call site); {@link recordAppliedStamp}
 * (#746 whole-branch review) is the one caller that updates an
 * already-created marker in place and passes the incremented version
 * explicitly.
 */
async function encodeIntentEnvelope(intent: BlobIntent, dek: EnclaveKey, newVersion = 1): Promise<EncryptedEnvelope> {
  const json = JSON.stringify(intent)
  const body = await writeEnvelopeBody(json, dek)
  return {
    _noydb: NOYDB_FORMAT_VERSION,
    _v: newVersion,
    _ts: new Date().toISOString(),
    ...body,
  }
}

/** Decrypt an envelope back into its `BlobIntent` payload. */
async function decodeIntentEnvelope(envelope: EncryptedEnvelope, dek: EnclaveKey): Promise<BlobIntent> {
  const json = await openEnvelopeJson(envelope, dek)
  return JSON.parse(json) as BlobIntent
}

/**
 * Read the `_blob_intent` marker for `{collection}::{recordId}`, or `null`
 * if none is pending. The resume-gate check every future blob mutator
 * (Task 3 / PR-2) runs before proceeding.
 */
export async function getIntent(
  adapter: NoydbStore,
  vault: string,
  collection: string,
  recordId: string,
  getDEK: (collection: string) => Promise<EnclaveKey>,
): Promise<BlobIntent | null> {
  const envelope = await adapter.get(vault, BLOB_INTENT_COLLECTION, intentKey(collection, recordId))
  if (!envelope) return null
  const dek = await getDEK(collection)
  return decodeIntentEnvelope(envelope, dek)
}

/**
 * Create a `_blob_intent` marker for `{collection}::{recordId}` — CAS
 * create-if-absent (C8). `store.put(..., expectedVersion: 0)` succeeds only
 * when no row is present (every real adapter treats a missing record +
 * `expectedVersion: 0` as a no-conflict write — the same convention
 * `loadOrCreateSigner` uses in `with-audit/attestation/signer.ts`); a
 * present row always carries `_v >= 1`, so the CAS throws `ConflictError`
 * and is converted here into {@link BlobIntentPendingError} — the signal
 * a caller catches to resume the PENDING operation before starting a new
 * one, rather than silently clobbering it (which would orphan the prior
 * op's op-stamps).
 */
export async function createIntent(
  adapter: NoydbStore,
  vault: string,
  collection: string,
  recordId: string,
  getDEK: (collection: string) => Promise<EnclaveKey>,
  intent: BlobIntent,
): Promise<void> {
  const key = intentKey(collection, recordId)
  const dek = await getDEK(collection)
  const envelope = await encodeIntentEnvelope(intent, dek)
  try {
    await adapter.put(vault, BLOB_INTENT_COLLECTION, key, envelope, 0)
  } catch (err) {
    if (isConflictError(err)) {
      throw new BlobIntentPendingError(collection, recordId)
    }
    throw err
  }
}

/** Delete the `_blob_intent` marker for `{collection}::{recordId}` — the operation's LAST step. */
export async function deleteIntent(
  adapter: NoydbStore,
  vault: string,
  collection: string,
  recordId: string,
): Promise<void> {
  await adapter.delete(vault, BLOB_INTENT_COLLECTION, intentKey(collection, recordId))
}

/** CAS retry budget for {@link recordAppliedStamp} — mirrors `blob-set.ts`'s `MAX_CAS_RETRIES`. */
const MAX_APPLIED_STAMP_RETRIES = 5

/**
 * Durably record that a rehome destination row-stamp has been CONFIRMED
 * applied — #746 whole-branch review (K=8 stamp-ring blocker). Appends
 * `stamp` to the marker's `appliedStamps` (idempotent no-op if already
 * present), CAS-retried against concurrent resumers touching the SAME
 * marker (mirrors `BlobSet.casUpdateSlots`'s retry shape).
 *
 * A no-op — never throws — when the marker is already gone: that only
 * happens if the whole op already completed and deleted it (this call is
 * racing its own operation's tail) or a sibling resumer already finished
 * it; either way there is nothing left to record against. A marker whose
 * `op` is NOT `'rehome'` (should be structurally impossible — only
 * `BlobSet`'s own rehome machinery calls this, against its own marker) is
 * treated the same way: nothing to record.
 */
export async function recordAppliedStamp(
  adapter: NoydbStore,
  vault: string,
  collection: string,
  recordId: string,
  getDEK: (collection: string) => Promise<EnclaveKey>,
  stamp: string,
): Promise<void> {
  const key = intentKey(collection, recordId)
  const dek = await getDEK(collection)
  for (let attempt = 0; attempt < MAX_APPLIED_STAMP_RETRIES; attempt++) {
    const envelope = await adapter.get(vault, BLOB_INTENT_COLLECTION, key)
    if (!envelope) return // marker already gone — nothing to record against
    const intent = await decodeIntentEnvelope(envelope, dek)
    if (intent.op !== 'rehome' || intent.appliedStamps?.includes(stamp)) return // already recorded (or not ours)
    const updated: BlobIntent = { ...intent, appliedStamps: [...(intent.appliedStamps ?? []), stamp] }
    const newEnvelope = await encodeIntentEnvelope(updated, dek, envelope._v + 1)
    try {
      await adapter.put(vault, BLOB_INTENT_COLLECTION, key, newEnvelope, envelope._v)
      return
    } catch (err) {
      if (isConflictError(err) && attempt < MAX_APPLIED_STAMP_RETRIES - 1) continue
      throw err
    }
  }
}

/**
 * List every persisted `_blob_intent` marker and resume each via the
 * caller-supplied `resume` callback (the forget-entry / vault-open sweep,
 * mirroring `_mv_stale`'s `hydratePersistedStaleMarkers`/orphan-sweep
 * pattern).
 *
 * **Per-marker isolation (#753 Task 3, carried finding from the Task 2
 * review):** each marker's decode + `resume` runs in its own try/catch — a
 * corrupt/DEK-mismatched marker, or a marker whose resume genuinely fails
 * (e.g. a store error mid-release), is reported via `onResumeError` and
 * skipped, never aborting the loop and never silently swallowed. Earlier
 * (Task 2) this loop had no try/catch at all; that was safe only because
 * nothing called `resume` with real logic yet — `BlobSet.mintShredIntent`'s
 * collection-scoped sweep (this function's first real caller, Task 3) can
 * hit a genuinely corrupt sibling marker and must not let it block a
 * healthy one (mirrors `stale.ts`'s orphan-sweep defensive posture, #736).
 *
 * `resume` is the per-marker resume action (Task 3: `BlobSet`'s
 * `resolvePendingIntent`-equivalent for a shred marker; a rehome marker is
 * PR-2 scope and should be skipped by the callback, not thrown into here).
 */
export async function sweepBlobIntents(
  adapter: NoydbStore,
  vault: string,
  getDEK: (collection: string) => Promise<EnclaveKey>,
  resume: BlobIntentResume,
  onResumeError?: (collection: string, recordId: string, err: unknown) => void,
): Promise<void> {
  const keys = await adapter.list(vault, BLOB_INTENT_COLLECTION)
  for (const key of keys) {
    const parsed = parseIntentKey(key)
    if (!parsed) continue // defensive: not our grammar, not ours to sweep
    try {
      const envelope = await adapter.get(vault, BLOB_INTENT_COLLECTION, key)
      if (!envelope) continue // raced with a concurrent resume's delete
      const dek = await getDEK(parsed.collection)
      const intent = await decodeIntentEnvelope(envelope, dek)
      await resume(parsed.collection, parsed.recordId, intent)
    } catch (err) {
      onResumeError?.(parsed.collection, parsed.recordId, err)
    }
  }
}
