/**
 * Showcase 29 — Email OTP with transport abstraction
 *
 * What you'll learn
 * ─────────────────
 * `issue({ email, transport, ... })` mints a one-time code, calls the
 * supplied transport (you provide the SMTP/SES/Resend integration), and
 * returns a `record` you persist. `verify(input, record)` checks the
 * code with constant-time compare and enforces TTL + max-attempts.
 *
 * Why it matters
 * ──────────────
 * The package is transport-agnostic: noy-db never sends mail itself
 * (zero-knowledge core). You inject the transport, so SES, Resend, SMTP,
 * Postmark, in-house relays — they're all one-line swaps.
 *
 * Prerequisites
 * ─────────────
 * - Showcase 22-on-passphrase.
 *
 * What to read next
 * ─────────────────
 *   - showcase 30-on-pin (session-resume PIN)
 *   - docs/subsystems/auth-email-otp.md
 *
 * Spec mapping
 * ────────────
 * features.yaml → auths → on-email-otp
 */

import { describe, it, expect } from 'vitest'
import { issue, verify, type EmailOtpTransport, type EmailOtpTransportArgs } from '@noy-db/on-email-otp'

describe('Showcase 29 — Email OTP', () => {
  it('issue → verify round-trip with a mock transport', async () => {
    const sent: EmailOtpTransportArgs[] = []
    const transport: EmailOtpTransport = async (args) => {
      sent.push(args)
    }

    const { record } = await issue({ email: 'alice@firm.example', transport })
    expect(sent).toHaveLength(1)
    expect(sent[0]!.to).toBe('alice@firm.example')

    // The user types the code they received.
    const result = await verify(sent[0]!.code, record)
    expect(result.ok).toBe(true)
  })

  it('a wrong code is rejected with reason mismatch', async () => {
    const transport: EmailOtpTransport = async () => {}
    const { record } = await issue({ email: 'alice@firm.example', transport })

    const result = await verify('000000', record)
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('mismatch')
  })
})
