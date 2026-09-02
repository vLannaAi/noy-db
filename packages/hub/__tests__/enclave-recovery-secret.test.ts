/**
 * #1316 — the recovery secret is minted by the enclave barrel, not by
 * `recovery.ts` calling `crypto.getRandomValues(new Uint8Array(32))` itself.
 *
 * That line sized the secret and picked the RNG from outside the fork-swap
 * contract, so a fork enclave (hardware RNG, a post-quantum wrap wanting a
 * different length) had no say over it. The Shamir provider splits byte-wise
 * at any length, so the barrel owning this is safe without touching
 * `@noy-db/on-shamir`.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { generateRecoverySecret } from '../src/kernel/enclave/index.js'

describe('generateRecoverySecret — enclave-owned recovery secret', () => {
  it('returns 32 bytes in the reference enclave', () => {
    const s = generateRecoverySecret()
    expect(s).toBeInstanceOf(Uint8Array)
    expect(s.length).toBe(32)
  })

  it('returns fresh material on every call', () => {
    const a = generateRecoverySecret()
    const b = generateRecoverySecret()
    expect(a).not.toEqual(b)
    expect(a.some((x) => x !== 0)).toBe(true)
  })

  it('recovery.ts no longer calls crypto.getRandomValues directly', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../src/with-party/team/recovery.ts', import.meta.url)),
      'utf8',
    )
    expect(src).not.toMatch(/getRandomValues/)
    expect(src).toMatch(/generateRecoverySecret\(\)/)
  })
})
