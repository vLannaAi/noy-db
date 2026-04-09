import type { NoydbAdapter, EncryptedEnvelope, CompartmentSnapshot } from '@noy-db/core'
import { ConflictError } from '@noy-db/core'
import {
  S3Client as AwsS3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  HeadBucketCommand,
} from '@aws-sdk/client-s3'

/**
 * Minimal interface for an S3 client. Compatible with @aws-sdk/client-s3's
 * S3Client. Exposed so tests (and advanced consumers) can inject a mock or
 * a pre-configured client without going through the default constructor.
 */
export interface S3ClientLike {
  send(command: unknown): Promise<unknown>
}

export interface S3Options {
  /** S3 bucket name. */
  bucket: string
  /** Key prefix within the bucket. Default: ''. */
  prefix?: string
  /** AWS region. Default: 'us-east-1'. */
  region?: string
  /** Custom endpoint (e.g., for MinIO or LocalStack). */
  endpoint?: string
  /**
   * Pre-built S3 client. If provided, the adapter uses this client
   * directly and ignores `region` / `endpoint`. Useful for tests and
   * for apps that want to share a client across adapters.
   */
  client?: S3ClientLike
}

/**
 * Create an S3 adapter.
 * Key scheme: `{prefix}/{compartment}/{collection}/{id}.json`
 */
export function s3(options: S3Options): NoydbAdapter {
  const { bucket, prefix = '' } = options

  // Use the injected client if provided (tests, advanced consumers).
  // The cast through `S3ClientLike` is safe because the AWS S3Client's
  // `send()` method matches the structural shape — we only call `send`
  // and inspect the documented response fields.
  const client = (options.client ?? new AwsS3Client({
    ...(options.region ? { region: options.region } : {}),
    ...(options.endpoint ? { endpoint: options.endpoint, forcePathStyle: true } : {}),
  })) as AwsS3Client

  function objectKey(compartment: string, collection: string, id: string): string {
    const parts = [compartment, collection, `${id}.json`]
    return prefix ? `${prefix}/${parts.join('/')}` : parts.join('/')
  }

  function collPrefix(compartment: string, collection: string): string {
    const parts = [compartment, collection, '']
    return prefix ? `${prefix}/${parts.join('/')}` : parts.join('/')
  }

  function compPrefix(compartment: string): string {
    return prefix ? `${prefix}/${compartment}/` : `${compartment}/`
  }

  return {
    name: 's3',

    async get(compartment, collection, id) {
      try {
        const result = await client.send(new GetObjectCommand({
          Bucket: bucket,
          Key: objectKey(compartment, collection, id),
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

    async put(compartment, collection, id, envelope, expectedVersion) {
      if (expectedVersion !== undefined) {
        const existing = await this.get(compartment, collection, id)
        if (existing && existing._v !== expectedVersion) {
          throw new ConflictError(existing._v, `Version conflict: expected ${expectedVersion}, found ${existing._v}`)
        }
      }

      await client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: objectKey(compartment, collection, id),
        Body: JSON.stringify(envelope),
        ContentType: 'application/json',
      }))
    },

    async delete(compartment, collection, id) {
      await client.send(new DeleteObjectCommand({
        Bucket: bucket,
        Key: objectKey(compartment, collection, id),
      }))
    },

    async list(compartment, collection) {
      const pfx = collPrefix(compartment, collection)
      const result = await client.send(new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: pfx,
      }))

      return (result.Contents ?? [])
        .map(obj => obj.Key ?? '')
        .filter(k => k.endsWith('.json'))
        .map(k => k.slice(pfx.length, -5))
    },

    async loadAll(compartment) {
      const pfx = compPrefix(compartment)
      const listResult = await client.send(new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: pfx,
      }))

      const snapshot: CompartmentSnapshot = {}

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

    async saveAll(compartment, data) {
      for (const [collection, records] of Object.entries(data)) {
        for (const [id, envelope] of Object.entries(records)) {
          await this.put(compartment, collection, id, envelope)
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
    async listPage(compartment, collection, cursor, limit = 100) {
      const pfx = collPrefix(compartment, collection)
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
