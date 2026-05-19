/**
 * Showcase 77 — on-email-otp delivered via real SMTP
 *
 * What you'll learn
 * ─────────────────
 * `@noy-db/on-email-otp` is **transport-agnostic** by design — it
 * mints the code, salts + hashes it for the record, and hands the
 * plaintext code to a caller-supplied `transport` callback exactly
 * once. Showcase 29 covers the in-process roundtrip with a sink-mock
 * transport. This showcase plugs in a **real nodemailer SMTP
 * transport** to deliver the code to a mailbox you control, then
 * verifies that the code typed back in (auto-scraped from IMAP, or
 * pasted manually) round-trips through `verify()`.
 *
 * Why it matters
 * ──────────────
 * The mocked path proves the package's crypto is correct. The
 * real-provider path proves the **integration contract** is correct
 * — that the transport callback signature is the right shape for
 * the email-sending APIs developers actually use, that the
 * `expiresAt` ISO string serializes as expected, that the code
 * survives the SMTP encoding round-trip without mutation.
 *
 * Two run modes
 * ─────────────
 * - **Auto** — when both `SMTP_*` and `SMTP_IMAP_*` env families are
 *   set, the showcase polls the inbox via `imapflow`, scrapes the
 *   6-digit code out of the email body, and completes verify
 *   in-test. CI runs this.
 * - **Manual** — when only `SMTP_*` is set, the showcase prompts on
 *   stdout for the operator to paste the code from their email
 *   client. **Skipped under CI** (`process.env.CI`) so an
 *   IMAP-less config never hangs an automated run.
 *
 * Prerequisites
 * ─────────────
 * - `NOYDB_SHOWCASE_SMTP_*` (six vars) in `showcases/.env`.
 * - Optionally `NOYDB_SHOWCASE_SMTP_IMAP_*` (four vars) for auto mode.
 * - `pnpm install` (deps: `nodemailer`, `imapflow`).
 *
 * Spec mapping
 * ────────────
 * features.yaml → auths → on-email-otp
 *
 * Acceptance (per #66)
 * ────────────────────
 *   ✓ One real email arrives at the configured address
 *   ✓ verify() succeeds against the real OTP
 *   ✓ Skipped with hint when SMTP env unset
 *   ✓ No SMTP creds committed (env-driven only)
 */

import { afterAll, describe, expect, it } from 'vitest'
import { issue, verify, type EmailOtpTransport } from '@noy-db/on-email-otp'
import { envGate, logSkipHint, SMTP_GATE_VARS, SMTP_IMAP_GATE_VARS } from './_env.js'
import {
  isCi, pollInboxForLatest, promptStdin, resolveImapEnv, resolveSmtpEnv,
  buildNodemailerTransport,
} from './_smtp.js'

/**
 * Per-provider override knob. SMTP-relay providers vary wildly in
 * inbound queue latency — set NOYDB_SHOWCASE_SMTP_POLL_MS=900000 (15 min)
 * for greylisting / virus-scanning providers that consistently
 * delay 5+ min.
 */
function parsePollTimeoutMs(defaultMs: number): number {
  const raw = process.env['NOYDB_SHOWCASE_SMTP_POLL_MS']
  if (!raw) return defaultMs
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : defaultMs
}

const smtpGate = envGate({ label: 'on-email-otp (smtp)', vars: SMTP_GATE_VARS })
const imapGate = envGate({ label: 'on-email-otp (smtp-imap)', vars: SMTP_IMAP_GATE_VARS })
logSkipHint('on-email-otp (smtp)', smtpGate, SMTP_GATE_VARS)

const enabled = smtpGate.enabled
// Manual mode requires a human at the keyboard — never run it in CI.
const mode: 'auto' | 'manual' | 'skip' =
  !enabled ? 'skip'
  : imapGate.enabled ? 'auto'
  : isCi() ? 'skip'
  : 'manual'

if (enabled && mode === 'skip') {
  // SMTP is set but IMAP isn't AND we're in CI — surface the reason
  // so the run log explains the unexpected skip.
  // eslint-disable-next-line no-console
  console.info(
    '[on-email-otp (smtp)] Skipping under CI — manual stdin mode is not safe ' +
      'for automated runs. Configure NOYDB_SHOWCASE_SMTP_IMAP_* to opt into auto mode.',
  )
}

