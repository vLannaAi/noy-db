import { describe, it, expect } from 'vitest'
import { buildInvoiceHtml } from './render-core.js'
import { decodeQr, encodeQr } from '@noy-db/attestation'
import type { RenderPayload } from './payload.js'

// A real QR string so the embedded SVG is built from a decodable payload.
const qr = encodeQr({ v: 1, docId: '01J0DEMO', salt: 'c2FsdA', alg: 'ed25519', keyId: 'k1', fieldHashes: ['h'], sig: 's' })
const payload: RenderPayload = { docId: '01J0DEMO', fields: { invoiceNo: 'INV-1042', total: 1234.5, issueDate: '2026-05-29' }, qr }

describe('buildInvoiceHtml', () => {
  it('renders every field value into the HTML', async () => {
    const html = await buildInvoiceHtml(payload)
    expect(html).toContain('INV-1042')
    expect(html).toContain('1234.5')
    expect(html).toContain('2026-05-29')
  })

  it('embeds the QR as inline vector <svg>, not a raster <img>', async () => {
    const html = await buildInvoiceHtml(payload)
    expect(html).toMatch(/<svg[\s>]/i)
    expect(html).not.toMatch(/<img[^>]+src=["']data:image\/png/i)
  })

  it('the embedded QR SVG was generated from the payload qr string', async () => {
    const html = await buildInvoiceHtml(payload)
    expect(decodeQr(payload.qr).docId).toBe('01J0DEMO')
    expect(html).toContain('<svg')
  })
})
