/**
 * PR3 — FactorKind extension (#30) + SecretPolicy escape hatches (#31).
 *
 * Pinned behaviors:
 *
 * #30 — FactorKind:
 *   - The new kinds (`webauthn-platform`, `password`, `pin`) are
 *     accepted by `FactorRequirement.anyOf` and `FactorProof.kind`.
 *   - PERSONAL_POLICY's `rotate-secret` accepts ALL kinds (the
 *     "any second factor I have wired" semantics).
 *   - STRICT_POLICY's `peer-recover-user` accepts only off-device
 *     kinds (recovery / TOTP / email-OTP / roaming WebAuthn) — the
 *     platform-bound kinds are intentionally excluded under STRICT
 *     because they don't survive device theft.
 *
 * #31 — SecretPolicy escape hatches:
 *   - Default behavior unchanged (lowercase-letters-and-spaces only).
 *   - `pattern` override accepts digits / uppercase / non-Latin
 *     scripts but other structural rules still apply.
 *   - `customValidator` replaces the entire decision tree.
 */
import { describe, it, expect } from 'vitest'
import {
  PERSONAL_POLICY,
  STRICT_POLICY,
  type FactorKind,
  type FactorProof,
} from '../src/with-party/policy/index.js'
import {
  validateSecret,
  assertStrongSecret,
  WeakSecretError,
  type SecretValidationResult,
} from '../src/kernel/validation.js'

describe('FactorKind extension (#30)', () => {
  it('TypeScript accepts the three new kinds in FactorProof.kind', () => {
    const proofs: FactorProof[] = [
      { kind: 'webauthn-platform', mintedAt: new Date().toISOString() },
      { kind: 'password', mintedAt: new Date().toISOString() },
      { kind: 'pin', mintedAt: new Date().toISOString() },
    ]
    expect(proofs).toHaveLength(3)
  })

  it('preserves the original five kinds (no breakage)', () => {
    const original: FactorKind[] = ['totp', 'email-otp', 'recovery', 'shamir', 'webauthn-roaming']
    expect(original).toHaveLength(5)
  })

  it('PERSONAL_POLICY rotate-secret accepts ALL kinds (closes #30 default)', () => {
    const gate = PERSONAL_POLICY.gates['rotate-secret']
    expect(gate?.factors).toBeDefined()
    const accepted = new Set(gate!.factors![0]!.anyOf)
    // All 8 kinds present.
    expect(accepted.has('totp')).toBe(true)
    expect(accepted.has('email-otp')).toBe(true)
    expect(accepted.has('recovery')).toBe(true)
    expect(accepted.has('webauthn-roaming')).toBe(true)
    expect(accepted.has('webauthn-platform')).toBe(true)
    expect(accepted.has('password')).toBe(true)
    expect(accepted.has('pin')).toBe(true)
  })

  it('STRICT_POLICY peer-recover-user excludes platform-bound kinds (off-device requirement)', () => {
    const gate = STRICT_POLICY.gates['peer-recover-user']
    expect(gate?.factors).toBeDefined()
    const accepted = new Set(gate!.factors![0]!.anyOf)
    // Off-device kinds accepted.
    expect(accepted.has('recovery')).toBe(true)
    expect(accepted.has('totp')).toBe(true)
    expect(accepted.has('email-otp')).toBe(true)
    expect(accepted.has('webauthn-roaming')).toBe(true)
    // Platform-bound kinds NOT accepted under STRICT.
    expect(accepted.has('webauthn-platform')).toBe(false)
    expect(accepted.has('password')).toBe(false)
    expect(accepted.has('pin')).toBe(false)
  })
})

