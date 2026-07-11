import { describe, it, expect } from 'vitest'
import { classified } from '../../src/shape/via-classified/presets.js'
import { resolveClassifiedFields } from '../../src/shape/via-classified/resolve.js'
import { enforceClassifiedWrite } from '../../src/shape/via-classified/write.js'
import { ClassifiedConfigError, ClassifiedVerifyError, ClassifiedRotationError } from '../../src/kernel/errors.js'
import * as classifiedBarrel from '../../src/shape/via-classified/index.js'
import * as rootBarrel from '../../src/index.js'

describe('classified.password()', () => {
  it('is digest-only, omit-listed, password-normalized, with policy knobs', () => {
    const spec = classified.password({ minLength: 12, rotateDays: 90, notLastN: 3 })
    expect(spec.storage).toBe('digest-only')
    expect(spec.list).toEqual({ kind: 'omit' })
    expect(spec.verifyNormalize).toBe('password')
    expect(spec.rotateDays).toBe(90)
    expect(spec.notLastN).toBe(3)
    expect(spec.validate?.('short')).toMatch(/at least 12/)
    expect(spec.validate?.('long-enough-pw!')).toBeNull()
  })

  it('defaults minLength 10 and caps notLastN at 8', () => {
    const spec = classified.password()
    expect(spec.validate?.('123456789')).not.toBeNull()
    expect(spec.validate?.('1234567890')).toBeNull()
    expect(() => classified.password({ notLastN: 9 })).toThrow(/0\.\.8/)
    expect(() => classified.password({ notLastN: -1 })).toThrow(/0\.\.8/)
  })
})

describe('classified.secretAnswer()', () => {
  it('is digest-only, groupable, non-empty-post-normalization', () => {
    const spec = classified.secretAnswer()
    expect(spec.storage).toBe('digest-only')
    expect(spec.verifyGroupMember).toBe(true)
    expect(spec.verifyNormalize).toBe('secret-answer')
    expect(spec.validate?.('   ')).not.toBeNull()
    expect(spec.validate?.(' Fluffy ')).toBeNull()
  })
})

describe('R5 — storage forms mutually exclusive per field', () => {
  it('a field claimed under two forms is refused with a form-exclusivity message', () => {
    expect(() => resolveClassifiedFields('users', {
      password: classified.password(),
      grp: { _noydbClassifiedGroup: true, preset: 'g', members: { password: classified.secretAnswer() } },
    })).toThrow(ClassifiedConfigError)
  })
})

describe('null-clear passes the write seam', () => {
  it('enforceClassifiedWrite skips validators for null on a digest-only field', () => {
    const byField = { password: classified.password() }
    expect(() => enforceClassifiedWrite({ password: null }, byField, 'users')).not.toThrow()
    // but null on a recoverable field still validates as before
    const rec = { email: classified.email() }
    expect(() => enforceClassifiedWrite({ email: null }, rec, 'users')).toThrow()
  })
})

describe('barrel exports', () => {
  it('classified subpath + root barrel export the stage-2 errors', () => {
    expect(classifiedBarrel.ClassifiedVerifyError).toBe(ClassifiedVerifyError)
    expect(classifiedBarrel.ClassifiedRotationError).toBe(ClassifiedRotationError)
    expect((rootBarrel as Record<string, unknown>).ClassifiedVerifyError).toBe(ClassifiedVerifyError)
    expect((rootBarrel as Record<string, unknown>).ClassifiedRotationError).toBe(ClassifiedRotationError)
  })
})
