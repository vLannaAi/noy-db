# Issue #255 — feat(as-zip): @noy-db/as-zip — composite record+blob archive (document sub-family)

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-21
- **Closed:** 2026-04-22
- **Milestone:** Fork · As (@noy-db/as-*)
- **Labels:** type: feature, priority: high, area: core, pilot-1

---

## `@noy-db/as-zip` — composite record+blob archive (document sub-family)

Export a set of records **and their attached blobs** as a single zip archive. The canonical "download this audit trail" or "migrate this entire case folder" primitive. Builds on top of `as-json` (records) + `as-blob` (attachments) internally but presents a single audited call to the consumer.

See `docs/patterns/as-exports.md` §"Document / blob exports" and the composite-entity pattern in `docs/patterns/email-archive.md`. RFC #249 governs the gate.

## Archive layout

```
invoices-2026-03.zip
├── manifest.json                 # Index: record IDs, blob slots, file paths, schema hashes
├── records.json                  # All records as JSON (structured)
├── records.csv                   # Optional — records as csv for accountants
└── attachments/
    ├── 01H5abc.../raw.pdf        # Original scan for invoice 01H5abc...
    ├── 01H5abc.../body-html.html # (if email-archive) rendered body
    ├── 01H5abc.../att-0-receipt.pdf
    └── 01H8xyz.../raw.pdf
```

The folder-per-record layout makes composite entities (email + body + attachments, invoice + scan + receipt) navigable by humans opening the zip in Finder/Explorer without tooling.

## API sketch

```ts
import { asZip } from '@noy-db/as-zip'

// Browser download
await asZip.download(vault, {
  filename: 'invoices-2026-03.zip',
  records: {
    collection: 'invoices',
    query: (q) => q.where('issueDate', '>=', '2026-03-01').where('issueDate', '<=', '2026-03-31'),
    formats: ['json', 'csv'],     // Which serialisations to include
  },
  attachments: {
    slots: ['raw', 'body-html', 'att-*'],  // Glob-matched slot selection
  },
})

// Or: explicit id list (for auditor-supplied cases)
await asZip.download(vault, {
  filename: 'case-47-evidence.zip',
  records: { collection: 'invoices', ids: ['01H5...', '01H6...'] },
  attachments: { slots: ['*'] },  // All blobs on each record
})

// Node file write (Tier 3 requires acknowledgeRisks)
await asZip.write(vault, '/archive/invoices-2026-03.zip', { /* ... */, acknowledgeRisks: true })
```

## Authorization + audit

Gated by `canExportPlaintext` (same gate as every plaintext-tier package). Emits **one** audit-ledger entry per archive invocation, not one per included record — auditors scanning the ledger see "Somchai exported 143 invoices + 312 blobs as a zip at 10:45" as a single event:

```ts
{
  type: 'as-export',
  encrypted: false,
  package: '@noy-db/as-zip',
  collection: 'invoices',
  recordCount: 143,
  blobCount: 312,
  totalBytes: 48_302_915,
  formats: ['json', 'csv'],
  actor: 'somchai@firm.example',
  grantedBy: 'owner@firm.example',
  reauthFresh: true,
  timestamp: '...',
}
```

## Why not just call as-json + as-blob in a loop?

A consumer could loop `as-blob` for every attachment and emit `as-json` for the records, then zip client-side. That would produce N+1 audit-ledger entries instead of one composite entry. For a 143-invoice export with 312 blobs that's 456 log lines for one user intent — noise that makes auditing harder, not easier.

`as-zip` collapses this into a single audited call. The composite framing matches the consumer's mental model ("I'm downloading the folder") and the auditor's review workflow ("one egress event, 48MB").

## Streaming

For large archives, `as-zip` streams chunks out as they're added (uses browser `CompressionStream` where available, Node zip libraries elsewhere). Memory ceiling is O(current-blob-being-processed), not O(archive).

## Acceptance

- [ ] Package skeleton under `packages/as-zip/`
- [ ] `download()` / `write()` / `toBytes()` entry points
- [ ] Honours `canExportPlaintext` capability (blocked by #249)
- [ ] Query-based selection + explicit-id selection both work
- [ ] Slot glob-matching (`raw`, `body-*`, `att-*`, `*`)
- [ ] Streaming implementation — memory independent of archive size
- [ ] Single composite audit-ledger entry per invocation
- [ ] Manifest.json includes enough metadata to reconstruct the source set (schema names, record IDs, blob slots, MIME types, byte counts)
- [ ] Unit tests: happy path, filtered by query, filtered by ids, all-slots glob, ACL refusal, streaming memory profile
- [ ] Showcase using email-archive composite pattern + audit export
- [ ] README with plaintext-on-disk warning

**Labels**: `pilot-1` — accounting firms frequently need "export all documents for this fiscal period" for audit response; this is the shape that solves it.

Blocked by #249.
