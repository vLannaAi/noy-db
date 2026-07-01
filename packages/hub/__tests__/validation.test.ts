import { describe, it, expect } from 'vitest'
import {
  validatePassphrase,
  assertStrongPassphrase,
  estimateEntropy,
  WeakPassphraseError,
} from '../src/validation.js'
import {
  NoydbError,
  DecryptionError,
  TamperedError,
  InvalidKeyError,
  NoAccessError,
  ReadOnlyError,
  PermissionDeniedError,
  ConflictError,
  NetworkError,
  NotFoundError,
  ValidationError,
} from '../src/kernel/errors.js'

describe('validatePassphrase (phrase format)', () => {
  it('accepts well-formed 6-word phrases', () => {
    expect(validatePassphrase('correct horse battery staple printer toaster')).toEqual({
      ok: true,
      words: 6,
    })
    expect(
      validatePassphrase('glasses cabinet bicycle umbrella thunder velvet'),
    ).toEqual({ ok: true, words: 6 })
  })

  it('rejects too-few-words', () => {
    const r = validatePassphrase('correct horse battery staple printer')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe('too-few-words')
      expect(r.minimum).toBe(6)
      expect(r.got).toBe(5)
    }
  })

  it('rejects empty', () => {
    const r = validatePassphrase('')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('empty')
  })

  it('rejects uppercase', () => {
    const r = validatePassphrase('Correct horse battery staple printer toaster')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('invalid-chars')
  })

  it('rejects punctuation / digits / symbols', () => {
    expect((validatePassphrase('correct horse battery staple printer toaster!') as { reason: string }).reason).toBe(
      'invalid-chars',
    )
    expect((validatePassphrase('correct horse battery staple printer toaster1') as { reason: string }).reason).toBe(
      'invalid-chars',
    )
    expect((validatePassphrase('correct-horse-battery-staple-printer-toaster') as { reason: string }).reason).toBe(
      'invalid-chars',
    )
  })

  it('rejects double space', () => {
    const r = validatePassphrase('correct  horse battery staple printer toaster')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('double-space')
  })

  it('rejects leading and trailing space', () => {
    expect((validatePassphrase(' correct horse battery staple printer toaster') as { reason: string }).reason).toBe(
      'leading-or-trailing-space',
    )
    expect((validatePassphrase('correct horse battery staple printer toaster ') as { reason: string }).reason).toBe(
      'leading-or-trailing-space',
    )
  })

  it('rejects words shorter than minimum', () => {
    const r = validatePassphrase('correct horse battery staple printer is')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe('word-too-short')
      expect(r.minimum).toBe(3)
    }
  })

  it('rejects repeated adjacent words', () => {
    const r = validatePassphrase('correct horse battery staple printer the the')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('repeated-adjacent')
  })

  it('honours strict policy (minWords: 8)', () => {
    const r = validatePassphrase('correct horse battery staple printer toaster', { minWords: 8 })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe('too-few-words')
      expect(r.minimum).toBe(8)
    }

    expect(
      validatePassphrase('correct horse battery staple printer toaster glasses cabinet', {
        minWords: 8,
      }),
    ).toEqual({ ok: true, words: 8 })
  })

  it('rejectRepeatedAdjacent=false allows "the the"', () => {
    expect(
      validatePassphrase('correct horse battery staple printer the the', {
        rejectRepeatedAdjacent: false,
      }),
    ).toEqual({ ok: true, words: 7 })
  })
})

describe('assertStrongPassphrase', () => {
  it('throws WeakPassphraseError on weak input', () => {
    expect(() => assertStrongPassphrase('abc')).toThrow(WeakPassphraseError)
  })

  it('passes on strong phrase', () => {
    expect(() =>
      assertStrongPassphrase('correct horse battery staple printer toaster'),
    ).not.toThrow()
  })

  it('allowWeakPassphrase: true bypasses (test fixtures)', () => {
    expect(() => assertStrongPassphrase('abc', { allowWeakPassphrase: true })).not.toThrow()
  })

  it('exposes machine-readable reason', () => {
    try {
      assertStrongPassphrase('abc')
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(WeakPassphraseError)
      if (err instanceof WeakPassphraseError) {
        expect(err.reason).toBe('too-few-words')
        expect(err.code).toBe('WEAK_PASSPHRASE')
      }
    }
  })
})

describe('estimateEntropy', () => {
  it('returns ~77 bits for a 6-word phrase', () => {
    const e = estimateEntropy('correct horse battery staple printer toaster')
    expect(e).toBeGreaterThanOrEqual(76)
    expect(e).toBeLessThanOrEqual(78)
  })

  it('returns 0 for ill-formed phrases', () => {
    expect(estimateEntropy('Ab1!')).toBe(0)
    expect(estimateEntropy('correct  horse battery staple printer toaster')).toBe(0)
  })
})

describe('error hierarchy', () => {
  const errors = [
    { Class: DecryptionError, code: 'DECRYPTION_FAILED', name: 'DecryptionError' },
    { Class: TamperedError, code: 'TAMPERED', name: 'TamperedError' },
    { Class: InvalidKeyError, code: 'INVALID_KEY', name: 'InvalidKeyError' },
    { Class: NoAccessError, code: 'NO_ACCESS', name: 'NoAccessError' },
    { Class: ReadOnlyError, code: 'READ_ONLY', name: 'ReadOnlyError' },
    { Class: PermissionDeniedError, code: 'PERMISSION_DENIED', name: 'PermissionDeniedError' },
    { Class: NetworkError, code: 'NETWORK_ERROR', name: 'NetworkError' },
    { Class: NotFoundError, code: 'NOT_FOUND', name: 'NotFoundError' },
    { Class: ValidationError, code: 'VALIDATION_ERROR', name: 'ValidationError' },
  ]

  for (const { Class, code, name } of errors) {
    it(`${name} extends NoydbError with code "${code}"`, () => {
      const err = new Class()
      expect(err).toBeInstanceOf(NoydbError)
      expect(err).toBeInstanceOf(Error)
      expect(err.code).toBe(code)
      expect(err.name).toBe(name)
    })
  }

  it('ConflictError extends NoydbError with version', () => {
    const err = new ConflictError(5)
    expect(err).toBeInstanceOf(NoydbError)
    expect(err.code).toBe('CONFLICT')
    expect(err.version).toBe(5)
  })
})
