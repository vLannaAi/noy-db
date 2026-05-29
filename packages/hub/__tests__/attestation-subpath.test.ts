import { describe, it, expect } from 'vitest'

describe('@noy-db/hub/attestation subpath', () => {
  it('re-exports issue + verify surface', async () => {
    const mod = await import('../src/attestation/index.js')
    expect(typeof mod.issueAttestationCore).toBe('function')
    expect(typeof mod.verifyAttestation).toBe('function')
    expect(typeof mod.decodeQr).toBe('function')
    expect(typeof mod.AttestationError).toBe('function')
    expect(() => { throw new mod.AttestationError('x') }).toThrow(/x/)
  })
})
