# Recipes

Domain-specific how-tos for recurring patterns. Each recipe is a
self-contained cookbook: the problem, the short answer, the decision
matrix, and runnable code. Recipes complement the reference docs —
[`architecture.md`](./architecture.md) explains *how the library works*;
recipes explain *how to use it for a common task*.

---

## Email archive

> **Problem:** You receive a MIME `.eml` email. It contains structured
> metadata (from, to, subject, dates, thread headers), body parts
> (plaintext + HTML), inline images, and attachments (PDFs, nested
> emails, anything). You want to query it as structured data AND serve
> the attachments as files AND keep the original `.eml` for forensic
> re-parsing. How do you lay it out in noy-db?

### Short answer

**An email is ONE entity with many facets.** Model it as one `Email`
record plus N+2 blob slots on that same record:

```
emails/<email-id>        ← the record (structured fields)
  └─ blob slots:
     ├─ 'raw'            ← original .eml (always)
     ├─ 'body-html'      ← if HTML part exists
     ├─ 'body-text'      ← if plaintext body is > 10 KB
     └─ 'att-N-<file>'   ← one blob per attachment
```

Don't split into separate `emails` + `attachments` collections unless
you cross ~50 000 emails. The attachment manifest lives on the email
record; the bytes are blob slots on that same record; noy-db's
content-address dedup stores the same PDF attached to 100 emails as
one blob on disk.

### The decision matrix — which part lives where

| Part | Size | Query-needed? | → Where |
|------|------|:-:|:-:|
| `from`, `to`, `cc`, `subject`, `receivedAt` | tiny | yes | **record** |
| `messageId`, `threadId`, `inReplyTo`, `references` | tiny | yes (threading) | **record** |
| `labels`, `flags` (read / starred / archived / replied) | tiny | yes | **record** |
| `bodyPreview` (first ~200 chars) | small | no (display) | **record** |
| `bodyText` plaintext | 1–50 KB typical | rarely | **record if < 10 KB, blob if larger** |
| `bodyHtml` | often 100 KB+ | no (display) | **blob** slot `body-html` |
| Raw `.eml` | 50 KB – few MB | no (forensic) | **blob** slot `raw` |
| Attachments (PDFs, images, nested `.eml`) | 10 KB – 100 MB | no (download) | **blob** slot per attachment |
| `attachments[]` metadata (filename, mime, size, slot name) | tiny | yes | **record** |
| `extracted` (AI summary, topics, action items) | small | yes | **record** |

One rule: **if you ever `.where()` or `.orderBy()` on it, put it on the
record**. Otherwise it's a blob. Keep records small so the in-memory
vault stays fast; blobs lazy-load.

### Concrete record shape

```ts
interface Address {
  email: string
  name?: string
}

interface Email {
  id: string                      // ULID — stable identity
  messageId: string               // RFC 5322 Message-ID header (dedup)
  threadId: string                // derived — see "Threading"

  inReplyTo?: string
  references?: string[]

  from: Address
  to: Address[]
  cc?: Address[]
  bcc?: Address[]
  subject: string
  receivedAt: string              // ISO-8601 — Received: header timestamp
  sentAt?: string                 // ISO-8601 — Date: header

  labels?: string[]
  flags?: {
    read?: boolean
    starred?: boolean
    replied?: boolean
    archived?: boolean
  }

  bodyPreview: string             // first ~200 chars for listing UIs
  bodyText?: string               // plaintext ONLY if < 10 KB
  bodyTextInBlob?: boolean        // true → fetch blob slot 'body-text'
  bodyHtmlInBlob?: boolean        // true → fetch blob slot 'body-html'

  attachments?: Array<{
    filename: string
    mimeType: string
    sizeBytes: number
    contentId?: string            // cid:... reference for inline images
    slotName: string              // blob slot holding the bytes
    eTag?: string                 // HMAC content-address (dedup)
  }>

  extracted?: {
    summary?: string
    topics?: string[]
    sentiment?: number
    actionItems?: string[]
    invoiceNumber?: string        // when the email IS an invoice
  }
}
```

### Ingest flow

```ts
import { parseEmail } from '<your-eml-parser>'
import { generateULID } from '@noy-db/hub'

async function ingestEml(vault: Vault, emlBytes: Uint8Array): Promise<string> {
  const parsed = parseEmail(emlBytes)               // MIME → structured
  const id = generateULID()
  const emails = vault.collection<Email>('emails')

  const attachments = parsed.attachments.map((a, i) => ({
    filename: a.filename,
    mimeType: a.contentType,
    sizeBytes: a.size,
    contentId: a.contentId,                         // for cid: inline images
    slotName: `att-${i}-${slug(a.filename)}`,
  }))

  const record: Email = {
    id,
    messageId: parsed.headers['message-id'],
    threadId: await deriveThreadId(emails, parsed),
    inReplyTo: parsed.headers['in-reply-to'],
    references: parsed.headers['references']?.split(/\s+/),
    from: parsed.from,
    to: parsed.to,
    cc: parsed.cc,
    subject: parsed.subject,
    receivedAt: parsed.headers['received-at'],
    bodyPreview: (parsed.text ?? '').slice(0, 200),
    bodyText: parsed.text && parsed.text.length < 10_000 ? parsed.text : undefined,
    bodyTextInBlob: (parsed.text?.length ?? 0) >= 10_000,
    bodyHtmlInBlob: !!parsed.html,
    attachments,
  }
  await emails.put(id, record)

  // Always store the raw .eml — forensic source of truth
  await emails.blob(id).put('raw', emlBytes, { mimeType: 'message/rfc822' })

  if (record.bodyTextInBlob) {
    await emails.blob(id).put('body-text', new TextEncoder().encode(parsed.text!))
  }
  if (record.bodyHtmlInBlob) {
    await emails.blob(id).put('body-html', new TextEncoder().encode(parsed.html!))
  }

  for (const [i, att] of attachments.entries()) {
    const src = parsed.attachments[i]
    await emails.blob(id).put(att.slotName, src.bytes, { mimeType: att.mimeType })
  }

  return id
}
```

