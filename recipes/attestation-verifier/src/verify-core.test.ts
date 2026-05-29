import { describe, it, expect } from 'vitest'
import { verifyDocument } from './verify-core.js'
import {
  generateDocSigningKeyPair, computeFieldHashes, signPayloadCore, encodeQr,
  signRevocationList, bytesToB64url,
  type AttestationFieldSchema, type QrPayload,
} from '@noy-db/attestation'

const fieldSchema: AttestationFieldSchema = {
  fields: [
    { path: 'invoiceNo', normalize: 'alnum-upper' },
    { path: 'total', normalize: 'cents' },
    { path: 'issueDate', normalize: 'iso-date' },
  ],
}
const record = { invoiceNo: 'INV-1', total: '1234.5', issueDate: '2026-05-29' }
const DOC = '01J0000000000000000000000A'

async function mint(
  signer: { keyId: string; privateKeyPkcs8B64: string },
  rec: Record<string, unknown> = record,
  docId = DOC,
): Promise<string> {
  const salt = bytesToB64url(crypto.getRandomValues(new Uint8Array(16)))
  const fieldHashes = await computeFieldHashes(salt, fieldSchema, rec)
  const sig = await signPayloadCore({ v: 1, docId, salt, keyId: signer.keyId, fieldHashes }, signer.privateKeyPkcs8B64)
  const payload: QrPayload = { v: 1, docId, salt, alg: 'ed25519', keyId: signer.keyId, fieldHashes, sig }
  return encodeQr(payload)
}

describe('verifyDocument', () => {
  it('authentic-valid for correct fields, no revocation list', async () => {
    const k = await generateDocSigningKeyPair()
    const qr = await mint(k)
    const v = await verifyDocument(qr, record, { publicKeys: { [k.keyId]: k.publicKeyB64 }, fieldSchema })
    expect(v.outcome).toBe('authentic-valid')
    expect(v.revocationTrusted).toBeNull()
    expect(v.perField.every((f) => f.match)).toBe(true)
  })

  it('altered when a field differs — localizes which', async () => {
    const k = await generateDocSigningKeyPair()
    const qr = await mint(k)
    const v = await verifyDocument(qr, { ...record, total: '9999' }, { publicKeys: { [k.keyId]: k.publicKeyB64 }, fieldSchema })
    expect(v.outcome).toBe('altered')
    expect(v.perField.find((f) => f.path === 'total')!.match).toBe(false)
    expect(v.perField.find((f) => f.path === 'invoiceNo')!.match).toBe(true)
  })

  it('authentic-revoked when a trusted list contains the docId', async () => {
    const k = await generateDocSigningKeyPair()
    const qr = await mint(k)
    const list = await signRevocationList([DOC], '2026-05-29T00:00:00.000Z', k.keyId, k.privateKeyPkcs8B64)
    const v = await verifyDocument(qr, record, { publicKeys: { [k.keyId]: k.publicKeyB64 }, fieldSchema, revocationList: list })
    expect(v.outcome).toBe('authentic-revoked')
    expect(v.revocationTrusted).toBe(true)
  })

  it('rotation-safe: keyId selects among multiple bundled keys', async () => {
    const k1 = await generateDocSigningKeyPair()
    const k2 = await generateDocSigningKeyPair()
    const qr = await mint(k1)
    const v = await verifyDocument(qr, record, { publicKeys: { [k1.keyId]: k1.publicKeyB64, [k2.keyId]: k2.publicKeyB64 }, fieldSchema })
    expect(v.outcome).toBe('authentic-valid')
  })

  it('unknown-key when the QR keyId is not bundled', async () => {
    const k = await generateDocSigningKeyPair()
    const other = await generateDocSigningKeyPair()
    const qr = await mint(k)
    const v = await verifyDocument(qr, record, { publicKeys: { [other.keyId]: other.publicKeyB64 }, fieldSchema })
    expect(v.outcome).toBe('unknown-key')
  })

  it('signature-invalid when keyId is known but the signature does not match', async () => {
    const k1 = await generateDocSigningKeyPair()
    const k2 = await generateDocSigningKeyPair()
    const qr = await mint(k1)
    // k1's keyId is present, but its slot holds k2's public key → sig invalid
    const v = await verifyDocument(qr, record, { publicKeys: { [k1.keyId]: k2.publicKeyB64 }, fieldSchema })
    expect(v.outcome).toBe('signature-invalid')
  })

  it('unreadable-qr for a malformed QR string', async () => {
    const k = await generateDocSigningKeyPair()
    const v = await verifyDocument('this-is-not-a-qr', record, { publicKeys: { [k.keyId]: k.publicKeyB64 }, fieldSchema })
    expect(v.outcome).toBe('unreadable-qr')
  })

  it('untrusted revocation list never marks a valid doc revoked', async () => {
    const k = await generateDocSigningKeyPair()
    const wrong = await generateDocSigningKeyPair()
    const qr = await mint(k)
    const badList = await signRevocationList([DOC], '2026-05-29T00:00:00.000Z', k.keyId, wrong.privateKeyPkcs8B64)
    const v = await verifyDocument(qr, record, { publicKeys: { [k.keyId]: k.publicKeyB64 }, fieldSchema, revocationList: badList })
    expect(v.outcome).toBe('authentic-valid')
    expect(v.revocationTrusted).toBe(false)
  })
})
