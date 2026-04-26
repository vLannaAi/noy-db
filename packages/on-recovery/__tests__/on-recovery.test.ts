import { describe, expect, it } from 'vitest'
import {
  deriveRecoveryWrappingKey,
  formatRecoveryCode,
  generateRecoveryCodeSet,
  parseRecoveryCode,
  unwrapKEKFromRecovery,
  wrapKEKForRecovery,
} from '../src/index.js'

async function freshKEK(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,  // extractable — let tests round-trip via exportKey
    ['encrypt', 'decrypt'],
  )
}

/**
 * Functional-equivalence test: encrypt with `original`, decrypt with
 * `candidate`. If both operations succeed on the same plaintext, the
 * two CryptoKeys are identical (AES-GCM auth tag ensures this).
 * Works regardless of extractability.
 */
async function assertSameKey(original: CryptoKey, candidate: CryptoKey): Promise<void> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const plaintext = new TextEncoder().encode('noydb-functional-equivalence-probe')
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    original,
    plaintext as BufferSource,
  )
  const recovered = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    candidate,
    ciphertext,
  )
  const recoveredText = new TextDecoder().decode(recovered)
  expect(recoveredText).toBe('noydb-functional-equivalence-probe')
}

// PBKDF2 with 600K iterations is CPU-intensive. Under parallel vitest
// workers the default 5s timeout trips — use explicit 30s to cover
// the worst-case 20-code-set generation under CPU contention.
const KDF_TIMEOUT = 30_000

describe('generateRecoveryCodeSet', () => {
  it('generates the default 10 codes', async () => {
    const kek = await freshKEK()
    const result = await generateRecoveryCodeSet({ kek })
    expect(result.codes).toHaveLength(10)
    expect(result.entries).toHaveLength(10)
  }, KDF_TIMEOUT)

  it('honours the count option', async () => {
    const kek = await freshKEK()
    const result = await generateRecoveryCodeSet({ kek, count: 5 })
    expect(result.codes).toHaveLength(5)
    expect(result.entries).toHaveLength(5)
  }, KDF_TIMEOUT)

  it('codes are formatted in groups of 4 separated by hyphens', async () => {
    const kek = await freshKEK()
    const { codes } = await generateRecoveryCodeSet({ kek, count: 1 })
    // 28 chars = 7 groups of 4, hyphen-separated
    expect(codes[0]).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{4}){6}$/)
  }, KDF_TIMEOUT)

  it('every code is unique across a single enrollment', async () => {
    const kek = await freshKEK()
    const { codes } = await generateRecoveryCodeSet({ kek, count: 20 })
    expect(new Set(codes).size).toBe(20)
  }, KDF_TIMEOUT)

  it('every entry has a unique codeId', async () => {
    const kek = await freshKEK()
    const { entries } = await generateRecoveryCodeSet({ kek, count: 10 })
    const ids = entries.map(e => e.codeId)
    expect(new Set(ids).size).toBe(10)
  }, KDF_TIMEOUT)

  it('rejects out-of-range count', async () => {
    const kek = await freshKEK()
    await expect(generateRecoveryCodeSet({ kek, count: 0 })).rejects.toThrow(/count must be/)
    await expect(generateRecoveryCodeSet({ kek, count: -1 })).rejects.toThrow(/count must be/)
    await expect(generateRecoveryCodeSet({ kek, count: 101 })).rejects.toThrow(/count must be/)
  })
})

describe('parseRecoveryCode', () => {
  it('accepts a well-formed code with hyphens', async () => {
    const kek = await freshKEK()
    const { codes } = await generateRecoveryCodeSet({ kek, count: 1 })
    const result = parseRecoveryCode(codes[0]!)
    expect(result.status).toBe('valid')
  }, KDF_TIMEOUT)

  it('accepts whitespace, lowercase, and missing hyphens', async () => {
    const kek = await freshKEK()
    const { codes } = await generateRecoveryCodeSet({ kek, count: 1 })
    const normalized = codes[0]!.replace(/-/g, '')
    expect(parseRecoveryCode(normalized).status).toBe('valid')
    expect(parseRecoveryCode(normalized.toLowerCase()).status).toBe('valid')
    expect(parseRecoveryCode(`  ${normalized}  `).status).toBe('valid')
    expect(parseRecoveryCode(codes[0]!.split('').join(' ')).status).toBe('valid')
  }, KDF_TIMEOUT)

  it('rejects malformed inputs', () => {
    expect(parseRecoveryCode('too-short').status).toBe('invalid-format')
    expect(parseRecoveryCode('A1!@#$%^&*()=+<>?:"{}|[]').status).toBe('invalid-format')
    expect(parseRecoveryCode('').status).toBe('invalid-format')
  })

  it('rejects codes with wrong checksum', async () => {
    const kek = await freshKEK()
    const { codes } = await generateRecoveryCodeSet({ kek, count: 1 })
    const normalized = codes[0]!.replace(/-/g, '')
    // Flip the last char of checksum — probability of accidental validity ~1/32
    const lastChar = normalized[normalized.length - 1]!
    const flipped = lastChar === 'A' ? 'B' : 'A'
    const tampered = normalized.slice(0, -1) + flipped
    expect(parseRecoveryCode(tampered).status).toBe('invalid-checksum')
  }, KDF_TIMEOUT)

  it('rejects codes with non-Base32 characters', () => {
    const bad = 'AAAA-0OIL-AAAA-AAAA-AAAA-AAAA'  // 0, O, I, L are not in Base32 alphabet
    expect(parseRecoveryCode(bad).status).toBe('invalid-format')
  })
})

