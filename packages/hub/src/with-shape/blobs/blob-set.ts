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
import { ConflictError, NotFoundError, UnsupportedTierCompositionError } from '../../kernel/errors.js'
import { liveRecordIsElevated, liveRecordTier } from '../../kernel/tier-visibility.js'
import { dekKey } from '../../with-party/team/tiers.js'
import { detectMagic, isPreCompressed } from './mime-magic.js'

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
   */
  private async ownerRecordElevated(): Promise<boolean> {
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
   */
  private async ownerTier(): Promise<number> {
    return liveRecordTier(this.store, this.vault, this.collection, this.recordId)
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

  // ─── Blob Index I/O (versioned for CAS refCount) ──────────────────

  private async loadBlobObject(eTag: string): Promise<{ blob: BlobObject; version: number } | null> {
    const envelope = await this.store.get(this.vault, BLOB_INDEX_COLLECTION, eTag)
    if (!envelope) return null

    if (!this.encrypted) {
      return { blob: JSON.parse(envelope._data) as BlobObject, version: envelope._v }
    }

    const dek = await this.getDEK(BLOB_COLLECTION)
    const json = await openEnvelopeJson(envelope, dek)
    return { blob: JSON.parse(json) as BlobObject, version: envelope._v }
  }

  private async writeBlobObject(blob: BlobObject, expectedVersion?: number): Promise<void> {
    const json = JSON.stringify(blob)
    const now = new Date().toISOString()
    const newVersion = (expectedVersion ?? 0) + 1
    let envelope: EncryptedEnvelope

    if (this.encrypted) {
      const dek = await this.getDEK(BLOB_COLLECTION)
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
   */
  private async casUpdateRefCount(eTag: string, delta: number): Promise<number> {
    for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
      const result = await this.loadBlobObject(eTag)
      if (!result) throw new NotFoundError(`BlobObject ${eTag} not found`)
      const { blob, version } = result
      const updated: BlobObject = { ...blob, refCount: blob.refCount + delta }
      try {
        await this.writeBlobObject(updated, version)
        return updated.refCount
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
   */
  private async releaseRef(
    eTag: string,
    n: number,
    reclaimLegacy: boolean,
  ): Promise<'shredded' | 'retainedShared' | 'residue'> {
    const loaded = await this.loadBlobObject(eTag)
    if (!loaded) return 'shredded' // already gone
    const erasable = loaded.blob._cek !== undefined
    const remaining = await this.casUpdateRefCount(eTag, -n)
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
   * #724 re-review (High) defense-in-depth: an unreadable slot map (wrong
   * DEK from a stray mis-keyed envelope, or genuine tamper) must not abort
   * the whole erasure cascade — the primary fix (`casUpdateSlots` deleting
   * the row instead of leaving it empty-but-present) prevents the mis-keying
   * in the first place, but `forget()` is the one path where "can't read the
   * slot map" and "no blobs to shred" should be indistinguishable: either
   * way there is nothing here to crypto-shred, and a `TamperedError` must
   * never leave a record tombstoned with its blob cascade half-run.
   */
  async shredAllForRecord(ownerTier?: number): Promise<{
    shredded: string[]
    retainedShared: string[]
    residue: string[]
  }> {
    const shredded: string[] = []
    const retainedShared: string[] = []
    const residue: string[] = []
    let slots: Record<string, SlotRecord>
    try {
      slots = (await this.loadSlots(ownerTier)).slots
    } catch {
      return { shredded, retainedShared, residue } // unreadable slot map ≡ no blobs to shred
    }
    const slotNames = Object.keys(slots)
    if (slotNames.length === 0) return { shredded, retainedShared, residue }

    // Reference count from THIS record per eTag.
    const holds = new Map<string, number>()
    for (const name of slotNames) {
      const eTag = slots[name]!.eTag
      holds.set(eTag, (holds.get(eTag) ?? 0) + 1)
    }

    for (const [eTag, n] of holds) {
      // Forget erasure reclaims legacy orphans too (the record is being erased),
      // so reclaimLegacy = true — but only erasable blobs count as a crypto-shred.
      const outcome = await this.releaseRef(eTag, n, true)
      if (outcome === 'shredded') shredded.push(eTag)
      else if (outcome === 'retainedShared') retainedShared.push(eTag)
      else residue.push(eTag)
    }

    // Sever the subject's link: drop the record's slot map.
    await this.store.delete(this.vault, this.slotsCollection, this.recordId)
    return { shredded, retainedShared, residue }
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
   */
  async rehomeForTier(fromTier: number, toTier: number, policy: 'isolate' | 'dedup'): Promise<void> {
    if (!this.encrypted || fromTier === toTier) return
    const { slots } = await this.loadSlots(fromTier)

    // Old eTag → new eTag for every object the slot loop below physically
    // re-`put()`s. Passed on to `rehomeVersionRecords` (#724 Arc 10 Task 2,
    // C4) so a version pinned to the SAME eTag a slot held can skip a
    // redundant fetch+re-encrypt — same plaintext + same `toBlobDEK` always
    // hashes to the same destination eTag (content-addressing).
    const rehomedETags = new Map<string, string>()

    if (Object.keys(slots).length > 0) {
      const eTags = new Set(Object.values(slots).map((s) => s.eTag).filter((eTag) => eTag !== ''))

      if (eTags.size > 0) {
        const fromBlobDEK = await this.getDEK(dekKey(BLOB_COLLECTION, fromTier))
        const toBlobDEK = await this.getDEK(dekKey(BLOB_COLLECTION, toTier))

        for (const eTag of eTags) {
          const loaded = await this.loadBlobObject(eTag)
          if (!loaded) continue
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
            await this.putUnderDEK(slotName, plaintext, toBlobDEK, {
              filename: slot.filename,
              ...(blob.mimeType !== undefined ? { mimeType: blob.mimeType } : {}),
              compress: blob.compression === 'gzip',
              ...(slot.uploadedBy !== undefined ? { uploadedBy: slot.uploadedBy } : {}),
            }, fromTier)
          }
        }
      }

      const { slots: finalSlots, version: finalVersion } = await this.loadSlots(fromTier)
      await this.saveSlots(finalSlots, finalVersion, toTier)
    }

    // #724 Arc 10 Task 2 (C4): published versions follow too. `publish()`
    // takes an INDEPENDENT refCount hold on a `BlobObject`, separate from
    // the slot map — the loop above only walks
    // `_blob_slots_{collection}/{recordId}` and never sees it. A version
    // whose eTag was superseded in the slot map (overwritten after publish)
    // would otherwise never be rehomed at all, and the version RECORD
    // itself (label/eTag/timestamps) stays on the fromTier collection DEK.
    await this.rehomeVersionRecords(fromTier, toTier, policy, rehomedETags)
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
   */
  private async rehomeVersionRecords(
    fromTier: number,
    toTier: number,
    policy: 'isolate' | 'dedup',
    rehomedETags: Map<string, string>,
  ): Promise<void> {
    const prefix = `${this.recordId}::`
    const allKeys = await this.store.list(this.vault, this.versionsCollection)
    const matchingKeys = allKeys.filter((k) => k.startsWith(prefix))
    if (matchingKeys.length === 0) return

    const fromCollDEK = await this.getDEK(dekKey(this.collection, fromTier))
    const fromBlobDEK = await this.getDEK(dekKey(BLOB_COLLECTION, fromTier))
    const toBlobDEK = await this.getDEK(dekKey(BLOB_COLLECTION, toTier))

    for (const key of matchingKeys) {
      const envelope = await this.store.get(this.vault, this.versionsCollection, key)
      if (!envelope) continue
      const record = this.encrypted
        ? JSON.parse(await openEnvelopeJson(envelope, fromCollDEK)) as VersionRecord
        : JSON.parse(envelope._data) as VersionRecord

      const newETag = await this.rehomeVersionETag(record, fromBlobDEK, toBlobDEK, policy, rehomedETags)
      const moved: VersionRecord = newETag === record.eTag ? record : { ...record, eTag: newETag }
      await this.writeVersionRecordAtKey(key, moved, toTier)
    }
  }

  /**
   * Rehome ONE version's independently-held eTag. Returns the eTag the
   * version should now point at.
   *
   * If the version happened to hold the SAME eTag a slot held (the common
   * case: publish right after put, no later overwrite), the slot loop in
   * `rehomeForTier` already re-`put()` the content under `toBlobDEK` —
   * `rehomedETags` (content-addressed, so deterministic) tells us the
   * resulting destination eTag without a redundant fetch+re-encrypt; we
   * only need to move THIS hold's refCount onto it. Otherwise (the version
   * outlived its slot, or was never in the slot map) this re-`put()`s the
   * plaintext itself via `writeBlobContent` — the same content-write core
   * `put()`/the slot loop use, no new crypto — mirroring the slot case's
   * legacy/`dedup`-shared skip conditions.
   */
  private async rehomeVersionETag(
    record: VersionRecord,
    fromBlobDEK: EnclaveKey,
    toBlobDEK: EnclaveKey,
    policy: 'isolate' | 'dedup',
    rehomedETags: Map<string, string>,
  ): Promise<string> {
    const already = rehomedETags.get(record.eTag)
    if (already !== undefined) {
      await this.casUpdateRefCount(already, +1)
      await this.releaseRef(record.eTag, 1, false).catch(() => {})
      return already
    }

    const loaded = await this.loadBlobObject(record.eTag)
    if (!loaded || loaded.blob._cek === undefined) return record.eTag // legacy/missing: no-op
    if (policy === 'dedup' && loaded.blob.refCount > 1) return record.eTag // #741: same residue as the slot case

    const plaintext = await this.fetchAllChunks(loaded.blob, fromBlobDEK)
    const { eTag: newETag } = await this.writeBlobContent(plaintext, toBlobDEK, {
      filename: record.label,
      ...(loaded.blob.mimeType !== undefined ? { mimeType: loaded.blob.mimeType } : {}),
      compress: loaded.blob.compression === 'gzip',
    })
    rehomedETags.set(record.eTag, newETag) // memoize: two versions may share an eTag outside the slot map too
    if (newETag !== record.eTag) {
      await this.releaseRef(record.eTag, 1, false).catch(() => {})
    }
    return newETag
  }

  /** CAS retry loop for an arbitrary BlobObject mutation. */
  private async casUpdateBlobObject(
    eTag: string,
    mutate: (blob: BlobObject) => BlobObject,
  ): Promise<void> {
    for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
      const result = await this.loadBlobObject(eTag)
      if (!result) throw new NotFoundError(`BlobObject ${eTag} not found`)
      try {
        await this.writeBlobObject(mutate(result.blob), result.version)
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

    const blobDEK = await this.getDEK(BLOB_COLLECTION)
    const { slots } = await this.loadSlots()
    const eTags = new Set(Object.values(slots).map((s) => s.eTag))

    for (const eTag of eTags) {
      const loaded = await this.loadBlobObject(eTag)
      if (!loaded) continue
      const blob = loaded.blob
      if (blob._cek !== undefined) { alreadyErasable.push(eTag); continue }

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

  private async fetchAllChunks(blob: BlobObject, blobDEK?: EnclaveKey): Promise<Uint8Array> {
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
    return blob.compression === 'gzip' ? await decompressBytes(assembled) : assembled
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
   * map is still physically there (see `ownerTier()`'s doc comment).
   */
  private async putUnderDEK(
    slotName: string,
    data: Uint8Array,
    blobDEK: EnclaveKey | null,
    opts?: BlobPutOptions,
    slotsTier?: number,
  ): Promise<void> {
    const { eTag, mimeType } = await this.writeBlobContent(data, blobDEK, opts)

    // Step 7 — CAS-update slot metadata
    const uploaderUserId = opts?.uploadedBy ?? this.userId
    await this.casUpdateSlots((slots) => {
      const oldETag = slots[slotName]?.eTag
      slots[slotName] = {
        eTag,
        filename: opts?.filename ?? slotName,
        size: data.byteLength,
        ...(mimeType !== undefined ? { mimeType } : {}),
        uploadedAt: new Date().toISOString(),
        ...(uploaderUserId !== undefined ? { uploadedBy: uploaderUserId } : {}),
      }
      // Schedule old eTag refCount decrement (non-blocking best-effort)
      if (oldETag && oldETag !== eTag) {
        this._deferredRefDecrement = oldETag
      }
      return slots
    }, slotsTier)

    // Release the old eTag outside the CAS loop. An erasable blob dropping to
    // refCount 0 here is crypto-shredded eagerly; a legacy one defers to GC.
    if (this._deferredRefDecrement) {
      const oldETag = this._deferredRefDecrement
      this._deferredRefDecrement = undefined
      await this.releaseRef(oldETag, 1, false).catch(() => {
        // Best-effort — a missed decrement is reconciled by a later pass.
      })
    }
  }

  /**
   * The chunk/CEK/dedup core of `put()` (former Steps 1-6 of `putUnderDEK`,
   * extracted #724 Arc 10 Task 2 so `rehomeVersionETag` can write a
   * version-held blob's content under a target tier's DEK WITHOUT touching
   * the slot map — `putUnderDEK`'s remaining Step 7 is slot-specific).
   * Content-addressed and dedup-aware exactly like `put()`: hashing the same
   * plaintext under the same `blobDEK` twice always lands on the same eTag.
   */
  private async writeBlobContent(
    data: Uint8Array,
    blobDEK: EnclaveKey | null,
    opts?: BlobPutOptions,
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
    const existingBlob = await this.loadBlobObject(eTag)

    if (existingBlob) {
      // eTag already exists — just increment refCount (CAS retry). Dedup is
      // preserved across the content-CEK split: the chunks (and the BlobObject's
      // `_cek`, if any) are reused as-is; a new referencer never re-encrypts.
      await this.casUpdateRefCount(eTag, +1)
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

    // Step 6 — write blob index entry after all chunks succeed
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
    })

    return { eTag, mimeType }
  }

  private _deferredRefDecrement: string | undefined

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

    return this.fetchAllChunks(result.blob)
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
    return Object.entries(slots).map(([name, slot]) => ({ name, ...slot }))
  }

  /**
   * Delete the named slot from this record.
   * Decrements refCount on the blob. Chunks are GC'd by `vault.blobGC()`.
   */
  async delete(slotName: string): Promise<void> {
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

    return this.buildResponse(slot, result.blob, opts)
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
    this.assertBlobWritable() // #724 I1 completion: same write-time refusal as put()
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

    return this.fetchAllChunks(result.blob)
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

    return this.buildResponse(slotLike, result.blob, opts)
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
  ): Promise<Response> {
    const fetchAllChunks = this.fetchAllChunks.bind(this)

    // buffered — all chunks loaded into memory then enqueued.
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          const output = await fetchAllChunks(blob)
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
