/**
 * **s3Bundle** — whole-vault bundle store for noy-db over Amazon S3.
 *
 * Implements the `NoydbBundleStore` contract (read/write/delete/list of whole
 * `.noydb` blobs) with optimistic concurrency via S3 conditional writes. Pairs
 * with `@noy-db/hub` snapshots (`withSnapshots({ store: s3Bundle(...) })`) and
 * with bundle-mode sync.
 *
 * Key scheme: `{prefix}/{vaultId}.noydb`. The version token is the object ETag.
 *
 * **OCC:** `writeBundle(id, bytes, expectedVersion)` —
 *   - `expectedVersion === null` → unconditional `PutObject` (first write / rolling overwrite).
 *   - `expectedVersion = <etag>` → `PutObject` with `IfMatch`; a 412 becomes `BundleVersionConflictError`.
 *
 * Requires `@aws-sdk/client-s3` ≥ 3.696 (conditional-write `IfMatch` on PutObject, GA Nov 2024).
 *
 * @packageDocumentation
 */
import type { NoydbBundleStore } from '@noy-db/hub'
import { BundleVersionConflictError } from '@noy-db/hub'
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  HeadObjectCommand,
} from '@aws-sdk/client-s3'

export interface S3BundleOptions {
  /** S3 bucket name. */
  bucket: string
  /** Key prefix within the bucket. Default ''. Keys are `{prefix}/{vaultId}.noydb`. */
  prefix?: string
  /** AWS region. Used only when `client` is not provided. Default 'us-east-1'. */
  region?: string
  /** Pre-built S3Client. If provided, `region` is ignored. */
  client?: S3Client
}

const SUFFIX = '.noydb'

function stripQuotes(etag: string | undefined): string {
  return (etag ?? '').replace(/^"|"$/g, '')
}

export function s3Bundle(options: S3BundleOptions): NoydbBundleStore {
  const { bucket, prefix = '' } = options
  const client = options.client ?? new S3Client({
    ...(options.region ? { region: options.region } : {}),
  })

  const listPrefix = prefix ? `${prefix}/` : ''
  function objectKey(vaultId: string): string {
    return `${listPrefix}${vaultId}${SUFFIX}`
  }

  return {
    kind: 'bundle',
    name: 's3',

    async readBundle(vaultId) {
      try {
        const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: objectKey(vaultId) }))
        if (!res.Body) return null
        const bytes = await (res.Body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray()
        return { bytes, version: stripQuotes(res.ETag) }
      } catch (err: unknown) {
        if (err instanceof Error && (err.name === 'NoSuchKey' || err.name === 'NotFound')) return null
        throw err
      }
    },

    async writeBundle(vaultId, bytes, expectedVersion) {
      try {
        const res = await client.send(new PutObjectCommand({
          Bucket: bucket,
          Key: objectKey(vaultId),
          Body: bytes,
          ContentType: 'application/octet-stream',
          ...(expectedVersion !== null ? { IfMatch: expectedVersion } : {}),
        }))
        let version = stripQuotes(res.ETag)
        if (!version) {
          const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: objectKey(vaultId) }))
          version = stripQuotes(head.ETag)
        }
        return { version }
      } catch (err: unknown) {
        const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
        if (err instanceof Error && (err.name === 'PreconditionFailed' || status === 412)) {
          throw new BundleVersionConflictError(
            `S3 bundle "${vaultId}" changed since expectedVersion="${expectedVersion}".`,
          )
        }
        throw err
      }
    },

    async deleteBundle(vaultId) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: objectKey(vaultId) }))
    },

    async listBundles() {
      const out: Array<{ vaultId: string; version: string; size: number }> = []
      let token: string | undefined
      do {
        const res = await client.send(new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: listPrefix,
          ...(token ? { ContinuationToken: token } : {}),
        }))
        for (const obj of res.Contents ?? []) {
          const key = obj.Key ?? ''
          if (!key.endsWith(SUFFIX)) continue
          out.push({
            vaultId: key.slice(listPrefix.length, -SUFFIX.length),
            version: stripQuotes(obj.ETag),
            size: obj.Size ?? 0,
          })
        }
        token = res.IsTruncated ? res.NextContinuationToken : undefined
      } while (token)
      return out
    },
  }
}
