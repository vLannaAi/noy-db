import { describe, it, expect } from 'vitest'
import { computeFieldHashes } from '../src/hashing.js'
import type { AttestationFieldSchema } from '../src/types.js'

const schema: AttestationFieldSchema = {
  fields: [
    { path: 'invoiceNo', normalize: 'alnum-upper' },
    { path: 'total', normalize: 'cents' },
  ],
}
const salt = 'c2FsdHNhbHRzYWx0c2Fs' // base64url, arbitrary

describe('computeFieldHashes', () => {
  it('returns one base64url hash per field, in schema order', async () => {
    const h = await computeFieldHashes(salt, schema, { invoiceNo: 'INV-1', total: 12.34 })
    expect(h).toHaveLength(2)
    for (const x of h) expect(x).not.toMatch(/[+/=]/)
  })
  it('is deterministic for the same salt+schema+values', async () => {
    const a = await computeFieldHashes(salt, schema, { invoiceNo: 'INV-1', total: 12.34 })
    const b = await computeFieldHashes(salt, schema, { invoiceNo: 'inv 1', total: '12.34' })
    expect(a).toEqual(b) // normalization makes these equal
  })
  it('changes when a field value changes', async () => {
    const a = await computeFieldHashes(salt, schema, { invoiceNo: 'INV-1', total: 12.34 })
    const b = await computeFieldHashes(salt, schema, { invoiceNo: 'INV-1', total: 99.99 })
    expect(a[0]).toBe(b[0])
    expect(a[1]).not.toBe(b[1])
  })
  it('changes when the salt changes', async () => {
    const a = await computeFieldHashes(salt, schema, { invoiceNo: 'INV-1', total: 12.34 })
    const b = await computeFieldHashes('ZGlmZmVyZW50c2FsdGRpZmY', schema, { invoiceNo: 'INV-1', total: 12.34 })
    expect(a[0]).not.toBe(b[0])
  })
  it('domain-separates fields with equal values (path is in the hash input)', async () => {
    const s2: AttestationFieldSchema = { fields: [{ path: 'a', normalize: 'trim' }, { path: 'b', normalize: 'trim' }] }
    const h = await computeFieldHashes(salt, s2, { a: 'same', b: 'same' })
    expect(h[0]).not.toBe(h[1])
  })
  it('throws when a declared field is missing from the record', async () => {
    await expect(computeFieldHashes(salt, schema, { invoiceNo: 'INV-1' })).rejects.toThrow(/missing/)
  })
})
