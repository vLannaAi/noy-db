import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'
import { KMSClient, DecryptCommand } from '@aws-sdk/client-kms'
import { decodeRenderPayload } from './payload.js'
import { buildInvoiceHtml, renderPdf as defaultRenderPdf } from './render-core.js'
import { verifyShareToken } from './share-link.js'

interface FnUrlEvent { rawPath?: string; queryStringParameters?: Record<string, string | undefined> | null }
interface FnUrlResult { statusCode: number; headers?: Record<string, string>; body?: string; isBase64Encoded?: boolean }

export interface HandlerDeps {
  s3: Pick<S3Client, 'send'>
  kms: Pick<KMSClient, 'send'>
  renderPdf: (html: string) => Promise<Uint8Array>
  bucket: string
  keyId: string
  prefix: string
  shareSecret: Uint8Array
}

/** Build a Function-URL handler. Deps are injected so it unit-tests with mocks. */
export function makeHandler(deps: HandlerDeps) {
  return async function handler(event: FnUrlEvent): Promise<FnUrlResult> {
    const q = event.queryStringParameters ?? {}
    const verdict = await verifyShareToken(
      { d: q['d'], exp: q['exp'], sig: q['sig'] }, deps.shareSecret, Date.now(),
    )
    if (!verdict.ok) return { statusCode: 403, headers: { 'content-type': 'text/plain' }, body: verdict.reason }
    const docId = verdict.docId

    let sealed: Uint8Array
    try {
      const obj = (await deps.s3.send(
        new GetObjectCommand({ Bucket: deps.bucket, Key: `${deps.prefix}/${docId}` }) as never,
      )) as { Body?: { transformToByteArray(): Promise<Uint8Array> } }
      if (!obj.Body) return { statusCode: 404, headers: { 'content-type': 'text/plain' }, body: 'not found' }
      sealed = await obj.Body.transformToByteArray()
    } catch (e) {
      if (e instanceof Error && (e.name === 'NoSuchKey' || e.name === 'NotFound')) {
        return { statusCode: 404, headers: { 'content-type': 'text/plain' }, body: 'not found' }
      }
      return { statusCode: 500, headers: { 'content-type': 'text/plain' }, body: 'storage error' }
    }

    try {
      const dec = (await deps.kms.send(
        new DecryptCommand({ CiphertextBlob: sealed, KeyId: deps.keyId }) as never,
      )) as { Plaintext?: Uint8Array }
      if (!dec.Plaintext) return { statusCode: 500, headers: { 'content-type': 'text/plain' }, body: 'decrypt error' }
      const payload = decodeRenderPayload(dec.Plaintext)
      const html = await buildInvoiceHtml(payload)
      const pdf = await deps.renderPdf(html)
      return {
        statusCode: 200,
        headers: { 'content-type': 'application/pdf' },
        body: Buffer.from(pdf).toString('base64'),
        isBase64Encoded: true,
      }
    } catch {
      return { statusCode: 500, headers: { 'content-type': 'text/plain' }, body: 'render error' }
    }
  }
}

/** The deployed Lambda entry point: ambient-cred clients + the real renderPdf. */
// The share-signing secret is stored KMS-encrypted in SHARE_SECRET_CIPHERTEXT
// (base64). Module scope can't await, so decrypt it lazily on first invoke and
// cache it for the life of the warm environment.
let cachedSecret: Uint8Array | null = null
async function resolveShareSecret(kms: Pick<KMSClient, 'send'>): Promise<Uint8Array> {
  if (cachedSecret) return cachedSecret
  const blob = Buffer.from(process.env['SHARE_SECRET_CIPHERTEXT'] ?? '', 'base64')
  const out = (await kms.send(new DecryptCommand({ CiphertextBlob: blob }) as never)) as { Plaintext?: Uint8Array }
  if (!out.Plaintext) throw new Error('SHARE_SECRET_CIPHERTEXT decrypt returned no plaintext')
  cachedSecret = new Uint8Array(out.Plaintext)
  return cachedSecret
}

const s3 = new S3Client({})
const kms = new KMSClient({})
const baseDeps = {
  s3,
  kms,
  renderPdf: defaultRenderPdf,
  bucket: process.env['DOCS_BUCKET'] ?? '',
  keyId: process.env['KMS_KEY_ID'] ?? '',
  prefix: process.env['DOCS_PREFIX'] ?? 'docs',
}

export async function handler(event: FnUrlEvent): Promise<FnUrlResult> {
  const shareSecret = await resolveShareSecret(kms)
  return makeHandler({ ...baseDeps, shareSecret })(event)
}
