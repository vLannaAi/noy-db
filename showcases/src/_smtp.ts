/**
 * SMTP + IMAP fixture for the email-OTP and magic-link real-provider
 * showcases (#66, #67).
 *
 * Two responsibilities, one file:
 *
 *   1. **Send** — `smtpTransport(env)` returns an
 *      `EmailOtpTransport`-shaped function that hands the OTP / link
 *      payload to nodemailer for real SMTP delivery. Reused unchanged
 *      by both showcases.
 *
 *   2. **Receive** — `pollInboxForLatest(env, predicate, opts)` opens
 *      an IMAP connection (when configured), polls the mailbox until
 *      a message arrives that matches the caller's predicate, and
 *      returns the body. Used to scrape the OTP code out of the
 *      delivered email or the magic-link URL out of the invite.
 *
 * Mode selection lives at the call site:
 *
 *   - `auto` — IMAP env is set, no human in the loop. CI runs this.
 *   - `manual` — IMAP env unset, prompt on stdin. Skipped under CI
 *     (`process.env.CI` truthy) so a missing IMAP config never hangs
 *     a CI run.
 *
 * No state is persisted between calls — a fresh nodemailer transport
 * + a fresh imapflow client per ceremony. The showcase suite runs in
 * tens of seconds; pooling adds complexity without buying anything
 * material.
 *
 * @module
 */

import { createInterface } from 'node:readline/promises'

/**
 * Resolved env values (string-typed; the gate has already verified
 * presence). The showcase gate calls `envGate({ vars: SMTP_GATE_VARS })`
 * and passes the resulting `values` map into `resolveSmtpEnv` below.
 */
export interface SmtpEnv {
  readonly host: string
  readonly port: number
  readonly user: string
  readonly pass: string
  readonly from: string
  readonly to: string
}

export interface ImapEnv {
  readonly host: string
  readonly port: number
  readonly user: string
  readonly pass: string
  readonly mailbox: string
}

/**
 * Pull the six SMTP vars out of a gate's `values` map and coerce
 * `port` to a number. Throws on a non-numeric port — the showcase's
 * gate caught the absence; this catches the typo.
 */
export function resolveSmtpEnv(values: Record<string, string | undefined>): SmtpEnv {
  const portStr = values['NOYDB_SHOWCASE_SMTP_PORT'] ?? ''
  const port = Number.parseInt(portStr, 10)
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error(
      `[smtp-fixture] NOYDB_SHOWCASE_SMTP_PORT must be a valid port number; got "${portStr}".`,
    )
  }
  return {
    host: values['NOYDB_SHOWCASE_SMTP_HOST']!,
    port,
    user: values['NOYDB_SHOWCASE_SMTP_USER']!,
    pass: values['NOYDB_SHOWCASE_SMTP_PASS']!,
    from: values['NOYDB_SHOWCASE_SMTP_FROM']!,
    to: values['NOYDB_SHOWCASE_SMTP_TO']!,
  }
}

/**
 * Pull the four IMAP vars out of a gate's `values` map. Returns
 * `null` when any var is missing — the showcase falls back to manual
 * mode in that case.
 */
export function resolveImapEnv(values: Record<string, string | undefined>): ImapEnv | null {
  const host = values['NOYDB_SHOWCASE_SMTP_IMAP_HOST']
  const portStr = values['NOYDB_SHOWCASE_SMTP_IMAP_PORT']
  const user = values['NOYDB_SHOWCASE_SMTP_IMAP_USER']
  const pass = values['NOYDB_SHOWCASE_SMTP_IMAP_PASS']
  if (!host || !portStr || !user || !pass) return null
  const port = Number.parseInt(portStr, 10)
  if (!Number.isFinite(port) || port <= 0 || port > 65535) return null
  return {
    host, port, user, pass,
    mailbox: values['NOYDB_SHOWCASE_SMTP_IMAP_MAILBOX'] ?? 'INBOX',
  }
}

// ─── Send ──────────────────────────────────────────────────────────────

/**
 * Build a nodemailer transport configured from the resolved SMTP env.
 *
 * Lazy-imports nodemailer so a missing `pnpm install` reports through
 * the gate's hint rather than a module-load crash. STARTTLS (port
 * 587) and implicit TLS (port 465) are auto-negotiated by nodemailer
 * via the `secure` flag — port 465 ⇒ secure, everything else ⇒
 * upgrade.
 */
