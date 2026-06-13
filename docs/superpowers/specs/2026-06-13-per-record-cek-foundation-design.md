# Per-record content-encryption keys (CEK) — foundation design (DESIGN ONLY, for review)

> **Foundation slice of the erasure/sealing security epic.** This is **step 1** of the build order
> the forget-cascade spec recommends (`per-record CEK → withForgetCascade #304 → record-scoped CEK
> sealing #306`). It introduces a per-record key layer **behind a per-collection flag**, resolves the
> interplay the [forget-cascade spec](./2026-06-08-forget-cascade-design.md) only *flagged*
> (`_det` blind-equality, history, tiers, blobs, bundles, migration, hot-path perf), and is the gate
> for both #304 and #306. **Security-critical core-crypto change — review before implementation.**

**Issues:** foundation for #304 + #306 · **Layer:** crypto / store · **Status:** design, not implemented.
**Architecture grounding:** all file:line refs below are current as of `0.2.0-pre.16` (`400b0583`).

## The one idea

Today the DEK is **per-collection** (`getDEK(collection)` — `keyring.ts:1198`): one AES-256-GCM key encrypts every record body *and* every `_history` envelope in a collection. That makes per-subject erasure and per-record sealing impossible without erasing/sealing the whole collection.

Introduce a **per-record CEK**: a fresh AES-256-GCM key per record, **AES-KW-wrapped under the collection DEK** and stored on the envelope as `_cek`. The body (and every history version of that record) encrypts under the CEK. Then:
- **Erase a record** = delete its `_cek` everywhere → body + all history versions permanently undecryptable; the collection DEK and every *other* record untouched (#304).
- **Seal one record to an `at-*` host** = seal that record's CEK, not the collection DEK (#306).

No new crypto primitives are needed — this mirrors the existing DEK-wrapped-under-KEK pattern exactly (`crypto.ts` already has `generateDEK`/`wrapKey`/`unwrapKey`).

## Envelope format

`EncryptedEnvelope` (`types.ts:98-135`) gains one optional field:

```ts
readonly _cek?: string   // base64 AES-KW-wrapped CEK (wrapped under the collection/tier DEK)
```

`_cek` **presence is the format discriminant** — there is no per-envelope format version today (`_noydb` is a vault-wide constant). `decryptJsonString` (`collection.ts:3928`) branches: `_cek` present → unwrap CEK under the collection DEK, decrypt body with CEK; `_cek` absent → legacy path (decrypt body directly under the collection DEK). This makes the change **backward-compatible by construction** — legacy records read unchanged.

## Write path (the stable-CEK rule)

The CEK must be **stable across versions of a record** — otherwise history versions don't share it and "one delete erases all versions" fails. So:

- **Insert** (`encryptRecord`, `collection.ts:3569`): `cek = generateDEK()`; `encrypt(body, cek)`; `_cek = wrapKey(cek, getDEK(collection))`.
- **Update**: read the live envelope's `_cek`, `unwrapKey` it under the collection DEK, **reuse the same CEK** to encrypt the new body, re-wrap under the (unchanged) collection DEK. Do **not** generate a new CEK on update.
- **History save** (`collection.ts:1441` → `history/history.ts:41`): the prior version is re-encrypted before being displaced. It MUST be encrypted under the **record's CEK**, not a fresh `getDEK` call — so every `_history/{collection}:{id}:{v}` envelope for a record carries that record's same `_cek`. This is the change that makes a single CEK delete kill the whole version chain. *(Today history re-encrypts under the collection DEK — this is the one history-path edit.)*

**Caching:** a session-scoped `(collection,id) → CryptoKey` LRU (reuse `cache/lru.ts`) avoids re-unwrapping on repeated reads and supplies the stable CEK on update. Keyed to session lifetime; bounded by LRU. Cleared on `load()` alongside the DEK cache.

## Read path

`decryptJsonString`: `getDEK(collection)` → (if `_cek`) `unwrapKey(_cek, dek)` → `decrypt(_iv, _data, cek)`. One extra AES-KW unwrap per read (cache-missed); negligible per-op, see Perf.

## Interplay resolutions (the point of this spec)

### 1. Deterministic `_det` fields — STAY DEK-keyed; shred strips them
`_det` blind-equality (`crypto.ts:438` `encryptDeterministic`, written at `collection.ts:3569`, searched at `:3603`) is keyed off the **collection DEK** (HKDF IV from the raw DEK bytes), so equal plaintext → equal ciphertext *across records*. Per-record CEKs would destroy that. **Resolution: `_det` remains keyed to the collection DEK, explicitly excluded from CEK scope.** The body encrypts under the CEK; `_det` slots keep using `getDEK(collection)` unchanged.

**Shred residue (critical):** after a CEK delete, the `_det` map survives on the envelope and `findByDet` would still match a record whose body is gone — then `decryptRecord` throws `TamperedError` (`collection.ts:3603-3628` doesn't catch). **Resolution: a shred is not just "delete `_cek`" — it rewrites the live envelope to a tombstone** that strips `_iv`, `_data`, `_cek`, **and `_det`**, keeping only `{ _noydb, _v, _ts, _by }` (so the version counter + "record existed" survive for ledger/audit continuity), and deletes (or tombstones) every `_history` envelope for the record. With `_det` gone, `findByDet` no longer matches a shredded record; `get()` on a tombstone returns `null`/a `shredded` marker rather than throwing. **`forget()`/shred owns three deletions per record: body-CEK, history envelopes, `_det` slots.** This is the residue fix the forget-cascade spec did not resolve.

### 2. History — shares the record CEK (see Write path)
Verified: history is a verbatim envelope pass-through today (`history.ts:41`), each version independently re-encrypted under the collection DEK at `collection.ts:1441`. Under CEK, that one site uses the record's stable CEK, so all versions share `_cek` and die together on shred. No history-storage change beyond that encrypt-key swap.

### 3. Tiers — compose transparently
Tier DEKs are extra slots in the same keyring Map (`dekKey(collection, tier)`, `team/tiers.ts:24`); `assertTierAccess` gates them. A CEK wrapped under the tier DEK composes — gating the tier DEK gates the CEK. The **one** edit: `elevate`/`demote` (`collection.ts:3832`) must `unwrapKey(_cek, fromTierDEK)` → `wrapKey(cek, toTierDEK)` (re-wrap, same CEK, new wrapping key). `assertTierAccess` is untouched.

### 4. Bundles / extract-partition — re-wrap `_cek` on re-key (correctness-critical)
`reKeyClosure` (`bundle/extract-partition.ts:39`) currently does `{ ...env, _iv, _data }` — re-encrypting bodies under a fresh destination DEK. With `_cek`, that spread would carry a **source-DEK-wrapped** CEK into a bundle re-keyed under a different DEK → **silently undecryptable for the recipient**. **Resolution:** the re-key must `unwrapKey(env._cek, srcDek)` → re-encrypt body under the same CEK (or a fresh one) → `wrapKey(cek, destDek)` → new `_cek`. `sealDeks` (collection-granularity, `:194`) is unchanged — CEKs become accessible transitively once the recipient re-wraps collection DEKs under their KEK (`adopt-partition.ts:249`). **This site needs new test coverage** (none exists — `_cek` is new). #306's record-scoped sealing layers here later: seal one record's CEK instead of the collection DEK.

### 5. Blobs — DEFERRED to a later slice (documented boundary)
Blobs share one vault-wide `_blob` DEK, and dedup keys the eTag off it (`HMAC(blobDEK, plaintext)`, `blobs/blob-set.ts:446`). Per-blob CEK would break cross-record dedup. **Resolution for this foundation: record-CEK does NOT cover blob content.** A record's blob attachments are *not* erased by a record-CEK shred in step 1 — this boundary MUST be surfaced loudly by `forget()` ("N blob attachments not shredded — blob CEK is a separate slice"). Per-blob CEK + dedup-vs-shred tradeoff is its own design (later slice).

### 6. Migration — flag-gated, `_cek`-absence = legacy, surfaced erasure gap
No per-record format version exists; `_cek` absent = legacy (body under collection DEK). New writes on a `perRecordKeys` collection emit `_cek` from the start. Existing records migrate via a re-encrypt pass built on `migrateAll`/`coordinatedCutover` (`collection.ts:1782`, `schema-update/cutover.ts`): decrypt under collection DEK → generate CEK → re-encrypt body under CEK → wrap → write `{ ...env, _cek, _iv, _data }`. **Until a record is migrated, `forget()` cannot guarantee its erasure** (body still directly under the shared collection DEK) — `forget()` MUST report un-migrated records explicitly rather than silently claim success.

## Flag / opt-in
Per-collection opt-in, mirroring `deterministicFields`: `vault.collection(name, { perRecordKeys: true })` sets `this.perRecordCek` and gates the CEK path in `encryptRecord`/`decryptJsonString`. `withForgetCascade({ subjects })` (#304) implies `perRecordKeys` for its declared collections. A vault-wide default can layer on later. Off by default — non-adopters pay nothing and read/write the legacy path unchanged.

## Performance
- **Write:** +1 `generateDEK()` (insert only; updates reuse the cached CEK) +1 `wrapKey` (AES-KW, one RFC-3394 block pass).
- **Read:** +1 `unwrapKey` on cache miss; LRU-cached thereafter.
- AES-KW is cheap; at typical noy-db scale (tens of records/op, ≤50K-record vaults) the overhead is negligible. Add a `to-bench` micro-benchmark (Dim 06) as a build gate; flag if >X% write regression.

## Build slices (step 1 only — #304/#306 are separate)
1. **Envelope `_cek` + crypto wrap/unwrap + read/write path + stable-CEK cache**, behind `perRecordKeys`, with the legacy dual-read. Tests: round-trip, update reuses CEK, legacy records still read.
2. **History under record CEK** (the `collection.ts:1441` key swap) + test that all versions decrypt under the same CEK.
3. **Migration pass** (`migrateAll`-based re-encrypt) + the "un-migrated = not shreddable" reporting surface.
4. **Tier elevate/demote CEK re-wrap** + test.
5. **Bundle `reKeyClosure` CEK re-wrap** + extract/adopt round-trip test with CEK records (the correctness-critical gap).
(#304 `withForgetCascade` + `_det`/history/tombstone shred semantics, and #306 record-scoped CEK sealing, build on top — separate specs/PRs.)

## Acceptance (foundation)
- A `perRecordKeys` collection round-trips records (insert + update) with `_cek`; updates reuse the same CEK; all history versions decrypt under it.
- A non-`perRecordKeys` collection is byte-for-byte unchanged (legacy path); a mixed vault reads both.
- Extract-partition of CEK records → adopt → recipient decrypts every record (the re-wrap works).
- Tier elevate/demote of a CEK record preserves decryptability at the new tier.
- `forget()`/shred (built in #304 on this) makes body + all history undecryptable, strips `_det`, leaves a tombstone, and the ledger hash-chain still verifies — and reports un-migrated/blob residue explicitly.

## Decisions (APPROVED 2026-06-13)
1. **Shred = tombstone.** A shred rewrites the live envelope to `{_noydb,_v,_ts,_by}` — no body / `_cek` / `_det` — and tombstones every `_history` envelope for the record. Preserves the version counter + "existed and was erased" for the audit ledger. (Tombstone *creation* is step 2 / #304; step 1's read path must tolerate a tombstone — see #5.)
2. **CEK reused on re-key.** Bundle/extract re-key keeps the same CEK per record (re-wrapped under the destination DEK), preserving history-chain identity. Fresh-CEK-on-extract is deferred.
3. **Per-collection flag.** `vault.collection(name, { perRecordKeys: true })` — mirrors `deterministicFields`. Off by default; a vault-wide default may layer on later. Erasure-bearing collections opt in without taxing the rest.
4. **Migration = explicit pass** (`migrateAll`-based re-encrypt) for a deterministic erasure-completeness guarantee; lazy-on-next-write may be added later as an optional accelerator. Un-migrated records are reported by `forget()`, never silently claimed erased.
5. **Read-of-shredded = `null` + `_shredded` marker.** `get()` on a tombstone returns `null`; the tombstone carries a queryable `_shredded` metadata marker so callers distinguish "never existed" from "erased." Step 1's read path must return `null` (not throw `TamperedError`) on an envelope with no `_data`/`_cek`.
