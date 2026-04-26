/**
 * Tests for the target-profile aware filename sanitizer (#292).
 *
 * Each profile gets a focused suite covering the threat scenarios
 * the issue enumerates (path injection, reserved names, NFC drift,
 * bidi override, NUL, ZIP slash leak, S3 `+` ambiguity, length cap
 * UTF-8 boundary). A small property-style fuzzer rounds it out:
 * 200 random Unicode strings × 6 non-opaque profiles must each
 * sanitize without exceeding their own length cap.
 */

import { describe, it, expect } from 'vitest'
import { sanitizeFilename, type FilenameProfile } from '../src/util/sanitize-filename.js'
import { FilenameSanitizationError } from '../src/errors.js'

const utf8 = new TextEncoder()

describe('sanitizeFilename — always-on transforms', () => {
  it('rejects NUL bytes (no silent strip — truncation-bypass class)', () => {
    expect(() => sanitizeFilename('safe.txt\0.exe', { profile: 'posix' }))
      .toThrow(FilenameSanitizationError)
  })

  it('NFC-normalizes — NFD `é` and NFC `é` collapse to one form', () => {
    const nfd = 'café.txt' // e + combining acute
    const nfc = 'café.txt'        // single composed é
    expect(sanitizeFilename(nfd, { profile: 'posix' })).toBe(nfc)
  })

  it('strips bidi overrides (LRO/RLO/PDI/etc.)', () => {
    const spoof = 'invoice‮.exe.txt'
    expect(sanitizeFilename(spoof, { profile: 'posix' })).toBe('invoice.exe.txt')
  })

  it('trims leading/trailing whitespace and ASCII control chars', () => {
    expect(sanitizeFilename('  \t\nhello.txt\r ', { profile: 'posix' }))
      .toBe('hello.txt')
  })

  it('throws on empty after sanitization', () => {
    expect(() => sanitizeFilename('   ', { profile: 'posix' }))
      .toThrow(FilenameSanitizationError)
  })

  it('throws on `.` and `..` exact match', () => {
    expect(() => sanitizeFilename('..', { profile: 'posix' })).toThrow(FilenameSanitizationError)
    expect(() => sanitizeFilename('.', { profile: 'posix' })).toThrow(FilenameSanitizationError)
  })

  it('throws on `..` segment in path', () => {
    expect(() => sanitizeFilename('foo/../bar', { profile: 'zip' }))
      .toThrow(FilenameSanitizationError)
  })
})

describe('sanitizeFilename — posix profile', () => {
  it('replaces `/` with the replacement char', () => {
    expect(sanitizeFilename('a/b/c.txt', { profile: 'posix' })).toBe('a_b_c.txt')
  })
  it('caps at 255 UTF-8 bytes by default', () => {
    const long = 'a'.repeat(300) + '.txt'
    const out = sanitizeFilename(long, { profile: 'posix' })
    expect(utf8.encode(out).byteLength).toBeLessThanOrEqual(255)
  })
})

describe('sanitizeFilename — windows profile', () => {
  it('replaces all reserved chars', () => {
    expect(sanitizeFilename('a<b>c:d"e/f\\g|h?i*j', { profile: 'windows' }))
      .toBe('a_b_c_d_e_f_g_h_i_j')
  })

  it('strips trailing space + dot', () => {
    expect(sanitizeFilename('hello. ', { profile: 'windows' })).toBe('hello')
  })

  it('avoids reserved DOS device names (case-insensitive, with extension)', () => {
    expect(sanitizeFilename('CON', { profile: 'windows' })).toBe('_CON')
    expect(sanitizeFilename('aux.txt', { profile: 'windows' })).toBe('_aux.txt')
    expect(sanitizeFilename('COM3', { profile: 'windows' })).toBe('_COM3')
    expect(sanitizeFilename('LPT9.dat', { profile: 'windows' })).toBe('_LPT9.dat')
  })

  it('caps at 255 UTF-16 code units', () => {
    const long = 'x'.repeat(600)
    expect(sanitizeFilename(long, { profile: 'windows' }).length).toBe(255)
  })
})

describe('sanitizeFilename — macos-smb profile (windows ∪ posix + hidden noise)', () => {
  it('inherits windows reserved-char rules', () => {
    expect(sanitizeFilename('a<b>.txt', { profile: 'macos-smb' })).toBe('a_b_.txt')
  })
  it('prefixes `.DS_Store`-style hidden noise', () => {
    expect(sanitizeFilename('.DS_Store', { profile: 'macos-smb' })).toBe('_.DS_Store')
    expect(sanitizeFilename('._resourcefork', { profile: 'macos-smb' })).toBe('_._resourcefork')
  })
  it('caps at 240 UTF-8 bytes (more conservative than posix)', () => {
    const long = 'a'.repeat(500)
    const out = sanitizeFilename(long, { profile: 'macos-smb' })
    expect(utf8.encode(out).byteLength).toBeLessThanOrEqual(240)
  })
})

describe('sanitizeFilename — zip profile', () => {
  it('strips leading slash', () => {
    expect(sanitizeFilename('/etc/passwd', { profile: 'zip' })).toBe('etc/passwd')
  })
  it('rejects `..` segment in path', () => {
    expect(() => sanitizeFilename('safe/../../etc/passwd', { profile: 'zip' }))
      .toThrow(FilenameSanitizationError)
  })
})