export async function buildNodemailerTransport(env: SmtpEnv): Promise<{
  sendMail(opts: { from: string; to: string; subject: string; text: string }): Promise<unknown>
  close(): void
}> {
  const nodemailer = await import('nodemailer')
  const transport = nodemailer.default.createTransport({
    host: env.host,
    port: env.port,
    secure: env.port === 465,
    auth: env.user ? { user: env.user, pass: env.pass } : undefined,
  })
  return transport
}

/**
 * Send a one-shot email. Convenience wrapper around the nodemailer
 * transport so call sites stay one-liners. Closes the transport
 * after send so each ceremony is self-contained.
 */
export async function sendOnce(env: SmtpEnv, subject: string, body: string): Promise<void> {
  const transport = await buildNodemailerTransport(env)
  try {
    await transport.sendMail({ from: env.from, to: env.to, subject, text: body })
  } finally {
    transport.close()
  }
}

// ─── Receive ───────────────────────────────────────────────────────────

export interface PollInboxOptions {
  /** How long to wait before giving up. Default 60 seconds. */
  readonly timeoutMs?: number
  /** Polling cadence between IMAP fetches. Default 3 seconds. */
  readonly intervalMs?: number
  /** Only consider messages newer than this Date. Default `now` at call time. */
  readonly since?: Date
  /**
   * Subject substring to filter on. Helps avoid scraping unrelated
   * recent mail when the showcase suite shares the mailbox with a
   * developer's other testing.
   */
  readonly subjectContains?: string
}

/**
 * Poll the IMAP mailbox until a message arrives that matches
 * `subjectContains` (when supplied) and `since`. Returns the message
 * body (text/plain preferred; falls back to the first text part).
 *
 * The function loops with `intervalMs` cadence between IMAP fetches
 * and bails after `timeoutMs`. Throws on timeout — the showcase's
 * `it.timeout` wraps this so a stuck IMAP run surfaces as a regular
 * test failure, not a hang.
 */
export async function pollInboxForLatest(
  env: ImapEnv,
  options: PollInboxOptions = {},
): Promise<{ subject: string; body: string; receivedAt: Date }> {
  const { ImapFlow } = (await import('imapflow')) as unknown as {
    ImapFlow: new (config: {
      host: string; port: number; secure: boolean
      auth: { user: string; pass: string }
      logger: false
    }) => {
      connect(): Promise<void>
      logout(): Promise<void>
      mailboxOpen(name: string): Promise<unknown>
      search(query: { since: Date }): Promise<number[]>
      fetchOne(uid: string | number, fields: { source: boolean; envelope: boolean; internalDate: boolean }): Promise<{
        source: Buffer; envelope: { subject: string }; internalDate: Date
      } | null>
    }
  }

  const timeoutMs = options.timeoutMs ?? 60_000
  const intervalMs = options.intervalMs ?? 3_000
  const since = options.since ?? new Date()
  const deadline = Date.now() + timeoutMs

  const client = new ImapFlow({
    host: env.host, port: env.port, secure: true,
    auth: { user: env.user, pass: env.pass },
    // imapflow's default logger writes to stdout — noisy under
    // vitest's verbose reporter. False keeps the showcase output
    // clean.
    logger: false,
  })

  // Folders the poll will check, in priority order. Some servers
  // auto-route bot-looking messages to Junk or even Deleted Items
  // — checking only INBOX gives a false-negative timeout. The
  // configured mailbox always goes first; the well-known fallback
  // folders fill in for the common server-side filter rules. The
  // exact paths vary by server (Outlook uses 'Junk E-mail';
  // Gmail uses '[Gmail]/Spam' etc.) — IMAP `LIST` would be more
  // robust but adds round-trips; this set covers the common cases.
  const candidateFolders = [
    env.mailbox,
    'INBOX',
    'Junk E-mail', 'Junk', '[Gmail]/Spam', 'Spam',
    'Deleted Items', 'Trash', '[Gmail]/Trash',
  ].filter((v, i, a) => a.indexOf(v) === i)

  await client.connect()
  try {
    // IMAP's `SINCE` keyword has **date-only granularity** per RFC 3501,
    // and many providers post-date `internalDate` by seconds-to-minutes
    // when SMTP delivery is queued (greylisting, virus-scan, throttling).
    // We use a wide search window (24h before `since`) and filter on
    // subject in-memory so a slow-arriving message we just sent is
    // reachable. The newer-than-`since` discriminator is gone — subject
    // is the discriminator now, which the caller is responsible for
    // making unique enough (the showcases append a random tag).
    const widenedSince = new Date(since.getTime() - 24 * 60 * 60 * 1000)
    while (Date.now() < deadline) {
      let totalCandidates = 0
      for (const folder of candidateFolders) {
        try {
          await client.mailboxOpen(folder)
        } catch {
          continue // folder doesn't exist on this server
        }
        const uids = await client.search({ since: widenedSince })
        totalCandidates += uids.length
        uids.sort((a, b) => b - a)
        for (const uid of uids) {
          const msg = await client.fetchOne(uid, { source: true, envelope: true, internalDate: true })
          if (!msg) continue
          const subject = msg.envelope.subject
          if (options.subjectContains && !subject.includes(options.subjectContains)) continue
          // eslint-disable-next-line no-console
          console.info(`[smtp-fixture] match in folder "${folder}": "${subject}"`)
          const body = extractTextBody(msg.source)
          return { subject, body, receivedAt: msg.internalDate }
        }
      }
      // eslint-disable-next-line no-console
      console.info(
        `[smtp-fixture] poll: no match yet for "${options.subjectContains ?? ''}" ` +
          `(${String(totalCandidates)} candidates across ${String(candidateFolders.length)} folders); ` +
          `sleeping ${String(intervalMs)}ms`,
      )
      await sleep(intervalMs)
    }
    throw new Error(
      `[smtp-fixture] IMAP poll timed out after ${String(timeoutMs)}ms — no matching message in ` +
        `${env.user} folders [${candidateFolders.join(', ')}]` +
        (options.subjectContains ? ` (subject contains "${options.subjectContains}")` : '') +
        `. Some SMTP providers delay delivery several minutes (greylisting, queue, ` +
        `virus-scan); bump timeoutMs or use a local SMTP sink (Mailpit) for fast iteration.`,
    )
  } finally {
    try { await client.logout() } catch { /* swallow */ }
  }
}

