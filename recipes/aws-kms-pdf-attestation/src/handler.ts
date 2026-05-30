import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'
import { KMSClient, DecryptCommand } from '@aws-sdk/client-kms'
import { decodeRenderPayload } from './payload.js'
import { buildInvoiceHtml, renderPdf as defaultRenderPdf } from './render-core.js'

interface FnUrlEvent { rawPath?: string; queryStringParameters?: Record<string, string | undefined> | null }
interface FnUrlResult { statusCode: number; headers?: Record<string, string>; body?: string; isBase64Encoded?: boolean }

export interface HandlerDeps {
  s3: Pick<S3Client, 'send'>
  kms: Pick<KMSClient, 'send'>
  renderPdf: (html: string) => Promise<Uint8Array>
  bucket: string
  keyId: string
  prefix: string
}

/** Build a Function-URL handler. Deps are injected so it unit-tests with mocks. */
export function makeHandler(deps: HandlerDeps) {
  return async function handler(event: FnUrlEvent): Promise<FnUrlResult> {
    const docId = (event.queryStringParameters?.['docId'] ?? event.rawPath?.replace(/^\/+/, '') ?? '').trim()
    if (!docId) return { statusCode: 400, headers: { 'content-type': 'text/plain' }, body: 'missing docId' }

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
export const handler = makeHandler({
  s3: new S3Client({}),
  kms: new KMSClient({}),
  renderPdf: defaultRenderPdf,
  bucket: process.env['DOCS_BUCKET'] ?? '',
  keyId: process.env['KMS_KEY_ID'] ?? '',
  prefix: process.env['DOCS_PREFIX'] ?? 'docs',
})