describe('sanitizeFilename — url-path profile (RFC 3986)', () => {
  it('encodes spaces and special chars per RFC 3986', () => {
    expect(sanitizeFilename('hello world.txt', { profile: 'url-path' }))
      .toBe('hello%20world.txt')
  })
  it('preserves `~` (unreserved)', () => {
    expect(sanitizeFilename('user~me.txt', { profile: 'url-path' })).toBe('user~me.txt')
  })
  it('encodes `+` as `%2B` (S3 presigned URL ambiguity)', () => {
    expect(sanitizeFilename('a+b.txt', { profile: 'url-path' })).toBe('a%2Bb.txt')
  })
  it('encodes Thai (multi-byte UTF-8) correctly', () => {
    // ก = U+0E01, UTF-8: E0 B8 81
    expect(sanitizeFilename('ก.txt', { profile: 'url-path' })).toBe('%E0%B8%81.txt')
  })
})

describe('sanitizeFilename — s3-key profile', () => {
  it('encodes RFC 3986 plus drops leading slashes (s3 keys do not start with /)', () => {
    expect(sanitizeFilename('/abc/def.txt', { profile: 's3-key' }))
      .toBe('abc%2Fdef.txt')
  })
  it('caps at 1024 UTF-8 bytes by default', () => {
    const long = 'x'.repeat(1500)
    const out = sanitizeFilename(long, { profile: 's3-key' })
    expect(utf8.encode(out).byteLength).toBeLessThanOrEqual(1024)
  })
})

describe('sanitizeFilename — opaque profile', () => {
  it('replaces the input entirely with `${id}.${ext}` when ext looks safe', () => {
    expect(sanitizeFilename('original-name.PDF', { profile: 'opaque', opaqueId: '01HABC' }))
      .toBe('01HABC.pdf')
  })
  it('drops the extension when the input has none or it is not alphanumeric', () => {
    expect(sanitizeFilename('original-name', { profile: 'opaque', opaqueId: '01HABC' }))
      .toBe('01HABC')
    expect(sanitizeFilename('weird.???', { profile: 'opaque', opaqueId: '01HABC' }))
      .toBe('01HABC')
  })
  it('throws when opaqueId is missing', () => {
    expect(() => sanitizeFilename('x.txt', { profile: 'opaque' }))
      .toThrow(/opaqueId/)
  })
})

describe('sanitizeFilename — UTF-8 boundary safety', () => {
  it('truncates at the last whole code-point boundary, never mid-multibyte', () => {
    // 'ก' is 3 UTF-8 bytes; cap at 8 should fit two whole code points (6 bytes).
    const out = sanitizeFilename('กกก', { profile: 'posix', maxBytes: 8 })
    expect(utf8.encode(out).byteLength).toBeLessThanOrEqual(8)
    // No replacement char (U+FFFD) in the output — boundary was clean.
    expect(out.includes('�')).toBe(false)
  })

  it('throws when maxBytes is too small for a single code point', () => {
    expect(() => sanitizeFilename('ก', { profile: 'posix', maxBytes: 2 }))
      .toThrow(FilenameSanitizationError)
  })
})

describe('sanitizeFilename — property fuzz', () => {
  // Generate a random Unicode-ish string that may include emoji,
  // CJK, Thai, controls, NUL, and spoof characters.
  function randomName(): string {
    const len = 1 + Math.floor(Math.random() * 100)
    let s = ''
    for (let i = 0; i < len; i++) {
      const cp = Math.floor(Math.random() * 0xfffe)
      // Skip surrogates (invalid alone) — `String.fromCodePoint` would
      // otherwise emit unpaired surrogates and complicate the assertion.
      if (cp >= 0xd800 && cp <= 0xdfff) { i--; continue }
      s += String.fromCodePoint(cp)
    }
    return s
  }

  const profiles: Exclude<FilenameProfile, 'opaque'>[] = [
    'posix', 'windows', 'macos-smb', 'zip', 'url-path', 's3-key',
  ]
  const caps: Record<typeof profiles[number], number> = {
    posix: 255, windows: 255, 'macos-smb': 240, zip: 255, 'url-path': 1024, 's3-key': 1024,
  }

  for (const profile of profiles) {
    it(`200 random inputs × profile=${profile} never exceed the byte cap`, () => {
      let attempts = 0
      let safe = 0
      while (attempts < 200) {
        const input = randomName()
        attempts++
        try {
          const out = sanitizeFilename(input, { profile })
          // Length cap measured per-profile.
          if (profile === 'windows') {
            expect(out.length).toBeLessThanOrEqual(caps[profile])
          } else {
            expect(utf8.encode(out).byteLength).toBeLessThanOrEqual(caps[profile])
          }
          safe++
        } catch (err) {
          // Throws are allowed — the input was unsanitizable (NUL, only
          // controls, dot-segment, etc.). What's NOT allowed is a
          // silent-broken output, which is what the byte-cap check
          // above guards.
          expect(err).toBeInstanceOf(FilenameSanitizationError)
        }
      }
      // At least some must succeed; otherwise the fuzzer is too
      // hostile for the test to be meaningful.
      expect(safe).toBeGreaterThan(0)
    })
  }
})
