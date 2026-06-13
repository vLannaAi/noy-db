# Dimension 14 — Derived data and materialized views

## Purpose

Capture the universal pattern of *data computed from other data* — previews, thumbnails, extracted metadata, OCR text, audio waveforms, transcoded variants, materialized query results, semantic embeddings — as a first-class primitive with explicit lifecycle, storage routing, and invalidation semantics. Most small-app patterns (document management, photo galleries, receipt scanning, email archives, audio/video libraries) are 80% derived data by storage volume; treating it as ad-hoc one-off code per app loses huge ergonomics and consistency wins.

## Why derived data is orthogonal, not a fifth shape

Derived-ness is a *property* that any data shape can carry, not a shape itself:

| Source shape | Possible derived outputs |
|---|---|
| Record | Computed fields (in-record, Dim 07), aggregates, materialized views |
| Blob (PDF) | Metadata (record), preview (blob), extracted text (record/stream), embedding (vector) |
| Blob (image) | Resized variants (blob), EXIF metadata (record), perceptual hash (record) |
| Blob (audio) | Waveform image (blob), duration/bitrate (record), transcoded variant (blob), transcript (record/stream) |
| Blob (email) | Parsed headers (record), body parts (records/blobs), thread links (record) |
| Stream | Materialized rollup (record), CDC mirror (stream), summary digest (record) |
| Collection (query result) | Materialized view (record collection), aggregate snapshot (record) |

**One source produces multiple outputs of different shapes.** This is the architectural novelty — a derivation function returns a list of typed outputs, each routed to its own storage tier with its own lifecycle.

## Current state

- `withComputedFields` (proposed in Dimension 07) covers in-record derivations only — same record, derived field
- Embeddings (Dimension 13) cover the source-record → vector derivation case
- Blobs are bare: no preview, no thumbnail, no metadata extraction, no derived companion records
- No materialized-view primitive at the collection level
- No separate-storage routing for derivations
- No lifecycle / invalidation policy as a first-class concept
- Apps reimplement all of this externally, every time

## Target state

A `withDerivation({ source, derive, outputs, lifecycle })` strategy lets a vault declare derivations once and have them maintained automatically. Multi-output derivations are explicit (one `derive` function returns a list of typed outputs). Separate storage tiers are declared per output (a preview blob to a CDN cache, extracted text to the main vault). Lifecycle policy is per-derivation (eager / lazy / cached / manual). Invalidation is automatic on source change with documented cascade semantics.

## Concrete additions

**Hub primitives:**

```ts
withDerivation({
  source: 'pdfs',  // collection or stream name
  outputs: {
    metadata: { shape: 'record', collection: 'pdf-metadata', store: 'main' },
    preview: { shape: 'blob', store: 'cache', lifecycle: { ttl: '90d', regenerateOnMiss: true } },
    text: { shape: 'record', collection: 'pdf-text', store: 'main' },
    embedding: { shape: 'embedding', collection: 'pdf-vectors', store: 'vector' },
  },
  derive: async (pdf) => ({
    metadata: { pageCount, title, author, ... },
    preview: webpBytesOfFirst5Pages,
    text: extractedText,
    embedding: await encode(extractedText),
  }),
  on: 'write',  // 'write' | 'read' | 'manual'
})
```

**Materialized views (collection-level derivation from a query):**

```ts
withMaterializedView({
  name: 'high-value-invoices',
  query: invoices.query().where(amount.gt(1000)).join('clientId', { as: 'client' }),
  refresh: 'eager',  // 'eager' | 'lazy' | 'manual' | { every: '1h' }
  store: 'main',
})
```

**Streaming materialized views (Materialize-inspired):** when the source is a stream collection (Dim 12), the materialized view updates **incrementally** as events arrive rather than recomputing from scratch. Combiner is declared (`fold: (acc, event) => acc'`); pairs with Dim 12 projections.

