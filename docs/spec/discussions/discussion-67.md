# Discussion #67 — Binary attachment store: encrypted blobs (PDF, CSV, images) alongside records

- **Category:** Ideas
- **Author:** @vLannaAi
- **Created:** 2026-04-07
- **State:** open
- **Comments:** 2
- **URL:** https://github.com/vLannaAi/noy-db/discussions/67

---

noy-db today stores **structured records** (JSON-shaped envelopes). Many real consumers also need to attach **binary documents** to those records — uploaded CSVs, generated PDFs, images, scanned receipts, signed contracts — and there is currently no clean path to do it. Options today:

1. **Base64 the bytes into a JSON field.** Works for small blobs (< ~100 KB). Destroys query performance, makes the v0.4 delta history absurdly inefficient (a 1 MB attachment edited once becomes a 2 MB delta), and bloats the encrypted envelope format it was never designed to carry.
2. **Store the blob out of band and reference it by URL.** Whatever stores the blob sees plaintext. This directly violates the project's thesis — "your data never leaves encrypted." It's the workaround that nobody on this project can recommend with a straight face.

Neither is acceptable for a library whose whole pitch is encrypted, offline, zero-knowledge document storage. Calling this out as a proper discussion because it affects core, the adapter contract, and every built-in adapter — it's not a bolt-on.

## Rough shape (to anchor, not to specify)

```ts
const attachments = company.attachments()    // sibling of .collection()

await attachments.put('receipt-001', {
  filename: 'invoice-2026-03.pdf',
  contentType: 'application/pdf',
  body: pdfStream,                            // Uint8Array | Blob | ReadableStream
})

const doc = await attachments.get('receipt-001')
// { filename, contentType, size, body: ReadableStream }

// FK from a structured record into an attachment
const invoices = company.collection<Invoice>('invoices', {
  refs: { receiptId: ref('attachments') },
})
```

## Key design points

1. **Chunked AEAD.** AES-256-GCM has a per-key byte ceiling (~64 GB) and single-shot encrypt isn't practical for a 500 MB file — you can't hold that in memory. Standard answer: chunk into ~1 MiB frames, each with its own IV, and bind the frame index into the AEAD associated data to prevent reordering attacks. Web Crypto can do all of this today — **no new crypto primitives, no new dependencies**. The invariant "Web Crypto API only" is preserved.

2. **Streaming I/O.** `put` accepts `ReadableStream`, `get` returns one. Neither side ever needs to materialize the full document in memory. This is what makes the feature actually usable for real documents.

3. **Adapter contract — "clean optional extension".** The current 6-method contract is record-oriented. The `CONTRIBUTING.md` invariant checklist explicitly allows a "clean optional extension" to the adapter contract. Blob storage is the canonical example: a new optional `BlobAdapter` interface that adapters can implement to get native blob I/O:
   - `@noy-db/file` → real files on disk, streamed from the filesystem.
   - `@noy-db/s3` → native S3 objects with multipart upload.
   - `@noy-db/browser` → IndexedDB's native blob store.
   - `@noy-db/dynamo` → chunked into items, with a documented hard size ceiling because DynamoDB is the wrong storage for large blobs.
   Adapters that don't implement `BlobAdapter` get a **core fallback** that chunks the blob across synthetic record keys using the existing 6 methods. Slower but universal — nothing stops working.

4. **Ledger integration.** Attachment puts/deletes hash-chain into the existing `_ledger/` the same way record mutations do. The hash is computed over the **encrypted frames**, not the plaintext, which preserves zero-knowledge in the ledger exactly as v0.4's record ledger does today. `verify()` extends to cover attachment chain entries alongside record entries.

5. **FK refs from records.** A record field like `receiptId: ref('attachments')` with the same strict / warn / cascade modes as v0.4 record FK refs. Cascade delete on a record removes its attachments; strict mode blocks deletion of an attachment still referenced by a record.

6. **Schema validation** attaches to attachment **metadata** (filename, contentType, size bounds, filename regex, allowed content types), not the body bytes themselves. A `max: 50_000_000` bound on the schema gives consumers a natural way to reject oversized uploads at the `put()` boundary.

7. **Query DSL.** Attachments get a narrow query DSL — `.list()`, `.filter(meta => ...)`, `.count()` — but **no content search**. Full-text over encrypted blobs is a different project.

## What I'd like out of this discussion

- Maintainer alignment on **whether this belongs in the noy-db scope at all**, given that it's a genuinely new primitive rather than a refinement of existing ones.
- If yes, rough placement on the roadmap. My guess: v0.7 or v0.8, behind identity & sessions (v0.5) and sync v2 (v0.6).
- Agreement on the **chunked AEAD framing** before anyone writes code — framing formats are the thing you absolutely cannot change after shipping.
- Agreement on the `BlobAdapter` optional-interface approach vs. trying to widen the 6-method contract. The former is the invariant-safe path.
- Explicit decision on the per-adapter size ceilings (`@noy-db/dynamo` in particular needs to be documented as "wrong tool" for anything over a few MB).


> _Comments are not archived here — see the URL for the full thread._
