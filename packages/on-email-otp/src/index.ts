/**
 * **@noy-db/on-email-otp** — email OTP second factor.
 *
 * Issues short-lived numeric codes, delivers via a **caller-supplied
 * transport** (SMTP / SES / Postmark / Resend / Mailgun / a test
 * sink), and verifies them in constant time with a one-use burn
 * guarantee.
 *
 * **Why no bundled SMTP client?** Every consumer already has an email
 * sender in their stack — coupling noy-db to a specific SMTP library
 * would pull in Node-only dependencies and complicate browser /
 * edge-worker usage. The transport abstraction is a single-method
 * interface; write a 5-line adapter for whatever you use today.
 *
 * ## Usage
 *
 * ```ts
 * import { issue, verify } from '@noy-db/on-email-otp'
 *
 * // Challenge issue (server side, post-passphrase)
 * const challenge = await issue({
 *   email: 'alice@example.com',
 *   ttlSeconds: 300,
 *   transport: async ({ to, code, expiresAt }) => {
 *     await smtp.send({ to, subject: 'Your code', text: `${code} — expires at ${expiresAt}` })
 *   },
 * })
 * // Store `challenge.record` somewhere the verifier can retrieve later.
 *
 * // Verify
 * const ok = await verify('123456', challenge.record)
 * ```
 *
 * ## Security model
 *
 * - Codes are 6-digit random numbers (by default) — 10⁶ space is
 *   fine because verification is rate-limited at the caller (by
 *   burning on success + a `maxAttempts` guard stored in the record).
 * - The record carries `sha256(code + salt)` — the plaintext code is
 *   never written to storage. Verification hashes the input with the
 *   stored salt and compares in constant time.
 * - `expiresAt` is enforced on every `verify()` — expired records are
 *   rejected before the hash comparison.
 * - Burn-on-success is the caller's responsibility — delete the
 *   record after a successful verify returns.
 *
 * @packageDocumentation
 */

export interface EmailOtpTransportArgs {
  readonly to: string
  readonly code: string
  readonly expiresAt: string
  readonly issuedAt: string
}

export type EmailOtpTransport = (args: EmailOtpTransportArgs) => Promise<void> | void

export interface IssueOptions {
  readonly email: string
  /** Seconds before the challenge expires. Default 300 (5 min). */
  readonly ttlSeconds?: number
  /** Code digits. Default 6. */
  readonly digits?: 6 | 7 | 8
  /** Maximum failed attempts before the record should be burned. Default 5. */
  readonly maxAttempts?: number
  /** Caller delivers the code here. Required. */
  readonly transport: EmailOtpTransport
}

export interface EmailOtpRecord {
  readonly email: string
  readonly digest: string        // hex SHA-256(code ⊕ salt)
  readonly salt: string          // hex
  readonly issuedAt: string
  readonly expiresAt: string
  readonly maxAttempts: number
  attempts: number
}

export interface IssueResult {
  readonly record: EmailOtpRecord
}

export interface VerifyResult {
  readonly ok: boolean
  /**
   * When `ok === false`, `reason` is one of:
   *  - `'expired'` — the record's `expiresAt` has passed.
   *  - `'mismatch'` — the digest didn't match.
   *  - `'locked'` — too many failed attempts; caller should burn.
   */
  readonly reason?: 'expired' | 'mismatch' | 'locked'
  readonly remainingAttempts?: number
}

/** Issue a new email OTP challenge. Calls the transport in the same tick. */
export async function issue(options: IssueOptions): Promise<IssueResult> {
  const digits = options.digits ?? 6
  const ttl = options.ttlSeconds ?? 300
  const maxAttempts = options.maxAttempts ?? 5

  const code = randomNumericCode(digits)
  const saltBytes = globalThis.crypto.getRandomValues(new Uint8Array(16))
  const salt = toHex(saltBytes)
  const digest = await hashCodeWithSalt(code, salt)

  const issuedAt = new Date()
  const expiresAt = new Date(issuedAt.getTime() + ttl * 1000)
  const record: EmailOtpRecord = {
    email: options.email,
    digest,
    salt,
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    maxAttempts,
    attempts: 0,
  }

  await options.transport({
    to: options.email,
    code,
    issuedAt: record.issuedAt,
    expiresAt: record.expiresAt,
  })

  return { record }
}

/**
 * Verify a user-entered code against a stored record. Increments
 * `attempts` on every call (pass or fail). Caller should delete the
 * record on success or when `remainingAttempts === 0`.
 */
export async function verify(input: string, record: EmailOtpRecord): Promise<VerifyResult> {
  if (record.attempts >= record.maxAttempts) {
    return { ok: false, reason: 'locked', remainingAttempts: 0 }
  }
  record.attempts += 1

  if (new Date(record.expiresAt).getTime() <= Date.now()) {
    return { ok: false, reason: 'expired', remainingAttempts: record.maxAttempts - record.attempts }
  }

  const digest = await hashCodeWithSalt(input, record.salt)
  if (!constantTimeEqual(digest, record.digest)) {
    return {
      ok: false,
      reason: record.attempts >= record.maxAttempts ? 'locked' : 'mismatch',
      remainingAttempts: record.maxAttempts - record.attempts,
    }
  }
  return { ok: true, remainingAttempts: record.maxAttempts - record.attempts }
}

// ── internals ─────────────────────────────────────────────────────────

function randomNumericCode(digits: number): string {
  // Rejection sampling to avoid modulo bias.
  const max = 10 ** digits
  const bytes = new Uint32Array(1)
  const threshold = Math.floor(0xffffffff / max) * max
  while (true) {
    globalThis.crypto.getRandomValues(bytes)
    if (bytes[0]! < threshold) {
      return (bytes[0]! % max).toString().padStart(digits, '0')
    }
  }
}

async function hashCodeWithSalt(code: string, saltHex: string): Promise<string> {
  const enc = new TextEncoder()
  const codeBytes = enc.encode(code)
  const saltBytes = fromHex(saltHex)
  const combined = new Uint8Array(codeBytes.length + saltBytes.length)
  combined.set(codeBytes, 0)
  combined.set(saltBytes, codeBytes.length)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', combined as BufferSource)
  return toHex(new Uint8Array(digest))
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}
