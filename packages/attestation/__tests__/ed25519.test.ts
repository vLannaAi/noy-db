import { describe, it, expect } from 'vitest'
import { generateDocSigningKeyPair, ed25519Sign, ed25519Verify } from '../src/ed25519.js'
import { utf8 } from '../src/encoding.js'

describe('Ed25519', () => {
  it('generates a keypair with a stable 16-char keyId and base64url keys', async () => {
    const kp = await generateDocSigningKeyPair()
    expect(kp.keyId).toHaveLength(16)
    expect(kp.publicKeyB64).not.toMatch(/[+/=]/)
    expect(kp.privateKeyPkcs8B64).not.toMatch(/[+/=]/)
  })
  it('sign → verify round-trips', async () => {
    const kp = await generateDocSigningKeyPair()
    const msg = utf8('hello document')
    const sig = await ed25519Sign(kp.privateKeyPkcs8B64, msg)
    expect(sig).not.toMatch(/[+/=]/)
    expect(await ed25519Verify(kp.publicKeyB64, sig, msg)).toBe(true)
  })
  it('verify fails for a different message', async () => {
    const kp = await generateDocSigningKeyPair()
    const sig = await ed25519Sign(kp.privateKeyPkcs8B64, utf8('original'))
    expect(await ed25519Verify(kp.publicKeyB64, sig, utf8('tampered'))).toBe(false)
  })
  it('verify fails for a different key', async () => {
    const a = await generateDocSigningKeyPair()
    const b = await generateDocSigningKeyPair()
    const sig = await ed25519Sign(a.privateKeyPkcs8B64, utf8('m'))
    expect(await ed25519Verify(b.publicKeyB64, sig, utf8('m'))).toBe(false)
  })
  it('the same public key yields the same keyId', async () => {
    const kp = await generateDocSigningKeyPair()
    const { keyIdFor } = await import('../src/ed25519.js')
    expect(await keyIdFor(kp.publicKeyB64)).toBe(kp.keyId)
  })
  it('returns false (does not throw) on malformed key/sig input', async () => {
    const kp = await generateDocSigningKeyPair()
    const sig = await ed25519Sign(kp.privateKeyPkcs8B64, utf8('m'))
    // malformed public key (not a valid 32-byte raw Ed25519 key)
    expect(await ed25519Verify('not-valid-base64-key', sig, utf8('m'))).toBe(false)
    // malformed signature string
    expect(await ed25519Verify(kp.publicKeyB64, 'AA', utf8('m'))).toBe(false)
  })
})
