# Issue #254 — feat(as-blob): @noy-db/as-blob — single-attachment plaintext export (document sub-family)

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-21
- **Closed:** 2026-04-22
- **Milestone:** Fork · As (@noy-db/as-*)
- **Labels:** type: feature, priority: high, area: core, pilot-1

---

## `@noy-db/as-blob` — single-attachment plaintext export (document sub-family)

Export one blob attached to a record as its native MIME bytes. The simplest of the document-extractor sub-family in the plaintext tier of Fork · As.

**Why it exists.** Record formatters (`as-xlsx`, `as-csv`, …) handle structured data. `as-blob` handles the other half of noy-db's dual data + document store: binary attachments in `BlobSet` (PDFs, images, scans, `.eml` files, audio). A decrypted PDF crosses the plaintext boundary just as a decrypted xlsx does — same gate, same audit trail, different content shape.

See `docs/patterns/as-exports.md` §"Document / blob exports" and RFC #249.

## API sketch

```ts
import { asBlob } from '@noy-db/as-blob'

// Browser download — one attachment, user clicks, gets the PDF
await asBlob.download(vault, {
  collection: 'invoices',
  id: '01H5...',
  slot: 'raw',                  // Optional — defaults to 'raw'
  filename: 'invoice-01H5.pdf', // Optional — defaults to slot name + detected ext
})

// Node file write (Tier 3 requires acknowledgeRisks)
await asBlob.write(vault, '/tmp/invoice.pdf', {
  collection: 'invoices',
  id: '01H5...',
  slot: 'raw',
  acknowledgeRisks: true,
})

// Raw bytes — consumer chooses sink (fetch upload, IndexedDB, custom)
const { bytes, mime, filename } = await asBlob.toBytes(vault, {
  collection: 'invoices',
  id: '01H5...',
})
```

## Authorization + audit

Gated by `canExportPlaintext` (default off; owner/admin grants). Emits:

```ts
{
  type: 'as-export',
  encrypted: false,
  package: '@noy-db/as-blob',
  collection: 'invoices',
  recordCount: 1,              // always 1 for single-blob
  blobSlot: 'raw',
  blobBytes: 482_301,
  mimeType: 'application/pdf', // detected via MIME magic, already stored in BlobSet
  actor: '...',
  grantedBy: 'owner@...',
  reauthFresh: true,
  timestamp: '...',
}
```

**No blob content, no content hash** — mirrors the plaintext-egress audit discipline. Only metadata that's already in the BlobSet index (MIME, byte count) goes in the entry.

## MIME-appropriate filenames

The BlobSet already runs magic-byte MIME detection (55 rules) on every stored blob. `as-blob` uses this to pick a sensible default filename extension when the consumer doesn't supply one: `application/pdf` → `.pdf`, `image/jpeg` → `.jpg`, `message/rfc822` → `.eml`, etc.

## ACL + capability composition

Just like record formatters, `as-blob` respects the parent collection's read ACL first — `canExportPlaintext` cannot override the fact that an `operator` without `payments` read permission cannot extract attachments from `payments`. Gate is layered on top of read, not instead of it.

## Acceptance

- [ ] Package skeleton under `packages/as-blob/`
- [ ] `download()` / `write()` / `toBytes()` entry points
- [ ] Honours `canExportPlaintext` capability (blocked by #249)
- [ ] Emits audit-ledger entry with `package: '@noy-db/as-blob'`, `blobSlot`, `blobBytes`, `mimeType`
- [ ] Uses MIME-magic detection for default filename extension
- [ ] Rejects export when parent collection read ACL denies access
- [ ] Unit tests: happy path, ACL refusal, capability refusal, PDF/JPEG/EML round-trip
- [ ] Showcase demonstrating attachment download from invoice workflow
- [ ] README with plaintext-on-disk warning

**Labels**: `pilot-1` (pilots need to extract invoice PDFs from the get-go — this is arguably more urgent than `as-xlsx` for their daily workflow).

Blocked by #249.
