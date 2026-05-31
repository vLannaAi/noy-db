import { describe, it, expect, vi } from 'vitest'
import { makeHandler } from './handler.js'
import { encodeRenderPayload, type RenderPayload } from './payload.js'

const payload: RenderPayload = { docId: 'd1', fields: { invoiceNo: 'INV-1', total: 5 }, qr: 'qr-string' }

function deps(over: Partial<{ getObjectBody: Uint8Array | null }> = {}) {
  const body = 'getObjectBody' in over ? over.getObjectBody : encodeRenderPayload(payload)
  const s3 = { send: async () => {
    if (body === null) { const e = new Error('NoSuchKey'); e.name = 'NoSuchKey'; throw e }
    return { Body: { transformToByteArray: async () => body } }
  } }
  // mock KMS Decrypt = identity (our test S3 body is already plaintext).
  const kms = { send: async (cmd: { input: { CiphertextBlob: Uint8Array } }) => ({ Plaintext: cmd.input.CiphertextBlob }) }
  const renderPdf = vi.fn(async (_html: string) => new Uint8Array([0x25, 0x50, 0x44, 0x46])) // "%PDF"
  return { s3: s3 as never, kms: kms as never, renderPdf, bucket: 'b', keyId: 'k', prefix: 'docs' }
}

describe('makeHandler', () => {
  it('returns a base64 application/pdf for a known docId', async () => {
    const d = deps()
    const handler = makeHandler(d)
    const res = await handler({ rawPath: '/d1', queryStringParameters: {} })
    expect(res.statusCode).toBe(200)
    expect(res.headers!['content-type']).toBe('application/pdf')
    expect(res.isBase64Encoded).toBe(true)
    expect(d.renderPdf).toHaveBeenCalledOnce()
    expect(d.renderPdf.mock.calls[0]![0]).toContain('INV-1')
  })

  it('404 when the object is missing', async () => {
    const handler = makeHandler(deps({ getObjectBody: null }))
    const res = await handler({ rawPath: '/missing', queryStringParameters: {} })
    expect(res.statusCode).toBe(404)
  })

  it('400 when no docId is provided', async () => {
    const handler = makeHandler(deps())
    const res = await handler({ rawPath: '/', queryStringParameters: {} })
    expect(res.statusCode).toBe(400)
  })
})
