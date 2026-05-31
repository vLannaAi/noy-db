import { describe, it, expect, vi } from 'vitest'
import { makeHandler } from './handler.js'
import { mintShareLink } from './share-link.js'
import { encodeRenderPayload, type RenderPayload } from './payload.js'

const payload: RenderPayload = { docId: 'd1', fields: { invoiceNo: 'INV-1', total: 5 }, qr: 'qr-string' }
const SHARE_SECRET = new Uint8Array(32).fill(3)

function deps(over: Partial<{ getObjectBody: Uint8Array | null }> = {}) {
  const body = 'getObjectBody' in over ? over.getObjectBody : encodeRenderPayload(payload)
  const s3 = { send: async () => {
    if (body === null) { const e = new Error('NoSuchKey'); e.name = 'NoSuchKey'; throw e }
    return { Body: { transformToByteArray: async () => body } }
  } }
  const kms = { send: async (cmd: { input: { CiphertextBlob: Uint8Array } }) => ({ Plaintext: cmd.input.CiphertextBlob }) }
  const renderPdf = vi.fn(async (_html: string) => new Uint8Array([0x25, 0x50, 0x44, 0x46]))
  return { s3: s3 as never, kms: kms as never, renderPdf, bucket: 'b', keyId: 'k', prefix: 'docs', shareSecret: SHARE_SECRET }
}

// Build a Function-URL event from a minted link's query string.
async function eventForValidLink(docId: string) {
  const url = await mintShareLink(docId, { secret: SHARE_SECRET, baseUrl: 'https://fn/' })
  const q = new URL(url).searchParams
  return { rawPath: '/', queryStringParameters: { d: q.get('d')!, exp: q.get('exp')!, sig: q.get('sig')! } }
}

describe('makeHandler — token-gated (path closure)', () => {
  it('200 application/pdf for a valid signed link; renderPdf receives the doc fields', async () => {
    const d = deps()
    const res = await makeHandler(d)(await eventForValidLink('d1'))
    expect(res.statusCode).toBe(200)
    expect(res.headers!['content-type']).toBe('application/pdf')
    expect(res.isBase64Encoded).toBe(true)
    expect(d.renderPdf).toHaveBeenCalledOnce()
    expect(d.renderPdf.mock.calls[0]![0]).toContain('INV-1')
  })

  it('403 + render NOT invoked when there is no token (bare docId is rejected)', async () => {
    const d = deps()
    const res = await makeHandler(d)({ rawPath: '/d1', queryStringParameters: { docId: 'd1' } } as never)
    expect(res.statusCode).toBe(403)
    expect(d.renderPdf).not.toHaveBeenCalled()
  })

  it('403 for a bad signature', async () => {
    const d = deps()
    const ev = await eventForValidLink('d1')
    ev.queryStringParameters.sig = 'AAAA'
    const res = await makeHandler(d)(ev)
    expect(res.statusCode).toBe(403)
    expect(d.renderPdf).not.toHaveBeenCalled()
  })

  it('404 when a validly-linked doc is missing from S3', async () => {
    const d = deps({ getObjectBody: null })
    const res = await makeHandler(d)(await eventForValidLink('d1'))
    expect(res.statusCode).toBe(404)
  })
})
