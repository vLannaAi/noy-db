/**
 * `@noy-db/as-aws-s3` — an {@link ObjectProjection} backed by AWS S3.
 *
 * Where `@noy-db/to-aws-s3` is a `to-*` store (ciphertext envelopes in/out, the
 * zero-knowledge backend), this is an `as-*` **projection**: it holds blob bytes
 * as **native, directly-consumable S3 objects** so they can be served straight
 * from S3/CDN — presigned (time-limited, private) or public — and processed by
 * AWS-native tooling. It sees **raw bytes** and lives **outside** the
 * zero-knowledge guarantee; wiring it to a blob field is a deliberate opt-in.
 *
 * @example
 * ```ts
 * import { asAwsS3 } from '@noy-db/as-aws-s3'
 * const objects = asAwsS3({ bucket: 'acme-public-assets', region: 'eu-west-1' })
 * await objects.putObject('logos/acme.png', bytes, { contentType: 'image/png', public: true })
 * const url = objects.publicUrl('logos/acme.png')          // stable CDN/S3 URL
 * const dl  = await objects.objectUrl('logos/acme.png')    // presigned GET
 * const up  = await objects.putUrl('videos/x.mp4', { contentType: 'video/mp4' }) // presigned PUT
 * ```
 */
import type { ObjectProjection, ObjectMeta, PutObjectOptions, ObjectUrlOptions, PutUrlOptions } from '@noy-db/hub'
import type { StoreCredentials, StoreCredentialSource } from '@noy-db/hub/to'
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

export interface AsAwsS3Options {
  /** Target bucket. */
  bucket: string
  /** Key prefix (folder). A trailing slash is added if missing. */
  prefix?: string
  /** AWS region. Default `us-east-1`. */
  region?: string
  /** Pre-built `S3Client` to share (overrides `region`). */
  client?: S3Client
  /**
   * Base URL for `publicUrl()` — a CDN origin or the bucket's website/vhost
   * URL. Defaults to the virtual-hosted S3 URL
   * (`https://{bucket}.s3.{region}.amazonaws.com`).
   */
  baseUrl?: string
  /** Default presigned-URL TTL (seconds). Default 900 (15 min). */
  defaultExpiresInSeconds?: number
  /**
   * Vendor-neutral rolling-credential hook (`@noy-db/hub`'s `StoreCredentials`
   * seam, #479). Wired as a functional `AwsCredentialIdentityProvider` so the
   * AWS SDK's own `memoizeIdentityProvider` re-invokes it at the credential's
   * expiry — this package does not run its own refresh logic on this arm.
   * Ignored when `client` is supplied (the pre-built client owns its own
   * provider). Omit to keep the ambient credential chain (default provider
   * chain / env vars / instance role).
   */
  credentials?: StoreCredentialSource
}

/** The projection plus an S3-specific stable-public-URL helper. */
export type AsAwsS3Projection = ObjectProjection & {
  /** A stable, non-expiring URL for a **public** object (CDN/vhost). */
  publicUrl(key: string): string
}

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } }
  return e?.name === 'NotFound' || e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404
}

/**
 * Maps a `kind:'aws'` {@link StoreCredentials} to the shape the AWS SDK's
 * credential provider expects. `expiration` MUST be a `Date` — the SDK's
 * `memoizeIdentityProvider` only re-invokes the provider when the returned
 * identity carries one; omitting it silently defeats rolling credentials
 * (the SDK memoizes forever). `kind:'token'` is a later slice (#479).
 */
function mapAws(creds: StoreCredentials) {
  if (creds.kind !== 'aws') {
    throw new Error(`@noy-db/as-aws-s3: credentials source returned kind '${creds.kind}' — only 'aws' is supported`)
  }
  return {
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    ...(creds.sessionToken ? { sessionToken: creds.sessionToken } : {}),
    ...(creds.expiresAt ? { expiration: new Date(creds.expiresAt) } : {}),
  }
}

