/**
 * Target-profile aware filename sanitizer (#292).
 *
 * Pure string in / string out. No filesystem access, no I/O. Use this
 * at the boundary where a user-supplied filename meets a storage
 * destination — local FS, ZIP archive, S3 key, URL path, SMB share —
 * to defuse the canonical 14-class footgun before it reaches that
 * destination.
 *
 * ## Threat model
 *
 *   1. Path injection — `..`, NUL bytes, `\` on POSIX, absolute paths.
 *   2. Windows reserved names — `CON`, `PRN`, `AUX`, `NUL`,
 *      `COM1-9`, `LPT1-9`, with or without an extension.
 *   3. Windows reserved chars — `< > : " / \ | ? *` plus ASCII 0-31.
 *   4. Trailing `.` and ` ` on Windows / SMB.
 *   5. Unicode normalization drift — same display, different bytes →
 *      "two files with the same name" sync ghosts.
 *   6. Bidi override spoofing — U+202E reversing `harmless.exe.txt`
 *      into `harmless.txt.exe`.
 *   7. URL `+` ambiguity in S3 presigned URLs.
 *   8. ZIP general-purpose-flag bit 11 (UTF-8 filename) optional in
 *      pre-2006 readers.
 *   9-14. Length caps, leading/trailing whitespace + controls,
 *      `.DS_Store`-style hidden noise, etc.
 *
 * ## Always-on transforms (every profile)
 *
 *   - NFC normalize (`String.prototype.normalize('NFC')`).
 *   - Reject NUL — hard fail, not strip. Silent strip enables a
 *     classic truncation bypass (`safe.txt\0.exe` → `safe.txt`).
 *   - Strip bidi overrides (`U+202A..U+202E`, `U+2066..U+2069`).
 *   - Trim leading/trailing whitespace and ASCII control chars.
 *
 * ## Non-goals (i18n boundary policy, #245)
 *
 *   - No transliteration.
 *   - No locale-aware slugging.
 *   - No script-specific segmentation.
 *
 * @module
 */

import { FilenameSanitizationError } from '../errors.js'

/**
 * One of seven storage destinations the sanitizer knows how to defang
 * for. Pick the most restrictive that covers your write site:
 * `'macos-smb'` is the safe default for "I don't know where these
 * files end up but they're going to a real filesystem somewhere."
 */
export type FilenameProfile =
  | 'posix'
  | 'windows'
  | 'macos-smb'
  | 'zip'
  | 'url-path'
  | 's3-key'
  | 'opaque'

export interface SanitizeFilenameOptions {
  /** Target-destination profile. */
  readonly profile: FilenameProfile
  /**
   * Override the per-profile length cap. Useful when leaving headroom
   * for a collision suffix — e.g. `maxBytes: 240` on a `posix` write
   * site that wants 15 bytes of slack for `-1`, `-2`, …
   */
  readonly maxBytes?: number
  /**
   * Required when `profile === 'opaque'`. The opaque profile replaces
   * the entire input with `${opaqueId}.${ext}` (extension preserved
   * from the input when present).
   */
  readonly opaqueId?: string
}

const REPLACEMENT = '_'

// Bidi overrides: U+202A LRE, U+202B RLE, U+202C PDF, U+202D LRO,
// U+202E RLO, U+2066 LRI, U+2067 RLI, U+2068 FSI, U+2069 PDI.
const BIDI_OVERRIDES = /[‪-‮⁦-⁩]/g

// Reserved by Windows / NTFS / FAT / SMB.
const WINDOWS_RESERVED_CHARS = /[<>:"/\\|?*]/g

const WINDOWS_RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
])

// macOS legacy hidden-noise files. Match the full name.
const MAC_HIDDEN_NOISE = /^(?:\.DS_Store|\.localized|\.fseventsd|\._.+)$/i

// RFC 3986 unreserved set.
const URL_UNRESERVED = /[A-Za-z0-9\-._~]/

const utf8 = new TextEncoder()

function isControlCode(cp: number): boolean {
  return (cp >= 0 && cp <= 0x1f) || cp === 0x7f
}

function stripControlChars(s: string): string {
  let out = ''
  for (let i = 0; i < s.length; i++) {
    out += isControlCode(s.charCodeAt(i)) ? REPLACEMENT : s[i]
  }
  return out
}

function trimWhitespaceAndControls(s: string): string {
  let start = 0
  let end = s.length
  while (start < end) {
    const ch = s[start]!
    if (!isControlCode(s.charCodeAt(start)) && ch.trim() !== '') break
    start++
  }
  while (end > start) {
    const ch = s[end - 1]!
    if (!isControlCode(s.charCodeAt(end - 1)) && ch.trim() !== '') break
    end--
  }
  return s.slice(start, end)
}

/**
 * Sanitize a filename for a target-destination profile. Pure: same
 * input + options always returns the same output, no I/O.
 *
 * Returns the sanitized name. Throws {@link FilenameSanitizationError}
 * when the input cannot be made safe at all (NUL byte, empty after
 * normalization, missing `opaqueId` for the opaque profile,
 * `..` segment that would fall out of any reasonable target).
 */
