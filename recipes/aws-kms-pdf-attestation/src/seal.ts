import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { awsKmsSealingProvider } from '@noy-db/at-aws-kms'
import { encodeRenderPayload, type RenderPayload } from './payload.js'

export interface SealAndUploadOptions {
  keyId: string
  bucket: string
  key: string
  /** DI for tests. Defaults to ambient-cred clients. */
  kmsClient?: { send: (cmd: unknown) => Promise<unknown> }
  s3Client?: Pick<S3Client, 'send'>
}

/**
 * Firm-side (hub context): seal a RenderPayload with the firm's KMS key via
 * at-aws-kms and upload the ciphertext to S3. The render Lambda later decrypts
 * + renders it. This is the @noy-db/at-aws-kms feature in action.
 */
export async function sealAndUpload(payload: RenderPayload, opts: SealAndUploadOptions): Promise<void> {
  const sealer = awsKmsSealingProvider({ keyId: opts.keyId, client: opts.kmsClient as never })
  const sealed = await sealer.seal(encodeRenderPayload(payload))
  const s3 = opts.s3Client ?? new S3Client({})
  await s3.send(new PutObjectCommand({ Bucket: opts.bucket, Key: opts.key, Body: sealed }) as never)
}
