import type {
  NoydbStore,
  EncryptedEnvelope,
  BlobObject,
  SlotRecord,
  SlotInfo,
  VersionRecord,
  BlobPutOptions,
  BlobResponseOptions,
} from '../../kernel/types.js'
import { NOYDB_FORMAT_VERSION } from '../../kernel/types.js'
import type { ObjectProjection } from './object-projection.js'
import type { BlobFieldsConfig } from './blob-compaction.js'
import {
  encrypt,
  openEnvelopeJson,
  hmacSha256Hex,
  encryptBytesWithAAD,
  decryptBytesWithAAD,
  bufferToBase64,
  base64ToBuffer,
  generateDEK,
  wrapCek,
  unwrapCek,
  sha256Hex,
  type EnclaveKey,
} from '../../kernel/enclave/index.js'
import { BlobIntentPendingError, ConflictError, NotFoundError, TamperedError, TierNotGrantedError, UnsupportedTierCompositionError, ValidationError } from '../../kernel/errors.js'
import { liveRecordIsElevated, liveRecordTier } from '../../kernel/tier-visibility.js'
import { dekKey, assertTierAccess } from '../../with-party/team/tiers.js'
import type { UnlockedKeyring } from '../../with-party/team/keyring.js'
import { detectMagic, isPreCompressed } from './mime-magic.js'
import { createIntent, getIntent, deleteIntent, sweepBlobIntents, recordAppliedStamp, type BlobIntent, type BlobIntentHold } from './blob-intent.js'

// ─── Internal collection names ─────────────────────────────────────────

/**
 * DEK slot name for vault-shared blob data. Calling `getDEK('_blob')`
 * auto-creates a blob DEK the first time — same lazy-creation mechanism
 * used for any user-defined collection.
 */
export const BLOB_COLLECTION = '_blob'

/** Stores `BlobObject` metadata envelopes, keyed by eTag. */
export const BLOB_INDEX_COLLECTION = '_blob_index'

/**
 * Stores encrypted chunk envelopes, keyed by `{eTag}/{chunkIndex}`.
 * NOT loaded into the in-memory query layer. Fetched on demand by
 * `BlobSet.get()` / `BlobSet.response()`.
 */
export const BLOB_CHUNKS_COLLECTION = '_blob_chunks'

/** Prefix for per-collection slot metadata collections. */
export const BLOB_SLOTS_PREFIX = '_blob_slots_'

/** Prefix for per-collection version records. */
export const BLOB_VERSIONS_PREFIX = '_blob_versions_'

/**
 * Default chunk size: 256 KB raw bytes.
 * After AES-GCM (same size) + base64 (~33% inflation) → ~342 KB per
 * envelope, safely within DynamoDB's 400 KB item limit.
 */
export const DEFAULT_CHUNK_SIZE = 256 * 1024

/** Maximum CAS retry attempts for refCount and slot metadata updates. */
const MAX_CAS_RETRIES = 5

/**
 * `BlobObject.lastOps` ring capacity — see that field's doc comment
 * (kernel/types.ts) for the audit-visible-bound rationale (#753 spec §7 C2).
 */
const LAST_OPS_RING_SIZE = 8

/** Append `stamp` to the bounded `lastOps` ring, evicting the oldest entry past K. */
function appendStamp(lastOps: readonly string[] | undefined, stamp: string): readonly string[] {
  const next = [...(lastOps ?? []), stamp]
  return next.length > LAST_OPS_RING_SIZE ? next.slice(next.length - LAST_OPS_RING_SIZE) : next
}

/**
 * Shared empty-set constant for {@link BlobSet.applyStampedIncrement}'s
 * `knownApplied` default — avoids allocating a fresh empty `Set` on every
 * unmarked (`knownApplied` omitted) call site.
 */
const EMPTY_STAMP_SET: ReadonlySet<string> = new Set()

/**
 * Mint a fresh op-stamp identity for a `_blob_intent` marker (#753 spec §7
 * §2a: "random nonce minted at marker creation"). Mirrors `buildBacklink`'s
 * opaque-token minting below — `crypto.getRandomValues`, hex-encoded.
 */
