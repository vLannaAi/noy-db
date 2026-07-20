# Via port phase B — via-classified, via-blob, posture enforcement, ViaCryptoCtx (#629)

**Date:** 2026-07-11
**Issue:** [#629](https://github.com/vLannaAi/noy-db/issues/629) · **Milestone:** #28 "Via port: unified field features [api]" · Phase A merged via #628 (main `f6d70de8`).
**Surface:** `api` — additive hooks + capability types; existing declarations preserved as sugar; `/adapter` and `/cargo` byte-untouched.
**Ground truth:** `.superpowers/sdd/seam-map-classified-blobs.md` (file:line anchors for every seam this spec names). Behavior lock: the FULL classified + blobs + forget/erasure + export + query-refusal suites pass **unchanged**.

## Reframing (from the seam map)

Phase B looked like "two more retrofits like money/i18n." The map splits it differently:

- **Classified** is the deep one — but its enclave entanglement has a clean fracture line: the `_sealed` sub-step (`sealFields`/`unsealField` in `record-codec.ts`) is **separable** (no write-history dependency), while the `_vdig`/`_bidx` digest sub-step is **not** (needs `{id, prev}` write context, integrity-critical). The architecture follows the fracture: seal/unseal moves behind a capability; digests stay codec-inline.
- **Blobs** are the light one — blob writes never touch `_putInternal` or the codec (fully out-of-band side-collections). `via-blob` is declaration + describe + erase + posture; the machinery stays service-side.
- **Two live fragilities get fixed as part of enforcement:** export redaction of classified fields is an *accident* (`SealedHandle.toJSON() → '[sealed]'`; zero classified-aware export code), and `vault.forget()` reaches classified internals via `(coll as any)` casts.
- **Real classified coupling is 6 symbols**, not 9 (3 error classes already live in `kernel/errors` — correct direction already).

## Decision summary

1. **ViaCryptoCtx = two narrow capabilities (Option 3, hybrid wrap/consult):**
   - `sealedSlots` — field-grain seal/unseal bound to `(collection, field, recordId)`. The kernel lifts the separable `_sealed` sub-step behind it; via-classified consumes it from new `encodeAtRest`/`decodeAtRest` hooks. A feature never holds the keyring, raw DEKs, or the enclave barrel.
   - `reservedEnvelopes(prefix)` — whole-envelope encrypt/decrypt + DEK resolution **scoped to a declared reserved-collection prefix**. i18n declares `_dict_`; DictionaryHandle gets its sanctioned path; the `VIA_ENCLAVE_ALLOWLIST` grandfather is **deleted**.
   - `_vdig`/`_bidx` digests stay inside `RecordCodec` (kernel-fixed): the binding *declares* digest participation; the codec consumes **resolved config**, never the binding object.
2. **Pipeline gains three additive hooks** (anticipated by the phase-A spec): an `enforceWrite` phase slot (classified's current post-gate/pre-computed position — a genuinely distinct phase, not foldable into `ingest` which runs pre-gate), `encodeAtRest`/`decodeAtRest` (invoked by the codec boundary, async), and live `erase` hooks (consumed by `forget()`).
3. **Posture enforcement flips three consumers, each behind behavior-parity tests:** query DSL consults `posture.queryable` (identical refusal errors; `'det-exact'` maps onto the `_bidx` equatable mechanism — NOT `_det`, they are two mechanisms); export consults `posture.exportable` (redaction becomes deliberate; the toJSON accident stays as belt-and-braces); `forget()` consults `posture.forgettable` + routes participation through `erase` hooks (classified: sealed-CEK prefix-deletes + shred/residue classification; blob: purge) — killing the `(coll as any)` casts.
4. **via-blob is thin:** folder move `with-shape/blobs` → `shape/via-blob`; binding carries declare/describeFragment/erase + posture `{ encryptedAtRest: 'envelope', queryable: 'none', exportable: true, forgettable: true }`; `BlobSet`, compaction, lifecycle, exportBlobs machinery stays service-side (the i18n-dictionary precedent); vault.ts's 3 value imports get the registry/port treatment. Add the missing blob bundle-check scenario.
5. **via-classified posture:** `{ encryptedAtRest: 'sealed', queryable: 'det-exact', exportable: false, forgettable: true }`.
6. **Async pipeline goes live per-field:** classified/blob stacks are async (crypto/I-O); money/i18n stacks stay sync; the per-field sync-iff-sync rule from A is unchanged.
7. **Ceilings are zero-slack** (collection 4473 / vault 4094 / noydb 2385): every task that adds kernel lines must first remove at least as many (moving `enforceClassifiedWrite` + classified imports out of collection.ts, and the forget-loop delegation out of vault.ts, creates the room). No bumps without a flagged deviation.
8. **Internal unification still** (phase E deferred) — but both capabilities are shaped as things a third-party feature could safely receive: bound to declared scope, revocable, no key material.

## Design

### 1. `ViaCryptoCtx` (`kernel/via.ts`, additive)

```ts
/** Narrow crypto capability handed ONLY to encodeAtRest/decodeAtRest/erase hooks. No key material ever crosses. */
export interface ViaCryptoCtx {
  /** Field-grain sealed-slot operations, pre-bound to (vault, collection, recordId). */
  readonly sealedSlots: {
    seal(field: string, plaintext: unknown): Promise<SealedSlotRef>
    unseal(field: string, ref: SealedSlotRef): Promise<unknown>        // throws ClassifiedRevealError per existing gates
    delete(field: string): Promise<void>                               // erase participation
  }
  /**
   * Whole-envelope crypto for a feature's own reserved collections, scoped to the
   * prefix the binding DECLARED (e.g. '_dict_'). Requests outside the prefix throw.
   */
  reservedEnvelopes(prefix: string): {
    encrypt(collection: string, json: string, v: number): Promise<EncryptedEnvelope>
    decrypt(collection: string, env: EncryptedEnvelope): Promise<string>
  }
}
```

Exact shapes (SealedSlotRef, error types, how the kernel pre-binds) are pinned in the plan against the current `sealFields`/`unsealField`/`resolveEnvelopeCek` signatures. Construction: the kernel (Collection/codec boundary) builds the ctx per call from enclave internals; the binding's declared `reservedPrefixes: ['_dict_']` (new optional `ViaBinding` field) gates `reservedEnvelopes`. The `via-enclave-isolation` rule keeps every `shape/via-*` file enclave-free — now with an **empty** allowlist.

### 2. Codec boundary (the hybrid)

`RecordCodec.encryptRecord`/`decryptRecord` keep their signatures and their inline `_vdig`/`_bidx` digest logic. The `_sealed` sub-step is extracted **inside the kernel** into the sealed-slot capability implementation; the codec invokes the via pipeline's `encodeAtRest`/`decodeAtRest` at exactly the point the inline sealing runs today, passing `ViaCryptoCtx`. For collections with no at-rest hooks the codec path is byte-identical (zero-via fast path extends to the codec boundary). Reveal (`SealedHandle`, reveal gates, `ClassifiedRevealError`) rides `decodeAtRest` + the existing handle machinery; `rotateRecordCek` and the sealed-CEK host-delivery namespace stay kernel-side (enclave concerns, not feature behavior).

### 3. via-classified retrofit

- Move `with-shape/classified/` → `shape/via-classified/`; binding: `declare` (resolveClassifiedFields + guardClassifiedCompat + config errors), `enforceWrite` (the current `enforceClassifiedWrite` body — post-gate/pre-computed slot), `encodeAtRest`/`decodeAtRest` (via `ctx.sealedSlots`), `erase` (sealed-CEK prefix-deletes + `_classifySealedShred` residue classification, consumed by forget), `describeFragment`. The classified marker persistence (`persistClassifiedMarkerForFields`/`readClassifiedMarkerDigestOnly`, the R10 drift guard) stays kernel-adjacent where it lives — the plan maps its exact seam.
- Sugar preserved: `classifiedFields` config + preset factories (`classified.creditCard()` etc.) compile to the binding; `via(classified(...))` works through `viaFields` (descriptors gain `_viaBrand: 'classified'`).
- Strategy: `ClassifiedStrategy`/`NO_CLASSIFIED` moves to `port/with/classified-strategy.ts` (the i18n-strategy precedent) for whatever remains strategy-gated.

### 4. via-blob retrofit

Move + thin binding as Decision 4. Blob field declaration (`blobFields`) compiles to the binding (brand `'blob'`); `BlobSet` routing, `_blob_*` side-collections, compaction/TTL/legal-hold, `exportBlobs` stay service-side. `vault.compact()`/`exportBlobs` public members keep their golden-locked signatures as thin delegators.

### 5. Posture enforcement (parity-first)

Each consumer flips behind tests that pin TODAY's observable behavior first:
1. **Query:** the DSL asks the pipeline's posture before building/evaluating a clause on a covered field; classified fields produce the same refusal errors as today; `det-exact` routes to the existing `_bidx` path. Money (`ordered`) and i18n (`full`) behavior unchanged.
2. **Export:** `exportStream`/bundle export consults `exportable`; classified fields are deliberately redacted (same output as the toJSON accident produces today — byte-parity on export fixtures); the accident remains as defense-in-depth.
3. **Forget:** the forget loop consults `forgettable` and invokes `erase` hooks; classified/blob participation produces identical erasure reports + residue classification (the forget-erasure suites are the lock); the `(coll as any)` casts die.

### 6. Testing

Behavior locks: full classified (incl. guard-gate-parity, reveal-gate, R10 drift), blobs (routing, compaction, lifecycle), forget/erasure (incl. sealed-CEK prefix-delete + residue), export (fixture byte-parity), query-refusal suites — all UNCHANGED. New: ViaCryptoCtx unit tests (scope violations throw: unseal outside bound record, reservedEnvelopes outside declared prefix); codec-boundary zero-via parity; async-stack detection (classified collection = async pipeline, money-only stays sync); grandfather-deletion proof (`VIA_ENCLAVE_ALLOWLIST` empty + rule still fires on synthetic); posture-consumer parity trios; blob bundle scenario.

## Out of scope

Phase C (formula/graph, computed(virtual), #621/#622), phase D (lookup), phase E (external SPI); `_det` unification with `_bidx` (two mechanisms today — flag only); at-* host sealing changes; any envelope-format or `/adapter` change.
