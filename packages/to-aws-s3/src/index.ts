/**
 * **@noy-db/to-aws-s3** — S3 object store for NOYDB.
 *
 * Each record is stored as a JSON object at
 * `{prefix}/{vault}/{collection}/{id}.json`. The `loadAll()` method uses
 * `ListObjectsV2` to enumerate keys then fetches them in parallel.
 *
 * ## When to use
 *
 * - **Blob / attachment storage** — pair with `@noy-db/to-aws-dynamo` via
 *   `routeStore({ default: dynamo(...), blobs: s3(...) })` to route
 *   encrypted binary chunks to S3.
 * - **Archive tier** — configure `routeStore` age-based tiering so old
 *   records migrate to S3 while hot records stay in DynamoDB.
 * - **Large vaults** — S3 has no item size limit, unlike DynamoDB's 400 KB cap.
 *
 * ## Limitations
 *
 * - **`loadAll()` is O(N) requests** — listing + fetching every object in a
 *   vault. Suitable for vaults up to ~10K records; beyond that, prefer
 *   DynamoDB for indexed stores and S3 only for append-heavy blob storage.
 *
 * ## IAM minimum permissions
 *
 * ```json
 * { "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject",
 *              "s3:ListBucket"] }
 * ```
 *
 * @packageDocumentation
 */

import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '@noy-db/hub'
import { ConflictError } from '@noy-db/hub'
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  HeadBucketCommand,
} from '@aws-sdk/client-s3'

/**
 * Options for `s3()`.
 *
 * Objects are stored at `{prefix}/{vault}/{collection}/{id}.json`.
 * `loadAll()` uses `ListObjectsV2` over the vault prefix followed by parallel
 * `GetObject` calls — suitable for vaults with up to ~10K records. For larger
 * vaults, use DynamoDB or pair with `routeStore` age-tiering so S3 only
 * holds archived records.
 *
 * S3 supports conditional writes (`IfMatch` / `IfNoneMatch` on `PutObject`),
 * enabling atomic CAS (`casAtomic: true`). Server clock is read via a sentinel
 * object's `LastModified` timestamp — store-authoritative, not client wall clock.
 * ε defaults to 5 000 ms (S3 is NTP-synced; observed skew bound).
 */
export interface S3Options {
  /** S3 bucket name. */
  bucket: string
  /** Key prefix within the bucket. Default: ''. */
  prefix?: string
  /** AWS region. Used only when `client` is not provided. Default: 'us-east-1'. */
  region?: string
  /**
   * Pre-built S3Client from `@aws-sdk/client-s3`. If provided, the adapter
   * uses this client directly and ignores `region`. Useful for apps that want
   * to share a client across adapters or supply custom middleware.
   */
  client?: S3Client
  /** Clock uncertainty bound for serverWriteTime (ms). Default: 5000. */
  clockUncertaintyMs?: number
}

/**
 * Create an S3 adapter.
 * Key scheme: `{prefix}/{vault}/{collection}/{id}.json`
 */
function isPreconditionFailed(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  if (err.name === 'PreconditionFailed') return true
  const meta = (err as { $metadata?: { httpStatusCode?: number } }).$metadata
  return meta?.httpStatusCode === 412
}

