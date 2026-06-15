/**
 * `ObjectProjection` — the capability an `as-*` projection store implements to
 * hold blob bytes as native, directly-consumable objects (e.g. servable S3
 * objects) rather than the encrypted-envelope chunks a `NoydbStore` holds.
 *
 * This is the shared seam behind **direct-serve blobs** (#412) and the
 * **debug raw-object path** (#413): "write these bytes as one real object and
 * give me a URL to it." See the as-aws-s3 design spec.
 *
 * Unlike `NoydbStore` (ciphertext in / ciphertext out), an `ObjectProjection`
 * sees **raw bytes** — it is `as-*`, not `to-*`, and lives **outside** the
 * zero-knowledge guarantee. Wiring it up is a deliberate, per-field opt-in.
 */

/** Metadata about a stored object, without its body. */
export interface ObjectMeta {
  readonly size: number
  readonly contentType?: string
  readonly etag?: string
  readonly lastModified?: string
  /** S3-style user metadata (`x-amz-meta-*`). Small; see the design's
   *  plain / encrypted / opaque-token modes. */
  readonly userMeta?: Record<string, string>
}

export interface PutObjectOptions {
  readonly contentType: string
  /** World-readable object (CDN origin) vs private (presigned-only). Default false. */
  readonly public?: boolean
  /** User metadata mirrored onto the object (the "secondary store"). */
  readonly userMeta?: Record<string, string>
}

export interface ObjectUrlOptions {
  /** TTL for a presigned URL (ignored for a public object). */
  readonly expiresInSeconds?: number
}

export interface PutUrlOptions {
  readonly contentType: string
  readonly expiresInSeconds?: number
}

export interface ObjectProjection {
  /** Diagnostic name (e.g. `'aws-s3'`, `'memory'`). */
  readonly name?: string
  /** Write raw bytes as a single native object with a real content type. */
  putObject(key: string, bytes: Uint8Array, opts: PutObjectOptions): Promise<void>
  /** Read the raw bytes back; `null` if absent. */
  getObject(key: string): Promise<Uint8Array | null>
  /** Delete the object. Idempotent — absent is not an error. */
  deleteObject(key: string): Promise<void>
  /** Object metadata without the body; `null` if absent. */
  headObject(key: string): Promise<ObjectMeta | null>
  /** A URL to GET the object — presigned (time-limited) or stable public. */
  objectUrl(key: string, opts?: ObjectUrlOptions): Promise<string>
  /** A presigned URL the client PUTs bytes to directly (large-file upload,
   *  bytes bypass the hub). */
  putUrl(key: string, opts: PutUrlOptions): Promise<string>
}

/**
 * In-memory {@link ObjectProjection} — a reference implementation for tests,
 * local development, and the hub's blob-wiring conformance. Holds bytes in a
 * `Map`; URLs are synthetic (`memory://…`). Not for production.
 */
export function memoryObjectProjection(opts: { baseUrl?: string } = {}): ObjectProjection {
  const base = opts.baseUrl ?? 'memory://objects'
  const store = new Map<
    string,
    { bytes: Uint8Array; contentType: string; userMeta?: Record<string, string>; public: boolean }
  >()
  return {
    name: 'memory',
    async putObject(key, bytes, o) {
      store.set(key, {
        bytes,
        contentType: o.contentType,
        public: o.public === true,
        ...(o.userMeta ? { userMeta: o.userMeta } : {}),
      })
    },
    async getObject(key) {
      return store.get(key)?.bytes ?? null
    },
    async deleteObject(key) {
      store.delete(key)
    },
    async headObject(key) {
      const e = store.get(key)
      if (!e) return null
      return {
        size: e.bytes.byteLength,
        contentType: e.contentType,
        ...(e.userMeta ? { userMeta: e.userMeta } : {}),
      }
    },
    async objectUrl(key, o) {
      const e = store.get(key)
      if (e?.public) return `${base}/${key}`
      return `${base}/${key}?sig=memory&expires=${o?.expiresInSeconds ?? 900}`
    },
    async putUrl(key, o) {
      return `${base}/${key}?upload=memory&ct=${encodeURIComponent(o.contentType)}`
    },
  }
}