function mintOpId(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

// ─── Compression helpers ───────────────────────────────────────────────

async function compressBytes(
  data: Uint8Array,
): Promise<{ bytes: Uint8Array; algorithm: 'gzip' | 'none' }> {
  if (typeof CompressionStream === 'undefined') {
    return { bytes: data, algorithm: 'none' }
  }
  // Pipe through the stream so `readable` is drained CONCURRENTLY with the
  // write. The await-write-then-read form deadlocks once the output exceeds the
  // stream's internal buffer (the writer backpressures waiting for a reader that
  // hasn't started yet).
  const piped = new Response(data as Uint8Array<ArrayBuffer>).body!.pipeThrough(new CompressionStream('gzip'))
  const buf = await new Response(piped).arrayBuffer()
  return { bytes: new Uint8Array(buf), algorithm: 'gzip' }
}

async function decompressBytes(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error(
      '[noy-db] DecompressionStream not available — cannot decompress blob chunk',
    )
  }
  // Concurrent read via pipeThrough — the await-write-then-read form deadlocks
  // when the DECOMPRESSED output exceeds the stream buffer (~16 KB): small
  // compressed input → large output → backpressure.
  const piped = new Response(data as Uint8Array<ArrayBuffer>).body!.pipeThrough(new DecompressionStream('gzip'))
  const buf = await new Response(piped).arrayBuffer()
  return new Uint8Array(buf)
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((s, c) => s + c.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out
}

/** Build the AAD binding for chunk integrity: "{eTag}:{chunkIndex}:{chunkCount}" */
function chunkAAD(eTag: string, chunkIndex: number, chunkCount: number): Uint8Array {
  return new TextEncoder().encode(`${eTag}:${chunkIndex}:${chunkCount}`)
}

// ─── BlobSet ──────────────────────────────────────────────────────────

/**
 * Handle for reading, writing, versioning, and deleting binary blobs
 * on a specific record.
 *
 * Obtained via `collection.blob(id)`. No I/O is performed until you
 * call a method.
 *
 * ## Storage layout
 *
 * ```
 * _blob_index/{eTag}                            BlobObject metadata (vault-shared DEK)
 * _blob_chunks/{eTag}/{chunkIndex}              Encrypted chunk data (vault-shared DEK + AAD)
 * _blob_slots_{collection}/{recordId}           Slot map (parent collection DEK)
 * _blob_versions_{collection}/{recordId}/{slot}/{label}  Published versions (parent collection DEK)
 * ```
 *
 * ## Deduplication
 *
 * `put()` computes `eTag = HMAC-SHA-256(blobDEK, plaintext)` — keyed so the
 * store cannot predict eTags for known content. If another record already
 * uploaded the same bytes, the chunks are reused and `refCount` is incremented.
 *
 * ## Chunk integrity
 *
 * Each chunk is encrypted with AES-256-GCM using AAD = `{eTag}:{index}:{count}`,
 * preventing chunk reorder, substitution, and truncation attacks.
 */
export class BlobSet {
  private readonly store: NoydbStore
  private readonly vault: string
  private readonly collection: string
  private readonly recordId: string
  private readonly getDEK: (name: string) => Promise<EnclaveKey>
  private readonly encrypted: boolean
  private readonly userId: string | undefined
  private readonly maxBlobBytes: number | undefined
  private readonly erasableBlobs: boolean
  private readonly tiersActive: boolean
  private readonly debugPlaintext: boolean
  private readonly objectStore: ObjectProjection | undefined
  private readonly blobFields: BlobFieldsConfig | undefined
  private readonly keyring: UnlockedKeyring | undefined
  /**
   * Set only on the cleared clone `atTier()` returns (#749) — never by
   * `openSlot`/`Collection.blob()`. Its presence is what makes a `BlobSet`
   * a cleared view: see `ownerRecordElevated()`/`ownerTier()`.
   */
  private readonly clearedTier: number | undefined

  constructor(opts: {
    store: NoydbStore
    vault: string
    collection: string
    recordId: string
    getDEK: (name: string) => Promise<EnclaveKey>
    encrypted: boolean
    userId?: string
    maxBlobBytes?: number
    erasableBlobs?: boolean
    tiersActive?: boolean
    debugPlaintext?: boolean
    objectStore?: ObjectProjection
    blobFields?: BlobFieldsConfig
    keyring?: UnlockedKeyring
    clearedTier?: number
  }) {
    this.store = opts.store
    this.vault = opts.vault
    this.collection = opts.collection
    this.recordId = opts.recordId
    this.getDEK = opts.getDEK
    this.encrypted = opts.encrypted
    this.userId = opts.userId
    this.maxBlobBytes = opts.maxBlobBytes
    this.erasableBlobs = opts.erasableBlobs === true
    this.tiersActive = opts.tiersActive === true
    this.debugPlaintext = opts.debugPlaintext === true
    this.objectStore = opts.objectStore
    this.blobFields = opts.blobFields
    this.keyring = opts.keyring
    this.clearedTier = opts.clearedTier
  }

  /**
   * #724 I1 completion: a legacy (non-`perRecordKeys`) blob has no per-blob
   * `_cek`, so `rehomeForTier` can never tier-isolate it on elevate/demote —
   * it stays decryptable under the flat tier-0 `_blob` DEK at rest even
   * after the owning record is elevated. The construction-time mandate
   * (`resolveCollectionConfig`) only catches this when `blobFields` is
   * DECLARED; a collection with an undeclared field (or no `blobFields` at
   * all) constructs fine and reaches this write path unguarded. Refuse the
   * write itself instead of broadening the construction mandate, which
   * would over-refuse blobless tiered collections (`blobStrategy` is
   * vault-wide, not per-collection). Called from every content-write entry
   * (`put()`, `publish()`) — never from a read path, so a pre-existing
   * legacy blob stays readable (back-compat).
   */
  private assertBlobWritable(): void {
    if (this.tiersActive && !this.erasableBlobs) {
      throw new UnsupportedTierCompositionError(
        'blobs',
        `Collection "${this.collection}": writing a blob to a tiered collection requires perRecordKeys ` +
          `(legacy blobs have no per-record key and cannot be tier-isolated) (#724).`,
      )
    }
  }

  /**
   * #748: `adoptExternal()`/`setExternalMeta()` write an `external` slot
   * reference directly — unlike `put()`, which only takes the external path
   * when `blobFields[slotName].external` is declared (the construction-time
   * tiers×blobFields mandate, `collection-config.ts`, then applies). Without
   * this gate, either method can attach an external reference to a slot the
   * collection never declared `external` — bypassing that mandate on a tiered
   * collection. Mirrors `put()`'s own gate.
   */
  private assertExternalDeclared(slotName: string): void {
    if (!this.blobFields?.[slotName]?.external) {
      throw new ValidationError(
        `Collection "${this.collection}": blob field "${slotName}" is not declared external `
          + `(blobFields["${slotName}"].external must be true) — cannot attach an external `
          + `reference to an undeclared slot (#748).`,
      )
    }
  }

  /**
   * Resolve the key the blob's CHUNKS are encrypted under.
   *
   * - `_cek` present (erasable blob) → unwrap the per-blob content CEK under
   *   `blobDEK`. Deleting the BlobObject (at `refCount → 0`) makes this
   *   key unrecoverable → the chunks are crypto-shredded.
   * - `_cek` absent (legacy) → `blobDEK` encrypts chunks directly.
   * - unencrypted vault → `null` (chunks stored as plaintext base64).
   *
   * `blobDEK` defaults to this record's own (tier-0) `_blob` DEK — every
   * pre-#724-T3 call site. `rehomeForTier`'s isolate-fork path (#724 Arc 10
   * Task 3) passes the `fromTier`-scoped DEK explicitly to read a shared
   * blob's plaintext under the key it's CURRENTLY wrapped under, reusing
   * this one `_cek` unwrap site rather than adding a new raw access.
   */
  private async resolveChunkKey(blob: Pick<BlobObject, '_cek'>, blobDEK?: EnclaveKey): Promise<EnclaveKey | null> {
    if (!this.encrypted) return null
    const dek = blobDEK ?? await this.getDEK(BLOB_COLLECTION)
    return blob._cek !== undefined ? await unwrapCek(blob._cek, dek) : dek
  }

  /**
   * #724 Arc 10 Task 1: the same "elevated ≡ invisible" clearance check
   * `collection.get()` applies to the owning record (`liveRecordIsElevated`,
   * #701/#707/#709/#712) — reused here, not reinvented, so a blob content
   * read on an elevated record is refused exactly like a `get()` on it
   * would be. Reads only the owning record's `_tier` envelope metadata;
   * runs before any blob decrypt.
   *
   * #749: a cleared clone (`this.clearedTier !== undefined`, produced only by
   * `atTier()`) short-circuits to `false` — its whole purpose is to see past
   * this gate, having already paid the `assertTierAccess` cost `atTier()`
   * charged to get here. No live envelope peek needed on that path.
   */
  private async ownerRecordElevated(): Promise<boolean> {
    if (this.clearedTier !== undefined) return false
    return liveRecordIsElevated(this.store, this.vault, this.collection, this.recordId)
  }

  /**
   * #724 Arc 10 Task 4: the tier this record's LIVE envelope currently
   * carries — `loadSlots`/`saveSlots` default to resolving the slot map's
   * collection DEK here, so the slot map (filenames/eTags/mimeTypes) is
   * read/written wherever a prior `rehomeForTier` call physically re-keyed
   * it to. `rehomeForTier` itself passes an EXPLICIT tier instead of
   * relying on this default (see its own doc comment): by the time it
   * runs, the owning record's live `_tier` has ALREADY moved to `toTier`
   * (the collection-level `elevate`/`demote`/`putAtTier` writes the record
   * before invoking `syncBlobs`), while the slot map is still physically at
   * `fromTier` until `rehomeForTier`'s own move step lands — so this peek
   * would resolve the wrong DEK mid-move.
   *
   * #749: a cleared clone reports its fixed `clearedTier` instead of
   * re-peeking — a stable view for the caller's whole session with it. A
   * concurrent demote/elevate on the underlying record is invisible to an
   * already-cleared handle; call `atTier()` again to see it. This is not a
   * silent-corruption risk: a WRITE through a stale clone after a concurrent
   * move fails loud, not quiet — the slot map/index envelope has already
   * been physically re-keyed to the record's new tier by `rehomeForTier`, so
   * the stale clone's `clearedTier`-pinned DEK can no longer open it and the
   * write throws an AEAD decrypt error rather than silently writing under
   * the wrong key.
   */
  private async ownerTier(): Promise<number> {
    if (this.clearedTier !== undefined) return this.clearedTier
    return liveRecordTier(this.store, this.vault, this.collection, this.recordId)
  }

  /**
   * The sanctioned cleared-read path to an elevated record's blobs (#749).
   *
   * The law: `blob(id)` is the tier-0 surface — `get()`/`list()`/`blobInfo()`/
   * etc. all hide an elevated record's blobs from EVERYONE, unconditionally
   * (`ownerRecordElevated()`, #724 Task 1), with no cleared path of their own.
   * `atTier()` is that cleared path, the `getAtTier()` analogue for blobs:
   * live-peeks the owning record's tier, and for `tier > 0` runs
   * `assertTierAccess` — the SAME gate `putAtTier`/`elevate`/`demote` run
   * before ever touching a tier DEK — then returns a NEW `BlobSet` bound to
   * that tier. Every subsequent call on the returned handle (`get()`,
   * `list()`, `publish()`, …) sees through the gate as if the record were at
   * tier 0.
   *
   * `assertTierAccess` — not a bare `getDEK` call — IS the authorization
   * check: owner/admin/custodian bypass it (their on-demand tier-DEK mint is
   * sanctioned), everyone else must already hold the tier DEK (via a prior
   * grant or delegation) or it throws `TierNotGrantedError`. A bare `getDEK`
   * would not gate anything here — it silently mints a fresh DEK for ANY
   * caller when one is missing, which is exactly the "non-cleared caller
   * creating tier key material inside the trust boundary" hazard
   * `assertTierAccess`'s own doc comment (`with-party/team/tiers.ts`) warns
   * against; running it BEFORE any `getDEK` call is what keeps an ungranted
   * member's failed `atTier()` call from minting junk key material into
   * their keyring as a side effect. No tier DEK is resolved here at all —
   * every actual read still resolves its DEK lazily, same as today.
   *
   * `this.keyring` is undefined only on a construction path that never
   * threads one through `openSlot` (`Collection.blob()` always does) — that
   * can't prove clearance for anyone, so it throws the same
   * `TierNotGrantedError` an ungranted caller would get.
   */
  async atTier(): Promise<BlobSet> {
    const tier = await liveRecordTier(this.store, this.vault, this.collection, this.recordId)
    if (tier === 0) return this

    if (!this.keyring) throw new TierNotGrantedError(this.collection, tier)
    assertTierAccess(this.keyring, this.collection, tier)
    // M3 (whole-branch review): the first gate only proves clearance on the
    // DATA collection (`docs#N`) — a member holding that grant but not the
    // `_blob#N` DEK grant would otherwise pass straight through and have
    // the first content read auto-mint a junk `_blob#N` DEK as a side
    // effect. Gate the blob DEK's own tier too, in the same
    // before-any-mint spot as the line above.
    assertTierAccess(this.keyring, BLOB_COLLECTION, tier)

    return new BlobSet({
      store: this.store,
      vault: this.vault,
      collection: this.collection,
      recordId: this.recordId,
      getDEK: this.getDEK,
      encrypted: this.encrypted,
      erasableBlobs: this.erasableBlobs,
      tiersActive: this.tiersActive,
      debugPlaintext: this.debugPlaintext,
      keyring: this.keyring,
      clearedTier: tier,
      ...(this.userId !== undefined ? { userId: this.userId } : {}),
      ...(this.maxBlobBytes !== undefined ? { maxBlobBytes: this.maxBlobBytes } : {}),
      ...(this.objectStore !== undefined ? { objectStore: this.objectStore } : {}),
      ...(this.blobFields !== undefined ? { blobFields: this.blobFields } : {}),
    })
  }

  /** The internal collection that holds slot metadata for this collection's blobs. */
  private get slotsCollection(): string {
    return `${BLOB_SLOTS_PREFIX}${this.collection}`
  }

  /** The internal collection that holds published versions for this collection's blobs. */
  private get versionsCollection(): string {
    return `${BLOB_VERSIONS_PREFIX}${this.collection}`
  }

  // ─── Slot Metadata I/O (CAS-protected) ─────────────────────────────

  /**
   * @param tier #724 Arc 10 Task 4: explicit tier to resolve the slot map's
   * collection DEK at — `getDEK(dekKey(this.collection, tier))`. Omitted →
   * resolves via `ownerTier()` (the record's CURRENT live tier), correct
   * for every call site except `rehomeForTier`'s own internal reads, which
   * must pin `fromTier` explicitly (see `ownerTier()`'s doc comment).
   */
  private async loadSlots(tier?: number): Promise<{
    slots: Record<string, SlotRecord>
    version: number
  }> {
    const envelope = await this.store.get(this.vault, this.slotsCollection, this.recordId)
    if (!envelope) return { slots: {}, version: 0 }

    if (!this.encrypted) {
      return {
        slots: JSON.parse(envelope._data) as Record<string, SlotRecord>,
        version: envelope._v,
      }
    }

    const dek = await this.getDEK(dekKey(this.collection, tier ?? await this.ownerTier()))
    const json = await openEnvelopeJson(envelope, dek)
    return {
      slots: JSON.parse(json) as Record<string, SlotRecord>,
      version: envelope._v,
    }
  }

  /**
   * Resumable slot-map read for `runRehomeSteps` (#746 spec §7 §2d bullet
   * 1): try `fromTier` (the map's pre-move physical location) first; on a
   * decrypt failure (wrong key, not "missing" — mirrors `loadBlobObject`'s
   * own TamperedError-only fallback trigger) retry `toTier` — the signal
   * that a prior (crashed) run's own move step already landed. `atTier`
   * reports which one opened it. A missing envelope reports `atTier:
   * fromTier` (arbitrary — the `Object.keys(slots).length > 0` gate the
   * caller applies makes the value moot for an empty map).
   */
  private async loadSlotsTolerant(fromTier: number, toTier: number): Promise<{
    slots: Record<string, SlotRecord>
    version: number
    atTier: number
  }> {
    const envelope = await this.store.get(this.vault, this.slotsCollection, this.recordId)
    if (!envelope) return { slots: {}, version: 0, atTier: fromTier }

    if (!this.encrypted) {
      return { slots: JSON.parse(envelope._data) as Record<string, SlotRecord>, version: envelope._v, atTier: fromTier }
    }

    const fromDek = await this.getDEK(dekKey(this.collection, fromTier))
    try {
      const json = await openEnvelopeJson(envelope, fromDek)
      return { slots: JSON.parse(json) as Record<string, SlotRecord>, version: envelope._v, atTier: fromTier }
    } catch (err) {
      if (!(err instanceof TamperedError) || fromTier === toTier) throw err
    }

    const toDek = await this.getDEK(dekKey(this.collection, toTier))
    const json = await openEnvelopeJson(envelope, toDek)
    return { slots: JSON.parse(json) as Record<string, SlotRecord>, version: envelope._v, atTier: toTier }
  }

  /** @param tier See {@link loadSlots}'s `tier` param — same resolution. */
  private async saveSlots(
    slots: Record<string, SlotRecord>,
    currentVersion: number,
    tier?: number,
  ): Promise<void> {
    const json = JSON.stringify(slots)
    const now = new Date().toISOString()
    let envelope: EncryptedEnvelope

    if (this.encrypted) {
      const dek = await this.getDEK(dekKey(this.collection, tier ?? await this.ownerTier()))
      const { iv, data } = await encrypt(json, dek)
      envelope = {
        _noydb: NOYDB_FORMAT_VERSION,
        _v: currentVersion + 1,
        _ts: now,
        _iv: iv,
        _data: data,
      }
    } else {
      envelope = {
        _noydb: NOYDB_FORMAT_VERSION,
        _v: currentVersion + 1,
        _ts: now,
        _iv: '',
        _data: json,
      }
    }

    await this.store.put(
      this.vault,
      this.slotsCollection,
      this.recordId,
      envelope,
      currentVersion > 0 ? currentVersion : undefined,
    )
  }

  /**
   * CAS retry loop for slot metadata updates. Re-reads slots on conflict
   * and re-applies the mutation function.
   *
   * #724 re-review (High): when the mutation empties the slot map (the
   * last slot was deleted), the `_blob_slots_{collection}/{recordId}` row
   * is DELETED rather than saved as an empty-but-present envelope. An
   * empty envelope left in place would still be tier-keyed at whatever
   * tier it was last written at; `rehomeForTier`'s `slots exist` guard
   * (`Object.keys(slots).length > 0`) would then skip re-keying it on a
   * later elevate/demote, stranding it at the wrong tier's DEK —
   * `TamperedError` on every later access. Deleting the row instead makes
   * "no slots" and "no envelope" the SAME state, so a record that once
   * had a blob and a record that never had one behave identically once
   * empty.
   *
   * @param tier See {@link loadSlots}'s `tier` param — threaded through so
   * `rehomeForTier`'s isolate-fork writes (via `putUnderDEK`) target the
   * slot map's CURRENT (fromTier) location during the move.
   */
  private async casUpdateSlots(
    mutate: (slots: Record<string, SlotRecord>) => Record<string, SlotRecord> | null,
    tier?: number,
  ): Promise<void> {
    for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
      const { slots, version } = await this.loadSlots(tier)
      const updated = mutate(slots)
      if (updated === null) return // no-op
      if (Object.keys(updated).length === 0) {
        if (version > 0) await this.store.delete(this.vault, this.slotsCollection, this.recordId)
        return
      }
      try {
        await this.saveSlots(updated, version, tier)
        return
      } catch (err) {
        if (err instanceof ConflictError && attempt < MAX_CAS_RETRIES - 1) continue
        throw err
      }
    }
  }

  /**
   * Clear a slot's `pendingRelease` breadcrumb once its release has landed
   * (#746 spec §7 review, carried finding (b)) — a no-op CAS if the field is
   * already gone (idempotent, safe to call again on resume) or no longer
   * matches `expected` (a NEWER put() on this slot already moved past it).
   */
  private async clearPendingRelease(slotName: string, expected: string, tier?: number): Promise<void> {
    await this.casUpdateSlots((slots) => {
      const slot = slots[slotName]
      if (!slot || slot.pendingRelease !== expected) return null
      const rest: SlotRecord = { ...slot }
      delete (rest as { pendingRelease?: string }).pendingRelease
      slots[slotName] = rest
      return slots
    }, tier)
  }

  /**
   * `runRehomeSteps`'s FIRST step (#746 spec §7 review, carried finding
   * (b)) — reconcile any `pendingRelease` breadcrumb left on `slots` by a
   * PRIOR (crashed) run of THIS SAME marker-governed rehome (`opId`
   * identifies it). `putUnderDEK`'s slot-CAS (pointing the slot at its new
   * eTag) and its old-eTag release are two separate writes; a crash between
   * them strands the release — the slot map has already moved past the old
   * eTag, so a plain re-derivation of "which eTags need releasing" from the
   * CURRENT slot map can never find it again (a permanent leak, not merely
   * a delayed one). Durably recording the old eTag ON the slot record
   * itself (in the SAME CAS write that moves it) survives exactly the crash
   * window that loses an in-memory breadcrumb, and this pass is what
   * consumes it on the next attempt — completing the release (idempotent
   * via the SAME row-scoped stamp `putUnderDEK` used) and clearing the
   * field. C10: the release is NOT swallowed — a failure here must keep the
   * marker alive (propagates), not silently strand it a second way.
   */
  private async reconcilePendingReleases(
    slots: Record<string, SlotRecord>,
    fromTier: number,
    opId: string,
  ): Promise<void> {
    for (const [slotName, slot] of Object.entries(slots)) {
      if (!slot.pendingRelease) continue
      const stamp = `${opId}:${slotName}`
      await this.releaseRef(slot.pendingRelease, 1, false, fromTier, stamp)
      await this.clearPendingRelease(slotName, slot.pendingRelease, fromTier)
    }
  }

  // ─── Blob Index I/O (versioned for CAS refCount) ──────────────────

  /**
   * #747: the `_blob_index` envelope follows the eTag's HOME tier — the
   * same tier the `_cek` payload wrapped inside it has been scoped to since
   * #724. That fix only tier-scoped the WRAPPED content CEK; the outer
   * index envelope itself stayed flat, so a tier-0 DEK holder could still
   * read an elevated record's blob metadata (size/mimeType/compression/
   * chunkCount/refCount/createdAt) straight off `_blob_index` at rest.
   *
   * `tier` defaults to `ownerTier()`, mirroring `loadSlots`. Two-tier mode
   * (#753 spec §7 C7 / §2d): try `tier`'s DEK first; on a decrypt failure
   * (wrong key — AES-GCM auth fails, not "missing") retry under
   * `alsoTryTier`'s DEK. `atTier` reports which key actually opened it, so a
   * caller mutating the object (`casUpdateRefCount`) can write it back
   * under that SAME key — never lifting a flat dedup/legacy object onto the
   * owner's tier (or vice versa) as a side effect of a refCount change.
   *
   * `alsoTryTier` defaults to `0` when `tier` resolves `> 0` and no explicit
   * value is given — this is #747's original tier-then-flat fallback,
   * preserved byte-identical for every pre-#753 call site (none of which
   * pass `alsoTryTier`). It covers the two legitimate classes that stay
   * flat even for an elevated owner: a `dedup`-policy shared object (#741,
   * left in place on purpose) and a legacy `_cek`-less object (chunks
   * direct under the flat DEK, never tier-isolated — #724 I1). When `tier`
   * resolves to `0` and no `alsoTryTier` is given, there is no fallback
   * attempt at all (matches pre-#753 behavior exactly) — but a `tier === 0`
   * caller MAY now pass an elevated `alsoTryTier` explicitly (the rehome
   * resume path, §2d: "try `fromTier`, fall back to `toTier`", either of
   * which may be 0). Passing `alsoTryTier === tier` is a no-op fallback (no
   * second attempt — nothing new to try).
   *
   * No migration/compat path: the whole tiers×blobs arc is unpublished, so
   * there is no previously-published elevated blob whose index envelope is
   * stuck flat at rest — every elevated write from here on is born
   * tier-keyed.
   */
  private async loadBlobObject(
    eTag: string,
    tier?: number,
    alsoTryTier?: number,
  ): Promise<{ blob: BlobObject; version: number; atTier: number } | null> {
    const envelope = await this.store.get(this.vault, BLOB_INDEX_COLLECTION, eTag)
    if (!envelope) return null

    if (!this.encrypted) {
      return { blob: JSON.parse(envelope._data) as BlobObject, version: envelope._v, atTier: 0 }
    }

    const t = tier ?? await this.ownerTier()
    const fallbackTier = alsoTryTier ?? (t > 0 ? 0 : undefined)

    const primaryDek = await this.getDEK(dekKey(BLOB_COLLECTION, t))
    try {
      const json = await openEnvelopeJson(envelope, primaryDek)
      return { blob: JSON.parse(json) as BlobObject, version: envelope._v, atTier: t }
    } catch (err) {
      // M1 (whole-branch review): only a decrypt/auth failure under the
      // primary key (`decrypt()` throws `TamperedError` on AES-GCM auth
      // failure — wrong key or tampered ciphertext) means "not ours at
      // this tier" — fall through to the alsoTryTier retry below (see doc
      // comment). A JSON.parse failure AFTER a successful decrypt under the
      // CORRECT primary key is genuine corruption, not a wrong-key signal,
      // and must propagate instead of being masked by a misleading
      // fallback-DEK error.
      if (!(err instanceof TamperedError)) throw err
      if (fallbackTier === undefined || fallbackTier === t) throw err
    }

    const fallbackDek = await this.getDEK(dekKey(BLOB_COLLECTION, fallbackTier))
    const json = await openEnvelopeJson(envelope, fallbackDek)
    return { blob: JSON.parse(json) as BlobObject, version: envelope._v, atTier: fallbackTier }
  }

  /**
   * `runRehomeSteps`'s per-eTag resume tolerance (#746 spec §7 §2d bullet 2)
   * — `loadBlobObject(eTag, fromTier, toTier)`, `alsoTryTier`'s first real
   * caller: `atTier === toTier` on return means this eTag's object already
   * opens under the DESTINATION tier — either a prior (crashed) run's own
   * re-`put()` already landed for it (skip: already moved), or it's a
   * `dedup`-policy/legacy object that happens to sit flat at tier 0 and
   * `toTier === 0` (skip either way — see the call site's doc comment).
   *
   * When `toTier !== 0`, that flat-at-0 legacy/dedup case is NOT covered by
   * the two tiers already tried — `loadBlobObject`'s own default fallback
   * (implicit `alsoTryTier: 0` when the primary tier is `> 0`) is exactly
   * what closes it for a non-resumable caller, but passing `toTier`
   * explicitly here overrides that default. So on a `TamperedError` from
   * both `fromTier` and `toTier`, retry once more at flat `0` — the SAME
   * fallback `loadBlobObject`'s own default already provides, just chained
   * behind the resume signal instead of replacing it.
   */
  private async loadBlobObjectResumable(
    eTag: string, fromTier: number, toTier: number,
  ): Promise<{ blob: BlobObject; version: number; atTier: number } | null> {
    try {
      return await this.loadBlobObject(eTag, fromTier, toTier)
    } catch (err) {
      if (!(err instanceof TamperedError) || toTier === 0) throw err
      return this.loadBlobObject(eTag, fromTier, 0)
    }
  }

  /**
   * @param tier See {@link loadBlobObject}'s `tier` param — same resolution.
   * A caller mutating an EXISTING object must pass the tier that OPENED it
   * (`loadBlobObject`'s `atTier`), never its own ask — see
   * `casUpdateRefCount`.
   */
  private async writeBlobObject(blob: BlobObject, expectedVersion?: number, tier?: number): Promise<void> {
    const json = JSON.stringify(blob)
    const now = new Date().toISOString()
    const newVersion = (expectedVersion ?? 0) + 1
    let envelope: EncryptedEnvelope

    if (this.encrypted) {
      const dek = await this.getDEK(dekKey(BLOB_COLLECTION, tier ?? await this.ownerTier()))
      const { iv, data } = await encrypt(json, dek)
      envelope = { _noydb: NOYDB_FORMAT_VERSION, _v: newVersion, _ts: now, _iv: iv, _data: data }
    } else {
      envelope = { _noydb: NOYDB_FORMAT_VERSION, _v: newVersion, _ts: now, _iv: '', _data: json }
    }

    await this.store.put(
      this.vault,
      BLOB_INDEX_COLLECTION,
      blob.eTag,
      envelope,
      expectedVersion,
    )
  }

  /**
   * CAS retry loop for refCount changes on a BlobObject.
   *
   * @param tier Resolves the READ side (see {@link loadBlobObject}). The
   * WRITE-back always uses `atTier` — the tier that actually opened the
   * object — never `tier` itself: a dedup-shared or legacy object left flat
   * on purpose must stay flat even when asked for under an elevated
   * owner's tier, or a refCount change would silently lift it there (#747).
   */
  private async casUpdateRefCount(eTag: string, delta: number, tier?: number): Promise<number> {
    for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
      const result = await this.loadBlobObject(eTag, tier)
      if (!result) throw new NotFoundError(`BlobObject ${eTag} not found`)
      const { blob, version, atTier } = result
      const updated: BlobObject = { ...blob, refCount: blob.refCount + delta }
      try {
        await this.writeBlobObject(updated, version, atTier)
        return updated.refCount
      } catch (err) {
        if (err instanceof ConflictError && attempt < MAX_CAS_RETRIES - 1) continue
        throw err
      }
    }
    throw new ConflictError(-1) // exhausted retries
  }

  /**
   * Stamp-aware CAS retry loop for refCount changes (#753 spec §7 C2/C4) —
   * the journal primitive `casUpdateRefCount` itself is deliberately left
   * untouched (every existing call site passes no stamp and must stay
   * byte-identical). A distinct method rather than an optional param on
   * `casUpdateRefCount` keeps the return shape type-clean: this one reports
   * whether ITS delta was newly applied, not just the resulting count.
   *
   * C4: the membership check lives INSIDE the retry loop — every (re)read,
   * including retries after a losing CAS attempt, checks `blob.lastOps` for
   * `stamp` FIRST, before computing a delta. This is what makes it a true
   * test-and-set rather than a check-then-act with a TOCTOU window: two
   * concurrent callers racing the SAME stamp can each land on any attempt,
   * but only the one that reads `lastOps` without the stamp present ever
   * applies the delta — the other, whichever attempt it lands on, always
   * observes the stamp (either already there, or freshly appended by the
   * winner) and skips.
   *
   * On apply: the stamp is appended to the bounded ring (`appendStamp`,
   * K=8) in the SAME `writeBlobObject` CAS write as the delta — no window
   * between them (spec C2's atomicity requirement).
   *
   * @returns `{ applied: true, refCount }` when this call's delta was freshly
   * applied (or `{ applied: false, refCount }` when `stamp` was already
   * present — the delta from a PRIOR call with this exact stamp already
   * landed; `refCount` reflects the object's current count, unchanged by
   * this call).
   * @param tier See {@link loadBlobObject}'s `tier` param — same resolution
   * and the same atTier write-back rule as `casUpdateRefCount`.
   */
  private async casUpdateRefCountStamped(
    eTag: string,
    delta: number,
    tier: number | undefined,
    stamp: string,
  ): Promise<{ applied: boolean; refCount: number }> {
    for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
      const result = await this.loadBlobObject(eTag, tier)
      if (!result) throw new NotFoundError(`BlobObject ${eTag} not found`)
      const { blob, version, atTier } = result
      if (blob.lastOps?.includes(stamp)) {
        return { applied: false, refCount: blob.refCount }
      }
      const updated: BlobObject = {
        ...blob,
        refCount: blob.refCount + delta,
        lastOps: appendStamp(blob.lastOps, stamp),
      }
      try {
        await this.writeBlobObject(updated, version, atTier)
        return { applied: true, refCount: updated.refCount }
      } catch (err) {
        if (err instanceof ConflictError && attempt < MAX_CAS_RETRIES - 1) continue
        throw err
      }
    }
    throw new ConflictError(-1) // exhausted retries
  }

  /**
   * Release `n` references to a blob and reclaim it at refCount 0.
   *
   * The single reclaim choke point for every reference-drop path — slot
   * delete/overwrite, published-version delete, and `forget()` shred — so the
   * refCount-0 policy is uniform:
   *  - **erasable blob** (`_cek` present) → delete the `BlobObject` (the SOLE
   *    copy of the wrapped content CEK → chunks permanently undecryptable) and
   *    reclaim the chunks. The crypto-shred is EAGER on every path: GDPR erasure
   *    must not wait on orphan retention.
   *  - **legacy blob** (no `_cek`) → reclaimed only when `reclaimLegacy` (the
   *    `forget()` erasure path); otherwise left for deferred GC so the existing
   *    `BlobLifecyclePolicy.orphanRetentionDays` semantics are preserved.
   *
   * @returns `'shredded'` (erasable, refCount 0, chunks dead) · `'retainedShared'`
   *   (erasable, still referenced) · `'residue'` (legacy — not a crypto-shred).
   *
   * @param tier See {@link loadBlobObject}'s `tier` param — forwarded to both
   * the read and the refCount write-back (which resolves its own `atTier`
   * from the read, per `casUpdateRefCount`'s doc comment).
   *
   * @param stamp #753 spec §7 C1 journal primitive: when present, this call
   * is a (possibly-resumed) journaled release and the CAS goes through
   * {@link casUpdateRefCountStamped} instead, under the two-armed resume
   * rule:
   *  - `lastOps` already has `stamp` && `refCount > 0` → this stamp's
   *    decrement already landed and the object is still referenced elsewhere
   *    — skip re-decrementing, report the same outcome a fresh call would
   *    (`retainedShared`/`residue`).
   *  - `lastOps` already has `stamp` && `refCount <= 0` → this stamp's
   *    decrement already landed, but the crash window sat BETWEEN the
   *    decrement CAS and the index+chunk deletion below — COMPLETE that
   *    deletion now (idempotent: both `store.delete` calls are void on an
   *    already-absent key).
   *  - not yet stamped → apply via `casUpdateRefCountStamped`, then proceed
   *    exactly like the unstamped path below.
   *
   * A crash can also land AFTER the index row is deleted but BEFORE every
   * chunk is — `loadBlobObject` then returns null (indistinguishable from
   * "never existed") and the object's `chunkCount` is gone with it. A
   * stamped caller who knows the true count (the journal marker's captured
   * `holds`, once that plumbing lands) supplies it via `chunkCountHint` so
   * this call can still finish the chunk deletion; without it, an
   * already-index-gone eTag is reported `'shredded'` same as today (best
   * effort — nothing left to key the cleanup off of).
   */
  private async releaseRef(
    eTag: string,
    n: number,
    reclaimLegacy: boolean,
    tier?: number,
    stamp?: string,
    chunkCountHint?: number,
  ): Promise<'shredded' | 'retainedShared' | 'residue'> {
    const loaded = await this.loadBlobObject(eTag, tier)
    if (!loaded) {
      // Index row already gone. A stamped caller who knows the true chunk
      // count (marker-supplied) can still complete cleanup; an unstamped
      // caller (or one without the hint) has nothing left to key it off —
      // best-effort, same posture as pre-#753.
      if (stamp !== undefined && chunkCountHint !== undefined) {
        for (let i = 0; i < chunkCountHint; i++) {
          await this.store.delete(this.vault, BLOB_CHUNKS_COLLECTION, `${eTag}_${i}`)
        }
      }
      return 'shredded'
    }
    const erasable = loaded.blob._cek !== undefined

    if (stamp !== undefined && loaded.blob.lastOps?.includes(stamp)) {
      // Already stamped: the decrement landed on a prior run. Two-armed
      // resume rule (spec C1).
      if (loaded.blob.refCount > 0) return erasable ? 'retainedShared' : 'residue'
      // refCount <= 0 but the object row is still here — the deletion step
      // never completed. Finish it now, idempotently.
      if (erasable || reclaimLegacy) {
        await this.store.delete(this.vault, BLOB_INDEX_COLLECTION, eTag)
        const chunkCount = chunkCountHint ?? loaded.blob.chunkCount
        for (let i = 0; i < chunkCount; i++) {
          await this.store.delete(this.vault, BLOB_CHUNKS_COLLECTION, `${eTag}_${i}`)
        }
      }
      return erasable ? 'shredded' : 'residue'
    }

    // Not yet stamped (or no stamp at all — the pre-#753 path): apply the
    // decrement now.
    const remaining = stamp !== undefined
      ? (await this.casUpdateRefCountStamped(eTag, -n, tier, stamp)).refCount
      : await this.casUpdateRefCount(eTag, -n, tier)
    if (remaining > 0) return erasable ? 'retainedShared' : 'residue'

    if (erasable || reclaimLegacy) {
      await this.store.delete(this.vault, BLOB_INDEX_COLLECTION, eTag)
      for (let i = 0; i < loaded.blob.chunkCount; i++) {
        await this.store.delete(this.vault, BLOB_CHUNKS_COLLECTION, `${eTag}_${i}`)
      }
    }
    return erasable ? 'shredded' : 'residue'
  }

  /**
   * Crypto-shred this record's blob attachments — called by
   * `vault.forget()`.
   *
   * For each distinct eTag the record references (a record may attach the same
   * content under several slot names → several refCount holds): decrement the
   * blob's refCount by that many. When it reaches 0:
   *  - **erasable blob** (`_cek` present) → delete the `BlobObject` (the SOLE
   *    recoverable copy of the wrapped content CEK → chunks permanently
   *    undecryptable) and reclaim the chunk bytes. This is the crypto-shred.
   *  - **legacy blob** (no `_cek`) → chunks are under the shared `_blob` DEK and
   *    stay decryptable until byte-deleted; we delete the orphaned chunks +
   *    index but report it as residue, not a cryptographic erasure.
   * When refCount stays > 0 the content legitimately persists for its other
   * owner — reported as `retainedShared` (or `residue` if legacy).
   *
   * Finally drops the record's slot map, severing the subject's link.
   *
   * @param ownerTier #724 Arc 10 C3: `vault.forget()` writes the record's
   * tombstone (which drops `_tier`) BEFORE calling this method, so the
   * `ownerTier()` default — a fresh peek at the now-tombstoned envelope —
   * would resolve tier 0 and decrypt the tier-scoped slot map under the
   * wrong DEK (`TamperedError`, erasure aborted mid-shred). `forget()` reads
   * the LIVE record first and passes its pre-tombstone tier here instead.
   *
   * #724 re-review (Critical) defense-in-depth: an unreadable slot map must
   * not abort the whole erasure cascade — `casUpdateSlots` deleting the row
   * instead of leaving it empty-but-present (rather than a stray mis-keyed
   * envelope) is what makes an ABSENT row the normal "no blobs" case, and
   * `loadSlots` already returns `{ slots: {}, version: 0 }` cleanly for
   * that, never throwing. So the only way this catch fires is a row that IS
   * present failing to decrypt — genuine corruption/mis-key/tamper — and
   * that must never be swallowed as "no blobs to shred": it is pushed onto
   * `residue` so `forget()` surfaces it via `blobResidueCollections` rather
   * than silently reporting a clean erasure while un-shredded blobs remain.
   *
   * #750: published versions (`_blob_versions_{collection}/{recordId}::*`)
   * take an INDEPENDENT refCount hold on a `BlobObject`, separate from the
   * slot map (see `publish()`) — the slot loop above never sees them. Left
   * untouched, that hold (and the version-held content, if the slot was
   * later overwritten) survives `forget()` — a GDPR-erasure hole. So this
   * method also enumerates the record's version rows via
   * `collectVersionHolds`, folds each version's hold into the SAME `holds`
   * map (a shared eTag reports ONE outcome, not two), and deletes the
   * readable version rows once their holds are released.
   *
   * **#753 spec §7 (crash-idempotent shred):** the holds used for the
   * actual release loop below come from a `_blob_intent` MARKER, never
   * re-collected from rows on resume:
   *  - `forget()` mints the marker PRE-tombstone (`mintShredIntent`,
   *    C5) — the normal case, so a marker is ALREADY present by the time
   *    this method runs and `intent.ownerTier` (captured live, before the
   *    tombstone dropped `_tier`) is authoritative even when the caller's
   *    own `ownerTier` argument is stale (a crash-retried `forget()`
   *    re-reads the now-tombstoned record and can only pass `0`).
   *  - Called WITHOUT a pre-existing marker (defensive/non-forget callers,
   *    or the direct-call path this suite exercises) — one is minted here
   *    from the live rows, exactly like `mintShredIntent` does, so the
   *    crash matrix holds regardless of caller (spec §2c).
   *  - A pending `op:'rehome'` marker is resumed to completion FIRST (#746
   *    spec §7 Q1 — "supersession is resume-then-shred": a half-done rehome
   *    can leave a row-unreferenced destination object that shred's
   *    row-derived holds can never see; replacing the marker instead of
   *    resuming it would leak that object past `forget()` permanently), via
   *    {@link resolveShredIntent} — then a fresh SHRED marker is minted (or
   *    discovered, if the resume's own completion raced with another
   *    minter) exactly as the no-marker branch below does.
   *
   * **Whole-branch review (#753):** the marker is a crash-safety
   * ENHANCEMENT, not a precondition for erasure. If the no-marker branch's
   * own mint fails (transient store error, `getDEK` failure — possibly the
   * same failure that already sent `forget()`'s pre-tombstone mint to
   * residue), this degrades to {@link unmarkedShred} — a best-effort
   * UNMARKED shred, exactly the pre-#753 behavior — rather than aborting
   * and leaving the blobs un-shredded.
   *
   * **#746 review Critical 1:** that degradation covers ONLY a genuine
   * no-marker mint failure — nothing was in flight, so a live-row
   * best-effort re-collection is safe. A REHOME-resume failure is a
   * DIFFERENT failure mode: a marker WAS present and its holds are
   * ambiguous mid-move (C10's whole point). `resolveShredIntent` below
   * therefore never wraps `consumeRehomeIntent` in the mint's degradation
   * try/catch — a resume failure propagates all the way out of this
   * method uncaught, leaving the rehome marker alive (never `deleteIntent`d)
   * for a later resume, instead of silently falling through to
   * `unmarkedShred`, which would both clobber rows the ambiguous rehome
   * still needs and abandon the marker forever (the exact permanent-leak
   * shape the journal exists to prevent).
   *
   * `collectShredHolds` is re-run here (idempotent — a corrupt/unreadable
   * row stays corrupt/unreadable on re-read; an already-deleted row reads
   * back cleanly empty) purely to derive the slot-map/version-row DELETE
   * targets and residue notices — never to recompute the release counts,
   * which are fixed for the operation's lifetime in the marker (C1/C2).
   */
  async shredAllForRecord(ownerTier?: number): Promise<{
    shredded: string[]
    retainedShared: string[]
    residue: string[]
  }> {
    const tierArg = ownerTier ?? 0
    const intent = await this.resolveShredIntent(tierArg)
    if (!intent) return this.unmarkedShred(tierArg)
    const tier = intent.ownerTier ?? tierArg
    const collected = await this.collectShredHolds(tier)
    return this.consumeShredIntent(intent, tier, collected)
  }

  /**
   * Resolve a SHRED `BlobIntent` for this record, or `null` when the entry
   * mint itself failed and nothing was in flight (the caller degrades to
   * {@link unmarkedShred}) — `shredAllForRecord`'s entry logic (#746 spec §7
   * Q1), factored out so the two failure modes stay structurally separate
   * (#746 review Critical 1):
   *
   *  - A pending REHOME marker — found up front OR discovered via a raced
   *    `createIntent` inside `mintFreshShredIntent` — is resumed via
   *    {@link consumeRehomeIntent} OUTSIDE the `try` below. Its failure
   *    PROPAGATES to the caller uncaught: holds are ambiguous mid-move, so
   *    this must surface, never silently degrade.
   *  - Only `mintFreshShredIntent` itself (the create-a-fresh-SHRED-marker
   *    step, reached with no rehome in flight) is wrapped — its failure is
   *    the ONLY thing `null` reports, matching the whole-branch-review
   *    degrade contract exactly.
   *
   * The loop re-attempts the mint after resuming a raced rehome discovery,
   * mirroring `resolveToShredIntent`'s prior recursive shape without ever
   * routing a `consumeRehomeIntent` call through the mint's own catch.
   */
  private async resolveShredIntent(tierArg: number): Promise<BlobIntent | null> {
    let intent = await getIntent(this.store, this.vault, this.collection, this.recordId, this.getDEK)
    let effectiveTier = tierArg
    for (;;) {
      if (intent && intent.op === 'rehome') {
        await this.consumeRehomeIntent(intent) // #746 review Critical 1: never caught here — propagates
        // #746 whole-branch review Hardening 2: the resumed rehome's OWN
        // `toTier` is now this record's TRUE live tier — use it for the
        // fresh shred mint below, not the caller's `tierArg` (sound today
        // only because `forget()` happens to pass `live._tier`, which
        // equals it; a direct `shredAllForRecord(staleTier)` caller after a
        // resumed rehome must not `collectShredHolds` at the wrong tier).
        effectiveTier = intent.toTier!
        intent = null
      }
      if (intent) return intent
      try {
        intent = await this.mintFreshShredIntent(effectiveTier)
      } catch {
        // Whole-branch review (#753): the mint is a crash-safety enhancement,
        // never a precondition for erasure — report "nothing resolved" so
        // the caller degrades to a best-effort unmarked shred. Scoped to
        // ONLY the mint call above — a `consumeRehomeIntent` failure never
        // reaches this catch (#746 review Critical 1).
        return null
      }
      if (intent.op === 'shred') return intent
      // intent.op === 'rehome': raced with a concurrent minter (C4) — loop
      // back to resume IT (outside this try/catch) before retrying the mint.
    }
  }

  /**
   * Best-effort UNMARKED shred (#753 whole-branch review) — reached only
   * when `shredAllForRecord`'s own entry-mint threw, so there is no marker
   * to journal against. Reproduces the pre-#753 `shredAllForRecord` body:
   * collect this record's holds from the live rows, release each unstamped
   * (no journal — a crash here reverts to the pre-#753 stranding-eTag
   * exposure, exactly like main before this arc), then unconditionally drop
   * the slot map / readable version rows. The mint failure itself is
   * reported as `_blob_intent` residue so `forget()` surfaces the
   * degraded crash-safety posture via `blobResidueCollections`, never
   * silently.
   */
  private async unmarkedShred(tier: number): Promise<{
    shredded: string[]
    retainedShared: string[]
    residue: string[]
  }> {
    const shredded: string[] = []
    const retainedShared: string[] = []
    const collected = await this.collectShredHolds(tier)
    const residue: string[] = [...collected.residue, `${this.collection}:${this.recordId}:_blob_intent`]
    for (const hold of collected.holds) {
      const outcome = await this.releaseRef(hold.eTag, hold.n, true, tier)
      if (outcome === 'shredded') shredded.push(hold.eTag)
      else if (outcome === 'retainedShared') retainedShared.push(hold.eTag)
      else residue.push(hold.eTag)
    }
    if (collected.slotsPresent) await this.store.delete(this.vault, this.slotsCollection, this.recordId)
    for (const key of collected.versionKeysToDelete) await this.store.delete(this.vault, this.versionsCollection, key)
    return { shredded, retainedShared, residue }
  }

  /**
   * Collect this record's CURRENT blob holds (slot map + published
   * versions) at `tier` — the shred journal's single hold-collection
   * routine (#753 spec §7), shared by `mintFreshShredIntent` (to seed a
   * fresh marker's authoritative `holds`) and `shredAllForRecord`/
   * `resolvePendingIntent` (to derive delete targets + residue on
   * consumption — see {@link shredAllForRecord}'s doc comment for why that
   * second use never feeds the release loop). Mirrors the pre-#753
   * inline collection logic byte-for-byte; `chunkCount` per hold (C5) is
   * best-effort — an unreadable index row just means the marker's hint is
   * absent, `releaseRef`'s own chunkCountHint fallback still applies.
   */
  private async collectShredHolds(tier: number): Promise<{
    holds: BlobIntentHold[]
    slotsPresent: boolean
    versionKeysToDelete: string[]
    residue: string[]
  }> {
    const residue: string[] = []
    let slots: Record<string, SlotRecord> = {}
    try {
      slots = (await this.loadSlots(tier)).slots
    } catch {
      // See shredAllForRecord's pre-#753 doc comment (now on collectShredHolds):
      // `loadSlots` throws only when the row is PRESENT but undecodable.
      residue.push(`${this.collection}:${this.recordId}:_blob_slots`)
    }

    const holdsMap = new Map<string, number>()
    for (const name of Object.keys(slots)) {
      const eTag = slots[name]!.eTag
      holdsMap.set(eTag, (holdsMap.get(eTag) ?? 0) + 1)
    }
    const versionKeysToDelete = await this.collectVersionHolds(tier, holdsMap, residue)

    const holds: BlobIntentHold[] = []
    for (const [eTag, n] of holdsMap) {
      let chunkCount = 0
      try {
        chunkCount = (await this.loadBlobObject(eTag, tier))?.blob.chunkCount ?? 0
      } catch {
        // Best-effort (C5 doc comment): releaseRef's own chunkCountHint
        // fallback covers the index-row-already-gone case; a hint that
        // couldn't be captured here just means that fallback won't fire.
      }
      holds.push({ eTag, n, chunkCount })
    }
    return { holds, slotsPresent: Object.keys(slots).length > 0, versionKeysToDelete, residue }
  }

  /**
   * Collect this record's current holds and CAS-create a fresh `_blob_intent`
   * SHRED marker from them (#753 spec §7 C8). Used by `mintShredIntent`
   * (forget()'s pre-tombstone step) and `shredAllForRecord`'s no-marker
   * (defensive/direct-call) branch.
   *
   * C4: a concurrent minter for this SAME record can win the create race —
   * `createIntent` throws `BlobIntentPendingError`, and the winner's marker
   * (whatever op it turns out to be) is returned instead; the caller decides
   * how to handle a raced rehome marker.
   */
  private async mintFreshShredIntent(tier: number): Promise<BlobIntent> {
    const collected = await this.collectShredHolds(tier)
    const candidate: BlobIntent = { op: 'shred', opId: mintOpId(), holds: collected.holds, ownerTier: tier }
    try {
      await createIntent(this.store, this.vault, this.collection, this.recordId, this.getDEK, candidate)
      return candidate
    } catch (err) {
      if (!(err instanceof BlobIntentPendingError)) throw err
      const raced = await getIntent(this.store, this.vault, this.collection, this.recordId, this.getDEK)
      if (raced) return raced
      throw err // vanishingly unlikely: deleted between the failed create and this read
    }
  }

  /**
   * Release every hold in `intent.holds` (stamped with `intent.opId`), then
   * delete the slot map / readable version rows / the marker itself — the
   * shred journal's consume step (#753 spec §7 §2c), shared by
   * `shredAllForRecord` and `resolvePendingIntent`.
   *
   * **C10 (no swallowed releases under a marker):** a release that THROWS
   * (as opposed to returning `'residue'`, a normal non-error outcome for a
   * legacy blob) is caught, reported as residue, and marks the whole
   * consumption incomplete — the slot map, version rows, and the marker
   * itself are then left IN PLACE (not deleted) so a later resume retries
   * every hold. Stamped holds that already landed skip re-decrementing
   * (C1/C4's test-and-set), so redoing the full loop on retry is safe.
   */
  private async consumeShredIntent(
    intent: BlobIntent,
    tier: number,
    collected: { slotsPresent: boolean; versionKeysToDelete: string[]; residue: string[] },
  ): Promise<{ shredded: string[]; retainedShared: string[]; residue: string[] }> {
    const shredded: string[] = []
    const retainedShared: string[] = []
    const residue: string[] = [...collected.residue]
    let allApplied = true

    for (const hold of intent.holds ?? []) {
      try {
        const outcome = await this.releaseRef(hold.eTag, hold.n, true, tier, intent.opId, hold.chunkCount)
        if (outcome === 'shredded') shredded.push(hold.eTag)
        else if (outcome === 'retainedShared') retainedShared.push(hold.eTag)
        else residue.push(hold.eTag)
      } catch {
        residue.push(hold.eTag)
        allApplied = false
      }
    }

    if (allApplied) {
      if (collected.slotsPresent) await this.store.delete(this.vault, this.slotsCollection, this.recordId)
      for (const key of collected.versionKeysToDelete) await this.store.delete(this.vault, this.versionsCollection, key)
      await deleteIntent(this.store, this.vault, this.collection, this.recordId)
    }
    return { shredded, retainedShared, residue }
  }

  /**
   * Resume gate (#753/#746 spec §7 C6): every refCount/slot mutator calls
   * this FIRST. A pending SHRED marker means a previous `forget()`/
   * `shredAllForRecord()` crashed mid-flight — refCounts are ambiguous
   * until it's resumed, so no new blob write may proceed over them; this
   * resumes it to completion before the caller's own mutation runs. A
   * pending REHOME marker means a previous tier move crashed mid-flight —
   * resumed to completion the SAME way (§2d), via {@link consumeRehomeIntent}
   * using the marker's OWN captured `fromTier`/`toTier`/`policy`/`opId`,
   * never the caller's own ask (which may be a totally unrelated write).
   *
   * Never called from `shredAllForRecord`/`mintShredIntent`/
   * `mintFreshShredIntent`/`collectShredHolds`/`consumeShredIntent`/
   * `sweepPendingShredIntents`/`runRehomeSteps`/`consumeRehomeIntent`
   * themselves — those ARE the resume machinery; routing them back through
   * this gate would recurse.
   */
  private async resolvePendingIntent(): Promise<void> {
    const intent = await getIntent(this.store, this.vault, this.collection, this.recordId, this.getDEK)
    if (!intent) return
    if (intent.op === 'rehome') {
      await this.consumeRehomeIntent(intent)
      return
    }
    const tier = intent.ownerTier ?? 0
    const collected = await this.collectShredHolds(tier)
    await this.consumeShredIntent(intent, tier, collected)
  }

  /**
   * Resume a pending REHOME marker to completion: run {@link
   * runRehomeSteps} (never the public `rehomeForTier`/`syncTierMove` —
   * both would re-enter `resolvePendingIntent` on the SAME marker and
   * recurse) using the marker's own captured `fromTier`/`toTier`/`policy`/
   * `opId`, then delete it. Shared by `resolvePendingIntent`'s rehome
   * branch and `resolveToShredIntent` (#746 spec §7 Q1: forget() resumes a
   * pending rehome before shredding).
   */
  private async consumeRehomeIntent(intent: BlobIntent): Promise<void> {
    await this.runRehomeSteps(intent.fromTier!, intent.toTier!, intent.policy!, intent.opId)
    await deleteIntent(this.store, this.vault, this.collection, this.recordId)
  }

  /**
   * Resume every stranded SHRED marker in THIS collection (#753 spec §7 —
   * `sweepBlobIntents`'s first real production caller, Task 3 item 5).
   * Scoped to `this.collection` rather than the whole vault: `forget()`
   * already iterates per-ref-collection, so calling this from
   * `mintShredIntent` once per ref opportunistically heals any OTHER
   * record's marker left behind by a previous crashed operation in the
   * same collection — "heals untouched ones" (spec C5's retry contract),
   * without a separate vault-open hook. A pending REHOME marker on a
   * sibling record is left alone here (out of THIS sweep's scope — it heals
   * on its OWN record's next write/tier-op via `resolvePendingIntent`,
   * §2d's "who resumes") rather than surfaced as a resume failure.
   * `sweepBlobIntents`'s own per-marker
   * isolation (blob-intent.ts) means one corrupt sibling never blocks
   * another record's healthy resume.
   */
  private async sweepPendingShredIntents(): Promise<void> {
    await sweepBlobIntents(this.store, this.vault, this.getDEK, async (collection, recordId, marker) => {
      if (collection !== this.collection || marker.op !== 'shred') return
      const target = new BlobSet({
        store: this.store, vault: this.vault, collection, recordId,
        getDEK: this.getDEK, encrypted: this.encrypted,
      })
      await target.resolvePendingIntent()
    })
  }

  /**
   * Mint the `_blob_intent` SHRED marker for this record — `vault.forget()`'s
   * PRE-tombstone step (#753 spec §7 C5). Captures this record's CURRENT
   * blob holds (slot map + published versions, at `ownerTier` — the LIVE
   * pre-tombstone tier) into a fresh marker before any destructive write
   * happens, so a crash between here and `shredAllForRecord`'s completion —
   * including one straddling the tombstone itself, which drops `_tier` and
   * would otherwise strand an elevated record's holds unrecoverably on
   * retry — leaves a resumable, tier-correct record of what must still be
   * released.
   *
   * First sweeps this collection for any stranded marker
   * (`sweepPendingShredIntents`) — this resumes a PRE-EXISTING marker for
   * THIS record (a previous forget() attempt crashed mid-shred) to
   * completion before minting fresh (C8: never overwrite a pending
   * marker — that would orphan its op-stamps), as a side effect of the
   * same collection-wide sweep.
   */
  async mintShredIntent(ownerTier: number): Promise<void> {
    await this.sweepPendingShredIntents()
    await this.mintFreshShredIntent(ownerTier)
  }

  /**
   * #750: enumerate this record's published-version rows (`{recordId}::*` in
   * `_blob_versions_{collection}` — the same raw prefix scan as
   * `rehomeVersionRecords`) and fold each version's independent refCount hold
   * into `holds`. Returns the READABLE version keys — safe to delete once
   * their holds are released. An unreadable row is pushed onto `residue` and
   * NOT returned: deleting it blind would orphan its refCount hold and strand
   * the content undecryptable-but-undeleted forever, so it stays in place for
   * out-of-band repair (mirrors the unreadable-slot-map posture above).
   */
  private async collectVersionHolds(
    ownerTier: number | undefined,
    holds: Map<string, number>,
    residue: string[],
  ): Promise<string[]> {
    const prefix = `${this.recordId}::`
    const keys = (await this.store.list(this.vault, this.versionsCollection)).filter((k) => k.startsWith(prefix))
    if (keys.length === 0) return []
    const readable: string[] = []
    const dek = this.encrypted ? await this.getDEK(dekKey(this.collection, ownerTier ?? await this.ownerTier())) : null
    for (const key of keys) {
      const envelope = await this.store.get(this.vault, this.versionsCollection, key)
      if (!envelope) continue
      try {
        const record = this.encrypted
          ? JSON.parse(await openEnvelopeJson(envelope, dek!)) as VersionRecord
          : JSON.parse(envelope._data) as VersionRecord
        holds.set(record.eTag, (holds.get(record.eTag) ?? 0) + 1)
        readable.push(key)
      } catch {
        residue.push(`${this.collection}:${this.recordId}:${key}`)
      }
    }
    return readable
  }

  /**
   * Rehome this record's blobs after a tier move (#724 Arc 10 Task 2,
   * at-rest isolation) — called by `TiersContext.syncBlobs`. A blob's home
   * tier is its owning record's tier: the `_blob` DEK is tier-scoped via
   * `dekKey('_blob', tier)`, so moving a record's tier must move the
   * wrapping key of any blob it exclusively owns, or a tier-0-cleared
   * caller could still unwrap the content CEK off the store at rest even
   * though the runtime read gate (Task 1) hides it through the API.
   *
   * Every read/write of the slot map INSIDE this method pins `fromTier`
   * explicitly (never the `loadSlots()`/`saveSlots()` default) — by the
   * time this runs, the owning record's live `_tier` envelope has ALREADY
   * moved to `toTier` (the collection-level `elevate`/`demote`/`putAtTier`
   * writes the record before invoking `syncBlobs`), but the slot map itself
   * is still physically encrypted at `fromTier` until this method's own
   * move step (last) lands. `ownerTier()`'s default would resolve the
   * wrong DEK for every read until then.
   *
   * Enumerates the record's eTags via the slot map — mirrors
   * `shredAllForRecord`'s `loadSlots()` → `holds` enumeration above. For
   * each distinct eTag:
   *  - **solo** (`refCount === 1`) and **shared `isolate`** (`refCount > 1`,
   *    default policy) are UNIFIED (#724 Arc 10 correction, closes C1): both
   *    re-`put()` the plaintext under `toBlobDEK` for every one of this
   *    record's slots pointing at the eTag. That mints a fresh, tier-scoped
   *    eTag/`_cek` (HMAC + wrap keyed by `toBlobDEK`) and, via `put()`'s own
   *    existing old-eTag decrement, releases this record's hold on the old
   *    object — a solo blob's old object drops to refCount 0 and is
   *    crypto-shredded; a shared co-owner keeps its unchanged refCount. The
   *    OLD in-place rewrap (`wrapCek(unwrapCek(_cek, fromDEK), toDEK)`, eTag
   *    held stable) is UNSAFE — it leaves the eTag in the FROM tier's HMAC
   *    namespace, so a later same-bytes put computed under that tier's DEK
   *    dedup-*hits* the wrapped object (cross-tier corruption of an
   *    uninvolved writer). Re-`put()`ing makes that structurally
   *    impossible: different tiers hash to different eTags. Landing at
   *    `toTier === 0` naturally REJOINS the tier-0 dedup pool if a co-owner
   *    already holds the content there (`put()`'s own dedup check matches
   *    on the recomputed tier-0-native eTag) — this is how `demote(→0)`
   *    reverses an `elevate()` fork.
   *  - **shared `dedup`** (#741, opt-in, only for `refCount > 1`): NO-OP.
   *    The slot keeps pointing at the shared eTag. The Task-1 runtime read
   *    gate still hides it from a tier-0 caller; the chunks remain
   *    decryptable at rest under the flat `_blob` DEK (documented residue).
   *  - **legacy** (`_cek` absent — chunks direct under the flat `_blob`
   *    DEK): NO-OP. Tiered collections mandate `perRecordKeys`, so new
   *    blob data is always erasable; a legacy blob reaching this method
   *    would need a chunk re-encrypt (not attempted here).
   *
   * #724 Arc 10 Task 4 — slot-map metadata move: LAST step, after every
   * fork/rewrap/reconcile write above (which all operated on the slot map
   * via the explicit `fromTier`, its still-current physical location).
   * Re-reads (to pick up any fork/reconcile-produced eTag changes from the
   * loop) and re-encrypts the SAME `_blob_slots_{collection}/{recordId}`
   * row under the `toTier` collection DEK — filenames/sizes/mimeTypes/eTags
   * are no longer tier-0-readable at rest for an elevated record. No
   * separate delete: it's the same physical row, just re-keyed in place
   * (mirrors `history.ts`'s `rewrapHistory`).
   *
   * @param opId #753/#746 spec §7 C3: the governing `_blob_intent` rehome
   * marker's op-stamp identity, threaded through by `syncTierMove`. Omitted
   * (a direct call, e.g. tests) → byte-identical unstamped behavior. When
   * present, every DESTINATION refCount `+1` this call performs (the slot
   * loop's dedup-hit re-put below, and `rehomeVersionETag`'s own increment)
   * carries a ROW-SCOPED stamp — `${opId}:${slotName}` / `${opId}:${versionKey}`,
   * never the bare opId — so a resumed re-put's `+1` is idempotent per row
   * without collapsing N legitimate `+1`s onto one destination eTag into one.
   *
   * The direct-call entry point: resumes a pending SHRED marker first
   * (unchanged, #753 C6), or a pending REHOME marker for a DIFFERENT prior
   * op (#746 Q1 — resumed via its OWN stored fromTier/toTier/opId before
   * this call's requested move proceeds), then runs {@link runRehomeSteps}.
   * `syncTierMove` — the real tier-op seam (`syncBlobs`) — calls
   * `runRehomeSteps` directly instead, after minting/consuming its own
   * marker (calling back through here would re-enter `resolvePendingIntent`
   * on the marker `syncTierMove` itself just created).
   */
  async rehomeForTier(fromTier: number, toTier: number, policy: 'isolate' | 'dedup', opId?: string): Promise<void> {
    if (!this.encrypted || fromTier === toTier) return
    await this.resolvePendingIntent() // #753/#746 spec §7 C6/Q1: resume a pending shred OR a stale rehome first
    await this.runRehomeSteps(fromTier, toTier, policy, opId)
  }

  /**
   * The tier-op → rehome seam (#746 spec §7 §2d) — called by
   * `TiersContext.syncBlobs` (`collection.ts`), replacing the pre-#746
   * unstamped `rehomeForTier` call. Mints the governing `_blob_intent`
   * REHOME marker BEFORE the first write (CAS create-if-absent), resuming
   * any marker already pending for this record first — a stale rehome from
   * an earlier, different move, or a shred, per the same C6/Q1 resume-first
   * law `rehomeForTier`'s own entry follows. Deletes the marker as the LAST
   * step, once every phase of {@link runRehomeSteps} completes without
   * throwing (a failure — including a C10 unswallowed release — leaves the
   * marker in place for the next resume).
   */
  async syncTierMove(fromTier: number, toTier: number, policy: 'isolate' | 'dedup'): Promise<void> {
    if (!this.encrypted || fromTier === toTier) return
    await this.resolvePendingIntent() // resume whatever is already pending for this record first
    if (await this.isBlobFree(fromTier)) return // #746 whole-branch review Hardening 1: nothing to journal
    const opId = mintOpId()
    const intent: BlobIntent = { op: 'rehome', opId, fromTier, toTier, policy }
    try {
      await createIntent(this.store, this.vault, this.collection, this.recordId, this.getDEK, intent)
    } catch (err) {
      if (!(err instanceof BlobIntentPendingError)) throw err
      // Raced with a concurrent minter for this record (C8) — resume
      // whichever marker won, then retry this request once resolved.
      await this.resolvePendingIntent()
      return this.syncTierMove(fromTier, toTier, policy)
    }
    await this.runRehomeSteps(fromTier, toTier, policy, opId)
    await deleteIntent(this.store, this.vault, this.collection, this.recordId)
  }

  /**
   * #746 whole-branch review Hardening 1: `syncTierMove` runs on EVERY tier
   * move (`elevate`/`demote`/`putAtTier`) — including the common case of a
   * record that has never attached a blob. Minting-then-deleting a marker
   * for such a record is pure overhead (~4 extra adapter ops on every
   * bulk elevate/demote of blob-less records) protecting nothing: an empty
   * slot map AND no published versions means there is genuinely no content
   * this op could strand. Checked AFTER `resolvePendingIntent` (a pending
   * marker, however stale, is always resumed first regardless of current
   * blob state — it may reference content this check alone wouldn't see)
   * and BEFORE minting a new one.
   */
  private async isBlobFree(fromTier: number): Promise<boolean> {
    const { slots } = await this.loadSlots(fromTier)
    if (Object.keys(slots).length > 0) return false
    const prefix = `${this.recordId}::`
    const versionKeys = await this.store.list(this.vault, this.versionsCollection)
    return !versionKeys.some((k) => k.startsWith(prefix))
  }

  /**
   * The resumable rehome executor (#746 spec §7 §2d) — `rehomeForTier`'s
   * pre-#746 body, factored out so it can be invoked WITHOUT re-entering
   * `resolvePendingIntent` (which would recurse: this method IS part of the
   * resume machinery, called from `resolvePendingIntent`'s own rehome
   * branch and from `syncTierMove` after its marker is already settled).
   *
   * Per-step resume tolerance:
   *  - Slot map: {@link loadSlotsTolerant} tries `fromTier` then `toTier` —
   *    if it opens at `toTier`, a prior run's move step already landed, so
   *    the ENTIRE per-eTag loop (strictly sequenced before the move) is
   *    also already done — skip both, but first reconstruct `rehomedETags`
   *    (see below) so the version pass's same-eTag fast path still works
   *    (carried finding (a)).
   *  - Per-eTag: {@link loadBlobObjectResumable} — an eTag that only opens
   *    under `toTier` means THIS slot's re-put already landed on a prior
   *    run — skip re-processing it.
   *  - Slot-CAS→release gap (carried finding (b)): {@link
   *    reconcilePendingReleases} runs FIRST, completing any old-eTag
   *    release a prior run's `putUnderDEK` left stranded (slot already
   *    moved to the new eTag, release not yet applied) before either the
   *    "already moved" or "still moving" branch below runs.
   *  - Version pass: same per-key tolerance, in `rehomeVersionRecords`.
   *  - Destination `+1`s (#746 whole-branch review, K=8 stamp-ring
   *    blocker): `knownApplied` — this op's marker-backed
   *    `appliedStamps`, read ONCE here — makes every row-scoped
   *    increment idempotent INDEPENDENTLY of `BlobObject.lastOps`'s
   *    bounded ring; see {@link applyStampedIncrement}'s doc comment.
   */
  private async runRehomeSteps(fromTier: number, toTier: number, policy: 'isolate' | 'dedup', opId?: string): Promise<void> {
    const { slots, atTier: slotsAtTier } = await this.loadSlotsTolerant(fromTier, toTier)
    if (opId !== undefined) await this.reconcilePendingReleases(slots, fromTier, opId)
    const knownApplied: ReadonlySet<string> = opId !== undefined
      ? new Set((await getIntent(this.store, this.vault, this.collection, this.recordId, this.getDEK))?.appliedStamps ?? [])
      : EMPTY_STAMP_SET

    // Old eTag → new eTag for every object the slot loop below physically
    // re-`put()`s. Passed on to `rehomeVersionRecords` (#724 Arc 10 Task 2,
    // C4) so a version pinned to the SAME eTag a slot held can skip a
    // redundant fetch+re-encrypt — same plaintext + same `toBlobDEK` always
    // hashes to the same destination eTag (content-addressing).
    const rehomedETags = new Map<string, string>()

    if (Object.keys(slots).length > 0) {
      if (slotsAtTier === toTier) {
        // Already fully moved by a prior (crashed) run — the move step is
        // strictly sequenced AFTER the per-eTag loop, so its completion
        // proves the loop already ran to completion too. Reconstruct
        // `rehomedETags` (old → new) so a version pass below sharing one of
        // these eTags still hits the fast path (carried finding (a)) rather
        // than falling through to a fromTier lookup for an eTag that may no
        // longer exist there.
        const toBlobDEK = await this.getDEK(dekKey(BLOB_COLLECTION, toTier))
        const fromBlobDEK = await this.getDEK(dekKey(BLOB_COLLECTION, fromTier))
        const doneETags = new Set(Object.values(slots).map((s) => s.eTag).filter((eTag) => eTag !== ''))
        for (const eTag of doneETags) {
          let loaded: { blob: BlobObject; version: number; atTier: number } | null
          try {
            // #746 review Critical 2: NO `alsoTryTier` — `loadBlobObject`'s
            // own DEFAULT fallback (implicit tier 0 when `toTier > 0`) would
            // otherwise silently open a still-flat `dedup`-left-in-place
            // object (#741, refCount > 1) at tier 0 and report success; the
            // `loaded.atTier !== toTier` guard below is what actually
            // catches that case (a `TamperedError` here only covers the
            // rarer "no fallback exists at all", e.g. `toTier === 0`).
            loaded = await this.loadBlobObject(eTag, toTier)
          } catch (err) {
            if (err instanceof TamperedError) continue // legacy/dedup, left flat — never moved, nothing to reconstruct
            throw err
          }
          // `loaded.atTier !== toTier`: the object opened via a FALLBACK
          // tier (not `toTier` itself) — it never actually moved to
          // `toTier` (a `dedup`-policy shared object left flat on purpose,
          // #741). Fetching it under `toBlobDEK` below would unwrap a
          // `_cek` that was never wrapped under that key — an uncaught
          // `TamperedError`/unwrap failure, permanently stuck on resume.
          // Nothing to reconstruct for it: its slot never held a DIFFERENT
          // eTag to begin with.
          if (!loaded || loaded.atTier !== toTier || loaded.blob._cek === undefined) continue
          const plaintext = await this.fetchAllChunks(loaded.blob, toBlobDEK)
          const oldETag = await hmacSha256Hex(fromBlobDEK, plaintext)
          if (oldETag !== eTag) rehomedETags.set(oldETag, eTag)
        }
      } else {
        const eTags = new Set(Object.values(slots).map((s) => s.eTag).filter((eTag) => eTag !== ''))

        if (eTags.size > 0) {
          const fromBlobDEK = await this.getDEK(dekKey(BLOB_COLLECTION, fromTier))
          const toBlobDEK = await this.getDEK(dekKey(BLOB_COLLECTION, toTier))

          for (const eTag of eTags) {
            const loaded = await this.loadBlobObjectResumable(eTag, fromTier, toTier)
            if (!loaded) continue
            if (loaded.atTier === toTier) continue // already moved by a prior run — see doc comment
            const { blob } = loaded
            if (blob._cek === undefined) continue // legacy: no rewrap (see doc comment)
            if (policy === 'dedup' && blob.refCount > 1) continue // #741: leave the shared object; read gate covers runtime

            // solo + shared-isolate, unified (#724 Arc 10 correction): fork for
            // every slot on THIS record pointing at the eTag, then release this
            // record's hold on the old object (via put()'s own old-eTag
            // decrement) — a solo blob's old object is crypto-shredded at
            // refCount 0, a shared co-owner keeps its unchanged refCount.
            const plaintext = await this.fetchAllChunks(blob, fromBlobDEK)
            rehomedETags.set(eTag, await hmacSha256Hex(toBlobDEK, plaintext))
            for (const [slotName, slot] of Object.entries(slots)) {
              if (slot.eTag !== eTag) continue
              // #747: `fromTier` still pins the slot-map CAS (it's physically
              // there until this method's own move step, last); `toTier` is the
              // NEW object's home — thread it alongside `toBlobDEK` so the fresh
              // `_blob_index` envelope is born tier-keyed, not flat.
              await this.putUnderDEK(slotName, plaintext, toBlobDEK, {
                filename: slot.filename,
                ...(blob.mimeType !== undefined ? { mimeType: blob.mimeType } : {}),
                compress: blob.compression === 'gzip',
                ...(slot.uploadedBy !== undefined ? { uploadedBy: slot.uploadedBy } : {}),
              }, fromTier, toTier, opId, knownApplied)
            }
          }
        }

        const { slots: finalSlots, version: finalVersion } = await this.loadSlots(fromTier)
        await this.saveSlots(finalSlots, finalVersion, toTier)
      }
    }

    // #724 Arc 10 Task 2 (C4): published versions follow too. `publish()`
    // takes an INDEPENDENT refCount hold on a `BlobObject`, separate from
    // the slot map — the loop above only walks
    // `_blob_slots_{collection}/{recordId}` and never sees it. A version
    // whose eTag was superseded in the slot map (overwritten after publish)
    // would otherwise never be rehomed at all, and the version RECORD
    // itself (label/eTag/timestamps) stays on the fromTier collection DEK.
    await this.rehomeVersionRecords(fromTier, toTier, policy, rehomedETags, opId, knownApplied)
  }

  /**
   * Rehome this record's PUBLISHED VERSIONS after a tier move — the second
   * half of `rehomeForTier` (#724 Arc 10 Task 2, closes C4). Enumerates
   * every `_blob_versions_{collection}/{recordId}::*` row (mirrors
   * `listVersions`'s raw prefix scan, but across ALL slots on this record,
   * not one) and, for each:
   *  - rehomes its held eTag via {@link rehomeVersionETag} (reusing the slot
   *    loop's result when the version happens to hold the SAME eTag a slot
   *    held — see that method's doc comment), and
   *  - re-keys the version RECORD itself onto the `toTier` collection DEK,
   *    regardless of whether the content moved — metadata protection is
   *    orthogonal to the shared-content dedup policy (matches the slot-map
   *    move, which always relocates even for a `dedup`-left-in-place blob).
   *
   * Per-key resume tolerance (#746 spec §7 §2d bullet 3): each key's
   * metadata is read via {@link loadVersionRecordAtKeyTolerant} (try
   * `fromTier` then `toTier`) — a key whose metadata already opens at
   * `toTier` had its `resolveRehomedVersionETag` call AND its
   * `writeVersionRecordAtKey` BOTH already land on a prior run (the
   * metadata write is sequenced strictly after the eTag rehome, which
   * itself completes the old-eTag release under C1's two-armed resume rule
   * — same order as the slot loop's own CAS-then-release), so it's skipped
   * entirely.
   *
   * Known residual gap (documented, not closed by this task — see the T2
   * report): if a version's OLD eTag is held ONLY by that version (never
   * shared with any slot), a crash strictly between
   * `resolveRehomedVersionETag`'s release (drops it to refCount 0,
   * crypto-shredding a solo-held erasable object) and THIS method's
   * metadata write would leave the version pointing at an eTag whose sole
   * copy is already gone. This mirrors the slot-side "carried finding (b)"
   * shape but on the version side; closing it durably (a `pendingRelease`-
   * style breadcrumb on `VersionRecord`, filtered from the public
   * `listVersions()` surface) is out of scope for this task.
   */
  private async rehomeVersionRecords(
    fromTier: number,
    toTier: number,
    policy: 'isolate' | 'dedup',
    rehomedETags: Map<string, string>,
    opId?: string,
    knownApplied?: ReadonlySet<string>,
  ): Promise<void> {
    const prefix = `${this.recordId}::`
    const allKeys = await this.store.list(this.vault, this.versionsCollection)
    const matchingKeys = allKeys.filter((k) => k.startsWith(prefix))
    if (matchingKeys.length === 0) return

    const fromBlobDEK = await this.getDEK(dekKey(BLOB_COLLECTION, fromTier))
    const toBlobDEK = await this.getDEK(dekKey(BLOB_COLLECTION, toTier))

    for (const key of matchingKeys) {
      const loaded = await this.loadVersionRecordAtKeyTolerant(key, fromTier, toTier)
      if (!loaded) continue
      if (loaded.atTier === toTier) continue // already fully rehomed on a prior run — see doc comment

      const stamp = opId !== undefined ? `${opId}:${key}` : undefined
      const newETag = await this.resolveRehomedVersionETag(loaded.record, fromTier, toTier, fromBlobDEK, toBlobDEK, policy, rehomedETags, stamp, knownApplied)
      const moved: VersionRecord = newETag === loaded.record.eTag ? loaded.record : { ...loaded.record, eTag: newETag }
      await this.writeVersionRecordAtKey(key, moved, toTier)
    }
  }

  /**
   * Resumable per-key version-record metadata read (#746 spec §7 §2d bullet
   * 3) — mirrors {@link loadSlotsTolerant}: try `fromTier` first, fall back
   * to `toTier` on a decrypt failure. `atTier === toTier` on return is the
   * "already fully rehomed" signal `rehomeVersionRecords` skips on.
   */
  private async loadVersionRecordAtKeyTolerant(
    key: string, fromTier: number, toTier: number,
  ): Promise<{ record: VersionRecord; atTier: number } | null> {
    const envelope = await this.store.get(this.vault, this.versionsCollection, key)
    if (!envelope) return null
    if (!this.encrypted) return { record: JSON.parse(envelope._data) as VersionRecord, atTier: fromTier }

    const fromDek = await this.getDEK(dekKey(this.collection, fromTier))
    try {
      const json = await openEnvelopeJson(envelope, fromDek)
      return { record: JSON.parse(json) as VersionRecord, atTier: fromTier }
    } catch (err) {
      if (!(err instanceof TamperedError) || fromTier === toTier) throw err
    }
    const toDek = await this.getDEK(dekKey(this.collection, toTier))
    const json = await openEnvelopeJson(envelope, toDek)
    return { record: JSON.parse(json) as VersionRecord, atTier: toTier }
  }

  /**
   * Rehome ONE version's independently-held eTag — both the DESTINATION
   * `+1`/create AND the OLD eTag's release, in that order (mirrors the slot
   * loop's own CAS-then-release sequencing, and matches C1's two-armed
   * resume rule: a crash after the release CAS lands but before the index
   * row's delete completes is resumable — `already`/`loadBlobObject` still
   * find the row at `fromTier` on a re-run, since the CALLER's metadata
   * write hasn't happened yet). Returns the eTag the version should now
   * point at (unchanged if legacy/missing/left `dedup`-shared) — the caller
   * (`rehomeVersionRecords`) writes the version's metadata after this
   * returns.
   *
   * If the version happened to hold the SAME eTag a slot held (the common
   * case: publish right after put, no later overwrite), the slot loop in
   * `runRehomeSteps` already re-`put()` the content under `toBlobDEK` —
   * `rehomedETags` (content-addressed, so deterministic) tells us the
   * resulting destination eTag without a redundant fetch+re-encrypt; we
   * only need to move THIS hold's refCount onto it. Otherwise (the version
   * outlived its slot, or was never in the slot map) this re-`put()`s the
   * plaintext itself via `writeBlobContent` — the same content-write core
   * `put()`/the slot loop use, no new crypto — mirroring the slot case's
   * legacy/`dedup`-shared skip conditions.
   *
   * @param fromTier / @param toTier #747: same from/to split as the slot
   * loop above — the read of the version's CURRENTLY-held eTag pins
   * `fromTier`; the re-put and the refCount bump onto an already-rehomed
   * (slot-loop-produced) eTag pin `toTier`.
   *
   * @param stamp #753/#746 spec §7 C3: when present (a marker-governed
   * rehome), every destination `+1` this call performs — both the
   * `already`-rehomed fast path's explicit CAS and the `writeBlobContent`
   * re-put's own dedup-hit CAS — carries the row-scoped stamp
   * `${opId}:${versionKey}` the caller computed, never the bare opId (see
   * `rehomeForTier`'s `opId` doc comment).
   * @param knownApplied #746 whole-branch review (K=8 stamp-ring blocker):
   * this op's marker-backed confirmed-stamps set — see
   * {@link applyStampedIncrement}. Threaded through to the
   * `writeBlobContent` re-put's own dedup-hit CAS too.
   */
  private async resolveRehomedVersionETag(
    record: VersionRecord,
    fromTier: number,
    toTier: number,
    fromBlobDEK: EnclaveKey,
    toBlobDEK: EnclaveKey,
    policy: 'isolate' | 'dedup',
    rehomedETags: Map<string, string>,
    stamp?: string,
    knownApplied?: ReadonlySet<string>,
  ): Promise<string> {
    const already = rehomedETags.get(record.eTag)
    if (already !== undefined) {
      if (stamp !== undefined) {
        await this.applyStampedIncrement(already, toTier, stamp, knownApplied ?? EMPTY_STAMP_SET)
      } else {
        await this.casUpdateRefCount(already, +1, toTier)
      }
      await this.releaseOldETagAfterMove(record.eTag, fromTier, stamp) // C10: not swallowed under a marker
      return already
    }

    const loaded = await this.loadBlobObject(record.eTag, fromTier)
    if (!loaded || loaded.blob._cek === undefined) return record.eTag // legacy/missing: no-op
    if (policy === 'dedup' && loaded.blob.refCount > 1) return record.eTag // #741: same residue as the slot case

    const plaintext = await this.fetchAllChunks(loaded.blob, fromBlobDEK)
    const { eTag: newETag } = await this.writeBlobContent(plaintext, toBlobDEK, {
      filename: record.label,
      ...(loaded.blob.mimeType !== undefined ? { mimeType: loaded.blob.mimeType } : {}),
      compress: loaded.blob.compression === 'gzip',
    }, toTier, stamp, knownApplied)
    rehomedETags.set(record.eTag, newETag) // memoize: two versions may share an eTag outside the slot map too
    if (newETag !== record.eTag) {
      await this.releaseOldETagAfterMove(record.eTag, fromTier, stamp) // C10: not swallowed under a marker
    }
    return newETag
  }

  /**
   * CAS retry loop for an arbitrary BlobObject mutation. Used only by
   * `migrate()`, which is legacy-only by definition — a legacy object is
   * always flat-keyed — so the tier is pinned to `0` explicitly rather than
   * left to `loadBlobObject`/`writeBlobObject`'s independent `ownerTier()`
   * defaults, which could diverge on an elevated owner and re-key the
   * envelope under the elevated tier DEK while chunks stay flat (#747 review).
   */
  private async casUpdateBlobObject(
    eTag: string,
    mutate: (blob: BlobObject) => BlobObject,
  ): Promise<void> {
    for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
      const result = await this.loadBlobObject(eTag, 0)
      if (!result) throw new NotFoundError(`BlobObject ${eTag} not found`)
      try {
        await this.writeBlobObject(mutate(result.blob), result.version, 0)
        return
      } catch (err) {
        if (err instanceof ConflictError && attempt < MAX_CAS_RETRIES - 1) continue
        throw err
      }
    }
    throw new ConflictError(-1) // exhausted retries
  }

  /**
   * Migrate this record's LEGACY blobs (no `_cek`, chunks under the shared
   * `_blob` DEK) to per-blob content CEKs so they become crypto-shreddable.
   * Returns the eTags migrated vs. already-erasable.
   *
   * **Explicit maintenance pass** (mirrors the record-CEK migration posture):
   * re-encrypts the existing compressed chunks IN PLACE under a fresh content
   * CEK — preserving the eTag, chunkCount, chunkSize, and compression — then
   * flips the `_cek` discriminant. Crash-safe + idempotent via `_cekPending`:
   *   1. persist the wrapped content CEK in `_cekPending` (readers ignore it →
   *      the blob stays readable under the `_blob` DEK; the key survives a crash);
   *   2. re-encrypt each chunk under the content CEK (a resume reads an
   *      already-migrated chunk under the content CEK, else under the `_blob` DEK);
   *   3. promote `_cekPending` → `_cek` (atomic flip). Reads now use the CEK.
   * A re-run after a crash resumes from whichever phase was reached.
   *
   * Dedup-safe: migrating a shared blob (refCount > 1) re-keys it for every
   * referencer at once; a non-erasable collection still reads it (it unwraps
   * `_cek` under the `_blob` DEK it holds).
   */
  async migrate(): Promise<{ migrated: string[]; alreadyErasable: string[] }> {
    const migrated: string[] = []
    const alreadyErasable: string[] = []
    if (!this.encrypted) return { migrated, alreadyErasable }
    await this.resolvePendingIntent() // #753/#756 spec §7 C6/C7: resume a pending shred or rehome marker before migrating

    const blobDEK = await this.getDEK(BLOB_COLLECTION)
    // #756 spec §3/C7: read the slot map at the record's OWNER tier, not a
    // hardcoded 0 — `elevate()`/`rehomeForTier` re-keys a non-empty slot map
    // onto the destination tier's DEK regardless of whether its blobs are
    // legacy, so a previously-elevated record's slot map is no longer
    // openable under the flat tier-0 DEK and pinning `0` here threw
    // `TamperedError` before migrate() did anything.
    const ownerTier = await this.ownerTier()
    const { slots } = await this.loadSlots(ownerTier)
    const eTags = new Set(Object.values(slots).map((s) => s.eTag))

    for (const eTag of eTags) {
      // #747 two-tier fallback (`loadBlobObject(eTag, ownerTier, 0)`): a
      // mixed slot map can hold both rehomed tier-keyed eTags and genuinely
      // legacy-flat ones — `t === 0` has no fallback by default, so this
      // must be passed explicitly. An object that opens at `atTier > 0` is
      // erasable by construction (rehome only ever moves per-record-CEK
      // objects onto a tier) — record it as already-erasable and never
      // touch it; migrate() only upgrades genuinely flat legacy objects
      // (`_cek === undefined`, opened at tier 0).
      const loaded = await this.loadBlobObject(eTag, ownerTier, 0)
      if (!loaded) continue
      const blob = loaded.blob
      if (loaded.atTier > 0 || blob._cek !== undefined) { alreadyErasable.push(eTag); continue }

      // Phase 1 — persist the content CEK (resume reuses an existing pending one).
      let contentCek: EnclaveKey
      if (blob._cekPending !== undefined) {
        contentCek = await unwrapCek(blob._cekPending, blobDEK)
      } else {
        contentCek = await generateDEK()
        const wrapped = await wrapCek(contentCek, blobDEK)
        await this.casUpdateBlobObject(eTag, (b) => ({ ...b, _cekPending: wrapped }))
      }

      // Phase 2 — re-encrypt each chunk under the content CEK, in place.
      for (let i = 0; i < blob.chunkCount; i++) {
        let raw: Uint8Array | null
        try {
          raw = await this.readChunk(eTag, i, blob.chunkCount, blobDEK)
        } catch {
          // Already re-encrypted under the content CEK (crash resume).
          raw = await this.readChunk(eTag, i, blob.chunkCount, contentCek)
        }
        if (!raw) {
          throw new NotFoundError(
            `Blob chunk ${i}/${blob.chunkCount} missing for eTag "${eTag}" during migration`,
          )
        }
        await this.writeChunk(eTag, i, blob.chunkCount, raw, contentCek)
      }

      // Phase 3 — promote _cekPending → _cek (atomic flip).
      await this.casUpdateBlobObject(eTag, (b) => {
        const { _cekPending, ...rest } = b
        return _cekPending === undefined ? b : { ...rest, _cek: _cekPending }
      })
      migrated.push(eTag)
    }
    return { migrated, alreadyErasable }
  }

  // ─── Chunk I/O (with AAD binding) ─────────────────────────────────

  private async writeChunk(
    eTag: string,
    index: number,
    chunkCount: number,
    chunk: Uint8Array,
    dek: EnclaveKey | null,
  ): Promise<void> {
    const id = `${eTag}_${index}`
    const now = new Date().toISOString()
    let envelope: EncryptedEnvelope

    if (dek) {
      const aad = chunkAAD(eTag, index, chunkCount)
      const { iv, data } = await encryptBytesWithAAD(chunk, dek, aad)
      envelope = { _noydb: NOYDB_FORMAT_VERSION, _v: 1, _ts: now, _iv: iv, _data: data }
    } else {
      envelope = {
        _noydb: NOYDB_FORMAT_VERSION,
        _v: 1,
        _ts: now,
        _iv: '',
        _data: bufferToBase64(chunk),
      }
    }

    await this.store.put(this.vault, BLOB_CHUNKS_COLLECTION, id, envelope)
  }

  private async readChunk(
    eTag: string,
    index: number,
    chunkCount: number,
    dek: EnclaveKey | null,
  ): Promise<Uint8Array | null> {
    const envelope = await this.store.get(this.vault, BLOB_CHUNKS_COLLECTION, `${eTag}_${index}`)
    if (!envelope) return null

    if (dek) {
      const aad = chunkAAD(eTag, index, chunkCount)
      return await decryptBytesWithAAD(envelope._iv, envelope._data, dek, aad)
    }

    return base64ToBuffer(envelope._data)
  }

  // ─── Version record I/O ───────────────────────────────────────────

  /** #752: '::' is the version-key separator (`versionKey`) — a recordId/slotName/label
   * containing it makes the `{recordId}::` prefix scans (listVersions / rehomeVersionRecords /
   * collectVersionHolds) match ACROSS records, which escalated from mis-read to destructive
   * with #750's shred path. Also refused: a part that starts or ends with ':' — otherwise a
   * boundary colon re-segments the key (recordId `"a:"` + slotName `"slot"` yields
   * `"a:::slot::label"`, which starts with `"a::"` and prefix-matches record `"a"`'s rows).
   * With both rules, every '::' in a stored key is exactly a component separator — the grammar
   * is unambiguous by construction. Refused at the write surface only: legacy '::' data stays
   * readable/sheddable. */
  private assertKeyPartSafe(part: string, what: 'record id' | 'slot name' | 'version label'): void {
    if (part.includes('::') || part.startsWith(':') || part.endsWith(':')) {
      throw new ValidationError(
        `Blob ${what} "${part}" must not contain '::' nor start/end with ':' (reserved as the blob version-key separator; #752)`,
      )
    }
  }

  /** #752: `recordId`/`slotName`/`label` must not contain '::' — see `assertKeyPartSafe`. */
  private versionKey(slotName: string, label: string): string {
    return `${this.recordId}::${slotName}::${label}`
  }

  /**
   * @param tier #724 Arc 10 Task 2: explicit tier to resolve the version
   * record's collection DEK at — `getDEK(dekKey(this.collection, tier))`,
   * mirroring `loadSlots`'s `tier` param. Omitted → resolves via
   * `ownerTier()` (the record's CURRENT live tier); `rehomeForTier`'s own
   * reads pin `fromTier`/`toTier` explicitly instead (see `ownerTier()`'s
   * doc comment for why the default would be wrong mid-move).
   */
  private async loadVersionRecord(slotName: string, label: string, tier?: number): Promise<VersionRecord | null> {
    const key = this.versionKey(slotName, label)
    const envelope = await this.store.get(this.vault, this.versionsCollection, key)
    if (!envelope) return null

    if (!this.encrypted) {
      return JSON.parse(envelope._data) as VersionRecord
    }

    const dek = await this.getDEK(dekKey(this.collection, tier ?? await this.ownerTier()))
    const json = await openEnvelopeJson(envelope, dek)
    return JSON.parse(json) as VersionRecord
  }

  /** @param tier See {@link loadVersionRecord}'s `tier` param — same resolution. */
  private async writeVersionRecord(slotName: string, record: VersionRecord, tier?: number): Promise<void> {
    await this.writeVersionRecordAtKey(
      this.versionKey(slotName, record.label),
      record,
      tier ?? await this.ownerTier(),
    )
  }

  /**
   * `writeVersionRecord`'s body, addressed by an explicit raw store key
   * instead of `slotName`+`label` — used by `rehomeVersionRecords` (#724
   * Arc 10 Task 2), which already has the key from its raw `store.list()`
   * scan across ALL of this record's version slots.
   */
  private async writeVersionRecordAtKey(key: string, record: VersionRecord, tier: number): Promise<void> {
    const json = JSON.stringify(record)
    const now = new Date().toISOString()
    let envelope: EncryptedEnvelope

    if (this.encrypted) {
      const dek = await this.getDEK(dekKey(this.collection, tier))
      const { iv, data } = await encrypt(json, dek)
      envelope = { _noydb: NOYDB_FORMAT_VERSION, _v: 1, _ts: now, _iv: iv, _data: data }
    } else {
      envelope = { _noydb: NOYDB_FORMAT_VERSION, _v: 1, _ts: now, _iv: '', _data: json }
    }

    await this.store.put(this.vault, this.versionsCollection, key, envelope)
  }

  private async deleteVersionRecord(slotName: string, label: string): Promise<void> {
    const key = this.versionKey(slotName, label)
    await this.store.delete(this.vault, this.versionsCollection, key)
  }

  // ─── Effective chunk size ─────────────────────────────────────────

  private effectiveChunkSize(opts?: BlobPutOptions): number {
    if (opts?.chunkSize) return opts.chunkSize
    if (this.maxBlobBytes) return this.maxBlobBytes
    return DEFAULT_CHUNK_SIZE
  }

  // ─── Fetch all chunks for a blob ──────────────────────────────────

  /**
   * #747/#749 whole-branch review I1: when `loadBlobObject`'s tier-scoped open
   * fell through to the flat retry while a CLEARED higher-tier view (#749)
   * was reading (`this.clearedTier > 0`, `result.atTier === 0`), the
   * `_blob_index` row that "won" the read is not necessarily the one this
   * handle's `assertTierAccess` grant vouches for. Chunk AAD
   * (`{eTag}:{index}:{count}`) is attacker-computable, and a legacy
   * (`_cek`-less) object has no wrapped content CEK to unwrap under a key
   * the attacker doesn't hold — so ANY flat `_blob` DEK holder with store
   * write access can plant a `_cek`-less forgery at `_blob_index/{eTag}`
   * (this elevated blob's own address) whose chunks are their own flat
   * bytes, and it will decrypt cleanly under the flat DEK the fallback
   * already tries.
   *
   * `verifyFlatETag`, when set, is the eTag the CALLER originally asked
   * for (the slot/version's `.eTag` — never `blob.eTag`, which is
   * attacker-controlled content pulled from the same forged row and would
   * make the check tautological). After assembling the plaintext, we
   * recompute the SAME content address every write path mints
   * (`hmacSha256Hex(flatBlobDEK, plaintext)` — `writeBlobContent`'s Step 1,
   * unconditional on `_cek`) and compare it to that requested eTag. A
   * forged row can produce valid ciphertext under the flat DEK, but can't
   * produce plaintext that re-hashes to an address it doesn't control.
   *
   * Both legitimate flat-fallback classes — a `dedup`-policy shared object
   * (#741) and a legacy `_cek`-less object (#724 I1) — were minted this
   * same way, so an honest read's recomputed hash always matches and this
   * is a no-op for them.
   */
  private async fetchAllChunks(
    blob: BlobObject,
    blobDEK?: EnclaveKey,
    verifyFlatETag?: string,
  ): Promise<Uint8Array> {
    // Chunks are keyed under the per-blob content CEK (erasable) or directly
    // under the `_blob` DEK (legacy) — resolveChunkKey discriminates on `_cek`.
    const chunkKey = await this.resolveChunkKey(blob, blobDEK)
    const chunks: Uint8Array[] = []

    for (let i = 0; i < blob.chunkCount; i++) {
      const chunk = await this.readChunk(blob.eTag, i, blob.chunkCount, chunkKey)
      if (!chunk) {
        throw new NotFoundError(
          `Blob chunk ${i}/${blob.chunkCount} missing for eTag "${blob.eTag}" on record "${this.recordId}"`,
        )
      }
      chunks.push(chunk)
    }

    const assembled = concatChunks(chunks)
    const plaintext = blob.compression === 'gzip' ? await decompressBytes(assembled) : assembled

    if (verifyFlatETag !== undefined && blobDEK) {
      const recomputed = await hmacSha256Hex(blobDEK, plaintext)
      if (recomputed !== verifyFlatETag) {
        throw new TamperedError(
          `Blob content for eTag "${verifyFlatETag}" failed content-address verification after a ` +
            'flat-tier fallback open — the _blob_index/_blob_chunks rows do not match the requested ' +
            'content address (#747/#749 review I1)',
        )
      }
    }

    return plaintext
  }

  /**
   * #747/#749 review I1: the eTag to pass as `fetchAllChunks`'s `verifyFlatETag` — set
   * only when `loadBlobObject` fell through to the flat retry
   * (`resolvedAtTier === 0`) on a CLEARED higher-tier view
   * (`this.clearedTier > 0`). Every ordinary (non-cleared) call reaching
   * a content-fetch site already has `ownerTier() === 0` (elevated records
   * are hidden by `ownerRecordElevated()` before this point), so
   * `loadBlobObject` never even attempts the tier branch for them — no
   * fallback occurred, nothing to verify.
   */
  private flatFallbackVerifyETag(requestedETag: string, resolvedAtTier: number): string | undefined {
    if (this.clearedTier === undefined || this.clearedTier <= 0) return undefined
    return resolvedAtTier === 0 ? requestedETag : undefined
  }

  // ─── Public API: Slot management ──────────────────────────────────

  /**
   * Upload bytes and attach them to this record under `slotName`.
   *
   * 1. Computes `eTag = HMAC-SHA-256(blobDEK, plaintext)` for keyed content-addressing.
   * 2. Auto-detects MIME type from magic bytes if not provided.
   * 3. If a blob with this eTag already exists, skips chunk upload (deduplication)
   *    and CAS-increments refCount.
   * 4. Otherwise: compresses → splits into chunks → encrypts each chunk with
   *    AAD binding → writes `_blob_chunks` → writes `BlobObject` to `_blob_index`.
   * 5. CAS-updates the slot metadata in `_blob_slots_{collection}`.
   *    If overwriting an existing slot, decrements the old eTag's refCount.
   */
  async put(slotName: string, data: Uint8Array, opts?: BlobPutOptions): Promise<void> {
    this.assertKeyPartSafe(this.recordId, 'record id')
    this.assertKeyPartSafe(slotName, 'slot name')
    await this.resolvePendingIntent() // #753 spec §7 C6: resume a pending shred before accepting a new write

    // External-projection path: the field is declared `external` and an
    // ObjectProjection is configured → write the raw bytes as ONE native object
    // (unencrypted, servable) and record an `external` slot (the catalog entry).
    // Bypasses eTag/chunk/CEK/dedup entirely.
    if (this.objectStore && this.blobFields?.[slotName]?.external) {
      const policy = this.blobFields[slotName]
      let contentType = opts?.mimeType
      if (!contentType) {
        const detected = detectMagic(data.subarray(0, 16))
        contentType = detected?.mime ?? 'application/octet-stream'
      }
      const key = `${this.collection}/${this.recordId}/${slotName}`
      const isPublic = policy.public === true
      // Stamp a self-describing backlink onto the object's metadata (the
      // "secondary store"): default opaque-token (no name leak).
      const backlink = await this.buildBacklink(slotName, policy.backlink ?? 'opaque-token')
      await this.objectStore.putObject(key, data, {
        contentType,
        public: isPublic,
        ...(backlink.userMeta ? { userMeta: backlink.userMeta } : {}),
      })

      const uploaderUserId = opts?.uploadedBy ?? this.userId
      let oldETag: string | undefined
      await this.casUpdateSlots((slots) => {
        oldETag = slots[slotName]?.eTag || undefined
        // Preserve any previously-synced derived metadata across re-upload.
        const prevMeta = slots[slotName]?.external?.meta
        slots[slotName] = {
          eTag: '',
          external: {
            key,
            contentType,
            ...(isPublic ? { public: true } : {}),
            ...(backlink.token ? { backlink: backlink.token } : {}),
            ...(prevMeta ? { meta: prevMeta } : {}),
          },
          filename: opts?.filename ?? slotName,
          size: data.byteLength,
          mimeType: contentType,
          uploadedAt: new Date().toISOString(),
          ...(uploaderUserId !== undefined ? { uploadedBy: uploaderUserId } : {}),
        }
        return slots
      })
      // If this slot previously held a chunk-based blob, release that eTag.
      if (oldETag) {
        await this.releaseRef(oldETag, 1, false).catch(() => {})
      }
      return
    }

    // #724 I1 completion: the chunk-based path below is what has (or lacks)
    // a per-blob `_cek` — refuse here, not in the external-projection branch
    // above (that path never had a `_cek` to begin with; out of scope).
    this.assertBlobWritable()

    // #724 Arc 10 correction (C2): key the eTag HMAC + content-CEK wrap
    // under the OWNING RECORD's current tier, not a flat tier-0 DEK — a
    // blob attached to an already-elevated record must be born tier-scoped,
    // or it stays tier-0-decryptable at rest despite the read gate hiding
    // it through the API. `dekKey(BLOB_COLLECTION, 0) === BLOB_COLLECTION`,
    // so a tier-0 (or untiered) record's write is byte-identical to before.
    const blobDEK = this.encrypted
      ? await this.getDEK(dekKey(BLOB_COLLECTION, await this.ownerTier()))
      : null
    return this.putUnderDEK(slotName, data, blobDEK, opts)
  }

  /**
   * The slot-attachment core of `put()` (Step 7 — CAS the slot metadata),
   * parameterized by which `_blob` DEK to hash the eTag and wrap the
   * content CEK under. Steps 1-6 (hash/dedup/compress/chunk/index-write)
   * are `writeBlobContent` (#724 Arc 10 Task 2 extraction, so `rehomeForTier`
   * can reuse them for a version-held eTag without touching the slot map).
   * `put()` always passes this record's own OWNER-TIER blob DEK (#724 Arc
   * 10 correction) — `dekKey(BLOB_COLLECTION, 0)` for a tier-0 record.
   *
   * `rehomeForTier` is the other caller: on every tier move it re-`put()`s
   * each owned blob's plaintext under the `toTier`-scoped DEK — solo and
   * shared-isolate alike — so the moved copy gets a private, tier-scoped
   * eTag and `_cek` wrap from the moment it's written. The move never
   * routes through public `put()` under the wrong key, and this method
   * adds no new raw `_cek`/`_iv`/`_data` access (identical bodies, just
   * parameterized).
   *
   * @param slotsTier #724 Arc 10 Task 4: pins the slot-map CAS update
   * (Step 7) to a specific tier instead of the caller's `ownerTier()`
   * default — `rehomeForTier` passes `fromTier`, since mid-move the slot
   * map is still physically there (see `ownerTier()`'s doc comment). The
   * old eTag being replaced lives wherever the slot map itself is
   * physically keyed, so its release (#747, below) reuses this SAME value
   * rather than a separate param.
   * @param contentTier #747: pins the `_blob_index` read/write inside
   * `writeBlobContent` to a specific tier — `rehomeForTier` passes `toTier`
   * (matching `blobDEK`, already resolved at `toTier`), since mid-move
   * `ownerTier()` already reads `toTier` too but this is more direct.
   * Omitted → `ownerTier()`, correct for `put()`'s ordinary (non-rehome) call.
   * @param opId #753/#746 spec §7 C3: `rehomeForTier`'s governing marker
   * op-stamp identity (omitted → `undefined`, `put()`'s ordinary call and
   * every pre-existing caller, byte-identical unstamped behavior). When
   * present, the ROW-SCOPED stamp `${opId}:${slotName}` — never the bare
   * opId — governs BOTH this call's destination `+1` (via
   * `writeBlobContent`'s dedup-hit CAS) and its old-eTag release below: two
   * different `BlobObject`s (destination vs. source), so the shared stamp
   * string collides with neither, and a resumed re-put of THIS slot can
   * neither double-apply the `+1` nor double-release the old object. Two
   * DIFFERENT slots on this record legitimately re-putting the SAME
   * destination eTag each get their OWN stamp (their own `slotName`) — the
   * row scope is what lets N slots' `+1`s all land on one destination
   * object instead of the first silently absorbing the rest.
   */
  private async putUnderDEK(
    slotName: string,
    data: Uint8Array,
    blobDEK: EnclaveKey | null,
    opts?: BlobPutOptions,
    slotsTier?: number,
    contentTier?: number,
    opId?: string,
    knownApplied?: ReadonlySet<string>,
  ): Promise<void> {
    const rowStamp = opId !== undefined ? `${opId}:${slotName}` : undefined
    const { eTag, mimeType } = await this.writeBlobContent(data, blobDEK, opts, contentTier, rowStamp, knownApplied)

    // Step 7 — CAS-update slot metadata
    const uploaderUserId = opts?.uploadedBy ?? this.userId
    let deferredOldETag: string | undefined
    await this.casUpdateSlots((slots) => {
      const oldETag = slots[slotName]?.eTag
      const pending = oldETag && oldETag !== eTag ? oldETag : undefined
      slots[slotName] = {
        eTag,
        filename: opts?.filename ?? slotName,
        size: data.byteLength,
        ...(mimeType !== undefined ? { mimeType } : {}),
        uploadedAt: new Date().toISOString(),
        ...(uploaderUserId !== undefined ? { uploadedBy: uploaderUserId } : {}),
        // #746 spec §7 review, carried finding (b): durably record the OLD
        // eTag ON the slot row itself, in the SAME CAS write that moves the
        // slot to `eTag` — see `SlotRecord.pendingRelease`'s doc comment.
        // Gated to marker-governed (stamped) calls only: ordinary put()
        // (`rowStamp` undefined) keeps today's in-memory best-effort
        // posture, zero footprint.
        ...(pending !== undefined && rowStamp !== undefined ? { pendingRelease: pending } : {}),
      }
      deferredOldETag = pending
      return slots
    }, slotsTier)

    // Release the old eTag outside the CAS loop. An erasable blob dropping to
    // refCount 0 here is crypto-shredded eagerly; a legacy one defers to GC.
    if (deferredOldETag) {
      // #747: the old eTag lives at `slotsTier` (the slot map's CURRENT
      // physical location — see the param doc above), not this record's
      // live tier — those diverge mid-rehome.
      await this.releaseOldETagAfterMove(deferredOldETag, slotsTier, rowStamp)
      // The pendingRelease breadcrumb above is only meaningful once the
      // release genuinely landed — clear it now (idempotent; a crash before
      // this point leaves it for `reconcilePendingReleases` to finish).
      if (rowStamp !== undefined) await this.clearPendingRelease(slotName, deferredOldETag, slotsTier)
    }
  }

  /**
   * C10 (#753/#746 spec §7): under a marker-governed (`stamp` present)
   * rehome, a failed old-eTag release must not be silently swallowed — it
   * is the crypto-shred of the FROM-tier object, and swallowing it during a
   * documented-exactly-once op is the bug C10 closes. Propagating keeps the
   * governing `_blob_intent` marker alive (never deleted) so a later resume
   * retries it, rather than completing the op over a residue that never
   * surfaces. Unstamped (ordinary `put()`/`delete()`) calls keep the
   * pre-#753 best-effort posture unchanged — a missed decrement there is
   * reconciled by a later pass, same as always.
   */
  private async releaseOldETagAfterMove(eTag: string, tier: number | undefined, stamp: string | undefined): Promise<void> {
    if (stamp !== undefined) {
      await this.releaseRef(eTag, 1, false, tier, stamp)
      return
    }
    await this.releaseRef(eTag, 1, false, tier).catch(() => {
      // Best-effort — a missed decrement is reconciled by a later pass.
    })
  }

  /**
   * Durably confirm a rehome row-stamp's `+1` in the governing marker —
   * #746 whole-branch review (K=8 stamp-ring blocker). No-op when there is
   * no marker to record against (a direct `rehomeForTier(..., opId)` call
   * with no real `_blob_intent` row, e.g. this suite's Task-1 tests —
   * byte-identical ring-only behavior for that path, unchanged). NOT
   * swallowed on failure (mirrors C10): a failed confirmation write must
   * keep the governing marker's op from completing silently over an
   * unconfirmed increment, not be dropped.
   */
  private async recordAppliedRehomeStamp(stamp: string): Promise<void> {
    await recordAppliedStamp(this.store, this.vault, this.collection, this.recordId, this.getDEK, stamp)
  }

  /**
   * Apply ONE destination `+1` under a row-scoped rehome stamp, made
   * idempotent INDEPENDENTLY of `BlobObject.lastOps`'s bounded ring (#746
   * whole-branch review — see `BlobIntent.appliedStamps`'s doc comment for
   * the full hazard). `knownApplied` — this op's OWN marker-backed,
   * unbounded record of confirmed stamps, read ONCE at the top of
   * `runRehomeSteps` — is consulted FIRST: a hit means this exact row's
   * `+1` was already confirmed on a PRIOR run, so the CAS is skipped
   * entirely regardless of whether the shared destination's ring has since
   * evicted it (another 8+ rows — from THIS record's own fan-out, or from
   * unrelated CONCURRENT rehomes converging on the same destination —
   * could have pushed it out). A miss falls through to the existing
   * ring-based stamped CAS (correct and sufficient for the overwhelming
   * majority of resumes — same-session or shortly-after), and on success
   * (freshly applied OR the ring itself already had it) records the stamp
   * into the marker so THIS row is never re-examined again by a later
   * resume, no matter how much unrelated activity lands on the destination
   * in between.
   */
  private async applyStampedIncrement(
    eTag: string, tier: number | undefined, stamp: string, knownApplied: ReadonlySet<string>,
  ): Promise<void> {
    if (knownApplied.has(stamp)) return
    await this.casUpdateRefCountStamped(eTag, +1, tier, stamp)
    await this.recordAppliedRehomeStamp(stamp)
  }

  /**
   * The chunk/CEK/dedup core of `put()` (former Steps 1-6 of `putUnderDEK`,
   * extracted #724 Arc 10 Task 2 so `rehomeVersionETag` can write a
   * version-held blob's content under a target tier's DEK WITHOUT touching
   * the slot map — `putUnderDEK`'s remaining Step 7 is slot-specific).
   * Content-addressed and dedup-aware exactly like `put()`: hashing the same
   * plaintext under the same `blobDEK` twice always lands on the same eTag.
   *
   * @param tier #747: the index-envelope tier to read/write at (see
   * {@link loadBlobObject}'s `tier` param) — `putUnderDEK`'s `contentTier`,
   * matching whichever tier `blobDEK` itself was resolved at. Omitted →
   * `ownerTier()`, correct for `put()`'s ordinary (non-rehome) call.
   * @param incrementStamp #753/#746 spec §7 C3: when present, a dedup hit at
   * Step 3 applies its `+1` via {@link casUpdateRefCountStamped} under this
   * stamp instead of the plain {@link casUpdateRefCount} — the row-scoped
   * identity `putUnderDEK`/`rehomeVersionETag` compute so a resumed re-put's
   * destination increment is idempotent per row. Omitted (every call site
   * before this arc) → byte-identical unstamped behavior.
   *
   * ALSO seeds `lastOps: [incrementStamp]` on the fresh-object create path
   * (Step 6, review finding on #746 C3): a solo blob has no pre-existing
   * destination object for a resumed re-put to dedup-hit against a stamp on
   * — the FIRST attempt's create is itself the only write, and a crash
   * after it lands but before the slot/version CAS leaves the object
   * present at refCount 1 with NO stamp. An unseeded resume then
   * re-executes Step 3, finds that same object, and — finding no matching
   * stamp — applies a SECOND, spurious `+1` (1 → 2), the exact over-count
   * hazard this stamping arc exists to close. Seeding the ring at create
   * time closes that: the resumed re-put's Step 3 dedup-hit against THIS
   * object finds its own stamp already present and skips, matching the
   * dedup-hit branch's behavior exactly.
   */
  private async writeBlobContent(
    data: Uint8Array,
    blobDEK: EnclaveKey | null,
    opts?: BlobPutOptions,
    tier?: number,
    incrementStamp?: string,
    knownApplied?: ReadonlySet<string>,
  ): Promise<{ eTag: string; mimeType: string | undefined }> {
    // Step 1 — keyed content-hash (plaintext, before compression)
    const eTag = blobDEK
      ? await hmacSha256Hex(blobDEK, data)
      : await plainSha256Hex(data)

    // Step 2 — MIME detection
    let mimeType = opts?.mimeType
    if (!mimeType) {
      const detected = detectMagic(data.subarray(0, 16))
      if (detected) mimeType = detected.mime
    }

    // Determine compression: explicit opt > auto-detect > default true
    let shouldCompress: boolean
    if (opts?.compress !== undefined) {
      shouldCompress = opts.compress
    } else if (mimeType && isPreCompressed(mimeType)) {
      shouldCompress = false
    } else {
      shouldCompress = true
    }
    // Debug-plaintext: write the blob as a single un-gzipped object so the
    // stored chunk's base64 `_data` decodes directly to the original bytes
    // (`base64 -d`) — no gzip layer, no multi-chunk reassembly. (encrypt:false
    // already stores chunks unencrypted; this drops the remaining indirection.)
    if (this.debugPlaintext) shouldCompress = false

    // Step 3 — deduplication check
    const existingBlob = await this.loadBlobObject(eTag, tier)

    if (existingBlob) {
      // eTag already exists — just increment refCount (CAS retry). Dedup is
      // preserved across the content-CEK split: the chunks (and the BlobObject's
      // `_cek`, if any) are reused as-is; a new referencer never re-encrypts.
      if (incrementStamp !== undefined) {
        // #746 whole-branch review (K=8 stamp-ring blocker): ring-independent
        // via `knownApplied` — see `applyStampedIncrement`'s doc comment.
        await this.applyStampedIncrement(eTag, tier, incrementStamp, knownApplied ?? EMPTY_STAMP_SET)
      } else {
        await this.casUpdateRefCount(eTag, +1, tier)
      }
      return { eTag, mimeType }
    }

    // Step 4 — compress
    const { bytes: compressed, algorithm } = shouldCompress
      ? await compressBytes(data)
      : { bytes: data, algorithm: 'none' as const }

    // Debug-plaintext stores the whole blob as one object (single chunk) so
    // it is one directly-openable file in the store rather than N shards.
    const chunkSize = this.debugPlaintext
      ? Math.max(compressed.byteLength, 1)
      : this.effectiveChunkSize(opts)
    const chunkCount = Math.max(1, Math.ceil(compressed.byteLength / chunkSize))

    // Erasable collection (`perRecordKeys`): mint a fresh per-blob content
    // CEK and encrypt the chunks under it instead of the shared `_blob` DEK,
    // so the BlobObject's wrapped `_cek` is the sole recoverable copy → a
    // refCount-0 delete crypto-shreds the chunks. `eTag` (the dedup address)
    // is still keyed off the `_blob` DEK, unchanged.
    let chunkKey = blobDEK
    let wrappedCek: string | undefined
    if (blobDEK && this.erasableBlobs) {
      const contentCek = await generateDEK()
      wrappedCek = await wrapCek(contentCek, blobDEK)
      chunkKey = contentCek
    }

    // Step 5 — write chunks FIRST with AAD binding (safe failure order)
    for (let i = 0; i < chunkCount; i++) {
      const start = i * chunkSize
      await this.writeChunk(
        eTag, i, chunkCount,
        compressed.subarray(start, start + chunkSize),
        chunkKey,
      )
    }

    // Step 6 — write blob index entry after all chunks succeed. #746 C3
    // review: seed `lastOps` with `incrementStamp` (when present) so a
    // resumed re-put's Step 3 dedup-hit against THIS freshly-created object
    // finds its own stamp already there and skips — see this method's
    // `incrementStamp` doc comment.
    await this.writeBlobObject({
      eTag,
      size: data.byteLength,
      compressedSize: compressed.byteLength,
      compression: algorithm,
      chunkSize,
      chunkCount,
      ...(mimeType !== undefined ? { mimeType } : {}),
      createdAt: new Date().toISOString(),
      refCount: 1,
      ...(wrappedCek !== undefined ? { _cek: wrappedCek } : {}),
      ...(incrementStamp !== undefined ? { lastOps: appendStamp(undefined, incrementStamp) } : {}),
    }, undefined, tier)
    // #746 whole-branch review (K=8 stamp-ring blocker): also confirm the
    // fresh-create in the marker, same as the dedup-hit path — a resumed
    // dedup-hit against THIS object (Step 3, a later run) then skips via
    // `knownApplied` even if the ring's own seeded entry has since been
    // evicted by unrelated activity on this destination.
    if (incrementStamp !== undefined) await this.recordAppliedRehomeStamp(incrementStamp)

    return { eTag, mimeType }
  }

  /**
   * Fetch all bytes for the named slot.
   * Returns `null` if the slot does not exist.
   * Throws `NotFoundError` if the index entry exists but a chunk is missing.
   */
  async get(slotName: string): Promise<Uint8Array | null> {
    if (await this.ownerRecordElevated()) return null // #724: elevated ≡ invisible, mirrors get()
    const { slots } = await this.loadSlots()
    const slot = slots[slotName]
    if (!slot) return null

    if (slot.external) {
      if (!this.objectStore) {
        throw new NotFoundError(`Blob slot "${slotName}" is external but no objectStore is configured`)
      }
      return this.objectStore.getObject(slot.external.key)
    }

    const result = await this.loadBlobObject(slot.eTag)
    if (!result) return null

    // #749: `fetchAllChunks`'s own `blobDEK` default (`resolveChunkKey`'s
    // flat `_blob` fallback) predates #724 Task 3's tier-scoped content CEKs
    // and was never wrong before `atTier()` existed — every pre-#749 caller
    // reaching this line was, by construction, a tier-0 record (the
    // `ownerRecordElevated()` gate above refused anything else). A cleared
    // view's elevated content has its `_cek` wrapped under the tier that
    // OPENED the index envelope (`result.atTier` — #747), not the flat one,
    // so it must be resolved explicitly here.
    const blobDEK = this.encrypted ? await this.getDEK(dekKey(BLOB_COLLECTION, result.atTier)) : undefined
    return this.fetchAllChunks(result.blob, blobDEK, this.flatFallbackVerifyETag(slot.eTag, result.atTier))
  }

  /**
   * A URL to fetch an `external` slot's object directly — presigned
   * (time-limited) or public, per the projection. Returns `null` if the slot
   * does not exist. Throws for a non-external slot (use `get()`/`response()`).
   */
  async url(slotName: string, opts?: { expiresInSeconds?: number }): Promise<string | null> {
    if (await this.ownerRecordElevated()) return null // #724: elevated ≡ invisible, mirrors get()
    const { slots } = await this.loadSlots()
    const slot = slots[slotName]
    if (!slot) return null
    if (!slot.external) {
      throw new NotFoundError(`Blob slot "${slotName}" is not external — url() is only for external fields`)
    }
    if (!this.objectStore) {
      throw new NotFoundError(`Blob slot "${slotName}" is external but no objectStore is configured`)
    }
    return this.objectStore.objectUrl(slot.external.key, opts)
  }

  /**
   * Build the backlink stamped onto an external object's metadata — the
   * self-describing "secondary store" reference back to this record. See
   * {@link BlobFieldPolicy.backlink}. Returns the `userMeta` to attach and, for
   * `opaque-token`, the `token` to record on the slot.
   */
  private async buildBacklink(
    slotName: string,
    mode: 'opaque-token' | 'encrypted' | 'plain' | 'none',
  ): Promise<{ userMeta?: Record<string, string>; token?: string }> {
    if (mode === 'none') return {}
    const ref = { vault: this.vault, collection: this.collection, record: this.recordId, field: slotName }
    if (mode === 'plain') {
      return {
        userMeta: {
          'noydb-vault': ref.vault,
          'noydb-collection': ref.collection,
          'noydb-record': ref.record,
          'noydb-field': ref.field,
        },
      }
    }
    if (mode === 'encrypted' && this.encrypted) {
      const dek = await this.getDEK(BLOB_COLLECTION)
      const { iv, data } = await encrypt(JSON.stringify(ref), dek)
      return { userMeta: { 'noydb-backlink-enc': `${iv}.${data}` } }
    }
    // opaque-token — also the fallback when `encrypted` is requested on a
    // plaintext vault (no DEK to encrypt under).
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16))
    const token = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
    return { userMeta: { 'noydb-backlink': token }, token }
  }

  /**
   * Adopt an EXISTING object in the projection into this slot **without
   * re-uploading** — used by import/bootstrap to anchor objects already in the
   * bucket. Writes the external slot record (the catalog entry).
   */
  async adoptExternal(
    slotName: string,
    ref: {
      key: string
      size?: number
      contentType?: string
      public?: boolean
      backlink?: string
      meta?: Record<string, unknown>
    },
  ): Promise<void> {
    this.assertKeyPartSafe(this.recordId, 'record id')
    this.assertKeyPartSafe(slotName, 'slot name')
    this.assertExternalDeclared(slotName)
    await this.resolvePendingIntent() // #753 spec §7 C6: resume a pending shred before accepting a new write

    const uploaderUserId = this.userId
    await this.casUpdateSlots((slots) => {
      slots[slotName] = {
        eTag: '',
        external: {
          key: ref.key,
          ...(ref.contentType ? { contentType: ref.contentType } : {}),
          ...(ref.public ? { public: true } : {}),
          ...(ref.backlink ? { backlink: ref.backlink } : {}),
          ...(ref.meta ? { meta: ref.meta } : {}),
        },
        filename: slotName,
        size: ref.size ?? 0,
        ...(ref.contentType ? { mimeType: ref.contentType } : {}),
        uploadedAt: new Date().toISOString(),
        ...(uploaderUserId !== undefined ? { uploadedBy: uploaderUserId } : {}),
      }
      return slots
    })
  }

  /**
   * Merge derived metadata (video `duration`, image `width`/`height`, arbitrary
   * metatags) into an external slot's secondary metadata store. Typically called
   * from an AWS-side processing callback (MediaConvert / ffprobe / Rekognition)
   * once it has probed the object. No-op for a missing or non-external slot.
   */
  async setExternalMeta(slotName: string, meta: Record<string, unknown>): Promise<void> {
    this.assertExternalDeclared(slotName)
    await this.resolvePendingIntent() // #753 spec §7 C6: resume a pending shred before accepting a new write
    await this.casUpdateSlots((slots) => {
      const slot = slots[slotName]
      if (!slot?.external) return null
      slots[slotName] = {
        ...slot,
        external: { ...slot.external, meta: { ...slot.external.meta, ...meta } },
      }
      return slots
    })
  }

  /**
   * Read an external slot's synced derived metadata (the secondary store).
   * Returns `null` for a missing or non-external slot, `{}` if none synced yet.
   */
  async externalMeta(slotName: string): Promise<Record<string, unknown> | null> {
    if (await this.ownerRecordElevated()) return null // #724: elevated ≡ invisible, mirrors get()
    const { slots } = await this.loadSlots()
    const slot = slots[slotName]
    if (!slot?.external) return null
    return slot.external.meta ?? {}
  }

  /**
   * List all slot entries for this record.
   * Returns metadata only — no chunk data is loaded.
   */
  async list(): Promise<SlotInfo[]> {
    if (await this.ownerRecordElevated()) return [] // #724: elevated ≡ invisible, mirrors get()
    const { slots } = await this.loadSlots()
    // #746: `pendingRelease` is internal rehome-journal bookkeeping (see
    // `SlotRecord`'s doc comment) — never surfaced through the public API.
    return Object.entries(slots).map(([name, slot]) => {
      const pub: SlotRecord = { ...slot }
      delete (pub as { pendingRelease?: string }).pendingRelease
      return { name, ...pub }
    })
  }

  /**
   * Delete the named slot from this record.
   * Decrements refCount on the blob. Chunks are GC'd by `vault.blobGC()`.
   */
  async delete(slotName: string): Promise<void> {
    await this.resolvePendingIntent() // #753 spec §7 C6: resume a pending shred before accepting a new write
    let eTagToRelease: string | undefined
    let externalKeyToDelete: string | undefined

    await this.casUpdateSlots((slots) => {
      if (!(slotName in slots)) return null
      const slot = slots[slotName]!
      if (slot.external) externalKeyToDelete = slot.external.key
      else eTagToRelease = slot.eTag
      delete slots[slotName]
      return slots
    })

    if (externalKeyToDelete && this.objectStore) {
      // External objects are hard-deleted (no crypto-shred — they were never
      // encrypted). CDN/replica cache TTLs may retain a copy; see the design.
      await this.objectStore.deleteObject(externalKeyToDelete).catch(() => {})
    }

    if (eTagToRelease) {
      // Erasable blobs are crypto-shredded at refCount 0 (this also covers
      // compaction eviction, which routes through delete()); legacy blobs keep
      // deferred-GC / orphan-retention semantics.
      await this.releaseRef(eTagToRelease, 1, false).catch(() => {
        // Best-effort — a missed decrement is reconciled by a later pass.
      })
    }
  }

  /**
   * Return a native `Response` whose body streams the decrypted,
   * decompressed blob bytes with full HTTP metadata headers.
   *
   * Note: implementation is buffered — all chunks are loaded into
   * memory before being enqueued. True streaming deferred to.
   *
   * Returns `null` if the slot does not exist.
   */
  async response(slotName: string, opts?: BlobResponseOptions): Promise<Response | null> {
    if (await this.ownerRecordElevated()) return null // #724: elevated ≡ invisible, mirrors get()
    const { slots } = await this.loadSlots()
    const slot = slots[slotName]
    if (!slot) return null

    const result = await this.loadBlobObject(slot.eTag)
    if (!result) return null

    // #749: see the matching comment in `get()`.
    const blobDEK = this.encrypted ? await this.getDEK(dekKey(BLOB_COLLECTION, result.atTier)) : undefined
    return this.buildResponse(slot, result.blob, opts, blobDEK, this.flatFallbackVerifyETag(slot.eTag, result.atTier))
  }

  /**
   * Decrypt the slot and wrap the bytes in a browser ObjectURL ready
   * to feed into `<img src>`, `<a href>`, etc. The caller MUST call
   * `revoke()` when the URL is no longer needed — otherwise the URL
   * (and the underlying decrypted Blob) are pinned for the lifetime
   * of the document, which leaks memory in long-lived pages.
   *
   * Returns `null` when the slot does not exist.
   *
   * Throws when `URL.createObjectURL` is unavailable in the host
   * environment (Node without DOM, restricted workers). Framework
   * adapters — `useBlobURL` in `@noy-db/in-vue`, etc. — guard against
   * this for SSR contexts and stay at `null` instead of propagating.
   */
  async objectURL(
    slotName: string,
    opts?: { mimeType?: string },
  ): Promise<{ url: string; revoke: () => void } | null> {
    if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
      throw new Error(
        'BlobSet.objectURL: URL.createObjectURL is unavailable in this environment. ' +
        'Call this from the browser, or use BlobSet.get() and create the URL yourself.',
      )
    }
    const bytes = await this.get(slotName)
    if (!bytes) return null

    const { slots } = await this.loadSlots()
    const slot = slots[slotName]
    const type = opts?.mimeType ?? slot?.mimeType ?? 'application/octet-stream'

    // Pinning the underlying ArrayBuffer in a Blob is what backs the
    // ObjectURL — once we createObjectURL the URL holds a strong ref
    // to the Blob, so the local `blob` variable can fall out of scope.
    // Copy through a fresh ArrayBuffer so TS narrows away the
    // SharedArrayBuffer branch of `ArrayBufferLike` (Uint8Array is
    // generic over the backing buffer type since TS 5.7).
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    const blob = new Blob([buffer], { type })
    const url = URL.createObjectURL(blob)
    let revoked = false
    const revoke = (): void => {
      if (revoked) return
      revoked = true
      URL.revokeObjectURL(url)
    }
    return { url, revoke }
  }

  // ─── Public API: Published versions (UC-3 amendment versioning) ───

  /**
   * Publish the current slot content as a named version snapshot.
   *
   * The published version holds an independent refCount reference to
   * the blob. Even if the slot is later overwritten or deleted, the
   * published version keeps the blob data alive.
   *
   * Publishing with an existing label overwrites it — if the eTags differ,
   * refCounts are adjusted accordingly.
   *
   * #724 Arc 10 Task 2 (C4): the version record is written under the owning
   * record's CURRENT tier — a version published on a tier-N record is keyed
   * at tier N, mirroring `put()`'s owner-tier resolution (Task 1). The
   * refCount hold it takes lands on `slot.eTag`, which is already
   * tier-scoped (born there by `put()`, or moved there by a prior
   * `rehomeForTier`) — no separate tier-scoping needed for the content side.
   */
  async publish(slotName: string, label: string): Promise<void> {
    this.assertKeyPartSafe(this.recordId, 'record id')
    this.assertKeyPartSafe(slotName, 'slot name')
    this.assertKeyPartSafe(label, 'version label')
    this.assertBlobWritable() // #724 I1 completion: same write-time refusal as put()
    await this.resolvePendingIntent() // #753 spec §7 C6: resume a pending shred before accepting a new write
    const { slots } = await this.loadSlots()
    const slot = slots[slotName]
    if (!slot) throw new NotFoundError(`Slot "${slotName}" not found on record "${this.recordId}"`)

    const tier = await this.ownerTier()

    // Check for existing version with this label
    const existing = await this.loadVersionRecord(slotName, label, tier)
    if (existing && existing.eTag === slot.eTag) return // no-op: same blob

    // Write the version record
    const record: VersionRecord = {
      label,
      eTag: slot.eTag,
      publishedAt: new Date().toISOString(),
      ...(this.userId !== undefined ? { publishedBy: this.userId } : {}),
    }
    await this.writeVersionRecord(slotName, record, tier)

    // Increment refCount for the new version's eTag
    await this.casUpdateRefCount(slot.eTag, +1)

    // If overwriting an existing version with a different eTag, release the old
    // one (crypto-shred at refCount 0 when erasable).
    if (existing && existing.eTag !== slot.eTag) {
      await this.releaseRef(existing.eTag, 1, false).catch(() => {})
    }
  }

  /**
   * Fetch bytes for a published version.
   * Returns `null` if the version does not exist.
   */
  async getVersion(slotName: string, label: string): Promise<Uint8Array | null> {
    if (await this.ownerRecordElevated()) return null // #724: elevated ≡ invisible, mirrors get()
    const record = await this.loadVersionRecord(slotName, label)
    if (!record) return null

    const result = await this.loadBlobObject(record.eTag)
    if (!result) return null

    // #749: see the matching comment in `get()` — `result.atTier` is the
    // tier that actually opened the index envelope, which is what the
    // wrapped content `_cek` is scoped under.
    const blobDEK = this.encrypted ? await this.getDEK(dekKey(BLOB_COLLECTION, result.atTier)) : undefined
    return this.fetchAllChunks(result.blob, blobDEK, this.flatFallbackVerifyETag(record.eTag, result.atTier))
  }

  /**
   * List all published versions for a slot.
   */
  async listVersions(slotName: string): Promise<VersionRecord[]> {
    if (await this.ownerRecordElevated()) return [] // #724: elevated ≡ invisible, mirrors get()
    const prefix = `${this.recordId}::${slotName}::`
    const allKeys = await this.store.list(this.vault, this.versionsCollection)
    const matchingKeys = allKeys.filter((k) => k.startsWith(prefix))

    const versions: VersionRecord[] = []
    for (const key of matchingKeys) {
      const envelope = await this.store.get(this.vault, this.versionsCollection, key)
      if (!envelope) continue

      if (!this.encrypted) {
        versions.push(JSON.parse(envelope._data) as VersionRecord)
      } else {
        const dek = await this.getDEK(this.collection)
        const json = await openEnvelopeJson(envelope, dek)
        versions.push(JSON.parse(json) as VersionRecord)
      }
    }

    return versions
  }

  /**
   * Delete a published version. Decrements refCount on its blob.
   */
  async deleteVersion(slotName: string, label: string): Promise<void> {
    await this.resolvePendingIntent() // #753 spec §7 C6: resume a pending shred before accepting a new write
    const record = await this.loadVersionRecord(slotName, label)
    if (!record) return

    await this.deleteVersionRecord(slotName, label)
    await this.releaseRef(record.eTag, 1, false).catch(() => {})
  }

  /**
   * Return a `Response` for a published version — same as `response()`
   * but reads from the version record's eTag instead of the current slot.
   */
  async responseVersion(
    slotName: string,
    label: string,
    opts?: BlobResponseOptions,
  ): Promise<Response | null> {
    if (await this.ownerRecordElevated()) return null // #724: elevated ≡ invisible, mirrors get()
    const record = await this.loadVersionRecord(slotName, label)
    if (!record) return null

    const result = await this.loadBlobObject(record.eTag)
    if (!result) return null

    // Build a synthetic SlotRecord from the version + blob data
    const slotLike: SlotRecord = {
      eTag: record.eTag,
      filename: opts?.filename ?? `${slotName}-${label}`,
      size: result.blob.size,
      ...(result.blob.mimeType !== undefined ? { mimeType: result.blob.mimeType } : {}),
      uploadedAt: record.publishedAt,
      ...(record.publishedBy !== undefined ? { uploadedBy: record.publishedBy } : {}),
    }

    // #749: see the matching comment in `get()`.
    const blobDEK = this.encrypted ? await this.getDEK(dekKey(BLOB_COLLECTION, result.atTier)) : undefined
    return this.buildResponse(slotLike, result.blob, opts, blobDEK, this.flatFallbackVerifyETag(record.eTag, result.atTier))
  }

  // ─── Diagnostics ──────────────────────────────────────────────────

  /**
   * Return the `BlobObject` metadata for the named slot.
   * Returns `null` if the slot or blob does not exist.
   */
  async blobInfo(slotName: string): Promise<BlobObject | null> {
    if (await this.ownerRecordElevated()) return null // #724: elevated ≡ invisible, mirrors get()
    const { slots } = await this.loadSlots()
    const slot = slots[slotName]
    if (!slot) return null
    const result = await this.loadBlobObject(slot.eTag)
    return result?.blob ?? null
  }

  // ─── Presigned URL (E5) ────────────────────────────────────────────

  /**
   * Generate a presigned URL for direct client download of the blob's
   * ciphertext. Only works when the blob store supports `presignUrl`.
   *
   * **Important:** The URL returns encrypted data. The caller must
   * decrypt client-side using `decryptResponse()` or a service worker.
   *
   * Returns `null` if the slot doesn't exist or the store doesn't support presigning.
   */
  async presignedUrl(slotName: string, expiresInSeconds = 3600): Promise<string | null> {
    if (await this.ownerRecordElevated()) return null // #724: elevated ≡ invisible, mirrors get()
    const { slots } = await this.loadSlots()
    const slot = slots[slotName]
    if (!slot) return null

    const result = await this.loadBlobObject(slot.eTag)
    if (!result) return null

    // Only works for single-chunk blobs where the store supports presigning
    if (result.blob.chunkCount !== 1) return null
    if (!this.store.presignUrl) return null

    const chunkId = `${slot.eTag}_0`
    return this.store.presignUrl(this.vault, '_blob_chunks', chunkId, expiresInSeconds)
  }

  /**
   * Decrypt a ciphertext Response (e.g. from a presigned URL fetch)
   * back into a plaintext Response with correct headers.
   *
   * Usage with service worker or client-side fetch:
   * ```ts
   * const url = await blobs.presignedUrl('invoice.pdf')
   * const cipherResponse = await fetch(url)
   * const plainResponse = await blobs.decryptResponse('invoice.pdf', cipherResponse)
   * ```
   */
  async decryptResponse(slotName: string, cipherResponse: Response): Promise<Response | null> {
    if (await this.ownerRecordElevated()) return null // #724: elevated ≡ invisible, mirrors get()
    const { slots } = await this.loadSlots()
    const slot = slots[slotName]
    if (!slot) return null

    const result = await this.loadBlobObject(slot.eTag)
    if (!result) return null

    // Parse the envelope from the ciphertext response
    const text = await cipherResponse.text()
    const envelope = JSON.parse(text) as { _iv: string; _data: string }

    const blobDEK = this.encrypted ? await this.getDEK('_blob') : null
    if (!blobDEK) {
      return this.buildResponse(slot, result.blob, { inline: true })
    }

    // Decrypt the single chunk
    const aad = chunkAAD(slot.eTag, 0, result.blob.chunkCount)
    const { decryptBytesWithAAD: decryptAAD } = await import('../../kernel/enclave/index.js')
    const decrypted = await decryptAAD(envelope._iv, envelope._data, blobDEK, aad)
    const plaintext = result.blob.compression === 'gzip'
      ? await decompressBytes(decrypted)
      : decrypted

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(plaintext)
        controller.close()
      },
    })

    const filename = slot.filename
    return new Response(body, {
      headers: {
        'Content-Type': slot.mimeType ?? 'application/octet-stream',
        'Content-Length': String(slot.size),
        'ETag': `"${slot.eTag}"`,
        'Content-Disposition': `inline; filename="${filename}"`,
        'Last-Modified': new Date(slot.uploadedAt).toUTCString(),
      },
    })
  }

  // ─── Internal: build Response from slot + blob ────────────────────

  private async buildResponse(
    slot: SlotRecord,
    blob: BlobObject,
    opts?: BlobResponseOptions,
    blobDEK?: EnclaveKey,
    verifyFlatETag?: string,
  ): Promise<Response> {
    const fetchAllChunks = this.fetchAllChunks.bind(this)

    // buffered — all chunks loaded into memory then enqueued.
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          const output = await fetchAllChunks(blob, blobDEK, verifyFlatETag)
          controller.enqueue(output)
          controller.close()
        } catch (err) {
          controller.error(err)
        }
      },
    })

    const filename = opts?.filename ?? slot.filename
    const disposition = opts?.inline
      ? `inline; filename="${filename}"`
      : `attachment; filename="${filename}"`

    return new Response(body, {
      headers: {
        'Content-Type': slot.mimeType ?? 'application/octet-stream',
        'Content-Length': String(slot.size),
        'ETag': `"${slot.eTag}"`,
        'Content-Disposition': disposition,
        'Last-Modified': new Date(slot.uploadedAt).toUTCString(),
      },
    })
  }
}

// ─── Fallback for unencrypted mode ──────────────────────────────────────

async function plainSha256Hex(data: Uint8Array): Promise<string> {
  return sha256Hex(data)
}
