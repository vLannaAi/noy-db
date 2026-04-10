import type {
  NoydbStore,
  EncryptedEnvelope,
  BlobObject,
  SlotRecord,
  SlotInfo,
  VersionRecord,
  BlobPutOptions,
  BlobResponseOptions,
} from './types.js'
import { NOYDB_FORMAT_VERSION } from './types.js'
import {
  encrypt,
  decrypt,
  hmacSha256Hex,
  encryptBytesWithAAD,
  decryptBytesWithAAD,
  bufferToBase64,
  base64ToBuffer,
} from './crypto.js'
import { ConflictError, NotFoundError } from './errors.js'
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
  const cs = new CompressionStream('gzip')
  const writer = cs.writable.getWriter()
  await writer.write(data as Uint8Array<ArrayBuffer>)
  await writer.close()
  const buf = await new Response(cs.readable).arrayBuffer()
  return { bytes: new Uint8Array(buf), algorithm: 'gzip' }
}

async function decompressBytes(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error(
      '[noy-db] DecompressionStream not available — cannot decompress blob chunk',
    )
  }
  const ds = new DecompressionStream('gzip')
  const writer = ds.writable.getWriter()
  await writer.write(data as Uint8Array<ArrayBuffer>)
  await writer.close()
  const buf = await new Response(ds.readable).arrayBuffer()
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
  private readonly getDEK: (name: string) => Promise<CryptoKey>
  private readonly encrypted: boolean
  private readonly userId: string | undefined
  private readonly maxBlobBytes: number | undefined

  constructor(opts: {
    store: NoydbStore
    vault: string
    collection: string
    recordId: string
    getDEK: (name: string) => Promise<CryptoKey>
    encrypted: boolean
    userId?: string
    maxBlobBytes?: number
  }) {
    this.store = opts.store
    this.vault = opts.vault
    this.collection = opts.collection
    this.recordId = opts.recordId
    this.getDEK = opts.getDEK
    this.encrypted = opts.encrypted
    this.userId = opts.userId
    this.maxBlobBytes = opts.maxBlobBytes
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

  private async loadSlots(): Promise<{
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

    const dek = await this.getDEK(this.collection)
    const json = await decrypt(envelope._iv, envelope._data, dek)
    return {
      slots: JSON.parse(json) as Record<string, SlotRecord>,
      version: envelope._v,
    }
  }

  private async saveSlots(
    slots: Record<string, SlotRecord>,
    currentVersion: number,
  ): Promise<void> {
    const json = JSON.stringify(slots)
    const now = new Date().toISOString()
    let envelope: EncryptedEnvelope

    if (this.encrypted) {
      const dek = await this.getDEK(this.collection)
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
   */
  private async casUpdateSlots(
    mutate: (slots: Record<string, SlotRecord>) => Record<string, SlotRecord> | null,
  ): Promise<void> {
    for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
      const { slots, version } = await this.loadSlots()
      const updated = mutate(slots)
      if (updated === null) return // no-op
      try {
        await this.saveSlots(updated, version)
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
    const json = await decrypt(envelope._iv, envelope._data, dek)
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
  private async casUpdateRefCount(eTag: string, delta: number): Promise<void> {
    for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
      const result = await this.loadBlobObject(eTag)
      if (!result) throw new NotFoundError(`BlobObject ${eTag} not found`)
      const { blob, version } = result
      const updated: BlobObject = { ...blob, refCount: blob.refCount + delta }
      try {
        await this.writeBlobObject(updated, version)
        return
      } catch (err) {
        if (err instanceof ConflictError && attempt < MAX_CAS_RETRIES - 1) continue
        throw err
      }
    }
  }

  // ─── Chunk I/O (with AAD binding) ─────────────────────────────────

  private async writeChunk(
    eTag: string,
    index: number,
    chunkCount: number,
    chunk: Uint8Array,
    dek: CryptoKey | null,
  ): Promise<void> {
    const id = `${eTag}/${index}`
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
    dek: CryptoKey | null,
  ): Promise<Uint8Array | null> {
    const envelope = await this.store.get(this.vault, BLOB_CHUNKS_COLLECTION, `${eTag}/${index}`)
    if (!envelope) return null

    if (dek) {
      const aad = chunkAAD(eTag, index, chunkCount)
      return await decryptBytesWithAAD(envelope._iv, envelope._data, dek, aad)
    }

    return base64ToBuffer(envelope._data)
  }

  // ─── Version record I/O ───────────────────────────────────────────

  private versionKey(slotName: string, label: string): string {
    return `${this.recordId}/${slotName}/${label}`
  }

  private async loadVersionRecord(slotName: string, label: string): Promise<VersionRecord | null> {
    const key = this.versionKey(slotName, label)
    const envelope = await this.store.get(this.vault, this.versionsCollection, key)
    if (!envelope) return null

    if (!this.encrypted) {
      return JSON.parse(envelope._data) as VersionRecord
    }

    const dek = await this.getDEK(this.collection)
    const json = await decrypt(envelope._iv, envelope._data, dek)
    return JSON.parse(json) as VersionRecord
  }

  private async writeVersionRecord(slotName: string, record: VersionRecord): Promise<void> {
    const key = this.versionKey(slotName, record.label)
    const json = JSON.stringify(record)
    const now = new Date().toISOString()
    let envelope: EncryptedEnvelope

    if (this.encrypted) {
      const dek = await this.getDEK(this.collection)
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

  private async fetchAllChunks(blob: BlobObject): Promise<Uint8Array> {
    const blobDEK = this.encrypted ? await this.getDEK(BLOB_COLLECTION) : null
    const chunks: Uint8Array[] = []

    for (let i = 0; i < blob.chunkCount; i++) {
      const chunk = await this.readChunk(blob.eTag, i, blob.chunkCount, blobDEK)
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
    // Step 1 — keyed content-hash (plaintext, before compression)
    const blobDEK = this.encrypted ? await this.getDEK(BLOB_COLLECTION) : null
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

    // Step 3 — deduplication check
    const existingBlob = await this.loadBlobObject(eTag)

    if (existingBlob) {
      // eTag already exists — just increment refCount (CAS retry)
      await this.casUpdateRefCount(eTag, +1)
    } else {
      // Step 4 — compress
      const { bytes: compressed, algorithm } = shouldCompress
        ? await compressBytes(data)
        : { bytes: data, algorithm: 'none' as const }

      const chunkSize = this.effectiveChunkSize(opts)
      const chunkCount = Math.max(1, Math.ceil(compressed.byteLength / chunkSize))

      // Step 5 — write chunks FIRST with AAD binding (safe failure order)
      for (let i = 0; i < chunkCount; i++) {
        const start = i * chunkSize
        await this.writeChunk(
          eTag, i, chunkCount,
          compressed.subarray(start, start + chunkSize),
          blobDEK,
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
      })
    }

    // Step 7 — CAS-update slot metadata
    const uploaderUserId = opts?.uploadedBy ?? this.userId
    await this.casUpdateSlots((slots) => {
      const oldETag = slots[slotName]?.eTag
      slots[slotName] = {
        eTag,
        filename: slotName,
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
    })

    // Decrement old eTag refCount outside the CAS loop
    if (this._deferredRefDecrement) {
      const oldETag = this._deferredRefDecrement
      this._deferredRefDecrement = undefined
      await this.casUpdateRefCount(oldETag, -1).catch(() => {
        // Best-effort — blobGC will reconcile
      })
    }
  }

  private _deferredRefDecrement: string | undefined

  /**
   * Fetch all bytes for the named slot.
   * Returns `null` if the slot does not exist.
   * Throws `NotFoundError` if the index entry exists but a chunk is missing.
   */
  async get(slotName: string): Promise<Uint8Array | null> {
    const { slots } = await this.loadSlots()
    const slot = slots[slotName]
    if (!slot) return null

    const result = await this.loadBlobObject(slot.eTag)
    if (!result) return null

    return this.fetchAllChunks(result.blob)
  }

  /**
   * List all slot entries for this record.
   * Returns metadata only — no chunk data is loaded.
   */
  async list(): Promise<SlotInfo[]> {
    const { slots } = await this.loadSlots()
    return Object.entries(slots).map(([name, slot]) => ({ name, ...slot }))
  }

  /**
   * Delete the named slot from this record.
   * Decrements refCount on the blob. Chunks are GC'd by `vault.blobGC()`.
   */
  async delete(slotName: string): Promise<void> {
    let eTagToDecrement: string | undefined

    await this.casUpdateSlots((slots) => {
      if (!(slotName in slots)) return null
      eTagToDecrement = slots[slotName]!.eTag
      delete slots[slotName]
      return slots
    })

    if (eTagToDecrement) {
      await this.casUpdateRefCount(eTagToDecrement, -1).catch(() => {
        // Best-effort — blobGC will reconcile
      })
    }
  }

  /**
   * Return a native `Response` whose body streams the decrypted,
   * decompressed blob bytes with full HTTP metadata headers.
   *
   * Note: v0.12 implementation is buffered — all chunks are loaded into
   * memory before being enqueued. True streaming deferred to v0.13.
   *
   * Returns `null` if the slot does not exist.
   */
  async response(slotName: string, opts?: BlobResponseOptions): Promise<Response | null> {
    const { slots } = await this.loadSlots()
    const slot = slots[slotName]
    if (!slot) return null

    const result = await this.loadBlobObject(slot.eTag)
    if (!result) return null

    return this.buildResponse(slot, result.blob, opts)
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
   */
  async publish(slotName: string, label: string): Promise<void> {
    const { slots } = await this.loadSlots()
    const slot = slots[slotName]
    if (!slot) throw new NotFoundError(`Slot "${slotName}" not found on record "${this.recordId}"`)

    // Check for existing version with this label
    const existing = await this.loadVersionRecord(slotName, label)
    if (existing && existing.eTag === slot.eTag) return // no-op: same blob

    // Write the version record
    const record: VersionRecord = {
      label,
      eTag: slot.eTag,
      publishedAt: new Date().toISOString(),
      ...(this.userId !== undefined ? { publishedBy: this.userId } : {}),
    }
    await this.writeVersionRecord(slotName, record)

    // Increment refCount for the new version's eTag
    await this.casUpdateRefCount(slot.eTag, +1)

    // If overwriting an existing version with a different eTag, decrement the old one
    if (existing && existing.eTag !== slot.eTag) {
      await this.casUpdateRefCount(existing.eTag, -1).catch(() => {})
    }
  }

  /**
   * Fetch bytes for a published version.
   * Returns `null` if the version does not exist.
   */
  async getVersion(slotName: string, label: string): Promise<Uint8Array | null> {
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
    const prefix = `${this.recordId}/${slotName}/`
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
        const json = await decrypt(envelope._iv, envelope._data, dek)
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
    await this.casUpdateRefCount(record.eTag, -1).catch(() => {})
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
    const record = await this.loadVersionRecord(slotName, label)
    if (!record) return null

    const result = await this.loadBlobObject(record.eTag)
    if (!result) return null

    // Build a synthetic SlotRecord from the version + blob data
    const slotLike: SlotRecord = {
      eTag: record.eTag,
      filename: opts?.filename ?? `${slotName}-${label}`,
      size: result.blob.size,
      mimeType: result.blob.mimeType,
      uploadedAt: record.publishedAt,
      uploadedBy: record.publishedBy,
    }

    return this.buildResponse(slotLike, result.blob, opts)
  }

  // ─── Diagnostics ──────────────────────────────────────────────────

  /**
   * Return the `BlobObject` metadata for the named slot.
   * Returns `null` if the slot or blob does not exist.
   */
  async blobInfo(slotName: string): Promise<BlobObject | null> {
    const { slots } = await this.loadSlots()
    const slot = slots[slotName]
    if (!slot) return null
    const result = await this.loadBlobObject(slot.eTag)
    return result?.blob ?? null
  }

  // ─── Internal: build Response from slot + blob ────────────────────

  private async buildResponse(
    slot: SlotRecord,
    blob: BlobObject,
    opts?: BlobResponseOptions,
  ): Promise<Response> {
    const self = this

    // v0.12: buffered — all chunks loaded into memory then enqueued.
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          const output = await self.fetchAllChunks(blob)
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

import { sha256Hex } from './crypto.js'

async function plainSha256Hex(data: Uint8Array): Promise<string> {
  return sha256Hex(data)
}
