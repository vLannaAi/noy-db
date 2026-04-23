/**
 * Share serialisation — raw bytes, Base32 for printing, and JSON for
 * structured transport (e.g. storing inside another on-* keyring).
 *
 * Binary layout (fixed header + secret-length y-bytes):
 *
 * ```
 *   offset  size  field
 *   0       1     version (= 1)
 *   1       1     x-coordinate (1..255)
 *   2       1     k (threshold)
 *   3       1     n (total)
 *   4       2     byteLength (big-endian uint16) — should equal y-length
 *   6+      L     y-bytes (L = byteLength)
 * ```
 *
 * Base32 adds a 26-character ULID `shareId` prefix + version/k/n
 * metadata for human-readable diagnostics.
 */

import type { RawShare } from './shamir.js'

const SHARE_VERSION = 1
const HEADER_LEN = 6

// RFC 4648 Base32 alphabet — no confusing 0/1/8/O/I/L/B pairs.
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** Serialise a raw share into its canonical binary form. */
export function encodeShareBytes(share: RawShare): Uint8Array {
  const bytes = new Uint8Array(HEADER_LEN + share.y.length)
  bytes[0] = SHARE_VERSION
  bytes[1] = share.x
  bytes[2] = share.k
  bytes[3] = share.n
  bytes[4] = (share.y.length >>> 8) & 0xff
  bytes[5] = share.y.length & 0xff
  bytes.set(share.y, HEADER_LEN)
  return bytes
}

/** Parse binary share bytes back into a structured share. */
export function decodeShareBytes(bytes: Uint8Array): RawShare {
  if (bytes.length < HEADER_LEN) {
    throw new Error(`on-shamir: share bytes too short (${bytes.length} < ${HEADER_LEN})`)
  }
  const version = bytes[0]!
  if (version !== SHARE_VERSION) {
    throw new Error(`on-shamir: unsupported share version ${version} (expected ${SHARE_VERSION})`)
  }
  const x = bytes[1]!
  const k = bytes[2]!
  const n = bytes[3]!
  const byteLength = (bytes[4]! << 8) | bytes[5]!
  if (bytes.length !== HEADER_LEN + byteLength) {
    throw new Error(`on-shamir: share length mismatch — header says ${byteLength}, got ${bytes.length - HEADER_LEN}`)
  }
  if (x === 0) {
    throw new Error('on-shamir: share has x=0 — malformed')
  }
  return { x, k, n, y: bytes.slice(HEADER_LEN) }
}

/**
 * Encode a share as a Base32 string with hyphenated groups of 4.
 *
 * Output format: `SHAMIR_S{x}_K{k}N{n}__<base32-groups-of-4>`
 *
 * The prefix is not fed into the decoder — it's for eye-readability at a
 * glance (share-number / threshold / total). The `SHAMIR` tag + `_`
 * separators are non-Base32 characters (Base32 alphabet is A-Z2-7
 * only), so the decoder can strip everything up to and including the
 * last `_` before the payload. The metadata is also encoded in the
 * share bytes themselves; the prefix is redundant-but-useful.
 */
export function encodeShareBase32(share: RawShare): string {
  const bytes = encodeShareBytes(share)
  const chunks = base32Encode(bytes)
  const grouped = chunks.match(/.{1,4}/g)?.join('-') ?? chunks
  return `SHAMIR_S${share.x}_K${share.k}N${share.n}__${grouped}`
}

/**
 * Parse a Base32 share string back into a structured share. Tolerates
 * hyphens, whitespace, lowercase, and the optional prefix produced by
 * `encodeShareBase32`. The metadata prefix is informational; actual
 * share data comes from the binary bytes after the last `_`.
 */
export function decodeShareBase32(input: string): RawShare {
  // Normalise first: uppercase + remove whitespace/hyphens. Keep `_`
  // and digits so we can locate the prefix separator.
  const normalised = input.toUpperCase().replace(/[\s-]/g, '')

  // If an optional SHAMIR_..._ prefix is present, strip up to the last `__`.
  const lastDoubleUnderscore = normalised.lastIndexOf('__')
  const payload = lastDoubleUnderscore >= 0 ? normalised.slice(lastDoubleUnderscore + 2) : normalised

  // Remove any remaining non-Base32 characters (defensive — also handles
  // cases where prefix metadata leaked into the payload somehow).
  const stripped = payload.replace(/[^A-Z2-7]/g, '')
  const bytes = base32Decode(stripped)
  return decodeShareBytes(bytes)
}

/**
 * JSON-friendly form for structured storage (e.g. stash inside another
 * on-* keyring entry, or pass over `postMessage`).
 */
export interface ShareJSON {
  readonly v: 1
  readonly x: number
  readonly k: number
  readonly n: number
  readonly y: string  // Base64
}

export function encodeShareJSON(share: RawShare): ShareJSON {
  return {
    v: SHARE_VERSION,
    x: share.x,
    k: share.k,
    n: share.n,
    y: base64Encode(share.y),
  }
}

export function decodeShareJSON(json: ShareJSON): RawShare {
  if (json.v !== SHARE_VERSION) {
    throw new Error(`on-shamir: unsupported share version ${String(json.v)}`)
  }
  return { x: json.x, k: json.k, n: json.n, y: base64Decode(json.y) }
}

// ── Base32 ─────────────────────────────────────────────────────────────

function base32Encode(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i]!
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out += BASE32_ALPHABET[(value >>> bits) & 0x1f]
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f]
  }
  return out
}

function base32Decode(input: string): Uint8Array {
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of input) {
    const idx = BASE32_ALPHABET.indexOf(ch)
    if (idx < 0) {
      throw new Error(`on-shamir: invalid Base32 character "${ch}"`)
    }
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      bits -= 8
      out.push((value >>> bits) & 0xff)
    }
  }
  return new Uint8Array(out)
}

// ── Base64 ─────────────────────────────────────────────────────────────

function base64Encode(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!)
  return btoa(s)
}

function base64Decode(str: string): Uint8Array {
  const s = atob(str)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}
