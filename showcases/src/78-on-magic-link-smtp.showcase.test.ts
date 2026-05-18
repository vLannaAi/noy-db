/**
 * Showcase 78 — on-magic-link delivered via real SMTP
 *
 * What you'll learn
 * ─────────────────
 * `@noy-db/on-magic-link/invite` mints a one-shot, atomic invite for
 * a NEW user: `issueInvite(db, vault, { userId, displayName, role })`
 * grants the recipient under a freshly-generated temp phrase, writes
 * the audit doc to `_meta/invite-audit-<tokenId>`, and returns an
 * `encoded` string ready to drop after the `#` of an URL. The
 * recipient redeems via `acceptInvite(encoded, { store, newPhrase })`,
 * which atomically rotates from the temp phrase to the recipient's
 * own — single-use by construction (the rotation invalidates the
 * temp phrase; the audit doc's `acceptedAt` field locks the second
 * call).
 *
 * Showcase 25 covers the in-process roundtrip — issue + claim
 * happen in the same JS heap. This showcase wires the **email
 * delivery channel** that real consumers ship: send the URL to the
 * recipient's inbox via nodemailer, scrape it back out via IMAP (or
 * have the operator paste it manually), pass to `acceptInvite`,
 * verify the post-accept vault state and that the second redemption
 * attempt rejects with `InviteAlreadyAcceptedError`.
 *
 * Why it matters
 * ──────────────
 * The cryptographic single-use guarantee is structural — the
 * rotation inside `acceptInvite` invalidates the temp phrase
 * regardless of how the URL got delivered. But the **integration**
 * — that the URL survives email transit (subject-line line-wrapping,
 * SMTP encoding, mail-client URL extraction), that an HTML mailer
 * doesn't escape characters in the fragment, that the recipient's
 * paste path produces a string `acceptInvite` accepts — is what
 * shipping consumers actually trip on. This showcase exercises that
 * end-to-end.
 *
 * Two run modes
 * ─────────────
 * - **Auto** — `SMTP_*` and `SMTP_IMAP_*` are both set; CI mode.
 * - **Manual** — only `SMTP_*` set; prompts on stdout. Skipped under
 *   CI to avoid hanging.
 *
 * Prerequisites
 * ─────────────
 * - `NOYDB_SHOWCASE_SMTP_*` (six vars) in `showcases/.env`.
 * - Optional `NOYDB_SHOWCASE_SMTP_IMAP_*` for auto mode.
 *
 * Spec mapping
 * ────────────
 * features.yaml → auths → on-magic-link
 *
 * Acceptance (per #67)
 * ────────────────────
 *   ✓ Real email with magic link arrives at configured address
 *   ✓ acceptInvite succeeds on first call
 *   ✓ Second call with same token throws InviteAlreadyAcceptedError
 *   ✓ Audit doc persisted at `_meta/invite-audit-<tokenId>` with `acceptedAt`
 *   ✓ Skipped with hint when SMTP env unset
 */

import { afterAll, describe, expect, it } from 'vitest'
import { createNoydb, type EncryptedEnvelope } from '@noy-db/hub'
import { memory } from '@noy-db/to-memory'
import {
  acceptInvite,
  InviteAlreadyAcceptedError,
  issueInvite,
} from '@noy-db/on-magic-link'
import { envGate, logSkipHint, SMTP_GATE_VARS, SMTP_IMAP_GATE_VARS } from './_env.js'
import {
  buildNodemailerTransport, isCi, pollInboxForLatest, promptStdin,
  resolveImapEnv, resolveSmtpEnv,
} from './_smtp.js'

const smtpGate = envGate({ label: 'on-magic-link (smtp)', vars: SMTP_GATE_VARS })
const imapGate = envGate({ label: 'on-magic-link (smtp-imap)', vars: SMTP_IMAP_GATE_VARS })
logSkipHint('on-magic-link (smtp)', smtpGate, SMTP_GATE_VARS)

const enabled = smtpGate.enabled
const mode: 'auto' | 'manual' | 'skip' =
  !enabled ? 'skip'
  : imapGate.enabled ? 'auto'
  : isCi() ? 'skip'
  : 'manual'

if (enabled && mode === 'skip') {
  // eslint-disable-next-line no-console
  console.info(
    '[on-magic-link (smtp)] Skipping under CI — manual stdin mode is not safe ' +
      'for automated runs. Configure NOYDB_SHOWCASE_SMTP_IMAP_* to opt into auto mode.',
  )
}

let transportHandle: { close(): void } | null = null
afterAll(() => {
  if (transportHandle) {
    try { transportHandle.close() } catch { /* swallow */ }
  }
})

const VAULT = 'showcase-78-vault'
const ISSUER = 'alice'
const ISSUER_PHRASE = 'correct horse battery staple printer toaster'
const RECIPIENT = 'bob'
const RECIPIENT_NEW_PHRASE = 'fresh horse battery staple printer toaster'
const APP_BASE_URL = 'https://noydb.example.test/accept'

interface Note { id: string; text: string }

