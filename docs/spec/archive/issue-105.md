# Issue #105 — feat(core): encrypted binary attachment store — blobs alongside records

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-08
- **Closed:** 2026-04-10
- **Milestone:** v0.12.0
- **Labels:** type: feature, area: core, area: adapters

---

## Target package

`@noy-db/core` (primary — attachment primitive and chunked AEAD), all adapters (storage contract)

## Spawned from

Discussion #67 — Binary attachment store. Full design discussion including chunked AEAD rationale, streaming read/write, and adapter contract implications.

## Problem

noy-db today stores structured records as JSON envelopes. Real consumers also need to attach binary documents to those records — uploaded CSVs, generated PDFs, images, scanned receipts, signed contracts. Current options are both bad:

1. **Base64 into a JSON field** — works for blobs under ~100 KB. Destroys query performance, makes v0.4 delta history absurdly inefficient (a 1 MB attachment edited once becomes a 2 MB delta), and bloats the envelope format it was never designed to carry.
2. **Store out of band and reference by URL** — whatever stores the blob sees plaintext. Directly violates the project's thesis. Nobody on this project can recommend it.

For a library whose whole pitch is encrypted, offline, zero-knowledge document storage, this is a real gap that affects core, the adapter contract, and every built-in adapter.

## Scope

- **`company.attachments()` sibling of `.collection()`** — a per-compartment attachment namespace with its own DEK, its own ACL surface (inherits collection-shape permissions), and its own indexed metadata.
  ```ts
  const attachments = company.attachments()
  
  await attachments.put('receipt-001', {
    filename: 'invoice-2026-03.pdf',
    contentType: 'application/pdf',
    body: pdfStream,  // Uint8Array | Blob | ReadableStream
  })
  
  const doc = await attachments.get('receipt-001')
  // { filename, contentType, size, body: ReadableStream }
  ```

- **Chunked AEAD** — AES-256-GCM has a per-key byte ceiling (~64 GB) and single-shot encrypt is impractical for large files. Implement chunk-at-a-time encryption with 1 MB default chunk size, per-chunk IV derivation via HKDF from a per-attachment base IV + chunk index. Each chunk has its own AEAD tag. Decrypt streams chunk-by-chunk.

- **Streaming API** — `put()` accepts `ReadableStream` and streams through the chunker without holding the full blob in memory. `get()` returns a `ReadableStream` that decrypts lazily.

- **Foreign-key references** — attachments are first-class targets for `ref()`:
  ```ts
  const invoices = company.collection<Invoice>('invoices', {
    refs: { receiptId: ref('attachments') },
  })
  ```
  Dangling-ref modes (`strict` / `warn` / `cascade`) apply same as collection refs.

- **Adapter contract extension** — adapters gain two optional methods: `putChunked(compartment, attachmentId, chunkIndex, bytes)` and `getChunked(compartment, attachmentId, chunkIndex)`. Adapters that don't implement these fall back to single-blob storage using the existing 6-method contract (acceptable for `@noy-db/memory` and small-attachment use).

- **Content-addressable deduplication** — attachments with identical plaintext hashes deduplicate at the storage layer. The hash is plaintext SHA256, computed client-side during `put()`. Wrapped under the attachment DEK, so the adapter cannot tell two deduped records have the same content.

- **No thumbnails, no previews, no OCR** — these are consumer concerns. The library ships the primitive; consumers build helpers.

## Non-goals

- **Thumbnail generation** — userland.
- **Search within attachments** — userland, and incompatible with zero-knowledge.
- **Per-chunk addressability for partial reads** — v2. v1 reads are whole-attachment streams.
- **Attachment versioning separate from records** — the ref from the record gives you pseudo-versioning.
- **Cross-compartment attachment sharing** — each attachment belongs to one compartment.

## Acceptance

- [ ] `company.attachments()` API exposed from `@noy-db/core`
- [ ] Per-attachment DEK derived from the compartment KEK (or: per-collection DEK analogue for attachments)
- [ ] Chunked AEAD with 1 MB default chunk size, per-chunk IV from HKDF
- [ ] Streaming `put()` and `get()` — validated by a test that attaches a 100 MB blob with bounded memory
- [ ] `ref('attachments')` works identically to collection refs
- [ ] Adapter contract extension `putChunked` / `getChunked` — optional, falls back for adapters without support
- [ ] Content-addressable dedup with wrapped plaintext-hash matching
- [ ] Tests: round-trip small/medium/large blobs, ref strictness modes, cross-adapter consistency
- [ ] Docs: `docs/attachments.md`
- [ ] Changeset

## Invariant compliance

- [x] Adapters never see plaintext — attachment chunks are ciphertext
- [x] AES-256-GCM, 12-byte IV per chunk, IVs never reused (derived deterministically from base IV + chunk index, base IV is random per attachment)
- [x] KEK never persisted
- [x] Chunked AEAD uses Web Crypto only, no new crypto deps
- [x] 6-method adapter contract preserved for adapters that don't opt into chunked storage

## Related

- Discussion #67 (source)
- #100 — `.noydb` container format (attachments ride along in bundle exports)
- #103 — `NoydbBundleAdapter` (bundle adapters need to handle attachments; determines per-bundle vs sidecar storage)

v0.11.0.
