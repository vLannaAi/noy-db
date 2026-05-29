import { describe, it, expect } from 'vitest'
import { isRevoked, verifyRevocationList, signRevocationList } from '../src/revocation.js'
import { generateDocSigningKeyPair } from '../src/ed25519.js'

describe('revocation', () => {
  it('isRevoked checks membership', () => {
    const list = { v: 1 as const, revokedDocIds: ['a', 'b'], asOf: '2026-06-01T00:00:00Z', keyId: 'k', sig: 'x' }
    expect(isRevoked('a', list)).toBe(true)
    expect(isRevoked('z', list)).toBe(false)
  })
  it('signRevocationList → verifyRevocationList round-trips', async () => {
    const kp = await generateDocSigningKeyPair()
    const list = await signRevocationList(['01J0DOC0001', '01J0DOC0002'], '2026-06-01T00:00:00Z', kp.keyId, kp.privateKeyPkcs8B64)
    expect(await verifyRevocationList(list, kp.publicKeyB64)).toBe(true)
  })
  it('verifyRevocationList fails on tamper', async () => {
    const kp = await generateDocSigningKeyPair()
    const list = await signRevocationList(['01J0DOC0001'], '2026-06-01T00:00:00Z', kp.keyId, kp.privateKeyPkcs8B64)
    const tampered = { ...list, revokedDocIds: [...list.revokedDocIds, '01J0EVIL'] }
    expect(await verifyRevocationList(tampered, kp.publicKeyB64)).toBe(false)
  })
  it('fails closed on malformed lists (no raw TypeError)', async () => {
    const kp = await generateDocSigningKeyPair()
    // missing/!array revokedDocIds — must not throw
    const bad = { v: 1, asOf: '2026-06-01T00:00:00Z', keyId: 'k', sig: 'x' } as unknown as Parameters<typeof isRevoked>[1]
    expect(isRevoked('a', bad)).toBe(false)
    expect(await verifyRevocationList(bad, kp.publicKeyB64)).toBe(false)
    // null list — must not throw
    expect(isRevoked('a', null as unknown as Parameters<typeof isRevoked>[1])).toBe(false)
    expect(await verifyRevocationList(null as unknown as Parameters<typeof verifyRevocationList>[0], kp.publicKeyB64)).toBe(false)
  })
})