describe.skipIf(mode === 'skip')(
  `Showcase 78 — on-magic-link via real SMTP (${mode} mode)`,
  () => {
    const smtp = resolveSmtpEnv(smtpGate.values)
    const imap = imapGate.enabled ? resolveImapEnv(imapGate.values) : null

    it(
      'issues a real invite, delivers via SMTP, accepts via real link, replay rejects',
      async () => {
        // ─── Setup: issuer's vault ────────────────────────────
        // Shared store so the issuer's grant + audit doc are
        // reachable by the recipient's acceptInvite call. In a
        // real deployment, the store is whatever sync backend
        // both peers point at.
        const store = memory()
        const issuerDb = await createNoydb({
          store, user: ISSUER, secret: ISSUER_PHRASE,
        })
        const vault = await issuerDb.openVault(VAULT)
        await vault.collection<Note>('notes').put('a', { id: 'a', text: 'hello bob' })

        // ─── Issue invite + send email ───────────────────────
        const { encoded, payload } = await issueInvite(issuerDb, VAULT, {
          userId: RECIPIENT,
          displayName: 'Bob',
          role: 'viewer',
          ttlMs: 5 * 60_000,
        })
        const url = `${APP_BASE_URL}#${encoded}`

        // Per-run tag — disambiguates this run's message from any
        // older showcase 78 messages still in the inbox.
        const runTag = `t${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
        const handle = await buildNodemailerTransport(smtp)
        transportHandle = handle
        const subject = `noy-db showcase 78 [${runTag}] invitation to ${VAULT}`
        // eslint-disable-next-line no-console
        console.info(`[on-magic-link (smtp)] sending invite to ${smtp.to} (token ${payload.tokenId})`)
        const pollSince = new Date(Date.now() - 5_000)
        await handle.sendMail({
          from: smtp.from,
          to: smtp.to,
          subject,
          // The body deliberately puts the URL on its own line so
          // the auto-mode regex below has a clean anchor. The
          // `#`-fragment carries the entire payload — query strings
          // are deliberately avoided because some MTAs / mail
          // clients re-encode `=` and `+` characters in query
          // strings but leave fragments untouched.
          text:
            `You've been invited to vault "${VAULT}" by ${payload.issuer}.\n\n` +
            `Open this URL to accept (single-use, expires ${payload.expiresAt}):\n\n` +
            `    ${url}\n\n` +
            `If you didn't expect this, you can ignore the message — the invite ` +
            `expires automatically.\n`,
        })

        // ─── Pull the URL back out ───────────────────────────
        let pastedUrl: string
        if (mode === 'auto' && imap) {
          const message = await pollInboxForLatest(imap, {
            since: pollSince,
            subjectContains: runTag,
            timeoutMs: parsePollTimeoutMs(360_000),
            intervalMs: 6_000,
          })
          // Match any URL on the configured app base — the fragment
          // is base64url so it has no `#`/`?`/whitespace inside.
          const escaped = APP_BASE_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          const m = message.body.match(new RegExp(`${escaped}#[A-Za-z0-9_\\-]+`))
          if (!m?.[0]) {
            throw new Error(
              `[on-magic-link (smtp)] auto mode could not locate the magic-link URL in the body:\n${message.body.slice(0, 600)}`,
            )
          }
          pastedUrl = m[0]
          // eslint-disable-next-line no-console
          console.info(`[on-magic-link (smtp)] auto-scraped URL from "${message.subject}"`)
        } else {
          pastedUrl = await promptStdin(
            `[on-magic-link (smtp)] paste the magic-link URL from ${smtp.to}: `,
          )
        }

        // ─── Accept invite ───────────────────────────────────
        // Pull the encoded payload out of the URL fragment — same
        // step the recipient's app does on click.
        const hashIdx = pastedUrl.indexOf('#')
        const tokenFromUrl = hashIdx >= 0 ? pastedUrl.slice(hashIdx + 1) : pastedUrl
        expect(tokenFromUrl).toBe(encoded)

        const { db: recipientDb, payload: acceptedPayload } = await acceptInvite(tokenFromUrl, {
          store,
          newPhrase: RECIPIENT_NEW_PHRASE,
        })
        expect(acceptedPayload.userId).toBe(RECIPIENT)

        // Recipient sees the issuer's record decrypted under their
        // own (now-rotated) keyring.
        const recipientVault = await recipientDb.openVault(VAULT)
        expect(await recipientVault.collection<Note>('notes').get('a')).toEqual({
          id: 'a', text: 'hello bob',
        })
        recipientDb.close()

        // ─── Audit doc persisted with acceptedAt ─────────────
        const auditEnv = await store.get(VAULT, '_meta', `invite-audit-${payload.tokenId}`)
        expect(auditEnv).not.toBeNull()
        // The audit doc bypasses encryption (same envelope shape as
        // `_keyring`); _data is plain JSON we can parse directly.
        const audit = JSON.parse((auditEnv as EncryptedEnvelope)._data) as { acceptedAt?: string }
        expect(audit.acceptedAt).toBeTruthy()
        expect(typeof audit.acceptedAt).toBe('string')

        // ─── Replay: second acceptInvite must reject ─────────
        await expect(
          acceptInvite(tokenFromUrl, {
            store,
            newPhrase: 'second horse battery staple printer toaster',
          }),
        ).rejects.toBeInstanceOf(InviteAlreadyAcceptedError)

        issuerDb.close()
      },
      450_000,
    )
  },
)

/** Same override as showcase 77. */
function parsePollTimeoutMs(defaultMs: number): number {
  const raw = process.env['NOYDB_SHOWCASE_SMTP_POLL_MS']
  if (!raw) return defaultMs
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : defaultMs
}
