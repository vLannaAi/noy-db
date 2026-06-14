# `as-aws-s3` — direct-serve blobs (presigned + full-public)

- **Date:** 2026-06-15
- **Status:** Design / proposed
- **Family:** `as-*` (projection/export) — net-new package `@noy-db/as-aws-s3`
- **Related:** [[per-blob-cek-design]], plaintext-debug-store-mode (sibling spec, same date), `to-aws-s3`

## 1. Problem

Today every blob noy-db writes is **chunked → gzipped → AES-256-GCM encrypted (AAD-bound) → wrapped in an `EncryptedEnvelope` JSON object**, then handed to the store as opaque ciphertext. That is exactly right for the zero-knowledge posture, but it makes a blob **impossible to serve directly**: an S3 `GET` returns `{"_noydb":1,"_iv":"...","_data":"<base64>"}`, a 1 MB PDF is 4 objects at hashed keys (`_blob_chunks/{eTag}_{i}`), and the bytes are gzipped without a `Content-Encoding` header.

We want a sanctioned path to publish **genuinely public assets** — logos, brand images, and **publicly-aware generated documents** (e.g. an issued invoice/receipt PDF that is meant to be shared) — as **single, natively-consumable S3 objects** with correct `Content-Type`, served straight from S3/CDN, **independent of noy-db**. Two delivery modes are required:

1. **Presigned** — time-limited URLs, object stays private (default, safest).
2. **Full-public** — world-readable object (or CDN origin), for assets that are intentionally public.

## 2. Why this is `as-*`, not "a flag on the store adapter"

The store adapter (`to-aws-s3`) is the wrong layer. `to-*` packages implement the uniform `NoydbStore` contract — **ciphertext in, ciphertext out** — and the architecture check (`scripts/check-architecture.mjs`, "stores-ciphertext-only" rule) forbids them from touching plaintext or crypto. A directly-servable object is *plaintext, single-object, content-typed* — it breaks every assumption of that contract.

Reframed under the package taxonomy (role-test = "what shape does the data **leave as**?"), this is a **projection of blobs AS servable S3 objects** → the `as-*` family. Hence `@noy-db/as-aws-s3`.

**Taxonomy caveat (worth recording):** every other `as-*` package is a *one-shot* export (`as-csv`, `as-xlsx`). `as-aws-s3` is a **live, continuous** projection — it writes on every public-blob `put` and deletes on `forget`/compaction. It still answers the `as-*` question ("what shape does data leave as"), but it is the family's first *streaming* member. If we later add more live projections we may want a dedicated prefix; for now `as-*` is the correct home and the user has chosen `as-aws-s3`.

## 2.1 Two storage classes: projection vs. primary external attachment

`as-aws-s3` must serve **two semantically distinct cases** that share the same S3 wire mechanism:

- **Case 1 — projection (derived).** An encrypted blob lives in the vault (source of truth); the S3 object is a servable *copy*. Disposable — regenerable from the vault. This is the classic `as-*` shape (like `as-csv`/`as-xlsx`).
- **Case 2 — primary external attachment (source-of-truth inversion).** A large binary (e.g. a **1 GB video**) is stored **unencrypted, directly in S3**, *because* the point is to run AWS-native tooling on it — MediaConvert transcoding/optimization, CloudFront streaming. The bytes are **never** encrypted in the vault; the record holds only a **reference + metadata**. The S3 object **is** the source of truth; deleting it loses the data irrecoverably.

Case 2 is **not** a conversion of an existing encrypted blob — it never had an encrypted twin. This inverts the assumption behind every other `as-*` package (derived & disposable → primary & irreplaceable).

### Modeling: storage class on the blob field (not a package distinction)

The two cases are distinguished in **field config**, not by separate packages:

```ts
blobFields: {
  invoicePdf: { public: 'presigned', mirrorOf: 'encrypted' }, // Case 1: derived servable copy
  promoVideo: { storage: 'external-plain' },                   // Case 2: primary, never encrypted
}
```

### Case-2 consequences (differ materially from Case 1)

- **Upload path:** the hub cannot stream 1 GB through itself → `as-aws-s3` must issue a presigned **PUT** URL (`putUrl`), with bytes going **direct to S3, bypassing noy-db**. The vault never sees the bytes.
- **Integrity:** the record stores a content hash (e.g. sha256) so the external object can be validated / tamper-detected — there is no encrypted twin to compare against.
- **Backup / DR:** an `as-noydb` vault bundle contains only the **reference**, not the bytes. Backups must include the external bucket separately. (Must be documented loudly — silent data loss risk on restore.)
- **Renditions:** MediaConvert *produces new objects* (transcoded variants). The field is effectively a **set** (original + renditions), not a single blob; the record references all of them.
- **Erasure:** record/forget delete must hard-delete the primary + all renditions; no crypto-shred (the bytes were never encrypted). Same CDN-residue caveat as §4, amplified.

