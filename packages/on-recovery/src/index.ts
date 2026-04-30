/**
 * **@noy-db/on-recovery** — one-time printable recovery codes for noy-db.
 *
 * The last-resort unlock path when the primary authentication
 * (passphrase, WebAuthn, OIDC) is unavailable. Codes are designed to
 * be printed on paper and stored in a safe — each code unlocks the
 * vault exactly once and then is burned by deleting its keyring entry.
 *
 * Part of the `@noy-db/on-*` authentication family.
 *
 * ## Security model
 *
 * Each code is a random 100-bit value (20 Base32 characters) with a
 * 5-character checksum appended. The wrapping key is derived from
 * the code via:
 *
 * ```
 *   PBKDF2-SHA256(
 *     password = normalizeCode(code),
 *     salt     = perCodeRandomSalt,
 *     iter     = 600_000,
 *     length   = 32,
 *   )
 * ```
 *
 * The wrapping key is then used with AES-KW (RFC 3394) to wrap the
 * vault's KEK. The wrapped KEK + salt + code-ID land in the keyring
 * under a `_recovery_<N>` entry, alongside other unlock mechanisms.
 *
 * This package provides the CRYPTO layer only. Storage, burn, audit,
 * and rate-limiting are the caller's responsibility — typically
 * coordinated with `@noy-db/hub`'s keyring + audit-ledger APIs.
 *
 * ## Usage
 *
 * ```ts
 * import {
 *   generateRecoveryCodeSet,
 *   parseRecoveryCode,
 *   deriveRecoveryWrappingKey,
 *   wrapKEKForRecovery,
 *   unwrapKEKFromRecovery,
 * } from '@noy-db/on-recovery'
 *
 * // ENROLL — after user unlocks with passphrase, generate N codes
 * const { codes, entries } = await generateRecoveryCodeSet({ count: 10, kek })
 * // `codes` is what you show the user ONCE (to print/save).
 * // `entries` goes into the keyring file (persistent storage).
 *
 * // UNLOCK — user types in a code later
 * const parsed = parseRecoveryCode(userInput)
 * if (parsed.status !== 'valid') handleInvalidFormat(parsed.status)
 *
 * for (const entry of storedEntries) {
 *   try {
 *     const kek = await unwrapKEKFromRecovery(parsed.code, entry)
 *     // Match! Burn this entry: delete from keyring.
 *     await deleteKeyringEntry(entry.codeId)
 *     return kek
 *   } catch (e) {
 *     // Wrong entry, try next
 *   }
 * }
 * throw new Error('no matching recovery code')
 * ```
 *
 * @packageDocumentation
 */

import { generateULID } from '@noy-db/hub'

// Constants ────────────────────────────────────────────────────────────

/** RFC 4648 Base32 alphabet — A-Z + 2-7, no ambiguous chars. */
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** Characters to ignore on input (whitespace, hyphens, lowercase). */
const STRIPPABLE = /[\s\-_]/g

/** How many random bytes of entropy per code. */
const CODE_ENTROPY_BYTES = 15   // 15 bytes = 120 bits = exactly 24 Base32 chars (clean groups of 4)

/** Length of the checksum portion (Base32 chars). */
const CHECKSUM_LEN = 4           // 24 body + 4 checksum = 28 chars = 7 groups of 4

/** PBKDF2 iteration count — matches hub's passphrase-unlock derivation. */
const PBKDF2_ITERATIONS = 600_000

/** PBKDF2 output length — 32 bytes = 256-bit wrapping key. */
const PBKDF2_KEY_LENGTH = 32 * 8

/** Per-code salt length. */
const SALT_BYTES = 16

// Types ────────────────────────────────────────────────────────────────

/**
 * A single recovery-code enrollment entry. The caller stores this in
 * the vault's keyring alongside other unlock mechanisms.
 */
