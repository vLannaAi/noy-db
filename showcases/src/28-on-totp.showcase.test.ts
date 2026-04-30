/**
 * Showcase 28 — TOTP (RFC 6238) second factor
 *
 * What you'll learn
 * ─────────────────
 * `generateSecret()` produces a base32 secret; `provisioningUri()` formats
 * the `otpauth://` URL that Google Authenticator, Authy, and 1Password
 * scan as a QR code. `generateCode()` is the deterministic 6-digit code
 * for the current 30-second window; `verify()` accepts the code with a
 * configurable skew window.
 *
 * Why it matters
 * ──────────────
 * Standard TOTP is the lingua franca of "what you have" second factors.
 * Pair this with passphrase unlock (showcase 22) to upgrade a vault from
 * one-factor to two-factor at zero infra cost.
 *
 * Prerequisites
 * ─────────────
 * - Showcase 22-on-passphrase.
 *
 * What to read next
 * ─────────────────
 *   - showcase 29-on-email-otp (transport-pluggable email second factor)
 *   - docs/subsystems/auth-totp.md
 *
 * Spec mapping
 * ────────────
 * features.yaml → auths → on-totp
 */

import { describe, it, expect } from 'vitest'
import { generateSecret, provisioningUri, generateCode, verify } from '@noy-db/on-totp'

describe('Showcase 28 — TOTP second factor', () => {
  it('provisioningUri produces a scannable otpauth:// URL', () => {
    const secret = generateSecret()
    const uri = provisioningUri(secret, { issuer: 'noy-db', account: 'alice@firm.example' })
    expect(uri.startsWith('otpauth://totp/')).toBe(true)
    expect(uri).toContain(encodeURIComponent('noy-db'))
    expect(uri).toContain('alice%40firm.example')
    expect(uri).toContain(`secret=${secret}`)
  })

  it('a freshly-generated code verifies against the same secret', async () => {
    const secret = generateSecret()
    const code = await generateCode(secret)
    expect(code).toMatch(/^\d{6}$/)
    expect(await verify(secret, code)).toBe(true)
    expect(await verify(secret, '000000')).toBe(false)
  })
})