### Threading without a separate collection

`threadId` is derived at ingest from `References` / `In-Reply-To`. An
email that references a parent already in the vault inherits the
parent's thread; otherwise this email is the thread root.

```ts
async function deriveThreadId(
  emails: Collection<Email>,
  parsed: ParsedEmail,
): Promise<string> {
  const parents = parsed.headers['references']?.split(/\s+/) ?? []
  for (const parentMessageId of parents) {
    const existing = await emails.query()
      .where('messageId', '==', parentMessageId)
      .first()
    if (existing) return existing.threadId
  }
  // New thread — use messageId hash as stable id
  return (await sha256Hex(parsed.headers['message-id'])).slice(0, 16)
}

// Querying a thread, chronological:
const thread = await emails.query()
  .where('threadId', '==', email.threadId)
  .orderBy('receivedAt', 'asc')
  .toArray()
```

### Rendering HTML with inline images

Emails embed images via `<img src="cid:abc123">` where `abc123` matches
an attachment's `contentId`. Resolve at render time:

```ts
async function renderHtml(emails: Collection<Email>, emailId: string): Promise<string> {
  const email = await emails.get(emailId)
  if (!email) throw new Error('not found')
  const htmlBytes = await emails.blob(emailId).get('body-html')
  let html = new TextDecoder().decode(htmlBytes)

  for (const att of email.attachments ?? []) {
    if (!att.contentId) continue
    const bytes = await emails.blob(emailId).get(att.slotName)
    const b64 = btoa(String.fromCharCode(...bytes))
    const dataUrl = `data:${att.mimeType};base64,${b64}`
    html = html.replaceAll(`cid:${att.contentId}`, dataUrl)
  }
  return html
}
```

In a browser consumer, `BlobSet.response(slotName)` + blob URLs is the
better lazy-rendering path — no `data:` blowup in the HTML string.

### When to flip to a secondary attachments collection

Add `vault.collection<AttachmentIndex>('attachments_index')` as a
**materialised view**, not a source of truth, when:

1. **You cross ~50 000 emails** and scan+filter queries for
   "find all PDFs" become slow.
2. **You have retention rules per attachment type** (e.g. "medical
   images purge after 7 years, legal agreements retain indefinitely")
   — easier to run lifecycle policies on a dedicated collection.
3. **You want attachments searchable independent of email state**
   (e.g. search deleted emails' attachments for compliance).

### Thread-level view

`threadId` on the record is the index. The *meaning* is the thread.
Users don't think "those 7 emails on April 12th"; they think "the
thread about the Q2 invoice". Most UI operations fold across the
thread: title (first email's subject minus `Re:`/`Fwd:`), participants
(union across every email), time span, unread / starred disjunction,
document set grouped by eTag + revision.

Compute these on demand with a query (cheap under ~50 emails per
thread). For heavier UIs, maintain a `vault.collection<Thread>('threads')`
materialised view, updated as a side-effect of every email `put`.

### Shared documents across a thread

The common case: someone attaches a PDF; three replies quote it back.
noy-db's content-address dedup (HMAC-SHA256 of the plaintext bytes →
`eTag`) stores **one blob** on disk regardless of how many slots
reference it. Surface this at the query layer by grouping attachments
by `eTag` and showing "📎 invoice.pdf · appears in 3 emails".

### Revision tracking — different eTags, same logical document

Harder case: someone sends `invoice-draft1.pdf`, later replies with
`invoice-draft2.pdf` and then `invoice-final.pdf`. Different bytes,
different eTags, but conceptually ONE document across three revisions.

Model this with a `DocumentGroup` collection — a first-class entity
whose identity spans email boundaries:

```ts
interface DocumentGroup {
  id: string                    // ULID
  label: string                 // human-readable
  threadId?: string
  filenameStem?: string         // common stem used for matching
  revisions: Array<{
    eTag: string
    emailId: string
    slotName: string
    filename: string
    receivedAt: string
    revisionLabel?: string      // 'draft', 'draft2', 'final'
    size: number
  }>
  latestETag?: string
  createdAt: string
  updatedAt: string
}
```

**Ingest-time revision detection** uses three signals:

1. **Byte match** — is this eTag already in the thread? It's the SAME
   file (dedup). Reuse the existing DocumentGroup.
2. **Stem match** — strip version suffixes and extension from the
   filename; matching stem in the thread → new revision of that group.
3. **No match** — create a new DocumentGroup. `filenameStem` becomes
   the search key for future revisions.

Optional **LLM enhancement**: when OCR text is available, feed both
versions plus the body context into an LLM and ask "is this a revision
of that?". Use as confirmation, not primary signal.

### Diffing two revisions

If OCR text is on each attachment (extracted at ingest), the hub's
`diff()` primitive works:

```ts
import { diff, formatDiff } from '@noy-db/hub/history'

const prevText = history[history.length - 2]?.ocrText ?? ''
const currText = history[history.length - 1]?.ocrText ?? ''
const changes = diff({ text: prevText }, { text: currText })
console.log(formatDiff(changes))
```

For binary-only revisions (PDFs with no OCR), diffing is lossy — ship
a "visual diff" link that opens both PDFs side-by-side in a viewer
instead.

---

*Recipes grow as patterns emerge. If you solve a composite-entity
problem that other adopters hit, send a PR adding the recipe here.*
