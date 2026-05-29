import { describe, it, expect } from 'vitest'
import { signPayloadCore, verifyAttestation } from '../src/verify.js'
import { computeFieldHashes } from '../src/hashing.js'
import { generateDocSigningKeyPair } from '../src/ed25519.js'
import { encodeQr } from '../src/qr.js'
import type { QrPayload } from '../src/qr.js'
import type { AttestationFieldSchema } from '../src/types.js'

const schema: AttestationFieldSchema = {
  fields: [
    { path: 'invoiceNo', normalize: 'alnum-upper' },
    { path: 'total', normalize: 'cents' },
    { path: 'issueDate', normalize: 'iso-date' },
  ],
}
const fields = { invoiceNo: 'INV-1001', total: 1234.5, issueDate: '2026-05-29' }

async function issue() {
  const kp = await generateDocSigningKeyPair()
  const salt = 'c2FsdHNhbHRzYWx0c2Fs'
  const docId = '01J0DOC0001'
  const fieldHashes = await computeFieldHashes(salt, schema, fields)
  const sig = await signPayloadCore({ v: 1, docId, salt, keyId: kp.keyId, fieldHashes }, kp.privateKeyPkcs8B64)
  const payload: QrPayload = { v: 1, docId, salt, alg: 'ed25519', keyId: kp.keyId, fieldHashes, sig }
  return { kp, payload, qr: encodeQr(payload), salt, docId }
}

describe('verifyAttestation', () => {
  it('valid: matching fields + correct key → valid', async () => {
    const { kp, qr } = await issue()
    const r = await verifyAttestation({ qr, claimedFields: fields, fieldSchema: schema, publicKeys: { [kp.keyId]: kp.publicKeyB64 } })
    expect(r.valid).toBe(true)
    expect(r.signatureValid).toBe(true)
    expect(r.perField.every((f) => f.match)).toBe(true)
    expect(r.revoked).toBeNull()
  })
  it('localizes a single altered field', async () => {
    const { kp, qr } = await issue()
    const r = await verifyAttestation({ qr, claimedFields: { ...fields, total: 9999.0 }, fieldSchema: schema, publicKeys: { [kp.keyId]: kp.publicKeyB64 } })
    expect(r.valid).toBe(false)
    expect(r.signatureValid).toBe(true)
    expect(r.perField.find((f) => f.path === 'total')!.match).toBe(false)
    expect(r.perField.find((f) => f.path === 'invoiceNo')!.match).toBe(true)
    expect(r.reason).toMatch(/field/)
  })
  it('forged QR (attacker key not in publicKeys) → signatureValid false', async () => {
    const { qr } = await issue()
    const attacker = await generateDocSigningKeyPair()
    const r = await verifyAttestation({ qr, claimedFields: fields, fieldSchema: schema, publicKeys: { [attacker.keyId]: attacker.publicKeyB64 } })
    expect(r.signatureValid).toBe(false)
    expect(r.valid).toBe(false)
    expect(r.reason).toMatch(/keyId/)
  })
  it('schema/payload field-count mismatch → invalid', async () => {
    const { kp, qr } = await issue()
    const shortSchema: AttestationFieldSchema = { fields: [{ path: 'invoiceNo', normalize: 'alnum-upper' }] }
    const r = await verifyAttestation({ qr, claimedFields: fields, fieldSchema: shortSchema, publicKeys: { [kp.keyId]: kp.publicKeyB64 } })
    expect(r.valid).toBe(false)
    expect(r.reason).toMatch(/count/)
  })
  it('revoked docId → valid false, revoked true', async () => {
    const { kp, qr, docId } = await issue()
    const r = await verifyAttestation({
      qr, claimedFields: fields, fieldSchema: schema, publicKeys: { [kp.keyId]: kp.publicKeyB64 },
      revocation: { list: { v: 1, revokedDocIds: [docId], asOf: '2026-06-01T00:00:00Z', keyId: kp.keyId, sig: 'x' } },
    })
    expect(r.revoked).toBe(true)
    expect(r.valid).toBe(false)
    expect(r.reason).toMatch(/revoked/)
  })
})
