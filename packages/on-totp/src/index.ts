/**
 * **@noy-db/on-totp** — TOTP (RFC 6238) authenticator-app second factor.
 *
 * Generates TOTP secrets, produces the standard `otpauth://` provisioning
 * URI that authenticator apps parse from QR codes, and verifies
 * user-entered 6-digit codes in constant time.
 *
 * **Zero dependencies.** HMAC-SHA1 runs on the Web Crypto API
 * (`crypto.subtle`) — same ethos as the rest of noy-db.
 *
 * ## Security model
 *
 * TOTP is a **second factor**, not an independent strength multiplier.
 * The secret must live somewhere the verifier can read (otherwise no
 * one can validate codes), so a compromised verifier leaks the secret.
 * In noy-db the typical pattern is:
 *
 *   1. User sets a passphrase (primary factor). KEK derives via PBKDF2.
 *   2. On enroll, a TOTP secret is generated and stored **encrypted
 *      under the KEK** in the user's keyring.
 *   3. On unlock, the user enters passphrase → unwraps the secret →
 *      validates the entered code → proceeds only on match.
 *
 * This adds "something you have" on top of "something you know" but
 * does not defend against a passphrase-KEK compromise. For real
 * hardware-backed second factor, use `@noy-db/on-webauthn`.
 *
 * ## API
 *
 * ```ts
 * import { generateSecret, provisioningUri, verify, generateCode } from '@noy-db/on-totp'
 *
 * // Enroll
 * const secret = generateSecret()
 * const uri = provisioningUri(secret, { account: 'alice@acme.com', issuer: 'Acme' })
 * // Show QR code of `uri`.
 *
 * // Unlock
 * const ok = await verify(secret, userEnteredCode)
 * ```
 *
 * @packageDocumentation
 */

// ─── Base32 encoding (RFC 4648, no padding) ─────────────────────────────

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** Encode raw bytes as RFC 4648 Base32 (no padding — authenticator apps accept this). */
export function encodeBase32(bytes: Uint8Array): string {
  let out = ''
  let buf = 0
  let bits = 0
  for (const b of bytes) {
    buf = (buf << 8) | b
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out += BASE32_ALPHABET[(buf >> bits) & 0x1f]
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(buf << (5 - bits)) & 0x1f]
  }
  return out
}

/** Decode RFC 4648 Base32 (case-insensitive, padding-tolerant, whitespace-stripped). */
export function decodeBase32(input: string): Uint8Array {
  const cleaned = input.replace(/\s|=/g, '').toUpperCase()
  const bytes: number[] = []
  let buf = 0
  let bits = 0
  for (const ch of cleaned) {
    const v = BASE32_ALPHABET.indexOf(ch)
    if (v < 0) throw new Error(`Invalid Base32 character: "${ch}"`)
    buf = (buf << 5) | v
    bits += 5
    if (bits >= 8) {
      bits -= 8
      bytes.push((buf >> bits) & 0xff)
    }
  }
  return new Uint8Array(bytes)
}

// ─── Secret generation ──────────────────────────────────────────────────

/** Random 20-byte (160-bit) TOTP secret — RFC 4226 recommended minimum. */
export function generateSecret(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(20))
  return encodeBase32(bytes)
}

// ─── Provisioning URI ───────────────────────────────────────────────────

export interface ProvisioningUriOptions {
  /** Account label shown in the authenticator — typically the user's email. */
  readonly account: string
  /** Issuer name shown in the authenticator — your product name. */
  readonly issuer?: string
  /** Code digits. Default 6. */
  readonly digits?: 6 | 7 | 8
  /** Step in seconds. Default 30. */
  readonly period?: number
  /** Hash algorithm. Default SHA1 (compatibility — Google Authenticator etc.). */
  readonly algorithm?: 'SHA1' | 'SHA256' | 'SHA512'
}

/** Build a standard `otpauth://totp/` URI that authenticator apps parse from QR codes. */
export function provisioningUri(secret: string, options: ProvisioningUriOptions): string {
  const issuer = options.issuer
  const label = issuer
    ? `${encodeURIComponent(issuer)}:${encodeURIComponent(options.account)}`
    : encodeURIComponent(options.account)

  const params = new URLSearchParams({
    secret,
    algorithm: options.algorithm ?? 'SHA1',
    digits: String(options.digits ?? 6),
    period: String(options.period ?? 30),
  })
  if (issuer) params.set('issuer', issuer)

  return `otpauth://totp/${label}?${params.toString()}`
}

// ─── Code generation + verification ─────────────────────────────────────

export interface TotpOptions {
  readonly digits?: 6 | 7 | 8
  readonly period?: number
  readonly algorithm?: 'SHA1' | 'SHA256' | 'SHA512'
}

export interface VerifyOptions extends TotpOptions {
  /**
   * Clock-drift tolerance window, in steps before/after the current
   * interval. `1` (default) accepts the current step ± 1. `0` is
   * strictly exact — authenticators rarely stay that precise.
   */
  readonly window?: number
  /** Override "now" for deterministic tests. */
  readonly timestamp?: number
}

/** Compute the TOTP code for the given secret at the current time. */
export async function generateCode(secret: string, options: TotpOptions = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return codeAt(secret, now, options)
}

/**
 * Verify a user-entered code against the secret. Constant-time comparison;
 * accepts drift within `window` steps.
 */
export async function verify(secret: string, code: string, options: VerifyOptions = {}): Promise<boolean> {
  const digits = options.digits ?? 6
  if (code.length !== digits) return false
  const window = options.window ?? 1
  const now = options.timestamp ?? Math.floor(Date.now() / 1000)
  const period = options.period ?? 30
  const step = Math.floor(now / period)

  // Gather the candidate codes and do constant-time equality — avoids the
  // wall-clock timing oracle on mismatches.
  let matched = false
  for (let i = -window; i <= window; i++) {
    const candidate = await codeAtStep(secret, step + i, options)
    if (constantTimeEqual(candidate, code)) matched = true
  }
  return matched
}

async function codeAt(secret: string, timestamp: number, options: TotpOptions): Promise<string> {
  const period = options.period ?? 30
  return codeAtStep(secret, Math.floor(timestamp / period), options)
}

async function codeAtStep(secret: string, step: number, options: TotpOptions): Promise<string> {
  const digits = options.digits ?? 6
  const algorithm = options.algorithm ?? 'SHA1'

  const keyBytes = decodeBase32(secret)
  // 8-byte big-endian step counter (HOTP/TOTP convention).
  const counter = new Uint8Array(8)
  let s = step
  for (let i = 7; i >= 0; i--) {
    counter[i] = s & 0xff
    s = Math.floor(s / 256)
  }

  const hmacName = algorithm === 'SHA1' ? 'SHA-1' : algorithm === 'SHA256' ? 'SHA-256' : 'SHA-512'
  const cryptoKey = await globalThis.crypto.subtle.importKey(
    'raw',
    keyBytes as BufferSource,
    { name: 'HMAC', hash: hmacName },
    false,
    ['sign'],
  )
  const signature = new Uint8Array(
    await globalThis.crypto.subtle.sign('HMAC', cryptoKey, counter as BufferSource),
  )

  // Dynamic truncation per RFC 4226 §5.3.
  const offset = signature[signature.length - 1]! & 0x0f
  const binary =
    ((signature[offset]! & 0x7f) << 24) |
    ((signature[offset + 1]! & 0xff) << 16) |
    ((signature[offset + 2]! & 0xff) << 8) |
    (signature[offset + 3]! & 0xff)

  const modulus = 10 ** digits
  const otp = (binary % modulus).toString().padStart(digits, '0')
  return otp
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}