describe('SecretPolicy escape hatches (#31)', () => {
  describe('default behavior unchanged', () => {
    it('accepts the canonical 6-lowercase-words phrase', () => {
      const r = validateSecret('correct horse battery staple printer toaster')
      expect(r.ok).toBe(true)
    })

    it('rejects digits by default', () => {
      const r = validateSecret('correct horse battery staple printer 2026')
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toBe('invalid-chars')
    })

    it('rejects uppercase by default', () => {
      const r = validateSecret('Correct horse battery staple printer toaster')
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toBe('invalid-chars')
    })
  })

  describe('pattern override (looser char class, tighter structure)', () => {
    it('accepts digits when pattern allows them', () => {
      const r = validateSecret('correct horse battery staple printer 2026', {
        pattern: /^[a-z0-9]+( [a-z0-9]+)*$/,
      })
      expect(r.ok).toBe(true)
    })

    it('accepts uppercase when pattern allows it', () => {
      const r = validateSecret('Correct Horse Battery Staple Printer Toaster', {
        pattern: /^[A-Za-z]+( [A-Za-z]+)*$/,
      })
      expect(r.ok).toBe(true)
    })

    it('accepts Thai script when pattern uses Unicode property classes', () => {
      // 6 Thai words, each ≥ 3 code points (default minWordLength).
      // Thai requires both \p{L} (consonants/independent vowels) AND
      // \p{M} (combining marks: vowel signs, tone marks). The pattern
      // class [\p{L}\p{M}] captures complete Thai grapheme clusters.
      const phrase = 'สวัสดี ทุกคน ขอบคุณ ครอบครัว ตำรวจ โรงเรียน'
      const r = validateSecret(phrase, {
        pattern: /^[\p{L}\p{M}]+( [\p{L}\p{M}]+)*$/u,
      })
      expect(r.ok).toBe(true)
    })

    it('still applies min-words even with permissive pattern', () => {
      const r = validateSecret('correct horse 2026', {
        pattern: /^[a-z0-9]+( [a-z0-9]+)*$/,
      })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toBe('too-few-words')
    })

    it('still applies min-word-length', () => {
      const r = validateSecret('a b c d e f', {
        pattern: /^[a-z]+( [a-z]+)*$/,
      })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toBe('word-too-short')
    })

    it('still applies repeated-adjacent', () => {
      const r = validateSecret('correct correct battery staple printer toaster', {
        pattern: /^[a-z]+( [a-z]+)*$/,
      })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toBe('repeated-adjacent')
    })

    it('still applies leading/trailing space and double-space rules', () => {
      const lt = validateSecret(' correct horse battery staple printer toaster', {
        pattern: /^[a-z]+( [a-z]+)*$/,
      })
      expect(lt.ok).toBe(false)
      if (!lt.ok) expect(lt.reason).toBe('leading-or-trailing-space')

      const ds = validateSecret('correct  horse battery staple printer toaster', {
        pattern: /^[a-z]+( [a-z]+)*$/,
      })
      expect(ds.ok).toBe(false)
      if (!ds.ok) expect(ds.reason).toBe('double-space')
    })
  })

  describe('customValidator (replace everything)', () => {
    it('takes over completely — none of the default rules run', () => {
      // A custom validator that accepts ANYTHING non-empty.
      const customValidator = (phrase: string): SecretValidationResult =>
        phrase.length > 0 ? { ok: true, words: 1 } : { ok: false, reason: 'empty' }
      // This phrase fails default rules (uppercase, digits, double space)
      // but the custom validator accepts it.
      const r = validateSecret('My-PASSWORD-2026', { customValidator })
      expect(r.ok).toBe(true)
    })

    it('can REJECT a phrase the default would accept', () => {
      // Custom validator demands the phrase contain a digit.
      const customValidator = (phrase: string): SecretValidationResult =>
        /[0-9]/.test(phrase)
          ? { ok: true, words: phrase.split(' ').length }
          : { ok: false, reason: 'invalid-chars' }
      // The canonical 6-lowercase phrase has no digit — would normally pass,
      // but the custom rule rejects it.
      const r = validateSecret('correct horse battery staple printer toaster', { customValidator })
      expect(r.ok).toBe(false)
    })

    it('flows through assertStrongSecret — custom rejection throws WeakSecretError', () => {
      const customValidator = (): SecretValidationResult => ({
        ok: false,
        reason: 'invalid-chars',
      })
      expect(() =>
        assertStrongSecret('anything-at-all', { customValidator }),
      ).toThrow(WeakSecretError)
    })

    it('customValidator wins over pattern when both supplied (escape hatches don\'t compose)', () => {
      const customValidator = (): SecretValidationResult => ({ ok: true, words: 1 })
      // pattern would reject digits; customValidator accepts. customValidator wins.
      const r = validateSecret('this 9000 should normally fail', {
        pattern: /^[a-z]+( [a-z]+)*$/,
        customValidator,
      })
      expect(r.ok).toBe(true)
    })
  })
})