export function sanitizeFilename(name: string, opts: SanitizeFilenameOptions): string {
  if (typeof name !== 'string') {
    throw new FilenameSanitizationError('input must be a string')
  }
  if (name.includes('\0')) {
    throw new FilenameSanitizationError('NUL byte in filename')
  }

  let s = name.normalize('NFC').replace(BIDI_OVERRIDES, '')

  if (opts.profile === 'opaque') {
    return applyOpaque(s, opts)
  }

  s = trimWhitespaceAndControls(s)

  switch (opts.profile) {
    case 'posix':     return cap(applyPosix(s),     opts.maxBytes ?? 255,  'utf8')
    case 'windows':   return cap(applyWindows(s),   opts.maxBytes ?? 255,  'utf16')
    case 'macos-smb': return cap(applyMacosSmb(s),  opts.maxBytes ?? 240,  'utf8')
    case 'zip':       return cap(applyZip(s),       opts.maxBytes ?? 255,  'utf8')
    case 'url-path':  return cap(applyUrlPath(s),   opts.maxBytes ?? 1024, 'bytes-pre-encode')
    case 's3-key':    return cap(applyS3Key(s),     opts.maxBytes ?? 1024, 'utf8')
  }
}

// ─── Profile implementations ────────────────────────────────────────────

function applyPosix(s: string): string {
  // POSIX is permissive; only `/` and NUL are off-limits.
  const cleaned = s.replace(/\//g, REPLACEMENT)
  return rejectDotSegments(cleaned)
}

function applyWindows(s: string): string {
  let cleaned = s.replace(WINDOWS_RESERVED_CHARS, REPLACEMENT)
  cleaned = stripControlChars(cleaned)
  // Trailing space/dot are stripped by Win32 path resolution.
  cleaned = cleaned.replace(/[. ]+$/g, '')
  cleaned = rejectDotSegments(cleaned)
  return avoidWindowsReservedName(cleaned)
}

function applyMacosSmb(s: string): string {
  let cleaned = applyWindows(s)
  if (MAC_HIDDEN_NOISE.test(cleaned)) {
    cleaned = REPLACEMENT + cleaned
  }
  return cleaned
}

function applyZip(s: string): string {
  let cleaned = s.replace(/^\/+/, '')
  cleaned = rejectDotSegments(cleaned)
  return stripControlChars(cleaned)
}

function applyUrlPath(s: string): string {
  // RFC 3986 percent-encoding for path segment. Keep `unreserved`,
  // encode everything else. `+` is encoded as `%2B` because S3 and
  // legacy servers treat raw `+` as space ambiguously.
  let out = ''
  for (const ch of s) {
    if (URL_UNRESERVED.test(ch)) { out += ch; continue }
    const bytes = utf8.encode(ch)
    for (const b of bytes) {
      out += '%' + b.toString(16).toUpperCase().padStart(2, '0')
    }
  }
  return out
}

function applyS3Key(s: string): string {
  // Strip leading slashes BEFORE percent-encoding — once `/` is
  // encoded to `%2F` the leading-slash regex no longer matches.
  return applyUrlPath(s.replace(/^\/+/, ''))
}

function applyOpaque(s: string, opts: SanitizeFilenameOptions): string {
  if (!opts.opaqueId) {
    throw new FilenameSanitizationError('opaque profile requires opaqueId')
  }
  // Preserve a "safe-looking" extension only — alphanumeric, ≤16 bytes.
  const dot = s.lastIndexOf('.')
  if (dot > 0 && dot < s.length - 1) {
    const ext = s.slice(dot + 1)
    if (/^[A-Za-z0-9]{1,16}$/.test(ext)) {
      return `${opts.opaqueId}.${ext.toLowerCase()}`
    }
  }
  return opts.opaqueId
}

// ─── Helpers ────────────────────────────────────────────────────────────

function rejectDotSegments(s: string): string {
  if (s === '.' || s === '..' || s.split(/[/\\]/).some((seg) => seg === '..')) {
    throw new FilenameSanitizationError('path traversal segment in filename')
  }
  if (s.length === 0) {
    throw new FilenameSanitizationError('empty filename after sanitization')
  }
  return s
}

function avoidWindowsReservedName(s: string): string {
  const dot = s.indexOf('.')
  const base = dot === -1 ? s : s.slice(0, dot)
  if (WINDOWS_RESERVED_NAMES.has(base.toUpperCase())) {
    return REPLACEMENT + s
  }
  return s
}

type LengthUnit = 'utf8' | 'utf16' | 'bytes-pre-encode'

function cap(s: string, max: number, unit: LengthUnit): string {
  if (max <= 0) {
    throw new FilenameSanitizationError('maxBytes must be positive')
  }
  if (unit === 'utf16') {
    if (s.length <= max) return s
    return s.slice(0, max)
  }
  if (unit === 'bytes-pre-encode') {
    if (utf8.encode(s).byteLength <= max) return s
    return truncateToByteCap(s, max)
  }
  if (utf8.encode(s).byteLength <= max) return s
  return truncateToByteCap(s, max)
}

function truncateToByteCap(s: string, max: number): string {
  // Walk by code points so we never split a multi-byte sequence in
  // the middle. Whole-grapheme handling (ZWJ-joined emoji) is a
  // documented non-goal; we only protect against UTF-8 boundary
  // splits here.
  let out = ''
  let used = 0
  for (const cp of s) {
    const n = utf8.encode(cp).byteLength
    if (used + n > max) break
    out += cp
    used += n
  }
  if (out.length === 0) {
    throw new FilenameSanitizationError('maxBytes too small for a single code point')
  }
  return out
}