**MapReduce views (CouchDB / PouchDB lineage):** for derivations that fan out (one source → many index entries), declare a `map: (record) => Entry[]` + optional `reduce: (entries) => Aggregate`; the materialized output is the reduced index. Useful for analytics-style aggregations the chainable builder can't express compactly.

**"Rendered views" (Zero / Replicache-inspired):** server-authoritative pre-rendered query results — the server materializes the view, clients consume it via `by-server` (Dim 5) without re-running the query locally. Pairs with optimistic mutations on the client.

**Built-in deriver helpers (`@noy-db/derivers-*`):**
- `@noy-db/derivers-pdf` — `pdf.preview(n)`, `pdf.text()`, `pdf.metadata()`, `pdf.pageCount()`
- `@noy-db/derivers-image` — `image.thumbnail(size)`, `image.resize(w, h)`, `image.exif()`, `image.perceptualHash()`
- `@noy-db/derivers-audio` — `audio.waveform()`, `audio.duration()`, `audio.transcode(codec)`
- `@noy-db/derivers-email` — `email.headers()`, `email.parts()`, `email.thread()`
- `@noy-db/derivers-text` — `text.summary()`, `text.tokens()`, `text.language()`

**Cache-tier storage backends (new sub-family in `to-*`):**
- `to-cache-cf-cdn` — Cloudflare CDN with KV-backed origin; expungable; free tier generous
- `to-cache-bunny-cdn` — Bunny.net CDN; cheapest at scale
- `to-cache-cloudinary-free` — image/video CDN with on-the-fly transformations
- `to-cache-imgix-free` — image CDN
- `to-cache-memory` — in-process LRU; for derivations small enough to live in RAM
- `to-cache-ttl-file` — local disk with TTL; for self-hosted

**Capability metadata extension (Dimension 01 retrofit):**
- `tier: 'primary' | 'derived' | 'cache'` — declares the lifecycle role of a backend
- `expungable: boolean` — backend supports cheap delete-and-regenerate semantics
- `transformations?: string[]` — for CDN-class backends, declares supported on-the-fly transforms (resize, format-convert, etc.)

## Shipped

