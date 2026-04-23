# Issue #239 — showcase: #15 email archive — MIME .eml ingest + threading + cid-rendering

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-21
- **Closed:** 2026-04-22
- **Milestone:** v0.17.1 Good to have scaffolding
- **Labels:** showcases

---

Concrete proof-of-pattern for `docs/patterns/email-archive.md` (shipped in commit 0bf457f, expanded with thread + revision sections in a follow-up). Demonstrates the single-record-with-multi-blob shape for composite entities, plus the THREAD-level dynamics that make email archives real archives: chronological conversation, shared-document dedup, cross-email revision tracking.

## Flow

### Base ingest (proves the composite-entity pattern)
1. Parse a hand-crafted `.eml` test fixture with:
   - text + html body parts
   - 2 attachments (PDF, PNG)
   - 1 inline image (cid:...)
2. Ingest to `vault.collection<Email>("emails")` + blob slots on the same record:
   - slot `raw` (the .eml)
   - slot `body-html` (when HTML is > 10 KB)
   - slot `att-0-invoice.pdf`, `att-1-logo.png` for attachments
3. Verify blob dedup: ingest a second email attaching the exact same PDF (same bytes) → exactly one blob on disk (content-address), two slot references.

### Threading (proves thread-level ops)
4. Ingest a reply chain — 4 emails, linked by `References` + `In-Reply-To`. Exercise `threadId` derivation (inherited from first email).
5. Query the thread chronological: `emails.query().where("threadId", "==", X).orderBy("receivedAt", "asc").toArray()`.
6. Compute derived thread metadata: participants union, firstAt/lastAt, messageCount. No separate `threads` collection needed for the showcase — compute on query.

### Revision tracking (proves DocumentGroup shape)
7. Have three emails in the thread carry `invoice-draft1.pdf`, `invoice-draft2.pdf`, `invoice-final.pdf` — DIFFERENT bytes, different eTags, same logical document.
8. Ingest-time heuristic creates one `DocumentGroup` with three revisions linked to their originating emails.
9. Query: get all revisions of a document chronologically, fetch the latest byte stream.
10. Spot-check: a fourth email attaching the SAME bytes as `invoice-final.pdf` does NOT create a new revision (eTag match → dedup at the group level too).

### Rendering (proves the cid:→data: rewrite path)
11. Render an HTML-bodied email with `cid:` references → blob URLs pulled from the same-record attachment slots.

### Recap
12. Raw `.eml` round-trips byte-for-byte for every ingested email.
13. All envelope data on the stores side is ciphertext (AES-256-GCM envelope).

## Acceptance

- Uses `@noy-db/hub/store` for blob primitives + `@noy-db/hub/query` for thread queries — demonstrates the v0.15.1 subpath discipline.
- Cross-references `docs/patterns/email-archive.md` in the file header.
- Passes in happy-dom (no Node-specific APIs).
- Under ~400 LoC (grew from 300 to cover thread + revision dynamics).

## Size

About a day of work. Largest unknown is the `.eml` fixture + a minimal MIME parser helper (or `mailparser` as a dev dep). DocumentGroup revision detection is a ~50 LoC heuristic (strip version suffix, compare filename stem).
