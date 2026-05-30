import { describe, it, expect } from 'vitest'
import { encodeRenderPayload, decodeRenderPayload, type RenderPayload } from './payload.js'

const payload: RenderPayload = {
  docId: '01J0000000000000000000DEMO',
  fields: { invoiceNo: 'INV-1042', total: 1234.5, issueDate: '2026-05-29' },
  qr: 'eyJ2IjoxfQ',
}

describe('render payload codec', () => {
  it('round-trips through encode/decode', () => {
    const bytes = encodeRenderPayload(payload)
    expect(bytes).toBeInstanceOf(Uint8Array)
    expect(decodeRenderPayload(bytes)).toEqual(payload)
  })

  it('throws when the encoded payload exceeds the 4 KB KMS plaintext limit', () => {
    const huge: RenderPayload = { ...payload, fields: { blob: 'x'.repeat(5000) } }
    expect(() => encodeRenderPayload(huge)).toThrow(/4 ?KB|4096/)
  })

  it('decode rejects malformed JSON', () => {
    expect(() => decodeRenderPayload(new TextEncoder().encode('not json'))).toThrow()
  })

  it('decode rejects a payload missing required fields', () => {
    const bad = new TextEncoder().encode(JSON.stringify({ docId: 'x' }))
    expect(() => decodeRenderPayload(bad)).toThrow(/docId|fields|qr|shape/)
  })
})