- **v1 / v2** — `withDerivation` + union-form materialized views + overlays (prior releases).
- **✅ Shipped 0.2.0-pre.16** (niwat-AU-series increment on top of Dim 14 v1/v2; source: integration-audit AU series epic #341 + first-class-money milestone 19 #333, both CLOSED + adopter-validated):
  - `withDerivation({ sources: [...] })` — declared sibling sources, re-fire on sibling writes (#344).
  - Union-form MV exact money aggregation via strategy `moneyFields` (#350) + union-arm `join` leg (#347).
  - Overlay field-level-merge `mergeMode` (#348).

## Hard tradeoffs

**1. Determinism vs persistence.**
- *Deterministic derivations* (PDF text extraction, image resize, deterministic hash) can be regenerated on miss → cache tier with TTL is safe.
- *Non-deterministic derivations* (LLM-generated summaries, embeddings whose model changes, OCR with retraining) must persist → primary tier, can't be regenerated identically.

The strategy declaration must say which: `lifecycle: { regenerateOnMiss: true }` is rejected for non-deterministic derivations.

**2. Encryption boundary.**
- Derivation functions read *plaintext* source (need the actual content to derive). They run inside the encrypted boundary (after DEK unwrap).
- Output goes through the same envelope-encrypt path as primary data → derived content sees the same zero-knowledge guarantee.
- **Exception:** CDN-served plaintext derivations (e.g., a public preview thumbnail accessible without auth). If declared `public: true` on the output, the derivation skips encryption and the user explicitly accepts the leak. Default is encrypted; `public` is opt-in with loud documentation.

**3. Lifecycle and invalidation cascade.**
- *Eager*: derive on source-write. High write cost; reads are always fresh.
- *Lazy*: derive on first read after source-change. First read pays the cost; subsequent reads are cached.
- *Cached*: derived once, persisted; never re-derives (until manually purged or TTL expires).
- *Manual*: user calls `vault.deriveAll('pdf-metadata')` explicitly.
- Source-change invalidation cascades to all dependent derivations. Cycle detection rejects circular derivation declarations at strategy registration time.

**4. Multi-output partial failure.**
- A multi-output `derive()` function may succeed for some outputs and fail for others (e.g., extracted text succeeds but preview generation crashes on a corrupt PDF page).
- Default: per-output success — partial derivation is committed, failed outputs marked with retry metadata. Failure does not block source write.
- Strict mode: `strict: true` — all-or-nothing, source write rolls back if any derivation fails (composes with `withTransactions`).

## Non-goals

- **Hosting derivation engines.** Derivers are user-supplied or library-supplied (`@noy-db/derivers-*`). noy-db doesn't ship a Lambda-style execution environment.
- **Workflow orchestration.** Multi-step pipelines (PDF → OCR → translate → summarize → embed) compose by chaining `withDerivation` declarations, but noy-db isn't a Temporal/Airflow.
- **Transformations on the read path** beyond the declared cache lookup. CDN-side transforms (Cloudinary-style on-the-fly resize) are exposed via the backend's `transformations` capability, not a noy-db DSL.
- **Cross-vault derivation.** Derivations are vault-scoped. Cross-vault materialized views are explicit cross-vault joins (Dimension 11 catch-all).

## Dependencies / sequencing

- Capability metadata extension in Dimension 01 (`tier`, `expungable`, `transformations`) — must land first
- `withTransactions` (already exists) is the rollback substrate for strict-mode derivations
- Dimension 13 (embeddings) reframes as a `withDerivation` shorthand once 14 lands — backward-compatible reframe
- Dimension 07 (`withComputedFields`) stays separate as the in-record-only narrow case (cheaper, no separate storage routing)
- Dimension 11's compaction primitive shares lifecycle infrastructure with cache-tier expiry

## Cross-references

- `features.yaml` → propose new `derivations` section parallel to `features`; cache-tier storage backends register under `adapters` with `tier: 'cache'` capability
- Related: Dimension 01 (`to-cache-*` backends, capability extensions), Dimension 03 (do exports include derivations or only primaries?), Dimension 06 (metering derivation cost — eager-vs-lazy decisions need cost data), Dimension 07 (`withComputedFields` is the in-record narrow case), Dimension 11 (compaction shares lifecycle infrastructure), Dimension 12 (CDC streams as derived data), Dimension 13 (embeddings are a specific derivation)
- Spec anchor: new `SUBSYSTEMS.md#derivations` section

## Open questions

- **`@noy-db/derivers-*` distribution.** One package per source type (`derivers-pdf`, `derivers-image`, `derivers-audio`), or one big `derivers-common` with feature flags? Bundle-size matters; PDFs alone pull `pdfjs` which is multi-MB.
- **Cache-tier backend authentication.** A CDN serves derivations to *some* audience (vault members? the public? signed URLs?). Where does the authn/authz live — inside the deriver, in the cache backend, or as a separate `withCacheAccess` strategy?
- **Public-preview leak channel.** Plaintext-CDN previews are an obvious privacy hole. Should `public: true` derivations require an explicit ACL gate (not just a flag), or is the loud doc warning enough?
- **Re-derivation cost discovery.** How does the application know the cost of regenerating a missed cache entry? (Dimension 06 metering captures it after-the-fact, but the first miss has no signal.)
- **Migration path for existing apps.** Apps already storing previews as plain blobs: is there a `migrate-to-derivation` primitive, or do they reimplement?
- **Materialized view freshness vs lazy-mode.** Lazy mode (v0.22) vaults can't materialize a view eagerly without loading everything. Materialized-view + lazy combination has a hard incompatibility unless the view is itself lazy-mode-aware.
- **Determinism declaration.** Who decides if a derivation is deterministic — the user (declares it), the library (annotates each `@noy-db/derivers-*` helper), or runtime detection (compare two runs and see)?
- **Derivation versioning.** When the deriver function changes (e.g., new PDF library version produces different text extraction), existing cache is stale. Version tag, hash, or refuse-to-mix?