export interface RecoveryCodeEntry {
  /** Stable identifier for this code (ULID). Used by the caller to delete the entry on burn. */
  readonly codeId: string
  /** PBKDF2 salt for this code, base64-encoded. */
  readonly salt: string
  /** Wrapped KEK, base64-encoded. Unwrap with AES-KW using the code-derived key. */
  readonly wrappedKEK: string
  /** Timestamp the code was enrolled. */
  readonly enrolledAt: string
}

/** Options for `generateRecoveryCodeSet()`. */
export interface GenerateRecoveryCodeSetOptions {
  /** Number of codes to generate. Default 10. Reasonable: 8-20. */
  count?: number
  /** The vault's current KEK (unwrapped). Required — proves possession. */
  kek: CryptoKey
}

/** Result of `parseRecoveryCode()`. */
export type ParseResult =
  | { status: 'valid'; code: string }          // Normalized, checksum-verified
  | { status: 'invalid-checksum' }             // Format OK, checksum wrong
  | { status: 'invalid-format' }               // Not a valid code shape

// Code generation ──────────────────────────────────────────────────────

/**
 * Generate a fresh recovery-code set. The returned `codes` must be shown
 * to the user exactly once (print/save); the `entries` go into the
 * keyring for persistent storage.
 *
 * The caller is responsible for:
 * 1. Displaying the plaintext codes to the user ONCE.
 * 2. Writing `entries` into the vault's keyring.
 * 3. Writing an audit-ledger entry recording the enrollment.
 */
export async function generateRecoveryCodeSet(
  opts: GenerateRecoveryCodeSetOptions,
): Promise<{ codes: string[]; entries: RecoveryCodeEntry[] }> {
  const count = opts.count ?? 10
  if (!Number.isInteger(count) || count < 1 || count > 100) {
    throw new Error(`on-recovery: count must be 1-100 (got ${count})`)
  }

  const codes: string[] = []
  const entries: RecoveryCodeEntry[] = []
  const now = new Date().toISOString()

  for (let i = 0; i < count; i++) {
    const raw = generateRawCode()
    const formatted = formatCodeForDisplay(raw)
    const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES))
    const wrappingKey = await deriveRecoveryWrappingKey(raw, salt)
    const wrappedKEK = await wrapKEK(opts.kek, wrappingKey)

    codes.push(formatted)
    entries.push({
      codeId: generateULID(),
      salt: base64Encode(salt),
      wrappedKEK: base64Encode(wrappedKEK),
      enrolledAt: now,
    })
  }

  return { codes, entries }
}

// Code parsing + normalization ─────────────────────────────────────────

/**
 * Parse user input into a normalized recovery code. Accepts whitespace,
 * hyphens, and lowercase — strips them all. Verifies the checksum.
 */
export function parseRecoveryCode(input: string): ParseResult {
  const normalized = input.toUpperCase().replace(STRIPPABLE, '')

  const expectedLen = base32CharsForBytes(CODE_ENTROPY_BYTES) + CHECKSUM_LEN
  if (normalized.length !== expectedLen) {
    return { status: 'invalid-format' }
  }
  for (const ch of normalized) {
    if (!BASE32_ALPHABET.includes(ch)) {
      return { status: 'invalid-format' }
    }
  }

  const bodyLen = normalized.length - CHECKSUM_LEN
  const body = normalized.slice(0, bodyLen)
  const checksum = normalized.slice(bodyLen)

  if (computeChecksum(body) !== checksum) {
    return { status: 'invalid-checksum' }
  }

  return { status: 'valid', code: normalized }
}

/**
 * Format a normalized recovery code for display (groups of 4, hyphenated).
 * Inverse of the strip-hyphens step in `parseRecoveryCode`.
 */
export function formatRecoveryCode(normalizedCode: string): string {
  const groups: string[] = []
  for (let i = 0; i < normalizedCode.length; i += 4) {
    groups.push(normalizedCode.slice(i, i + 4))
  }
  return groups.join('-')
}

// Key derivation ───────────────────────────────────────────────────────

