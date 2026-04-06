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

export interface S3Options {
  /** S3 bucket name. */
  bucket: string
  /** Key prefix within the bucket. Default: ''. */
  prefix?: string
  /** AWS region. Default: 'us-east-1'. */
  region?: string
  /** Custom endpoint (e.g., for MinIO or LocalStack). */
  endpoint?: string
}

/**
 * Create an S3 adapter.
 * Key scheme: `{prefix}/{compartment}/{collection}/{id}.json`
 */
export function s3(options: S3Options): NoydbAdapter {
  const { bucket, prefix = '' } = options

  const client = new AwsS3Client({
    ...(options.region ? { region: options.region } : {}),
    ...(options.endpoint ? { endpoint: options.endpoint, forcePathStyle: true } : {}),
  })

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
        snapshot[collection]![id] = JSON.parse(body) as EncryptedEnvelope
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
  }
}
