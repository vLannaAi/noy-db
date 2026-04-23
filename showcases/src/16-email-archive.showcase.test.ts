/**
 * Showcase 16 — Email archive (MIME .eml ingest + threading + cid rendering)
 * GitHub issue: https://github.com/vLannaAi/noy-db/issues/239
 * Pattern doc:  docs/patterns/email-archive.md
 *
 * Framework: pure hub
 * Store:     `memory()`
 * Pattern:   Composite entity — one record, many attached blobs
 *            plus thread-level reads via query DSL.
 *
 * What this proves:
 *   1. A MIME `.eml` (text+html body, 2 attachments, 1 inline image)
 *      parses into a single `Email` record + several named blob slots
 *      on the same record — the canonical composite-entity shape.
 *   2. Blob content-addressing dedupes: ingesting two emails with
 *      the same PDF bytes yields ONE blob object on disk, two slot
 *      references.
 *   3. A reply thread (linked via `References` + `In-Reply-To`)
 *      reads chronologically via `.query().where('threadId')
 *      .orderBy('receivedAt')`.
 *   4. HTML bodies with `cid:` references rewrite to blob URLs
 *      drawn from the same record's attachment slots.
 *   5. Every envelope on the store side is AES-GCM ciphertext — a
 *      ciphertext peek at `_data` proves the subject + body never
 *      leak plaintext.
 *
 * The revision-tracking / DocumentGroup dynamics (#239 step 7-10)
 * are tracked as a follow-up — this showcase covers the base
 * ingest, dedup, threading, and rendering paths.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createNoydb, type Noydb, type NoydbStore } from '@noy-db/hub'
import { memory } from '@noy-db/to-memory'
import { SHOWCASE_PASSPHRASE } from './_fixtures.js'

interface Email {
  id: string            // stable id (usually Message-Id)
  threadId: string      // shared across a thread
  from: string
  to: readonly string[]
  subject: string
  receivedAt: string    // ISO-8601
  inReplyTo?: string
  references?: readonly string[]
  hasHtml: boolean
  participants: readonly string[]
}

// ── Tiny .eml fixtures ─────────────────────────────────────────────

// Round-trip byte integrity is checked at the end — we store the
// whole .eml as slot `raw` and read it back.
const EML_1 = Buffer.from(
  [
    'Message-ID: <msg1@example.com>',
    'From: alice@example.com',
    'To: bob@example.com',
    'Subject: Q1 invoices',
    'Date: Thu, 15 Jan 2026 09:00:00 +0000',
    'Content-Type: multipart/mixed; boundary="boundary"',
    '',
    '--boundary',
    'Content-Type: text/plain',
    '',
    'Attached are Q1 invoices. See inline logo.',
    '--boundary',
    'Content-Type: text/html',
    '',
    '<html><body><p>Q1 invoices. <img src="cid:logo@acme"/></p></body></html>',
    '--boundary',
    'Content-Type: application/pdf; name="invoice.pdf"',
    'Content-Disposition: attachment; filename="invoice.pdf"',
    '',
    '[PDF-BYTES-INVOICE-Q1]',
    '--boundary',
    'Content-Type: image/png',
    'Content-ID: <logo@acme>',
    '',
    '[PNG-BYTES-LOGO]',
    '--boundary--',
    '',
  ].join('\r\n'),
  'utf-8',
)

const EML_2_REPLY = Buffer.from(
  [
    'Message-ID: <msg2@example.com>',
    'In-Reply-To: <msg1@example.com>',
    'References: <msg1@example.com>',
    'From: bob@example.com',
    'To: alice@example.com',
    'Subject: Re: Q1 invoices',
    'Date: Thu, 15 Jan 2026 10:00:00 +0000',
    'Content-Type: multipart/mixed; boundary="boundary"',
    '',
    '--boundary',
    'Content-Type: text/plain',
    '',
    'Thanks — same PDF attached for the file.',
    '--boundary',
    'Content-Type: application/pdf; name="invoice.pdf"',
    'Content-Disposition: attachment; filename="invoice.pdf"',
    '',
    '[PDF-BYTES-INVOICE-Q1]', // SAME bytes as EML_1 — expected to dedupe
    '--boundary--',
    '',
  ].join('\r\n'),
  'utf-8',
)

const EML_3_FOLLOWUP = Buffer.from(
  [
    'Message-ID: <msg3@example.com>',
    'In-Reply-To: <msg2@example.com>',
    'References: <msg1@example.com> <msg2@example.com>',
    'From: alice@example.com',
    'To: bob@example.com',
    'Subject: Re: Q1 invoices',
    'Date: Thu, 15 Jan 2026 11:00:00 +0000',
    '',
    'Great, thanks!',
    '',
  ].join('\r\n'),
  'utf-8',
)

// ── Minimal MIME parser ─────────────────────────────────────────────

interface ParsedEmail {
  messageId: string
  from: string
  to: string[]
  subject: string
  date: string
  inReplyTo?: string
  references?: string[]
  parts: Array<{
    contentType: string
    contentId?: string
    filename?: string
    bytes: Uint8Array
  }>
}

function parseEml(raw: Uint8Array): ParsedEmail {
  const text = new TextDecoder().decode(raw)
  const [headerBlock, ...bodyBlocks] = text.split('\r\n\r\n')
  const headers = parseHeaders(headerBlock!)
  const boundary = extractBoundary(headers['content-type'] ?? '')
  const body = bodyBlocks.join('\r\n\r\n')

  const parts: ParsedEmail['parts'] = []
  if (boundary) {
    const chunks = body.split(`--${boundary}`)
    for (const chunk of chunks) {
      const trimmed = chunk.trim()
      if (!trimmed || trimmed === '--') continue
      const [partHeader, ...partBody] = trimmed.split('\r\n\r\n')
      const partHeaders = parseHeaders(partHeader!)
      const ct = partHeaders['content-type'] ?? 'text/plain'
      const cid = partHeaders['content-id']?.replace(/[<>]/g, '')
      const filename = /filename="([^"]+)"/.exec(
        partHeaders['content-disposition'] ?? partHeaders['content-type'] ?? '',
      )?.[1]
      const bytes = new TextEncoder().encode(partBody.join('\r\n\r\n').trim())
      const part: ParsedEmail['parts'][number] = {
        contentType: ct.split(';')[0]!.trim(),
        bytes,
      }
      if (cid !== undefined) part.contentId = cid
      if (filename !== undefined) part.filename = filename
      parts.push(part)
    }
  } else {
    parts.push({
      contentType: headers['content-type']?.split(';')[0]?.trim() ?? 'text/plain',
      bytes: new TextEncoder().encode(body.trim()),
    })
  }

  const parsed: ParsedEmail = {
    messageId: (headers['message-id'] ?? '').replace(/[<>]/g, ''),
    from: headers['from'] ?? '',
    to: (headers['to'] ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    subject: headers['subject'] ?? '',
    date: headers['date'] ?? '',
    parts,
  }
  if (headers['in-reply-to']) parsed.inReplyTo = headers['in-reply-to'].replace(/[<>]/g, '')
  if (headers['references']) {
    parsed.references = headers['references']
      .split(/\s+/)
      .map((s) => s.replace(/[<>]/g, ''))
      .filter(Boolean)
  }
  return parsed
}

function parseHeaders(block: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of block.split('\r\n')) {
    const i = line.indexOf(':')
    if (i <= 0) continue
    out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim()
  }
  return out
}

function extractBoundary(contentType: string): string | null {
  return /boundary="?([^";]+)"?/.exec(contentType)?.[1] ?? null
}

// ── Ingest — wire a parsed email into the vault ────────────────────

async function ingestEmail(vault: ReturnType<Noydb['vault']>, raw: Uint8Array): Promise<string> {
  const parsed = parseEml(raw)
  const id = parsed.messageId
  // Thread-id derivation: the first id in References (if any) is
  // the thread root; otherwise the message is its own thread.
  const threadId = parsed.references?.[0] ?? parsed.inReplyTo ?? id
  const emails = vault.collection<Email>('emails')
  const participants = Array.from(new Set([parsed.from, ...parsed.to]))
  const hasHtml = parsed.parts.some((p) => p.contentType === 'text/html')

  const record: Email = {
    id,
    threadId,
    from: parsed.from,
    to: parsed.to,
    subject: parsed.subject,
    receivedAt: new Date(parsed.date).toISOString(),
    hasHtml,
    participants,
    ...(parsed.inReplyTo !== undefined && { inReplyTo: parsed.inReplyTo }),
    ...(parsed.references !== undefined && { references: parsed.references }),
  }
  await emails.put(id, record)

  // Attach every blob-worthy part as a slot on this email's record.
  const blobSet = emails.blob(id)
  await blobSet.put('raw', raw, { mimeType: 'message/rfc822', compress: false })
  for (let i = 0; i < parsed.parts.length; i++) {
    const part = parsed.parts[i]!
    if (part.contentType === 'text/html') {
      await blobSet.put('body-html', part.bytes, { mimeType: 'text/html' })
    } else if (part.contentId) {
      await blobSet.put(`cid-${part.contentId}`, part.bytes, { mimeType: part.contentType })
    } else if (part.filename) {
      await blobSet.put(`att-${i}-${part.filename}`, part.bytes, { mimeType: part.contentType })
    }
  }
  return id
}

// ── Tests ─────────────────────────────────────────────────────────

describe('Showcase 16 — Email archive (MIME .eml ingest + threading)', () => {
  let db: Noydb
  let rawStore: NoydbStore

  beforeEach(async () => {
    rawStore = memory()
    db = await createNoydb({ store: rawStore, user: 'archivist', secret: SHOWCASE_PASSPHRASE })
    await db.openVault('inbox')
  })

  afterEach(() => {
    db.close()
  })

  it('step 1 — ingest one .eml as one record + multiple blob slots', async () => {
    const vault = db.vault('inbox')
    const id = await ingestEmail(vault, EML_1)
    expect(id).toBe('msg1@example.com')

    const record = await vault.collection<Email>('emails').get(id)
    expect(record?.subject).toBe('Q1 invoices')
    expect(record?.from).toBe('alice@example.com')

    const slots = await vault.collection<Email>('emails').blob(id).list()
    const slotNames = slots.map((s) => s.name).sort()
    expect(slotNames).toContain('raw')
    expect(slotNames).toContain('body-html')
    expect(slotNames.some((n) => n.startsWith('att-'))).toBe(true)
    expect(slotNames.some((n) => n.startsWith('cid-'))).toBe(true)
  })

  it('step 2 — blob dedup: same PDF attached to two emails stores one blob', async () => {
    const vault = db.vault('inbox')
    await ingestEmail(vault, EML_1)
    await ingestEmail(vault, EML_2_REPLY)

    // Both emails should have their own slot referring to the PDF.
    const e1Slots = await vault.collection<Email>('emails').blob('msg1@example.com').list()
    const e2Slots = await vault.collection<Email>('emails').blob('msg2@example.com').list()
    const pdf1 = e1Slots.find((s) => s.name.includes('invoice.pdf'))!
    const pdf2 = e2Slots.find((s) => s.name.includes('invoice.pdf'))!
    // Same content bytes → same eTag (content-hashed).
    expect(pdf1.eTag).toBe(pdf2.eTag)
  })

  it('step 3 — thread reads chronologically via query DSL', async () => {
    const vault = db.vault('inbox')
    await ingestEmail(vault, EML_1)
    await ingestEmail(vault, EML_2_REPLY)
    await ingestEmail(vault, EML_3_FOLLOWUP)

    const thread = vault
      .collection<Email>('emails')
      .query()
      .where('threadId', '==', 'msg1@example.com')
      .orderBy('receivedAt', 'asc')
      .toArray()

    expect(thread.map((e) => e.id)).toEqual([
      'msg1@example.com',
      'msg2@example.com',
      'msg3@example.com',
    ])
    expect(thread[0]!.subject).toBe('Q1 invoices')
    expect(thread[2]!.inReplyTo).toBe('msg2@example.com')
  })

  it('step 4 — derived thread metadata: participants + messageCount', async () => {
    const vault = db.vault('inbox')
    await ingestEmail(vault, EML_1)
    await ingestEmail(vault, EML_2_REPLY)
    await ingestEmail(vault, EML_3_FOLLOWUP)

    const thread = vault
      .collection<Email>('emails')
      .query()
      .where('threadId', '==', 'msg1@example.com')
      .toArray()
    const participantsUnion = new Set(thread.flatMap((e) => e.participants))
    expect(participantsUnion).toEqual(new Set(['alice@example.com', 'bob@example.com']))
    expect(thread.length).toBe(3)
  })

  it('step 5 — cid:→data: rewrite: inline image served from attachment slot', async () => {
    const vault = db.vault('inbox')
    await ingestEmail(vault, EML_1)

    const blob = vault.collection<Email>('emails').blob('msg1@example.com')
    const htmlBytes = await blob.get('body-html')
    const cidBytes = await blob.get('cid-logo@acme')
    expect(htmlBytes).not.toBeNull()
    expect(cidBytes).not.toBeNull()

    // Render: swap cid:XXX for a data URL composed from the cid slot.
    const html = new TextDecoder().decode(htmlBytes!)
    const dataUrl = `data:image/png;base64,${Buffer.from(cidBytes!).toString('base64')}`
    const rendered = html.replace(/cid:logo@acme/g, dataUrl)
    expect(rendered).toContain('src="data:image/png;base64,')
    expect(rendered).not.toContain('cid:logo@acme')
  })

  it('step 6 — raw .eml round-trips byte-for-byte', async () => {
    const vault = db.vault('inbox')
    await ingestEmail(vault, EML_1)
    const recovered = await vault
      .collection<Email>('emails')
      .blob('msg1@example.com')
      .get('raw')
    expect(recovered).not.toBeNull()
    expect(new Uint8Array(recovered!)).toEqual(new Uint8Array(EML_1))
  })

  it('step 7 — ciphertext peek: subject + body never leak through the adapter', async () => {
    const vault = db.vault('inbox')
    await ingestEmail(vault, EML_1)

    // Peek the raw envelope on the store. `_data` is AES-GCM
    // ciphertext — it must not contain any plaintext from the
    // record (subject) or the body (invoice).
    const envelope = await rawStore.get('inbox', 'emails', 'msg1@example.com')
    expect(envelope).not.toBeNull()
    expect(envelope!._data).not.toContain('Q1 invoices')
    expect(envelope!._data).not.toContain('alice@example.com')
  })
})
