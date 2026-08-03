/**
 * Tests for `.noydb` pod header L2 fields — `engineRange`, `unlockMethods`,
 * `hasApp`, `species`, `pointerMode` (#942, Task 1: format.ts only —
 * validators + encode/decode round-trip). Additive on top of #943's
 * sig/keyId/sigAlg fields.
 */

import { describe, it, expect } from 'vitest'
import {
  validateBundleHeader,
  encodeBundleHeader,
  decodeBundleHeader,
  NOYDB_BUNDLE_FORMAT_VERSION,
} from '../src/with-pod/format.js'

describe('pod header L2 fields — engineRange/unlockMethods/hasApp/species/pointerMode', () => {
  const baseV1 = {
    formatVersion: NOYDB_BUNDLE_FORMAT_VERSION,
    handle: '01HYABCDEFGHJKMNPQRSTVWXYZ',
    bodyBytes: 1234,
    bodySha256: 'a'.repeat(64),
  }

  const allFive = {
    engineRange: '^0.5.0',
    unlockMethods: ['password', 'webauthn'] as const,
    hasApp: true,
    species: 'full' as const,
    pointerMode: 'public' as const,
  }

  it('accepts a header carrying all 5 valid fields', () => {
    expect(() => validateBundleHeader({ ...baseV1, ...allFive })).not.toThrow()
  })

  it('still validates a legacy header with none of the 5 fields', () => {
    expect(() => validateBundleHeader(baseV1)).not.toThrow()
  })

  it('still rejects an unknown key', () => {
    expect(() =>
      validateBundleHeader({ ...baseV1, foo: 'bar' }),
    ).toThrow(/forbidden key "foo"/)
  })

  it('rejects a non-string engineRange', () => {
    expect(() =>
      validateBundleHeader({ ...baseV1, engineRange: 123 }),
    ).toThrow(/header\.engineRange must be a string/)
  })

  it('rejects a non-array unlockMethods', () => {
    expect(() =>
      validateBundleHeader({ ...baseV1, unlockMethods: 'password' }),
    ).toThrow(/header\.unlockMethods must be an array/)
  })

  it('rejects an unlockMethods array with a bad member', () => {
    expect(() =>
      validateBundleHeader({ ...baseV1, unlockMethods: ['password', 'bogus'] }),
    ).toThrow(/header\.unlockMethods\[1\]/)
  })

  it('rejects a non-boolean hasApp', () => {
    expect(() =>
      validateBundleHeader({ ...baseV1, hasApp: 'yes' }),
    ).toThrow(/header\.hasApp must be a boolean/)
  })

  it('rejects an invalid species', () => {
    expect(() =>
      validateBundleHeader({ ...baseV1, species: 'bogus' }),
    ).toThrow(/header\.species must be one of/)
  })

  it('rejects an invalid pointerMode', () => {
    expect(() =>
      validateBundleHeader({ ...baseV1, pointerMode: 'weird' }),
    ).toThrow(/header\.pointerMode must be 'public' or 'private'/)
  })

  it('round-trips all 5 fields through encode/decode', () => {
    const header = { ...baseV1, ...allFive }
    const bytes = encodeBundleHeader(header)
    const decoded = decodeBundleHeader(bytes)
    expect(decoded).toEqual(header)
  })

  it('round-trips a legacy header (none of the 5) unchanged', () => {
    const bytes = encodeBundleHeader(baseV1)
    const decoded = decodeBundleHeader(bytes)
    expect(decoded).toEqual(baseV1)
  })
})