// One transport instance is reused across every test in the file.
// nodemailer pools the connection internally; closing in afterAll
// releases the socket cleanly.
let transportHandle: { close(): void } | null = null

afterAll(() => {
  if (transportHandle) {
    try { transportHandle.close() } catch { /* swallow */ }
  }
})

describe.skipIf(mode === 'skip')(
  `Showcase 77 — on-email-otp via real SMTP (${mode} mode)`,
  () => {
    const smtp = resolveSmtpEnv(smtpGate.values)
    const imap = imapGate.enabled ? resolveImapEnv(imapGate.values) : null

    it('delivers a real OTP via SMTP and verifies the code round-trips', async () => {
      // Per-run tag — the IMAP search is wide (24h window) because
      // server `internalDate` lags actual delivery; the unique tag
      // is what disambiguates THIS run's message from any
      // leftovers in the mailbox.
      const runTag = `t${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
      const transport: EmailOtpTransport = async ({ to, code, expiresAt }) => {
        const handle = await buildNodemailerTransport(smtp)
        transportHandle = handle
        const subject = `noy-db showcase 77 [${runTag}] verification code`
        // eslint-disable-next-line no-console
        console.info(`[on-email-otp (smtp)] sending OTP to ${to} (expires ${expiresAt})`)
        await handle.sendMail({
          from: smtp.from,
          to,
          subject,
          // The body deliberately puts the code on its own line so
          // the auto-mode regex below has a clean anchor.
          text:
            `Your noy-db showcase verification code:\n\n` +
            `    ${code}\n\n` +
            `Expires at ${expiresAt}.\n` +
            `Issued by the @noy-db/on-email-otp showcase test suite. ` +
            `If you weren't running it, you can ignore this message.\n`,
        })
      }

      // The window in which auto-mode polls IMAP — anchor it just
      // before we send. The fixture widens it by 24h internally to
      // tolerate IMAP `SINCE` date-only granularity; the per-run
      // tag is what makes the match unique.
      const pollSince = new Date(Date.now() - 5_000)
      const { record } = await issue({
        email: smtp.to,
        ttlSeconds: 300,
        transport,
      })

      let typedCode: string
      if (mode === 'auto' && imap) {
        const message = await pollInboxForLatest(imap, {
          since: pollSince,
          subjectContains: runTag,
          // Wide window — some providers delay 3+ min before INBOX
          // delivery (greylisting / queue / virus-scan). Override
          // with NOYDB_SHOWCASE_SMTP_POLL_MS for slower providers.
          timeoutMs: parsePollTimeoutMs(360_000),
          intervalMs: 6_000,
        })
        const m = message.body.match(/\b(\d{6,8})\b/)
        if (!m?.[1]) {
          throw new Error(
            `[on-email-otp (smtp)] auto mode could not locate a 6-8 digit code in the body:\n${message.body.slice(0, 400)}`,
          )
        }
        typedCode = m[1]
        // eslint-disable-next-line no-console
        console.info(`[on-email-otp (smtp)] auto-scraped code from "${message.subject}"`)
      } else {
        typedCode = await promptStdin(
          `[on-email-otp (smtp)] paste the 6-digit code from ${smtp.to}: `,
        )
      }

      const result = await verify(typedCode, record)
      expect(result.ok).toBe(true)
      expect(record.attempts).toBe(1)
    }, 420_000)

    it('a wrong code is rejected with reason mismatch (no SMTP needed for the negative path)', async () => {
      // The negative path doesn't need to hit SMTP again — fast sink
      // transport so the run stays short. Verifies that the verify
      // contract holds the same way it does in showcase 29.
      const sink: EmailOtpTransport = async () => { /* drop on the floor */ }
      const { record } = await issue({ email: smtp.to, transport: sink })
      const result = await verify('000000', record)
      expect(result.ok).toBe(false)
      expect(result.reason).toBe('mismatch')
    })
  },
)