export function asAwsS3(options: AsAwsS3Options): AsAwsS3Projection {
  const { bucket } = options
  const prefix = options.prefix ? options.prefix.replace(/\/+$/, '') + '/' : ''
  const region = options.region ?? 'us-east-1'
  const credentialsSource = options.credentials
  const client = options.client ?? new S3Client({
    region,
    ...(credentialsSource ? { credentials: async () => mapAws(await credentialsSource()) } : {}),
  })
  // getSignedUrl types its client against its own @smithy/types copy; when the
  // installed @aws-sdk/client-s3 and s3-request-presigner resolve to different
  // minor versions, S3Client and the expected Client diverge only on a private
  // `handlers` field. Runtime is identical — cast across the version skew.
  const presignClient = client as unknown as Parameters<typeof getSignedUrl>[0]
  const defaultExpiry = options.defaultExpiresInSeconds ?? 900
  const publicBase = (options.baseUrl ?? `https://${bucket}.s3.${region}.amazonaws.com`).replace(/\/+$/, '')
  const fullKey = (key: string): string => `${prefix}${key}`

  return {
    name: 'aws-s3',

    async putObject(key: string, bytes: Uint8Array, opts: PutObjectOptions): Promise<void> {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: fullKey(key),
          Body: bytes,
          ContentType: opts.contentType,
          ...(opts.public ? { ACL: 'public-read' as const } : {}),
          ...(opts.userMeta ? { Metadata: opts.userMeta } : {}),
        }),
      )
    },

    async getObject(key: string): Promise<Uint8Array | null> {
      try {
        const r = await client.send(new GetObjectCommand({ Bucket: bucket, Key: fullKey(key) }))
        if (!r.Body) return null
        return await r.Body.transformToByteArray()
      } catch (err) {
        if (isNotFound(err)) return null
        throw err
      }
    },

    async deleteObject(key: string): Promise<void> {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: fullKey(key) }))
    },

    async headObject(key: string): Promise<ObjectMeta | null> {
      try {
        const r = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: fullKey(key) }))
        return {
          size: r.ContentLength ?? 0,
          ...(r.ContentType ? { contentType: r.ContentType } : {}),
          ...(r.ETag ? { etag: r.ETag } : {}),
          ...(r.LastModified ? { lastModified: r.LastModified.toISOString() } : {}),
          ...(r.Metadata && Object.keys(r.Metadata).length ? { userMeta: r.Metadata } : {}),
        }
      } catch (err) {
        if (isNotFound(err)) return null
        throw err
      }
    },

    async objectUrl(key: string, opts?: ObjectUrlOptions): Promise<string> {
      // Always a presigned GET — works for private and public objects alike.
      // For a stable public URL, use `publicUrl()`.
      return await getSignedUrl(presignClient, new GetObjectCommand({ Bucket: bucket, Key: fullKey(key) }), {
        expiresIn: opts?.expiresInSeconds ?? defaultExpiry,
      })
    },

    async putUrl(key: string, opts: PutUrlOptions): Promise<string> {
      return await getSignedUrl(
        presignClient,
        new PutObjectCommand({ Bucket: bucket, Key: fullKey(key), ContentType: opts.contentType }),
        { expiresIn: opts.expiresInSeconds ?? defaultExpiry },
      )
    },

    async listPrefix(listPrefixArg: string) {
      const out: Array<{ key: string; meta: ObjectMeta }> = []
      let token: string | undefined
      do {
        const r = await client.send(
          new ListObjectsV2Command({ Bucket: bucket, Prefix: fullKey(listPrefixArg), ContinuationToken: token }),
        )
        for (const obj of r.Contents ?? []) {
          if (!obj.Key) continue
          // Strip the configured prefix so callers see logical keys.
          const logicalKey = prefix && obj.Key.startsWith(prefix) ? obj.Key.slice(prefix.length) : obj.Key
          out.push({
            key: logicalKey,
            meta: {
              size: obj.Size ?? 0,
              ...(obj.ETag ? { etag: obj.ETag } : {}),
              ...(obj.LastModified ? { lastModified: obj.LastModified.toISOString() } : {}),
            },
          })
        }
        token = r.IsTruncated ? r.NextContinuationToken : undefined
      } while (token)
      return out
    },

    publicUrl(key: string): string {
      return `${publicBase}/${fullKey(key)}`
    },
  }
}
