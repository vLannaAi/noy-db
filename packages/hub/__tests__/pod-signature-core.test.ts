import { describe, it, expect } from 'vitest'
import { signRecord, verifyRecord, signedBytes, POD_SIG_ALG } from '../src/with-pod/signature.js'
import { generateDocSigningKeyPair } from '@noy-db/attestation'

describe('pod signing convention', () => {
  it('round-trips and rejects tamper / wrong key / alg swap surface', async () => {
    const k = await generateDocSigningKeyPair()
    const payload = { alg: POD_SIG_ALG, keyId: k.keyId, bodySha256: 'ab'.repeat(32), formatVersion: 2 }
    const sig = await signRecord(k.privateKeyPkcs8B64, payload)
    expect(await verifyRecord(k.publicKeyB64, sig, payload)).toBe(true)
    expect(await verifyRecord(k.publicKeyB64, sig, { ...payload, bodySha256: 'cd'.repeat(32) })).toBe(false)
    expect(await verifyRecord(k.publicKeyB64, sig, { ...payload, alg: 'evil' })).toBe(false) // alg is inside signed bytes
    const other = await generateDocSigningKeyPair()
    expect(await verifyRecord(other.publicKeyB64, sig, payload)).toBe(false)
  })
  it('signedBytes is key-order-independent and rejects undefined', () => {
    expect(signedBytes({ a: 1, b: 2 })).toEqual(signedBytes({ b: 2, a: 1 }))
    expect(() => signedBytes({ a: undefined as unknown as number })).toThrow()
  })
})