### Naming verdict — DECIDED (2026-06-15): keep `as-*`, two storage classes

Both cases live in **`as-aws-s3`** (the `as-*` family). The projection-vs-primary distinction is carried by the **blob-field storage class** (`mirrorOf:'encrypted'` vs `storage:'external-plain'`), **not** by separate packages. Rationale: one S3 implementation serves both; **no clean 2-letter preposition** exists for "primary unencrypted external attachment" (`of-`/`off-` weak; `at-` taken by sealing); and the family-proliferation discipline ("why six, not more") argues against inventing one.

Rejected alternatives: a new prefix family (no defensible preposition; splits one impl across two packages) and an unencrypted `to-*` variant (the ciphertext-only invariant *is* the definition of `to-*`).

## 3. Design

### 3.1 Per-field opt-in (never per-vault)

A new blob-field policy flag, declared on the collection:

```ts
vault.collection('documents', {
  blobFields: {
    logo:        { public: true },                 // full-public (world-readable / CDN origin)
    issuedPdf:   { public: 'presigned' },          // private object, presigned URLs only
    statementPdf:{ /* default */ },                // encrypted, ZK, as today — unchanged
  },
})
```

- `public: 'presigned' | true | false` (default `false` = today's encrypted path, untouched).
- Public fields **bypass** envelope-wrapping, chunking, gzip, and encryption — they write **one raw object** with the declared/ sniffed `Content-Type`.

### 3.2 Physical isolation — a dedicated public store

Public blobs MUST NOT share a path/bucket with encrypted-vault data. Wire via the existing router:

```ts
routeStore({
  default:     dynamo({ table: 'noydb' }),
  blobs:       s3({ bucket: 'noydb-encrypted-blobs' }),   // to-aws-s3, ciphertext
  publicBlobs: asAwsS3({ bucket: 'noydb-public-assets', baseUrl: 'https://cdn.example.com' }),
})
```

A misconfigured `public: true` can then only ever land in the explicitly-designated public bucket — never in an encrypted store.

### 3.3 New store capability (the raw-object seam)

`as-aws-s3` is not a `NoydbStore`; it implements a small new **projection capability** the hub calls for public fields only:

```ts
interface ObjectProjection {
  putObject(key: string, bytes: Uint8Array, opts: { contentType: string; public: boolean }): Promise<void>
  putUrl(key: string, opts: { contentType: string; expiresInSeconds?: number }): Promise<string> // presigned PUT — direct-to-S3 upload for large files (Case 2); bytes bypass the hub
  deleteObject(key: string): Promise<void>
  objectUrl(key: string, opts?: { expiresInSeconds?: number }): Promise<string>  // presigned or public GET
  headObject(key: string): Promise<ObjectMeta>      // size, etag, contentType, lastModified, userMeta (x-amz-meta-*)
  copyMetadata(key: string, userMeta: Record<string, string>): Promise<void> // push fields → S3 user metadata (copy-in-place; S3 meta is immutable post-PUT)
  listPrefix(prefix: string): AsyncIterable<{ key: string; meta: ObjectMeta }> // import/reconcile only
}
```

### 3.4 URL helper

```ts
const url = await documents.blob('doc-1').publicUrl('issuedPdf')        // presigned (default expiry)
const url = await documents.blob('doc-1').publicUrl('logo')             // stable public/CDN URL
```

Key scheme is documented and stable: `{prefix}/{vault}/{collection}/{recordId}/{field}.{ext}`.

### 3.5 Record-anchoring invariant — every plain object is an extension of a record

**MUST:** every S3 plain object corresponds to **exactly one field on exactly one record** in a master collection. There are **no orphan objects** — an S3 plain file is an *extension of a record*, never a free-standing artifact.

Consequences:

- **The encrypted collection is the authoritative catalog.** To list/enumerate plain objects you **query the master collection** (`documents.query()`), **never** S3 `ListObjectsV2`. Enumeration, ACL, search, ordering, and lifecycle are all driven by the encrypted record set.
- **Secure manifest over an opaque bucket (privacy win).** The bucket can be private with **object listing disabled**; the only catalog of what exists — names, count, metadata — lives encrypted in the vault. So even though the *bytes* of an `external-plain` object are unencrypted, the **existence, naming, and metadata** of objects stay zero-knowledge (presigned/private case). Public objects expose only their own URL, nothing about the rest of the set. *(This holds only if pushed metadata — especially the backlink — is `encrypted`/`opaque-token`; a `plain` backlink would re-leak catalog structure. See §3.6.)*
- **Lifecycle is record-driven.** Deleting a record hard-deletes its object(s) + renditions. An object with no record is an **orphan**, swept by `reconcile()` (§3.7) — or adopted via import (§3.8).

### 3.6 Metadata exchange & sync

The encrypted pair-record is the home for the object's metadata: `contentType`, `size`, `sha256`/`etag`, S3 user metadata (`x-amz-meta-*`), **and derived media metadata** — video duration/codec/resolution, image dimensions/EXIF, PDF page count, arbitrary metatags. Sync is bidirectional:

- **Pull (S3 → record):** `documents.blob(id).sync(field)` reads `headObject` and merges metadata into the encrypted record. Heavy probes (a 1 GB video's duration/dimensions) **cannot run in the hub** → they are produced **AWS-side** (MediaConvert emits metadata; Lambda+ffprobe; Rekognition for images) and delivered via a callback `setObjectMetadata(id, field, meta)`. So media-metadata pull is **event-driven** (S3 event → processing → callback), not synchronous.
- **Push (record → S3) — S3 metadata as a *secondary store*:** selected record fields are mirrored into S3 user metadata (`x-amz-meta-*`) via `copyMetadata` (copy-in-place; S3 metadata is immutable after PUT). This is a deliberate denormalization — the encrypted record stays primary; the S3 metadata is a resilient, AWS-visible mirror. **Three per-field push modes:**
  - **`plain`** — value readable by AWS tooling (e.g. `duration`, `contentType`, `width`/`height`). **Leaks the value to any bucket reader.** Must be US-ASCII → base64-encode any non-ASCII (e.g. Thai). Use only for non-sensitive fields.
  - **`encrypted`** — value encrypted under the record CEK / collection DEK, stored as base64 `{iv,ct}`. Preserves zero-knowledge (a bucket reader sees ciphertext); only a vault-unlock can read it. AWS-side tools cannot use it.
  - **`opaque-token`** — a stable random/HMAC id stamped on the object that reverse-maps to the record **only via an encrypted index in the vault**. Self-identifying without leaking real names. **This is the recommended default for the backlink.**
- **Backlink (the headline secondary-store use):** stamp `{vault, collection, recordId, field}` onto the object so it self-describes its owning record — invaluable for `reconcile()`/GC, import/bootstrap (exact re-pairing instead of guessed id derivation), DR (the bucket self-describes its associations), and AWS-side jobs (a MediaConvert rendition can copy the source's backlink so the callback knows which record to update). **Default `opaque-token` or `encrypted`** to preserve the opaque-bucket property (§3.5); `plain` only if the deployment accepts structure leakage in exchange for AWS-side readability.
- **Constraints:** S3 user-defined metadata is capped at ~2 KB total (keys + values), values must be ASCII → the secondary store is for *small* fields (backlink, tags, dimensions), never bulk; updating requires `CopyObject` with `MetadataDirective=REPLACE`.
- **Drift detection:** `sync()` reports size/hash/etag mismatch, missing object, or missing record, and reconciles record metadata to the object. The record remains the source of truth on conflict (the S3 mirror is rebuilt, except the immutable backlink).

### 3.7 Consistency — two-phase upload & reconciliation

Bytes upload direct-to-S3 (presigned PUT) **outside** the vault transaction, so creation is a two-phase protocol that preserves the anchoring invariant:

1. create/patch the record in `pending` state (reserves the pairing + key)
2. issue a presigned `putUrl`
3. client uploads bytes straight to S3
4. **finalize:** confirm via `headObject`, pull metadata, flip record → `active`

- **Abandoned uploads** (client never finalizes): TTL sweep of `pending` records + abort incomplete multipart uploads.
- **`reconcile()` audit:** (a) objects with no record → orphans (delete, or adopt via §3.8); (b) records with no object → dangling (mark broken / re-request upload).

### 3.8 Import / bootstrap (reverse `as-`) — build a collection from an existing bucket

A utility (CLI) **and/or** base feature that walks an existing S3 bucket/prefix and **builds a master collection** where each record anchors one plain object + its metadata — the inverse of the pairing invariant (adopting orphans into the catalog):

- `listPrefix(prefix)` → for each object, `headObject` for metadata → derive a record id from the key → create a record whose field references the object → optionally run a media-probe pass (AWS-side) → populate metadata.
- **Decisions:** folder → collection mapping (one collection per top-level prefix? flat? configurable); id derivation (sanitized key vs content hash); **idempotent re-runs** (skip objects already paired); optional probe pass.
- Conceptual sibling of `as-xls` Mode B (import builds a collection) — the same "reverse projection bootstraps a collection/schema" pattern across the `as-*` family.

## 4. Security analysis (this is the load-bearing section)

Public blobs sit **outside the zero-knowledge guarantee**. The danger is not the feature — it is **misconfiguration** placing client PII (invoices, statements, KYC) on a world-readable bucket, permanently un-shreddable and CDN-cached past deletion. That is the precise inverse of the right-to-erasure posture the per-blob CEK epic was built for.

Mandatory guardrails:

- **Default to presigned, not world-readable.** "Served directly from S3" is fully satisfied by presigned URLs + CDN. `public: true` (world-readable) is the explicit, louder choice.
- **Two-key gate for full-public:** `public: true` is rejected unless the vault is opened with `allowPublicBlobs: true`. One field flag alone can't expose data.
- **Erasure contract — documented loudly:** public blobs are **NOT crypto-shreddable**. `forget()`/compaction must perform a **hard `deleteObject`**, and the contract states that CDN/replica cache TTLs may retain the object after deletion. `vault.forget()` reporting gains a `publicObjectsDeleted` / `publicResidueWarning` field.
- **Architecture-invariant carve-out:** the "store sees only ciphertext" invariant becomes "…except blob fields explicitly declared `public`." This must be a **named exception** in `check-architecture.mjs`, not a silent bypass — otherwise review reads it as a security regression. `as-aws-s3` is allowed to see plaintext **because it is `as-*`, not `to-*`**.
- **PII allowlist discipline:** docs steer the accounting use-case toward `public: 'presigned'` for any client-bearing document; `public: true` is reserved for brand assets and explicitly-public generated documents.

## 5. Relationship to plaintext/debug mode

`as-aws-s3`'s raw-object write path (no envelope, no gzip, no chunk-encryption) is the **same mechanism** the plaintext/debug store mode needs to make blobs directly openable in native tooling. Both depend on a "render this blob as its raw bytes" path in the blob subsystem. Build that path once; the debug spec and this spec share it.

## 6. Phasing

- **P1 — core + anchoring:** blob-field `public`/`storage` classes + `ObjectProjection` capability (incl. `putUrl`) + presigned GET/PUT + `external-plain` storage class + **record-anchoring invariant** (catalog = `collection.query()`, never S3 list) + **two-phase upload** + `publicUrl()` + router wiring + hard-delete on forget.
- **P2 — full-public:** full-public mode behind `allowPublicBlobs`, CDN `baseUrl`, architecture-invariant carve-out, erasure-residue reporting.
- **P3 — metadata exchange:** `sync()` pull (`headObject`) + event-driven `setObjectMetadata` callback (MediaConvert/ffprobe/Rekognition) + push via `copyMetadata` (non-sensitive only) + drift detection + `reconcile()`/GC.
- **P4 — import/bootstrap:** `listPrefix` walk → build master collection from an existing bucket (adopt orphans), idempotent, optional probe pass. (CLI utility + base API.)
- **P5 — polish:** content-type sniffing, cache-control headers, renditions-as-a-set modeling, showcase + `docs/packages/as-exports.md` entry + `features.yaml`.

## 7. Open questions

1. Stable public key scheme vs. unguessable (random-suffix) keys even for `public: true`? (Defense-in-depth for "public but unlisted" assets.)
2. Should `publicUrl()` for `presigned` fields auto-rotate / support a configurable default TTL per field?
3. Do we need an integrity signal (the encrypted twin's eTag stored as object metadata) so a public object can be validated against the vault?
4. Cross-cloud: is the abstraction `as-aws-s3`-specific, or do we define `ObjectProjection` generically now and add `as-r2` / `as-gcs` later?
5. **Import folder→collection mapping:** one collection per top-level prefix, fully flat, or a user-supplied mapping function? And id derivation — sanitized object key vs content hash?
6. **Import as utility vs base feature:** ship the bucket→collection bootstrap as a CLI only, a `vault`-level API, or both?
7. **Push-metadata allowlist:** which record fields are eligible to be mirrored into (unencrypted) S3 user metadata — explicit per-field opt-in, given the plaintext exposure?
8. **Pending-record TTL:** how long before an unfinalized two-phase upload is swept, and is the sweep automatic or operator-triggered?
9. **Backlink default mode:** `opaque-token` (recommended, preserves opacity) vs `encrypted` vs `plain` (AWS-side readable but leaks structure) — per-deployment default?
10. **Encrypted-metadata key + rotation:** does `encrypted`/`opaque-token` metadata use the record CEK or the collection DEK, and what happens on key rotation — re-`CopyObject` all mirrored metadata, or accept that old metadata is unreadable until next `sync()`? (Backlink is immutable post-PUT, so prefer the opaque-token's vault-side index, which rotates without touching S3.)
