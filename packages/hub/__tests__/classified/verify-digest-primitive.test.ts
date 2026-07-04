import { describe, it, expect } from 'vitest'
import { pbkdf2VerifyDigest, VDIG_ITERATIONS } from '../../src/kernel/enclave/classify/digest.js'
import { normalizeForVerify } from '../../src/kernel/enclave/classify/normalize.js'

// Low iteration count for speed in structural tests; determinism is
// iteration-count independent. One test pins the 600K family constant.
const FAST = 1_000

describe('pbkdf2VerifyDigest', () => {
  it('returns exactly 32 bytes regardless of input length', async () => {
    const salt = new Uint8Array(32).fill(7)
    expect((await pbkdf2VerifyDigest('a', salt, FAST)).length).toBe(32)
    expect((await pbkdf2VerifyDigest('a'.repeat(500), salt, FAST)).length).toBe(32)
  })

  it('is deterministic for same value+salt+iterations, and salt-sensitive', async () => {
    const s1 = new Uint8Array(32).fill(1)
    const s2 = new Uint8Array(32).fill(2)
    const a = await pbkdf2VerifyDigest('correct horse', s1, FAST)
    const b = await pbkdf2VerifyDigest('correct horse', s1, FAST)
    const c = await pbkdf2VerifyDigest('correct horse', s2, FAST)
    expect(Buffer.from(a).toString('hex')).toBe(Buffer.from(b).toString('hex'))
    expect(Buffer.from(a).toString('hex')).not.toBe(Buffer.from(c).toString('hex'))
  })

  it('pins the family iteration constant', () => {
    expect(VDIG_ITERATIONS).toBe(600_000)
  })
})

describe('normalizeForVerify', () => {
  it('password mode is NFC-only and otherwise byte-faithful', () => {
    // U+0065 U+0301 (e + combining acute) NFC-normalizes to U+00E9
    expect(normalizeForVerify('password', 'café')).toBe('café')
    expect(normalizeForVerify('password', '  MiXeD  Case  ')).toBe('  MiXeD  Case  ')
  })

  it('secret-answer mode: NFC + casefold + trim + collapse whitespace', () => {
    expect(normalizeForVerify('secret-answer', '  Fluffy   The\tCat ')).toBe('fluffy the cat')
    expect(normalizeForVerify('secret-answer', 'CAFÉ')).toBe('café')
  })

  it('secret-answer mode: case-folding matches regardless of accents/case/whitespace', () => {
    expect(normalizeForVerify('secret-answer', '  Élan  Vital ')).toBe(
      normalizeForVerify('secret-answer', 'élan vital'),
    )
  })
})
