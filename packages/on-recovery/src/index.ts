/**
 * **@noy-db/on-recovery** — printable recovery codes for noy-db.
 *
 * The last-resort unlock path when the primary authentication is
 * unavailable. Codes are designed to be printed on paper and stored
 * in a safe — each code unlocks the vault exactly once and then is
 * burned by deleting its `_meta/recovery-paper` entry.
 *
 * Part of the `@noy-db/on-*` authentication family.
 *
 * ## Format (Option A)
 *
 * This package is now a **thin code-generator + parser layer over
 * the hub's `mintPaperRecoveryEntry` primitive**. Its job is exactly
 * three things:
 *
 * 1. Generate printable Base32 codes with checksums (the user-facing
 *    string format).
 * 2. Parse user input back into a normalized code (whitespace /
 *    hyphen / case insensitive).
 * 3. Delegate the wrapping crypto to the hub via
 *    `mintPaperRecoveryEntry(deks, code, codeId)`.
 *
 * This delegation aligns recovery with the hub's wrap-DEKs primitive
 * (the same shape used by `@noy-db/on-pin` and now `@noy-db/on-password`
 * after the wrap-DEKs path change). It eliminates the format mismatch
 * that made the previous package version unusable with `db.enrollRecovery`.
 *
 * ## Usage
 *
 * ```ts
 * import { generateRecoveryCodeSet, parseRecoveryCode } from '@noy-db/on-recovery'
 *
 * // ENROLL — after the user unlocks at tier 1, mint N codes
 * const keyring = await db.team.getKeyring('acme')
 * const { codes, entries } = await generateRecoveryCodeSet({ deks: keyring.deks, count: 10 })
 * showCodesToUser(codes)
 * await db.team.enrollRecovery('acme', { profile: 'paper', entries })
 *
 * // RECOVER — user types one back later (handled by db.recoverPassphrase)
 * const parsed = parseRecoveryCode(userInput)
 * if (parsed.status !== 'valid') return handleInvalid(parsed.status)
 * await db.team.recoverPassphrase('acme', {
 *   newPassphrase,
 *   recoveryProof: { profile: 'paper', payload: { code: parsed.code } },
 * })
 * ```
 *
 * @packageDocumentation
 */

import { generateULID, mintPaperRecoveryEntry, type PaperRecoveryEntry } from '@noy-db/hub'

// Constants ────────────────────────────────────────────────────────────

/** RFC 4648 Base32 alphabet — A-Z + 2-7, no ambiguous chars. */
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** Characters to ignore on input (whitespace, hyphens, lowercase). */
const STRIPPABLE = /[\s\-_]/g

/** How many random bytes of entropy per code. */
const CODE_ENTROPY_BYTES = 15   // 15 bytes = 120 bits = exactly 24 Base32 chars (clean groups of 4)

/** Length of the checksum portion (Base32 chars). */
const CHECKSUM_LEN = 4           // 24 body + 4 checksum = 28 chars = 7 groups of 4

// Types ────────────────────────────────────────────────────────────────

/** Options for `generateRecoveryCodeSet()`. */
export interface GenerateRecoveryCodeSetOptions {
  /** Number of codes to generate. Default 10. Reasonable: 8-20. */
  count?: number
  /**
   * The vault's current DEK set (typically `(await db.team.getKeyring(vault)).deks`).
   * Required — proves possession and is the input the hub's
   * `mintPaperRecoveryEntry` needs.
   */
  deks: Map<string, CryptoKey>
}

/** Result of `parseRecoveryCode()`. */
export type ParseResult =
  | { status: 'valid'; code: string }          // Normalized, checksum-verified
  | { status: 'invalid-checksum' }             // Format OK, checksum wrong
  | { status: 'invalid-format' }               // Not a valid code shape

// Code generation ──────────────────────────────────────────────────────

/**
 * Generate a fresh recovery-code set. Returned `codes` must be shown
 * to the user exactly once (print/save); `entries` go into the vault
 * via `db.team.enrollRecovery({ profile: 'paper', entries })`.
 *
 * Internally calls the hub's `mintPaperRecoveryEntry` once per code.
 * The hub's wrap-DEKs format is preserved end-to-end — `db.enrollRecovery`
 * stores the entries verbatim and `db.recoverPassphrase` consumes them
 * via `unwrapDeksFromPaperEntry`.
 */
export async function generateRecoveryCodeSet(
  opts: GenerateRecoveryCodeSetOptions,
): Promise<{ codes: string[]; entries: PaperRecoveryEntry[] }> {
  const count = opts.count ?? 10
  if (!Number.isInteger(count) || count < 1 || count > 100) {
    throw new Error(`on-recovery: count must be 1-100 (got ${count})`)
  }

  const codes: string[] = []
  const entries: PaperRecoveryEntry[] = []

  for (let i = 0; i < count; i++) {
    const raw = generateRawCode()
    const formatted = formatCodeForDisplay(raw)
    // The hub stores entries keyed on the NORMALIZED code (raw, no
    // hyphens). Mint with the normalized form so `db.recoverPassphrase`'s
    // `normalizePaperCode(input)` matches at unlock time.
    const entry = await mintPaperRecoveryEntry(opts.deks, raw, generateULID())
    codes.push(formatted)
    entries.push(entry)
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
  const chars: string[] = []
  for (let i = 0; i < CHECKSUM_LEN; i++) {
    chars.push(BASE32_ALPHABET[(h >>> (i * 5)) & 0x1f]!)
  }
  return chars.join('')
}

function base32CharsForBytes(n: number): number {
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