describe('formatRecoveryCode', () => {
  it('groups into 4-char hyphen-separated blocks', () => {
    expect(formatRecoveryCode('AAAABBBBCCCCDDDDEEEEFFFFGGGG')).toBe('AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG')
  })

  it('is the inverse of the strip in parseRecoveryCode', async () => {
    const kek = await freshKEK()
    const { codes } = await generateRecoveryCodeSet({ kek, count: 1 })
    const parsed = parseRecoveryCode(codes[0]!)
    if (parsed.status !== 'valid') throw new Error('expected valid')
    expect(formatRecoveryCode(parsed.code)).toBe(codes[0])
  }, KDF_TIMEOUT)
})

describe('wrap + unwrap round-trip', () => {
  it('unwraps a functionally-equivalent KEK when given the correct code', async () => {
    const kek = await freshKEK()
    const { codes, entries } = await generateRecoveryCodeSet({ kek, count: 1 })
    const parsed = parseRecoveryCode(codes[0]!)
    if (parsed.status !== 'valid') throw new Error('expected valid')

    const unwrapped = await unwrapKEKFromRecovery(parsed.code, entries[0]!)
    await assertSameKey(kek, unwrapped)
  }, 20_000)

  it('fails to unwrap when the code is wrong', async () => {
    const kek = await freshKEK()
    const { codes, entries } = await generateRecoveryCodeSet({ kek, count: 2 })
    const parsedA = parseRecoveryCode(codes[0]!)
    if (parsedA.status !== 'valid') throw new Error('expected valid')

    // Try to unwrap entry 0 using code 1 — should fail (AES-KW auth)
    await expect(unwrapKEKFromRecovery(parsedA.code, entries[1]!)).rejects.toThrow()
  }, 20_000)

  it('low-level wrap/unwrap produces a functionally-equivalent KEK', async () => {
    const kek = await freshKEK()
    const salt = crypto.getRandomValues(new Uint8Array(16))
    // Any string works for the low-level wrap test; length matches the normalized code format.
    const code = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAA'  // 28 chars
    const wrapped = await wrapKEKForRecovery(kek, code, salt)
    const wrappingKey = await deriveRecoveryWrappingKey(code, salt)
    const unwrapped = await crypto.subtle.unwrapKey(
      'raw',
      wrapped as BufferSource,
      wrappingKey,
      'AES-KW',
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    )
    await assertSameKey(kek, unwrapped)
  }, 20_000)
})

describe('burn-on-use semantics (application-layer)', () => {
  it('after the caller deletes the entry, the code is unusable', async () => {
    const kek = await freshKEK()
    const { codes, entries } = await generateRecoveryCodeSet({ kek, count: 3 })

    // Consumer side: unlock with entry 0, then "delete" it from storage.
    const parsed0 = parseRecoveryCode(codes[0]!)
    if (parsed0.status !== 'valid') throw new Error('expected valid')
    const unwrapped = await unwrapKEKFromRecovery(parsed0.code, entries[0]!)
    expect(unwrapped).toBeDefined()

    // Simulate burn: drop entry 0 from the stored list.
    const stillEnrolled = entries.slice(1)

    // Attempting to re-use code 0 against the remaining entries must fail.
    let usableAgain = false
    for (const entry of stillEnrolled) {
      try {
        await unwrapKEKFromRecovery(parsed0.code, entry)
        usableAgain = true
        break
      } catch {
        // Expected — code 0 doesn't match any remaining entry.
      }
    }
    expect(usableAgain).toBe(false)
  }, 30_000)
})