export function s3(options: S3Options): NoydbStore {
  const { bucket, prefix = '' } = options
  const clockUncertaintyMs = options.clockUncertaintyMs ?? 5_000

  const client = options.client ?? new S3Client({
    ...(options.region ? { region: options.region } : {}),
  })

  function objectKey(vault: string, collection: string, id: string): string {
    const parts = [vault, collection, `${id}.json`]
    return prefix ? `${prefix}/${parts.join('/')}` : parts.join('/')
  }

  function collPrefix(vault: string, collection: string): string {
    const parts = [vault, collection, '']
    return prefix ? `${prefix}/${parts.join('/')}` : parts.join('/')
  }

  function compPrefix(vault: string): string {
    return prefix ? `${prefix}/${vault}/` : `${vault}/`
  }

  // Sentinel key used solely to sample the store's server clock.
  const clockKey = prefix ? `${prefix}/_noydb-clock` : '_noydb-clock'

  return {
    name: 's3',
    capabilities: {
      casAtomic: true,
      serverWriteTime: true,
      auth: { kind: 'iam', required: true, flow: 'static' },
    },

    async getStoreTime() {
      // Write a sentinel object so S3 assigns a server-authoritative LastModified.
      await client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: clockKey,
        Body: '',
        ContentType: 'text/plain',
      }))
      const head = await client.send(new HeadObjectCommand({
        Bucket: bucket,
        Key: clockKey,
      }))
      const serverMs = head.LastModified!.getTime()
      return { earliest: serverMs - clockUncertaintyMs, latest: serverMs + clockUncertaintyMs }
    },

    async get(vault, collection, id) {
      try {
        const result = await client.send(new GetObjectCommand({
          Bucket: bucket,
          Key: objectKey(vault, collection, id),
        }))

        if (!result.Body) return null
        const body = await result.Body.transformToString()
        return JSON.parse(body) as EncryptedEnvelope
      } catch (err: unknown) {
        if (err instanceof Error && (err.name === 'NoSuchKey' || err.name === 'NotFound')) {
          return null
        }
        throw err
      }
    },

    async put(vault, collection, id, envelope, expectedVersion) {
      const key = objectKey(vault, collection, id)

      if (expectedVersion !== undefined) {
        if (expectedVersion === 0) {
          // Create-only — IfNoneMatch: '*' is atomic at S3's write layer.
          try {
            await client.send(new PutObjectCommand({
              Bucket: bucket,
              Key: key,
              Body: JSON.stringify(envelope),
              ContentType: 'application/json',
              IfNoneMatch: '*',
            }))
          } catch (err: unknown) {
            if (isPreconditionFailed(err)) {
              try {
                const r = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
                const b = await r.Body!.transformToString()
                const cur = JSON.parse(b) as EncryptedEnvelope
                throw new ConflictError(cur._v, 'Concurrent create: object already exists')
              } catch (inner: unknown) {
                if (inner instanceof ConflictError) throw inner
              }
              throw new ConflictError(0, 'Concurrent create: object already exists')
            }
            throw err
          }
          return
        }

        // Update — GetObject captures ETag + verifies _v, then PutObject with
        // IfMatch: etag ensures no concurrent writer slipped in between.
        let currentETag: string
        try {
          const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
          const body = await result.Body!.transformToString()
          const current = JSON.parse(body) as EncryptedEnvelope
          if (current._v !== expectedVersion) {
            throw new ConflictError(current._v, `Version conflict: expected ${expectedVersion}, found ${current._v}`)
          }
          currentETag = result.ETag ?? ''
        } catch (err: unknown) {
          if (err instanceof ConflictError) throw err
          if (err instanceof Error && (err.name === 'NoSuchKey' || err.name === 'NotFound')) {
            throw new ConflictError(0, `Object not found, expected version ${expectedVersion}`)
          }
          throw err
        }

        try {
          await client.send(new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: JSON.stringify(envelope),
            ContentType: 'application/json',
            IfMatch: currentETag,
          }))
        } catch (err: unknown) {
          if (isPreconditionFailed(err)) {
            try {
              const r = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
              const b = await r.Body!.transformToString()
              const latest = JSON.parse(b) as EncryptedEnvelope
              throw new ConflictError(latest._v, 'Concurrent write detected')
            } catch (inner: unknown) {
              if (inner instanceof ConflictError) throw inner
            }
            throw new ConflictError(0, 'Concurrent write detected')
          }
          throw err
        }
        return
      }

      // Unconditional PUT.
      await client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: JSON.stringify(envelope),
        ContentType: 'application/json',
      }))
    },

    async delete(vault, collection, id) {
      await client.send(new DeleteObjectCommand({
        Bucket: bucket,
        Key: objectKey(vault, collection, id),
      }))
    },

    async list(vault, collection) {
      const pfx = collPrefix(vault, collection)
      const result = await client.send(new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: pfx,
      }))

      return (result.Contents ?? [])
        .map(obj => obj.Key ?? '')
        .filter(k => k.endsWith('.json'))
        .map(k => k.slice(pfx.length, -5))
    },

    async loadAll(vault) {
      const pfx = compPrefix(vault)
      const listResult = await client.send(new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: pfx,
      }))

      const snapshot: VaultSnapshot = {}

      for (const obj of listResult.Contents ?? []) {
        const key = obj.Key ?? ''
        if (!key.endsWith('.json')) continue

        const relativePath = key.slice(pfx.length)
        const parts = relativePath.split('/')
        if (parts.length !== 2) continue

        const collection = parts[0]!
        const id = parts[1]!.slice(0, -5)
        if (collection.startsWith('_')) continue

        const getResult = await client.send(new GetObjectCommand({
          Bucket: bucket,
          Key: key,
        }))

        if (!getResult.Body) continue
        const body = await getResult.Body.transformToString()

        if (!snapshot[collection]) snapshot[collection] = {}
        snapshot[collection][id] = JSON.parse(body) as EncryptedEnvelope
      }

      return snapshot
    },

    async saveAll(vault, data) {
      for (const [collection, records] of Object.entries(data)) {
        for (const [id, envelope] of Object.entries(records)) {
          await this.put(vault, collection, id, envelope)
        }
      }
    },

    async ping() {
      try {
        await client.send(new HeadBucketCommand({ Bucket: bucket }))
        return true
      } catch {
        return false
      }
    },

    /**
     * Paginate over a collection using S3's native `ContinuationToken`.
     *
     * Each page does:
     *   1. ListObjectsV2 with MaxKeys = limit and the previous token
     *   2. GetObject for every key on the page (in parallel)
     *
     * The 2-step pattern is necessary because S3 list responses don't
     * include object bodies. For very large collections this is N+1 — but
     * the parallel GETs amortize well, and consumers willing to pay for
     * stronger pagination should use a different adapter (Dynamo).
     */
    async listPage(vault, collection, cursor, limit = 100) {
      const pfx = collPrefix(vault, collection)
      const listResult = await client.send(new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: pfx,
        MaxKeys: limit,
        ...(cursor ? { ContinuationToken: cursor } : {}),
      }))

      const keys = (listResult.Contents ?? [])
        .map(obj => obj.Key ?? '')
        .filter(k => k.endsWith('.json'))

      // Fetch every body in parallel — bounded by `limit` so we never
      // fan out beyond the page size.
      const items = await Promise.all(keys.map(async (key) => {
        const id = key.slice(pfx.length, -5)
        const getResult = await client.send(new GetObjectCommand({
          Bucket: bucket,
          Key: key,
        }))
        if (!getResult.Body) return null
        const body = await getResult.Body.transformToString()
        return { id, envelope: JSON.parse(body) as EncryptedEnvelope }
      }))

      return {
        items: items.filter((x): x is { id: string; envelope: EncryptedEnvelope } => x !== null),
        nextCursor: listResult.IsTruncated && listResult.NextContinuationToken
          ? listResult.NextContinuationToken
          : null,
      }
    },
  }
}

export { s3Bundle } from './bundle.js'
export type { S3BundleOptions } from './bundle.js'
