/**
 * @noy-db/on-recovery — post pre.8 (#38 Option A).
 *
 * The package is now a thin code-generator + parser layer over the
 * hub's `mintPaperRecoveryEntry` primitive. These tests verify:
 *   1. Code-set generation produces the expected count + format.
 *   2. Codes round-trip through `parseRecoveryCode` (whitespace /
 *      hyphens / case insensitive, checksum validation).
 *   3. Entries delegate to the hub's wrap-DEKs format — round-tripping
 *      via the hub's `unwrapDeksFromPaperEntry` recovers the same DEK
 *      bytes that were enrolled.
 *   4. Burn-on-use semantics work at the consumer layer.
 */
import { describe, expect, it } from 'vitest'
import {
  formatRecoveryCode,
  generateRecoveryCodeSet,
  parseRecoveryCode,
} from '../src/index.js'
import { unwrapDeksFromPaperEntry } from '@noy-db/hub'

const subtle = globalThis.crypto.subtle

async function freshDeks(): Promise<Map<string, CryptoKey>> {
  const dek1 = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
  const dek2 = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
  return new Map([['invoices', dek1], ['clients', dek2]])
}

async function dekBytes(dek: CryptoKey): Promise<string> {
  const raw = new Uint8Array(await subtle.exportKey('raw', dek))
  return Array.from(raw).map((b) => b.toString(16).padStart(2, '0')).join('')
}

// PBKDF2 with 600K iterations is CPU-intensive. Under parallel vitest
// workers the default 5s timeout trips — use explicit 30s to cover
// the worst-case 20-code-set generation under CPU contention.
const KDF_TIMEOUT = 30_000

describe('generateRecoveryCodeSet (delegates to hub mintPaperRecoveryEntry)', () => {
  it('generates the default 10 codes', async () => {
    const deks = await freshDeks()
    const result = await generateRecoveryCodeSet({ deks })
    expect(result.codes).toHaveLength(10)
    expect(result.entries).toHaveLength(10)
  }, KDF_TIMEOUT)

  it('honours the count option', async () => {
    const deks = await freshDeks()
    const result = await generateRecoveryCodeSet({ deks, count: 5 })
    expect(result.codes).toHaveLength(5)
    expect(result.entries).toHaveLength(5)
  }, KDF_TIMEOUT)

  it('codes are formatted in groups of 4 separated by hyphens', async () => {
    const deks = await freshDeks()
    const { codes } = await generateRecoveryCodeSet({ deks, count: 1 })
    // 28 chars = 7 groups of 4, hyphen-separated
    expect(codes[0]).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{4}){6}$/)
  }, KDF_TIMEOUT)

  it('every code is unique across a single enrollment', async () => {
    const deks = await freshDeks()
    const { codes } = await generateRecoveryCodeSet({ deks, count: 20 })
    expect(new Set(codes).size).toBe(20)
  }, KDF_TIMEOUT)

  it('every entry has a unique codeId (ULID)', async () => {
    const deks = await freshDeks()
    const { entries } = await generateRecoveryCodeSet({ deks, count: 10 })
    const ids = entries.map((e) => e.codeId)
    expect(new Set(ids).size).toBe(10)
  }, KDF_TIMEOUT)

  it('entries use the hub PaperRecoveryEntry shape (wrap-DEKs)', async () => {
    const deks = await freshDeks()
    const { entries } = await generateRecoveryCodeSet({ deks, count: 1 })
    const e = entries[0]!
    expect(typeof e.codeId).toBe('string')
    expect(typeof e.salt).toBe('string')
    expect(typeof e.iv).toBe('string')           // wrap-DEKs has IV (no wrappedKEK)
    expect(typeof e.wrappedDeks).toBe('string')
    expect(typeof e.enrolledAt).toBe('string')
    // Anti-regression: the broken pre.7 shape had `wrappedKEK` instead.
    expect((e as Record<string, unknown>).wrappedKEK).toBeUndefined()
  }, KDF_TIMEOUT)

  it('rejects out-of-range count', async () => {
    const deks = await freshDeks()
    await expect(generateRecoveryCodeSet({ deks, count: 0 })).rejects.toThrow(/count must be/)
    await expect(generateRecoveryCodeSet({ deks, count: -1 })).rejects.toThrow(/count must be/)
    await expect(generateRecoveryCodeSet({ deks, count: 101 })).rejects.toThrow(/count must be/)
  })
})

