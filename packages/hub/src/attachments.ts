import type {
  NoydbStore,
  EncryptedEnvelope,
  BlobObject,
  AttachmentEntry,
  AttachmentInfo,
  AttachmentPutOptions,
  AttachmentResponseOptions,
} from './types.js'
import { NOYDB_FORMAT_VERSION } from './types.js'
import {
  encrypt,
  decrypt,
  encryptBytes,
  decryptBytes,
  sha256Hex,
  bufferToBase64,
  base64ToBuffer,
} from './crypto.js'
import { NotFoundError } from './errors.js'

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
 * `AttachmentHandle.get()` / `AttachmentHandle.response()`.
 */
export const BLOB_CHUNKS_COLLECTION = '_blob_chunks'

/** Prefix for per-collection attachment metadata collections. */
export const ATTACH_META_PREFIX = '_attach_'

/**
 * Default chunk size: 256 KB raw bytes.
 * After AES-GCM (same size) + base64 (~33% inflation) → ~342 KB per
 * envelope, safely within DynamoDB's 400 KB item limit.
 */
export const DEFAULT_CHUNK_SIZE = 256 * 1024

// ─── Compression helpers ───────────────────────────────────────────────

async function compressBytes(
  data: Uint8Array,
): Promise<{ bytes: Uint8Array; algorithm: 'gzip' | 'none' }> {
  if (typeof CompressionStream === 'undefined') {
    return { bytes: data, algorithm: 'none' }
  }
  const cs = new CompressionStream('gzip')
  const writer = cs.writable.getWriter()
  // Cast needed: TypeScript lib types CompressionStream as accepting Uint8Array
  // but infers a narrower generic than Uint8Array<ArrayBufferLike>.
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

// ─── AttachmentHandle ──────────────────────────────────────────────────

/**
 * Handle for reading, writing, listing, and deleting binary attachments
 * on a specific record.
 *
 * Obtained via `collection.attachments(id)`. No I/O is performed until you
 * call a method.
 *
 * ## Storage layout
 *
 * ```
 * _blob_index/{eTag}                   BlobObject metadata (vault-shared DEK)
 * _blob_chunks/{eTag}/{chunkIndex}      Encrypted chunk data (vault-shared DEK)
 * _attach_{collection}/{recordId}       Attachment slot map (parent collection DEK)
 * ```
 *
 * ## Deduplication
 *
 * `put()` computes `eTag = sha256(plaintext)` before compression. If another
 * record (or another attachment slot on this record) already uploaded the same
 * bytes, the chunks are reused — only the attachment metadata envelope is
 * updated. A `vault.blobGC()` call (v0.13) removes orphaned chunks after
 * `delete()` or `put()` overwrites.
 *
 * ## HTTP streaming
 *
 * `response(name)` returns a native `Response` with full HTTP headers
 * (`Content-Type`, `Content-Length`, `ETag`, `Content-Disposition`,
 * `Last-Modified`). The body decrypts and decompresses chunks lazily via
 * a `ReadableStream`, suitable for service workers, Hono, Nitro, or any
 * Fetch-API-compatible handler.
 */
export class AttachmentHandle {
  private readonly store: NoydbStore
  private readonly vault: string
  private readonly collection: string
  private readonly recordId: string
  private readonly getDEK: (name: string) => Promise<CryptoKey>
  private readonly encrypted: boolean
  private readonly userId: string | undefined

  constructor(opts: {
    store: NoydbStore
    vault: string
    collection: string
    recordId: string
    /** Vault-level DEK resolver — same callback Collection holds internally. */
    getDEK: (name: string) => Promise<CryptoKey>
    encrypted: boolean
    /** User ID recorded as `uploadedBy` when not overridden in put options. */
    userId?: string
  }) {
    this.store = opts.store
    this.vault = opts.vault
    this.collection = opts.collection
    this.recordId = opts.recordId
    this.getDEK = opts.getDEK
    this.encrypted = opts.encrypted
    this.userId = opts.userId
  }

  /** The internal collection that holds metadata for this collection's attachments. */
  private get metaCollection(): string {
    return `${ATTACH_META_PREFIX}${this.collection}`
  }

  // ─── Metadata envelope I/O ──────────────────────────────────────────

  private async loadEntries(): Promise<{
    entries: Record<string, AttachmentEntry>
    version: number
  }> {
    const envelope = await this.store.get(this.vault, this.metaCollection, this.recordId)
    if (!envelope) return { entries: {}, version: 0 }

    if (!this.encrypted) {
      return {
        entries: JSON.parse(envelope._data) as Record<string, AttachmentEntry>,
        version: envelope._v,
      }
    }

    const dek = await this.getDEK(this.collection)
    const json = await decrypt(envelope._iv, envelope._data, dek)
    return {
      entries: JSON.parse(json) as Record<string, AttachmentEntry>,
      version: envelope._v,
    }
  }

  private async saveEntries(
    entries: Record<string, AttachmentEntry>,
    currentVersion: number,
  ): Promise<void> {
    const json = JSON.stringify(entries)
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

    // Pass expectedVersion only when updating an existing record so stores
    // that implement CAS (DynamoDB, IDB) can detect concurrent modifications.
    // For new records (currentVersion === 0) omit it — we just confirmed it
    // was null, so no CAS check is needed and not all stores accept 0.
    await this.store.put(
      this.vault,
      this.metaCollection,
      this.recordId,
      envelope,
      currentVersion > 0 ? currentVersion : undefined,
    )
  }

  // ─── Blob index I/O ─────────────────────────────────────────────────

  private async loadBlobObject(eTag: string): Promise<BlobObject | null> {
    const envelope = await this.store.get(this.vault, BLOB_INDEX_COLLECTION, eTag)
    if (!envelope) return null

    if (!this.encrypted) {
      return JSON.parse(envelope._data) as BlobObject
    }

    const dek = await this.getDEK(BLOB_COLLECTION)
    const json = await decrypt(envelope._iv, envelope._data, dek)
    return JSON.parse(json) as BlobObject
  }

  private async writeBlobObject(blob: BlobObject): Promise<void> {
    const json = JSON.stringify(blob)
    const now = new Date().toISOString()
    let envelope: EncryptedEnvelope

    if (this.encrypted) {
      const dek = await this.getDEK(BLOB_COLLECTION)
      const { iv, data } = await encrypt(json, dek)
      envelope = { _noydb: NOYDB_FORMAT_VERSION, _v: 1, _ts: now, _iv: iv, _data: data }
    } else {
      envelope = { _noydb: NOYDB_FORMAT_VERSION, _v: 1, _ts: now, _iv: '', _data: json }
    }

    await this.store.put(this.vault, BLOB_INDEX_COLLECTION, blob.eTag, envelope)
  }

  // ─── Chunk I/O ──────────────────────────────────────────────────────

  private async writeChunk(
    eTag: string,
    index: number,
    chunk: Uint8Array,
    dek: CryptoKey | null,
  ): Promise<void> {
    const id = `${eTag}/${index}`
    const now = new Date().toISOString()
    let envelope: EncryptedEnvelope

    if (dek) {
      const { iv, data } = await encryptBytes(chunk, dek)
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
    dek: CryptoKey | null,
  ): Promise<Uint8Array | null> {
    const envelope = await this.store.get(this.vault, BLOB_CHUNKS_COLLECTION, `${eTag}/${index}`)
    if (!envelope) return null

    if (dek) {
      return await decryptBytes(envelope._iv, envelope._data, dek)
    }

    return base64ToBuffer(envelope._data)
  }

  // ─── Public API ─────────────────────────────────────────────────────

  /**
   * Upload bytes and attach them to this record under `name`.
   *
   * 1. Computes `eTag = sha256(plaintext)` for content-addressing.
   * 2. If a blob with this eTag already exists, skips chunk upload (deduplication).
   * 3. Otherwise: compresses (gzip by default) → splits into chunks → encrypts
   *    each chunk with the vault-shared `_blob` DEK → writes `_blob_chunks`.
   * 4. Writes the `BlobObject` to `_blob_index` AFTER all chunks succeed, so
   *    a partial failure leaves orphan chunks (GC-able) not a broken index entry.
   * 5. Updates the attachment metadata envelope in `_attach_{collection}`.
   *
   * @param name  Slot key for this attachment (e.g. `'invoice.pdf'`).
   * @param data  Raw bytes to store. Typically from `File.arrayBuffer()` or `fs.readFile`.
   */
  async put(name: string, data: Uint8Array, opts?: AttachmentPutOptions): Promise<void> {
    // Step 1 — content-hash (plaintext, before compression)
    const eTag = await sha256Hex(data)

    // Step 2 — deduplication check
    const existingBlob = await this.loadBlobObject(eTag)

    if (!existingBlob) {
      // Step 3 — compress
      const shouldCompress = opts?.compress !== false
      const { bytes: compressed, algorithm } = shouldCompress
        ? await compressBytes(data)
        : { bytes: data, algorithm: 'none' as const }

      const chunkSize = opts?.chunkSize ?? DEFAULT_CHUNK_SIZE
      const blobDEK = this.encrypted ? await this.getDEK(BLOB_COLLECTION) : null
      const chunkCount = Math.max(1, Math.ceil(compressed.byteLength / chunkSize))

      // Step 4 — write chunks FIRST (safe failure order)
      for (let i = 0; i < chunkCount; i++) {
        const start = i * chunkSize
        await this.writeChunk(eTag, i, compressed.subarray(start, start + chunkSize), blobDEK)
      }

      // Step 5 — write blob index entry after all chunks succeed
      await this.writeBlobObject({
        eTag,
        size: data.byteLength,
        compressedSize: compressed.byteLength,
        compression: algorithm,
        ...(opts?.mimeType !== undefined ? { mimeType: opts.mimeType } : {}),
        createdAt: new Date().toISOString(),
      })
    }

    // Step 6 — update attachment metadata envelope (versioned)
    const { entries, version } = await this.loadEntries()

    entries[name] = {
      eTag,
      filename: name,
      size: data.byteLength,
      ...(opts?.mimeType !== undefined ? { mimeType: opts.mimeType } : {}),
      uploadedAt: new Date().toISOString(),
      ...(opts?.uploadedBy !== undefined
        ? { uploadedBy: opts.uploadedBy }
        : this.userId !== undefined
          ? { uploadedBy: this.userId }
          : {}),
    }

    await this.saveEntries(entries, version)
  }

  /**
   * Fetch all bytes for the named attachment.
   *
   * Reads chunk count from the blob index, fetches each chunk from
   * `_blob_chunks` individually (no `loadAll`), decrypts, reassembles,
   * and decompresses if needed.
   *
   * Returns `null` if the attachment slot does not exist.
   * Throws `NotFoundError` if the index entry exists but a chunk is missing.
   */
  async get(name: string): Promise<Uint8Array | null> {
    const { entries } = await this.loadEntries()
    const entry = entries[name]
    if (!entry) return null

    const blob = await this.loadBlobObject(entry.eTag)
    if (!blob) return null

    const blobDEK = this.encrypted ? await this.getDEK(BLOB_COLLECTION) : null
    const chunkCount = Math.max(1, Math.ceil(blob.compressedSize / DEFAULT_CHUNK_SIZE))
    const chunks: Uint8Array[] = []

    for (let i = 0; i < chunkCount; i++) {
      const chunk = await this.readChunk(entry.eTag, i, blobDEK)
      if (!chunk) {
        throw new NotFoundError(
          `Blob chunk ${i}/${chunkCount} missing for attachment "${name}" on record "${this.recordId}"`,
        )
      }
      chunks.push(chunk)
    }

    const assembled = concatChunks(chunks)
    return blob.compression === 'gzip' ? await decompressBytes(assembled) : assembled
  }

  /**
   * List all attachment slots for this record.
   * Returns metadata only — no chunk data is loaded.
   */
  async list(): Promise<AttachmentInfo[]> {
    const { entries } = await this.loadEntries()
    return Object.entries(entries).map(([name, entry]) => ({ name, ...entry }))
  }

  /**
   * Delete the named attachment slot from this record.
   *
   * The blob chunks in `_blob_chunks` are NOT immediately removed.
   * Unreferenced blobs are cleaned up lazily by `vault.blobGC()` (v0.13),
   * which scans all `_attach_*` envelopes to find eTags no longer referenced
   * by any record in the vault.
   *
   * This design avoids an O(vault) scan per delete and is safe: chunk data
   * without an eTag reference in any attachment envelope is unreachable.
   */
  async delete(name: string): Promise<void> {
    const { entries, version } = await this.loadEntries()
    if (!(name in entries)) return

    delete entries[name]
    await this.saveEntries(entries, version)
  }

  /**
   * Return a native `Response` whose body streams the decrypted,
   * decompressed attachment bytes with full HTTP metadata headers.
   *
   * Suitable for direct use in service workers, Hono routes, Nitro
   * handlers, or any Fetch-API-compatible server:
   *
   * ```ts
   * app.get('/files/:id/:name', async (ctx) => {
   *   const res = await vault
   *     .collection<Invoice>('invoices')
   *     .attachments(ctx.params.id)
   *     .response(ctx.params.name, { inline: true })
   *   return res ?? ctx.notFound()
   * })
   * ```
   *
   * Headers returned:
   * - `Content-Type` — from attachment entry, fallback `application/octet-stream`
   * - `Content-Length` — original uncompressed size in bytes
   * - `ETag` — quoted SHA-256 hex (content-addressed, stable across re-uploads)
   * - `Content-Disposition` — `inline` or `attachment` based on `opts.inline`
   * - `Last-Modified` — RFC 7231 date from `uploadedAt`
   *
   * Returns `null` if the attachment slot does not exist.
   */
  async response(name: string, opts?: AttachmentResponseOptions): Promise<Response | null> {
    const { entries } = await this.loadEntries()
    const entry = entries[name]
    if (!entry) return null

    const blob = await this.loadBlobObject(entry.eTag)
    if (!blob) return null

    const blobDEK = this.encrypted ? await this.getDEK(BLOB_COLLECTION) : null
    const chunkCount = Math.max(1, Math.ceil(blob.compressedSize / DEFAULT_CHUNK_SIZE))

    // Capture locals for the ReadableStream closure
    const { eTag } = entry
    const compression = blob.compression
    const self = this

    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          const chunks: Uint8Array[] = []
          for (let i = 0; i < chunkCount; i++) {
            const chunk = await self.readChunk(eTag, i, blobDEK)
            if (!chunk) {
              controller.error(
                new NotFoundError(`Chunk ${i}/${chunkCount} missing for attachment "${name}"`),
              )
              return
            }
            chunks.push(chunk)
          }

          const assembled = concatChunks(chunks)
          const output = compression === 'gzip' ? await decompressBytes(assembled) : assembled
          controller.enqueue(output)
          controller.close()
        } catch (err) {
          controller.error(err)
        }
      },
    })

    const disposition = opts?.inline
      ? `inline; filename="${entry.filename}"`
      : `attachment; filename="${entry.filename}"`

    return new Response(body, {
      headers: {
        'Content-Type': entry.mimeType ?? 'application/octet-stream',
        'Content-Length': String(entry.size),
        'ETag': `"${entry.eTag}"`,
        'Content-Disposition': disposition,
        'Last-Modified': new Date(entry.uploadedAt).toUTCString(),
      },
    })
  }

  /**
   * Return the `BlobObject` metadata for the named attachment.
   * Useful for inspecting compression ratio, exact chunk layout, and
   * confirming deduplication (same eTag on two records = shared chunks).
   * Returns `null` if the slot or blob does not exist.
   */
  async blobInfo(name: string): Promise<BlobObject | null> {
    const { entries } = await this.loadEntries()
    const entry = entries[name]
    if (!entry) return null
    return this.loadBlobObject(entry.eTag)
  }
}
