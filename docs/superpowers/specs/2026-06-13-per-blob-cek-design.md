# Per-blob content-encryption keys (CEK) — crypto-shred of blob attachments (DESIGN, for review)

> Final deferred slice of the per-record CEK epic (#357). The record **body** + history
> are crypto-shreddable (#304); this makes a record's **blob attachments** shreddable too,
> closing `forget()`'s `blobResidueCollections` gap. **Issue:** #365 · **Layer:** crypto / blobs.
> **Status:** design, not implemented. Architecture refs current as of `0.2.0-pre.16` + the
> record-keys subsystem (#362/#364).

## The gap

Blobs are encrypted under a **vault-wide `_blob` DEK** (`blobs/blob-set.ts:446`), independent of
the per-record CEK hierarchy. So when `vault.forget(subject)` tombstones a record (body + history
undecryptable), the record's blob attachments survive — `forget()` reports them as
`blobResidueCollections` (`vault.ts:2240`, `forget/strategy.ts:93`) and explicitly does NOT erase
them (foundation decision #5). This is the last hole in GDPR crypto-shred.

Dedup makes this hard. `eTag = HMAC(_blobDEK, plaintext)` (`blob-set.ts:447`) is content-addressed:
identical bytes across N records share one chunk set with `refCount = N` (`_blob_index/{eTag}`,
`_blob_chunks/{eTag}/{i}`). A naive per-`(record,blob)` CEK would destroy that.

## The one idea — content CEK per eTag, crypto-shred at refCount 0

Introduce a **per-eTag content CEK**: a fresh AES-256-GCM key minted on a blob's first upload,
**AES-KW-wrapped under the `_blob` DEK** and stored on the `BlobObject` (`_blob_index/{eTag}`) as
`_cek`. The chunks are encrypted **once** under the content CEK (not the `_blob` DEK), so:

- **Dedup is preserved.** `eTag` derivation is unchanged (still `HMAC(_blobDEK, plaintext)` — the
  dedup *address*). A re-uploader of identical content finds the existing `BlobObject`, unwraps its
  content CEK under the `_blob` DEK, `refCount += 1`, and skips chunk re-encryption — exactly
  today's dedup flow plus one AES-KW unwrap.
- **Crypto-shred at refCount 0.** When the last referencer is erased/deleted (`refCount → 0`),
  delete the `BlobObject` (the **only** wrapped content CEK) *before/independent of* chunk-byte GC.
  The chunks become permanently undecryptable the instant that ~40-byte key is gone — even if the
  chunk bytes linger on a backend that doesn't truly delete. That key-delete IS the shred, mirroring
  how a record tombstone shreds the body without bulk-deleting backend bytes.

This delivers the approved contract (D1): **erasure is complete when the blob is exclusively the
subject's** (the common case — `refCount` 1 → `forget()` drops it to 0 → shred), and **correct when
shared** (`refCount > 1` → the content legitimately persists for its other owner; `forget()` reports
*shared-content retention*, distinct from un-erasable residue).

### Why NOT a per-referencing-record wrap (design finding)

The intuitive "wrap the content CEK once per referencing record, delete the subject's wrap on
`forget()`" does **not** work under dedup and is dropped:

1. **Chicken-and-egg for re-uploaders.** A second uploader of identical content needs the *existing*
   random content CEK to reuse the chunks. Recovering it requires a copy decryptable without the
   subject's key — i.e. a shared (`_blob`-DEK-wrapped) copy. Once that shared copy exists, per-record
   wraps add no erasure strength: the shared copy already recovers the key while `refCount > 0`.
2. **Cryptographic limit.** Truly revoking subject A's access to bytes that subject B still shares
   would require *re-encrypting all chunks under a new CEK on every refCount decrement* (a blob
   `rotateRecordCek` analog) — expensive and only meaningful if A cached the key. Standard dedup
   systems accept that shared content is not per-subject-erasable; we do too, and report it honestly.

So: **one** content CEK per eTag, in the index, shredded at `refCount 0`. (A rotate-on-decrement
mode can be added later if a deployment ever needs per-subject revocation of shared content.)

## Storage format

`BlobObject` (`types.ts:1492`) gains one optional field:

```ts
readonly _cek?: string   // base64 AES-KW-wrapped content CEK (wrapped under the _blob DEK)
```

`_cek` **presence is the discriminant** (same convention as the record envelope): present → chunks
are under the content CEK (unwrap, then decrypt each chunk); absent → legacy, chunks decrypt directly
under the `_blob` DEK. Backward-compatible by construction — legacy blobs read unchanged.

`SlotRecord` (`types.ts:1528`) and the chunk AAD (`{eTag}:{i}:{count}`, `blob-set.ts:100`) are
**unchanged** — the slot still references by `eTag`, and AAD still binds chunk position.

## Write path (`put`, `blob-set.ts:444`)

1. `eTag = HMAC(_blobDEK, plaintext)` — unchanged.
2. **Dedup hit** (`loadBlobObject(eTag)` exists): unwrap its `_cek` under the `_blob` DEK → content
   CEK; `refCount += 1`; skip chunk write. (Legacy hit with no `_cek` on a non-erasable path: today's
   behaviour. On an erasable collection re-uploading a legacy blob: see Migration.)
3. **Dedup miss, erasable collection:** `cek = generateDEK()`; encrypt each chunk under `cek`;
   `writeBlobObject({ …, _cek: wrapCek(cek, _blobDEK), refCount: 1 })`.
4. **Dedup miss, non-erasable collection:** today's path (chunks under `_blob` DEK, no `_cek`).

The content-CEK mode is a property of the **eTag/BlobObject**, fixed at first upload, not of the
collection — see Interplay (mixed collections).

## Read path (`get`)

`loadBlobObject(eTag)` → if `_cek` present, unwrap under the `_blob` DEK → decrypt each chunk under
the content CEK; else legacy direct-`_blob`-DEK decrypt. One extra AES-KW unwrap per blob open
(cache the unwrapped CEK on the in-memory `BlobObject` for the multi-chunk loop).

## Erasure integration (`forget()` + slot delete)

- `forget(subject)` already tombstones the record. **New:** for each shredded record it loads
  `_blob_slots_{collection}/{id}`, and for each slot `eTag`, `refCount -= 1` (CAS). The slot envelope
  is dropped (it lived under the collection DEK; removing it severs the link).
- **At `refCount → 0`:** delete the `BlobObject` (`_blob_index/{eTag}`) — the wrapped content CEK is
  now unrecoverable → chunks crypto-shredded — then delete the chunk bytes (defense in depth /
  storage reclaim), reusing the existing GC delete path.
- **Reporting (D3, recommended):** `ForgetResult` distinguishes
  - `blobsShredded` — count of eTags taken to refCount 0 and shredded;
  - `blobsRetainedShared` — eTags still `refCount > 0` (content persists for other owners);
  - `blobResidueCollections` — now only **non-erasable** (legacy / no-`_cek`) blobs that genuinely
    cannot be shredded. An all-erasable subject yields an empty residue list.

## Interplay resolutions

1. **eTag / dedup** — unchanged (address vs. encryption key are now distinct: `eTag = HMAC(_blobDEK,·)`
   addresses; the random content CEK encrypts). Dedup hit cost: +1 AES-KW unwrap.
2. **Mixed erasable / non-erasable collections sharing one eTag** — the BlobObject's mode is set by
   the first uploader. A non-erasable collection referencing a content-CEK blob unwraps fine (it holds
   the `_blob` DEK). An erasable collection referencing a pre-existing **legacy** blob cannot shred it
   until migrated — reported in `blobResidueCollections`. Document this boundary; do not silently claim
   erasure.
3. **Migration** — `_cek`-absent = legacy. `BlobSet.migrate()` (explicit maintenance pass, mirrors the
   record-CEK posture) re-encrypts a record's legacy chunks **in place** under a fresh content CEK and
   stamps `_cek`, preserving the eTag/chunkCount/chunkSize/compression. Crash-safe + idempotent via a
   transient **`_cekPending`** field: (1) persist the wrapped content CEK in `_cekPending` (readers
   ignore it → blob stays readable under the `_blob` DEK, and the key survives a crash → no data loss);
   (2) re-encrypt each chunk under the content CEK (a resume reads an already-migrated chunk under the
   content CEK, else the `_blob` DEK); (3) promote `_cekPending` → `_cek` (atomic flip). Until migrated,
   an erasable collection's legacy blobs are reported as residue, not shreddable. Adopting the cascade
   on existing data also needs `vault.rebuildSubjectIndex()` so pre-adoption records are discoverable.
4. **Compaction / GC** (`blob-compaction.ts`, `route-store.ts BlobLifecyclePolicy`) — eviction
   decrements refCount via `deleteSlot` → `BlobSet.delete()`. A single reclaim choke point
   (`releaseRef`) backs every reference-drop path (slot delete/overwrite, published-version delete,
   `forget()` shred): at refCount 0, **erasable** blobs (`_cek`) are crypto-shredded EAGERLY (GDPR
   erasure must not wait on `orphanRetentionDays`), while **legacy** blobs keep deferred GC / orphan
   retention. So compaction eviction of an erasable blob to refCount 0 crypto-shreds it automatically.
5. **export-blobs / bundles** — `export-blobs.ts` exports **plaintext** via `BlobSet.get()`, which is
   content-CEK-aware through `resolveChunkKey` (slice 1) → no change needed; the recipient re-imports
   fresh. Partition **bundles** (`bundle/walk-closure.ts`, `extract-partition.ts`) do NOT include the
   `_blob_*` storage collections, so blob chunks are out of the partition closure — nothing to re-wrap.

## Opt-in (D2 — tie to `perRecordKeys`)

No new public knob. A collection with `perRecordKeys: true` (or declared in `withForgetCascade`) gets
erasable blobs automatically: its `BlobSet.put` mints content CEKs on dedup-miss. Off by default —
non-adopting collections keep the byte-identical shared-`_blob`-DEK path.

## Build slices

1. **`BlobObject._cek` + content-CEK write/read path + dedup-unwrap**, behind the flag, with the
   legacy dual-read. Tests: round-trip, dedup reuses the content CEK, legacy blobs still read.
2. **`forget()` + slot-delete refCount drive + refCount-0 crypto-shred** + the
   `blobsShredded`/`blobsRetainedShared`/residue reporting split.
3. **Migration pass** (`migrateBlobs`) + the un-migrated reporting surface.
4. **Compaction + export/bundle** content-CEK plumbing.

## Acceptance

- A blob attached to a single erasable-collection record is **undecryptable after `forget()`**
  (BlobObject deleted at refCount 0); the `_blob` DEK and every other blob untouched.
- Cross-record dedup still holds (a re-uploaded identical blob shares chunks, `refCount` increments).
- A blob shared by two subjects survives `forget()` of one (`refCount → 1`), reported as retained-shared.
- A non-erasable collection is byte-for-byte unchanged; a mixed vault reads both.
- `forget()` reports erasable blobs as shredded/retained, not as un-erasable residue.

## Decisions

1. **Dedup model = envelope-encryption (content CEK per eTag).** Dedup preserved; crypto-shred at
   refCount 0. *(APPROVED 2026-06-13.)*
2. **Opt-in = tie to `perRecordKeys` / `withForgetCascade`.** No separate flag. *(APPROVED 2026-06-13.)*
3. **`forget()` reporting** splits `blobsShredded` / `blobsRetainedShared` / (legacy-only) residue.
   *(Recommended — confirm.)*
4. **Per-record wrap dropped** as ineffective under dedup; single content CEK in the index.
   *(Design finding — see above.)*