/**
 * Naive text-body extractor — RFC 5322 multipart messages. Looks for
 * the first `text/plain` part; if absent, returns the part after the
 * blank-line header separator (works for simple single-part text
 * messages). Sufficient for SMTP-fixture scraping; not a complete MIME
 * parser, intentionally — the showcase sends a tiny known message, so
 * the structure is predictable.
 *
 * Also strips quoted-printable soft line breaks (`=\r\n` / `=\n`)
 * which SMTP applies to lines >76 chars — long magic-link URLs would
 * otherwise be truncated by a token-character regex match.
 */
function extractTextBody(source: Buffer): string {
  const raw = source.toString('utf-8')
  let body: string
  // Try to find a text/plain part separated by the boundary marker.
  const ctMatch = raw.match(/Content-Type:\s*text\/plain[^\n]*\n[\s\S]*?\n\n([\s\S]*?)(?:\n--|\n\.\n|$)/i)
  if (ctMatch?.[1]) {
    body = ctMatch[1].trim()
  } else {
    const headerEnd = raw.indexOf('\r\n\r\n')
    if (headerEnd >= 0) body = raw.slice(headerEnd + 4).trim()
    else {
      const ne = raw.indexOf('\n\n')
      body = ne >= 0 ? raw.slice(ne + 2).trim() : raw
    }
  }
  // Quoted-printable soft line break — `=` at end of line means the
  // line continues. Strip the marker AND the line break so a wrapped
  // URL re-joins as a single token. Real QP sequences (`=XX`) where
  // XX is two hex chars are decoded too — common for `=3D` (`=`
  // itself), `=20` (space), and any 8-bit character.
  body = body.replace(/=\r?\n/g, '')
  body = body.replace(/=([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
  return body
}

// ─── Manual mode (stdin prompt) ────────────────────────────────────────

/**
 * `true` when the suite is running in CI — `process.env.CI` is set by
 * GitHub Actions, GitLab CI, CircleCI, Jenkins, and most others.
 * Manual mode skips when this is true so a missing IMAP config never
 * hangs an automated run waiting for stdin that never comes.
 */
export function isCi(): boolean {
  const v = process.env['CI']
  return v !== undefined && v !== '' && v !== '0' && v !== 'false'
}

/**
 * Prompt on stdout, read a single line from stdin. Used by the
 * showcases when IMAP is not configured — the developer pastes the
 * OTP / URL by hand. The 5-minute readline timeout matches the
 * default OTP TTL: if you can't read the email within 5 min, the
 * code has expired anyway.
 */
export async function promptStdin(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const line = await rl.question(question)
    return line.trim()
  } finally {
    rl.close()
  }
}

// ─── Internals ─────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