/**
 * Derive the AES-KW wrapping key from a recovery code + salt. Used for
 * both enrollment (wrap the KEK) and unlock (unwrap the KEK).
 *
 * @param code - A normalized recovery code (uppercase Base32, no
 *   hyphens/whitespace, checksum included).
 * @param salt - Per-code random salt from the stored entry.
 */
export async function deriveRecoveryWrappingKey(
  code: string,
  salt: Uint8Array,
): Promise<CryptoKey> {
  const password = new TextEncoder().encode(code)
  const baseKey = await crypto.subtle.importKey(
    'raw',
    password as BufferSource,
    'PBKDF2',
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: salt as BufferSource,
      iterations: PBKDF2_ITERATIONS,
    },
    baseKey,
    { name: 'AES-KW', length: PBKDF2_KEY_LENGTH },
    false,
    ['wrapKey', 'unwrapKey'],
  )
}

// KEK wrap/unwrap ──────────────────────────────────────────────────────

/**
 * Wrap a KEK with a recovery-code-derived wrapping key.
 * Returns raw bytes suitable for base64 encoding + storage.
 */
export async function wrapKEKForRecovery(
  kek: CryptoKey,
  code: string,
  salt: Uint8Array,
): Promise<Uint8Array> {
  const wrappingKey = await deriveRecoveryWrappingKey(code, salt)
  return wrapKEK(kek, wrappingKey)
}

/**
 * Unwrap the KEK using a recovery code + a stored entry.
 *
 * Throws (AES-KW authentication failure) if the code doesn't match
 * this entry. The caller typically iterates all enrolled entries and
 * catches the failure until one succeeds.
 *
 * On success, the caller MUST burn the entry — deleting `entry.codeId`
 * from the keyring — so the code can never be replayed.
 */
export async function unwrapKEKFromRecovery(
  code: string,
  entry: RecoveryCodeEntry,
): Promise<CryptoKey> {
  const salt = base64Decode(entry.salt)
  const wrappedKEK = base64Decode(entry.wrappedKEK)
  const wrappingKey = await deriveRecoveryWrappingKey(code, salt)

  return crypto.subtle.unwrapKey(
    'raw',
    wrappedKEK as BufferSource,
    wrappingKey,
    'AES-KW',
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

// Internals ────────────────────────────────────────────────────────────

function generateRawCode(): string {
  const entropy = crypto.getRandomValues(new Uint8Array(CODE_ENTROPY_BYTES))
  const body = base32Encode(entropy)
  const checksum = computeChecksum(body)
  return body + checksum
}

function formatCodeForDisplay(rawNormalized: string): string {
  return formatRecoveryCode(rawNormalized)
}

/**
 * Deterministic 4-character checksum over Base32 body. Catches
 * transcription errors (single-char swaps, shifted digits) with very
 * high probability.
 *
 * Uses a simple polynomial hash reduced modulo the Base32 alphabet
 * size (32). Four output chars = 20 bits ≈ 1-in-1M false positive.
 */
function computeChecksum(body: string): string {
  let h = 0
  for (let i = 0; i < body.length; i++) {
    const v = BASE32_ALPHABET.indexOf(body[i]!)
    h = (h * 33 + v) >>> 0
  }
  // Extract 4 Base32 chars from the 20 low bits
  const chars: string[] = []
  for (let i = 0; i < CHECKSUM_LEN; i++) {
    chars.push(BASE32_ALPHABET[(h >>> (i * 5)) & 0x1f]!)
  }
  return chars.join('')
}

function base32CharsForBytes(n: number): number {
  // Each 5 bytes → 8 Base32 chars. Partial-byte handling via ceil.
  return Math.ceil((n * 8) / 5)
}

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

async function wrapKEK(kek: CryptoKey, wrappingKey: CryptoKey): Promise<Uint8Array> {
  const wrapped = await crypto.subtle.wrapKey('raw', kek, wrappingKey, 'AES-KW')
  return new Uint8Array(wrapped)
}

function base64Encode(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!)
  // `btoa` is globally available in browsers, Node 16+, Deno, Bun.
  return btoa(s)
}

function base64Decode(str: string): Uint8Array {
  const s = atob(str)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}