describe('parseRecoveryCode', () => {
  it('accepts a well-formed code with hyphens', async () => {
    const deks = await freshDeks()
    const { codes } = await generateRecoveryCodeSet({ deks, count: 1 })
    const result = parseRecoveryCode(codes[0]!)
    expect(result.status).toBe('valid')
  }, KDF_TIMEOUT)

  it('accepts whitespace, lowercase, and missing hyphens', async () => {
    const deks = await freshDeks()
    const { codes } = await generateRecoveryCodeSet({ deks, count: 1 })
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
    const deks = await freshDeks()
    const { codes } = await generateRecoveryCodeSet({ deks, count: 1 })
    const normalized = codes[0]!.replace(/-/g, '')
    const lastChar = normalized[normalized.length - 1]!
    const flipped = lastChar === 'A' ? 'B' : 'A'
    const tampered = normalized.slice(0, -1) + flipped
    expect(parseRecoveryCode(tampered).status).toBe('invalid-checksum')
  }, KDF_TIMEOUT)

  it('rejects codes with non-Base32 characters', () => {
    const bad = 'AAAA-0OIL-AAAA-AAAA-AAAA-AAAA'  // 0, O, I, L are not in Base32
    expect(parseRecoveryCode(bad).status).toBe('invalid-format')
  })
})

describe('formatRecoveryCode', () => {
  it('groups into 4-char hyphen-separated blocks', () => {
    expect(formatRecoveryCode('AAAABBBBCCCCDDDDEEEEFFFFGGGG')).toBe('AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG')
  })

  it('is the inverse of the strip in parseRecoveryCode', async () => {
    const deks = await freshDeks()
    const { codes } = await generateRecoveryCodeSet({ deks, count: 1 })
    const parsed = parseRecoveryCode(codes[0]!)
    if (parsed.status !== 'valid') throw new Error('expected valid')
    expect(formatRecoveryCode(parsed.code)).toBe(codes[0])
  }, KDF_TIMEOUT)
})

describe('hub-delegated round-trip (wrap-DEKs)', () => {
  it('unwraps the same DEK bytes when given the correct code', async () => {
    const deks = await freshDeks()
    const { codes, entries } = await generateRecoveryCodeSet({ deks, count: 1 })
    const parsed = parseRecoveryCode(codes[0]!)
    if (parsed.status !== 'valid') throw new Error('expected valid')

    const recovered = await unwrapDeksFromPaperEntry(entries[0]!, parsed.code)
    expect(recovered.size).toBe(2)
    for (const coll of deks.keys()) {
      expect(recovered.has(coll)).toBe(true)
      expect(await dekBytes(recovered.get(coll)!)).toBe(await dekBytes(deks.get(coll)!))
    }
  }, KDF_TIMEOUT)

  it('fails to unwrap when the code is wrong', async () => {
    const deks = await freshDeks()
    const { codes, entries } = await generateRecoveryCodeSet({ deks, count: 2 })
    const parsedA = parseRecoveryCode(codes[0]!)
    if (parsedA.status !== 'valid') throw new Error('expected valid')

    // Try to unwrap entry 0 using code 1 — must fail (AES-GCM auth tag).
    await expect(unwrapDeksFromPaperEntry(entries[1]!, parsedA.code)).rejects.toThrow()
  }, KDF_TIMEOUT)
})

describe('burn-on-use semantics (application-layer)', () => {
  it('after the caller deletes the entry, the code is unusable', async () => {
    const deks = await freshDeks()
    const { codes, entries } = await generateRecoveryCodeSet({ deks, count: 3 })

    const parsed0 = parseRecoveryCode(codes[0]!)
    if (parsed0.status !== 'valid') throw new Error('expected valid')
    const unwrapped = await unwrapDeksFromPaperEntry(entries[0]!, parsed0.code)
    expect(unwrapped.size).toBeGreaterThan(0)

    // Simulate burn: drop entry 0 from the stored list.
    const stillEnrolled = entries.slice(1)

    // Attempting to re-use code 0 against the remaining entries must fail.
    let usableAgain = false
    for (const entry of stillEnrolled) {
      try {
        await unwrapDeksFromPaperEntry(entry, parsed0.code)
        usableAgain = true
        break
      } catch {
        // Expected — code 0 doesn't match any remaining entry.
      }
    }
    expect(usableAgain).toBe(false)
  }, KDF_TIMEOUT)
})
