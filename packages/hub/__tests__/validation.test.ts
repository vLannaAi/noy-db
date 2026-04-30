import { describe, it, expect } from 'vitest'
import { validatePassphrase, estimateEntropy } from '../src/validation.js'
import { ValidationError } from '../src/errors.js'
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
} from '../src/errors.js'

describe('validatePassphrase', () => {
  it('accepts strong passphrases', () => {
    expect(() => validatePassphrase('correct-horse-battery-staple')).not.toThrow()
    expect(() => validatePassphrase('MyP@ssw0rd!2026')).not.toThrow()
    expect(() => validatePassphrase('สวัสดีครับทดสอบรหัสผ่าน')).not.toThrow()
  })

  it('rejects short passphrases', () => {
    expect(() => validatePassphrase('short')).toThrow(ValidationError)
    expect(() => validatePassphrase('1234567')).toThrow(ValidationError)
  })

  it('rejects very short passphrases below minimum', () => {
    expect(() => validatePassphrase('Ab1!')).toThrow(ValidationError) // 4 chars, too short
    expect(() => validatePassphrase('abcdefg')).toThrow(ValidationError) // 7 chars
    expect(() => validatePassphrase('abcdefgh')).not.toThrow() // 8 chars, passes
  })
})

describe('estimateEntropy', () => {
  it('increases with password length', () => {
    const short = estimateEntropy('abc')
    const long = estimateEntropy('abcdefghijkl')
    expect(long).toBeGreaterThan(short)
  })

  it('increases with character class diversity', () => {
    const lower = estimateEntropy('abcdefgh')
    const mixed = estimateEntropy('aBcDeFgH')
    const withNum = estimateEntropy('aBcD1234')
    const withSym = estimateEntropy('aB1!cD2@')
    expect(mixed).toBeGreaterThan(lower)
    expect(withNum).toBeGreaterThan(mixed)
    expect(withSym).toBeGreaterThan(withNum)
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
