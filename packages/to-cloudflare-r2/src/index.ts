/**
 * **@noy-db/to-cloudflare-r2** — Cloudflare R2 adapter for noy-db.
 *
 * R2 is S3-API-compatible, so this package is a thin factory that
 * configures `@noy-db/to-aws-s3` to point at the R2 endpoint and
 * pass the R2-specific access key signature. Every capability,
 * behavior, and pagination detail of `s3()` applies verbatim.
 *
 * ## Why R2 for noy-db?
 *
 * - **Zero egress fees** — backup/archive workflows that stream the
 *   whole vault on a schedule cost nothing to read back.
 * - **S3-compatible** — no new API surface; same SDK, same commands.
 * - **Workers edge** — pair with `@noy-db/to-cloudflare-d1` for a
 *   pure-edge noy-db deployment.
 *
 * ## Account-id vs endpoint
 *
 * The simplest configuration passes your Cloudflare account id and
 * the bucket name:
 *
 * ```ts
 * import { r2 } from '@noy-db/to-cloudflare-r2'
 *
 * const store = r2({
 *   accountId: 'abc123…',       // Cloudflare dashboard → R2 → account id
 *   bucket: 'my-noydb-bucket',
 *   accessKeyId: process.env.R2_ACCESS_KEY_ID!,
 *   secretAccessKey: process.env.R2_SECRET!,
 * })
 * ```
 *
 * Consumers who already have a configured `S3Client` (common in Workers
 * / multi-region setups) can pass it via `client`; the rest of the
 * options are ignored.
 *
 * @packageDocumentation
 */

import type { NoydbStore } from '@noy-db/hub'
import type { S3Client, S3ClientConfig } from '@aws-sdk/client-s3'
import { S3Client as RealS3Client } from '@aws-sdk/client-s3'
import { s3 } from '@noy-db/to-aws-s3'

export interface R2Options {
  /** Cloudflare account id (from the R2 dashboard). Required unless `client` is supplied. */
  readonly accountId?: string
  /** R2 bucket name. */
  readonly bucket: string
  /** Key prefix within the bucket. Default `''`. */
  readonly prefix?: string
  /**
   * R2 access key id. Required unless `client` is supplied. Prefer
   * short-lived credentials via the account's API token flow.
   */
  readonly accessKeyId?: string
  /** R2 secret access key. Required unless `client` is supplied. */
  readonly secretAccessKey?: string
  /**
   * Pre-built S3Client — overrides every other authentication option.
   * Use this when you already share an R2-pointed client across adapters
   * or run in Cloudflare Workers with an injected binding.
   */
  readonly client?: S3Client
  /** Override the endpoint. Default derived from `accountId`. */
  readonly endpoint?: string
}

const R2_REGION = 'auto'

/**
 * Build the default R2 endpoint URL for a Cloudflare account.
 * The public form is documented as:
 *   `https://<accountId>.r2.cloudflarestorage.com`
 */
export function r2EndpointFor(accountId: string): string {
  return `https://${accountId}.r2.cloudflarestorage.com`
}

/**
 * Create a noy-db store backed by Cloudflare R2. Delegates to
 * `@noy-db/to-aws-s3`'s `s3()` with R2-specific endpoint + region
 * configured.
 */
export function r2(options: R2Options): NoydbStore {
  if (options.client) {
    const opts: Parameters<typeof s3>[0] = {
      bucket: options.bucket,
      ...(options.prefix !== undefined && { prefix: options.prefix }),
      client: options.client,
    }
    return s3(opts)
  }

  if (!options.accountId) {
    throw new Error('@noy-db/to-cloudflare-r2: provide either `client` or `accountId`.')
  }
  if (!options.accessKeyId || !options.secretAccessKey) {
    throw new Error('@noy-db/to-cloudflare-r2: `accessKeyId` and `secretAccessKey` are required (unless `client` is supplied).')
  }

  const endpoint = options.endpoint ?? r2EndpointFor(options.accountId)
  const config: S3ClientConfig = {
    region: R2_REGION,
    endpoint,
    credentials: {
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
    },
    forcePathStyle: true,
  }
  const built = new RealS3Client(config)
  const opts: Parameters<typeof s3>[0] = {
    bucket: options.bucket,
    ...(options.prefix !== undefined && { prefix: options.prefix }),
    client: built,
  }
  return { ...s3(opts), name: 'cloudflare-r2' }
}
