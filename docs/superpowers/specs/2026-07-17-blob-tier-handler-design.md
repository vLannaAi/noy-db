# Arc 10 — blob content follows its owning record's tier (#724)

**Issue:** [#724](https://github.com/vLannaAi/noy-db/issues/724) · recon: task a9bb1a6d. **Owner decision (2026-07-17):** replace the Arc-7 refusal with a real handler; expose tier-isolation-vs-dedup as a **policy option** (`blobTierPolicy`), default to law-compliant isolation, implement both modes now. Option tracked as [#741](https://github.com/vLannaAi/noy-db/issues/741).
**Predecessors:** the tier campaign through #722 + the Arc-7 composition guard (#724-verify). This is the last of the "full support" handlers; it closes #724 and #741.

## The problem (recon-confirmed leak)

Blob field content is stored as chunks encrypted with a per-blob content CEK, wrapped under a **flat, vault-wide `_blob` DEK** (`getDEK('_blob')`) with **no tier parameter** (`blob-set.ts`). The wrapped CEK lives on a **shared, content-addressed, refcounted `BlobObject`** at `_blob_index/{eTag}` — not on the record envelope, not keyed by record id. Tier ops (`elevate`/`demote`/`putAtTier`) never touch blobs. The read path `collection.blob(id)` → `BlobSet` has **zero `_tier` awareness**.

Result (reproduced in `tier-composition-guard.test.ts` describe #1): elevate a record that owns blob content, delete the record's tier DEK — `docs.get(id)` correctly returns `null`, but `docs.blob(id).get(slot)` still returns full plaintext. The blob content is neither runtime-hidden nor at-rest-isolated by the record's elevation. Same leak class as `_idx` (#709), `_vec`/`_ftindex` (#721), history (#712), ledger (#729), derived outputs (#722): **an attached artifact inherits a non-tier key and doesn't move when the record's tier moves.**

Arc 7 only *refused* the `tiers + blobFields` composition (`assertTierComposition` throws `UnsupportedTierCompositionError`). This arc removes that refusal and makes the composition work correctly.

## Why blobs diverge from #712 (the design crux)

History/ledger deltas are **strictly per-record** — #712 rewraps a record's own history CEKs with no side effects. Blob content is **deduplicated / content-addressed / refcounted**: two records that upload identical bytes share one `BlobObject` with one wrapped CEK (`eTag = HMAC(_blob DEK, plaintext)`; `put()` dedups by eTag; `releaseRef` decrements). A naive "rewrap the record's blob CEK" would **corrupt every co-owning tier-0 record** of the same bytes. This sharing is the reason the fix needs a policy, not a fixed rewrap.

## Design: a blob's home tier = its owning record's tier

Generalize the `_blob` DEK to be tier-scoped: **`getDEK(dekKey('_blob', tier))`** — `dekKey('_blob', 0) === '_blob'` (byte-identical to today; no migration for tier-0), `dekKey('_blob', N) === '_blob#N'` (`with-party/team/tiers.ts:24`). A record at tier `T` homes its blobs under the tier-`T` `_blob` DEK.

Three mechanisms, composed:

### 1. Read-path tier gate — UNCONDITIONAL (both policy modes)

`collection.blob(id)` consults the owning record's `_tier` before returning any blob bytes. If the record is elevated beyond the caller's clearance (the caller lacks the tier DEK), the blob accessor refuses exactly as `get()` does for the record (returns `null` / the same not-visible outcome — match `getAtTier`/`get`'s existing tier-0 gate semantics, established #701/#709/#712). This is the **runtime** defense and is present in every mode. The gate reads only `_tier` metadata — no decrypt before the gate (campaign law: gates precede decrypt).

### 2. Solo-owned blob (refCount == 1) — in-place CEK rewrap (both modes)

> **⚠️ SUPERSEDED — see "## Correction" below.** The in-place-rewrap-keep-eTag optimization described here is UNSAFE: keeping the eTag in the tier-0 HMAC namespace while rewrapping the `_cek` to a tier DEK causes a later same-bytes tier-0 `put()` to dedup-*hit* a tier-N-wrapped object (silent corruption of an uninvolved writer — Critical C1). The corrected mechanism re-`put()`s the blob under the tier DEK so its eTag is tier-scoped. The paragraph below is retained as the record of what was tried and why it was wrong.

When the elevating record exclusively owns a blob (`refCount == 1`), rewrap its `BlobObject._cek` from the tier-0 `_blob` DEK to the tier-`T` `_blob` DEK: `wrapCek(await unwrapCek(blob._cek, blobDEK0), blobDEKT)`, rewrite the `BlobObject`. Chunks are **not** re-encrypted (they stay under the unchanged content CEK) — O(1), not O(size). The `eTag` stays stable (addressing DEK unchanged; a minor dedup-miss for a later same-plaintext tier-`T` put is acceptable). At-rest: a tier-0 caller can no longer unwrap `_cek` → cannot derive the content CEK → cannot read chunks. No dedup cost (the blob is solo by definition).

### 3. Shared blob (refCount > 1) — policy-dependent (`blobTierPolicy`)

New collection option **`blobTierPolicy?: 'isolate' | 'dedup'`**, default `'isolate'`:

- **`isolate`** (default, at-rest law-compliant): **fork** — re-`put()` the blob's plaintext under the tier-`T` `_blob` DEK (yielding a tier-scoped `eTag' = HMAC(blobDEK_T, plaintext)`, a private `_blob_index/{eTag'}` + `_blob_chunks/{eTag'}_*`), repoint the record's slot to `eTag'`, and `releaseRef(eTag)` on the shared object (co-owners keep it). O(size) but only for genuinely cross-tier-shared blobs. Fully at-rest-isolated; dedup lost for this elevated blob (dedup among same-tier elevated records still works — same tier DEK → same `eTag'`).
- **`dedup`** (opt-in, #741): leave the slot pointing at the shared tier-0 `eTag`; the read gate (mechanism 1) is the only defense. **Documented at-rest residue:** a tier-0 holder of the `_blob` DEK can still decrypt the shared chunks off the store. Accepted, tracked property (analogous to #722's aggregate-inference channel).

### 4. Slot-map metadata move (both modes)

The slot map `_blob_slots_{collection}/{recordId}` (filenames, sizes, mimeTypes, eTags) is stored under the **parent-collection (tier-0) DEK** and is strictly per-record (not shared). On elevate, rewrap it under the tier-`T` DEK (a clean per-record move, like the record envelope). On demote, move it back. This keeps blob *metadata* from leaking at tier 0.

### Reversal on demote (reversibility)

- Solo rewrapped → rewrap `_cek` back to the tier-0 `_blob` DEK.
- `isolate` fork → re-`put()` the plaintext under the tier-0 `_blob` DEK (re-joining the tier-0 dedup pool if that `eTag` already exists), repoint the slot, release the tier-`T` copy.
- Slot map → move back to the parent-collection DEK.
- `dedup` shared → nothing to reverse (never moved).

`putAtTier(T>0)` behaves like elevate-to-`T`; `putAtTier(0)` / `demote(→0)` like the reversal. `demote(→ intermediate >0)` re-homes to the intermediate tier (still isolated).

## The hook

`TiersContext.syncBlobs(id, fromTier, toTier): Promise<void>` — a seventh `sync*` hook beside `syncHistory` (same "after the live `adapter.put`" block; runs alongside `syncHistory`, order-independent — it touches only the blob side structures, not this collection's cache/indexes). Wired in `collection.ts` `tiersContext()` to a `BlobSet` method `rehomeForTier(id, fromTier, toTier, policy)`. The tier op does **not** hold a blob manifest (the envelope carries no blob reference), so `syncBlobs` opens a `BlobSet` for `id` and enumerates via the slot map (the same enumeration `shredAllForRecord` uses). Guarded by a `hasBlobFields` flag (no-op fast when the collection declares no blob fields).

## Removing the Arc-7 refusal

`assertTierComposition`'s only production caller is `collection.ts:895` (import `:82`). Delete the call + import. **Keep** the `UnsupportedTierCompositionError` class and its barrel export (`index.ts:974`) — it stays available for genuinely unsupported future compositions, and keeping it avoids churning `root-barrel-surface.golden.json`. Invert `tier-composition-guard.test.ts` describe #2 (the 6 "throws" cases become "constructs + behaves" cases); keep describe #1 (the leak repro) and flip its post-fix assertion from "leaks plaintext" to "blob is tier-invisible".

## Constraints

- **Zero-knowledge:** rewrap uses the enclave `wrapCek`/`unwrapCek` primitives only; it resolves tier `_blob` DEKs via the sanctioned `getDEK(dekKey(...))` path, never raw keyring/DEK material. The fork re-`put()`s through the normal blob write path (no new crypto). `rewrapEnvelope`/`rewrapBodyToDek` are **not** reusable (envelope-triple, not blob-CEK) — use the lower-level `wrapCek`/`unwrapCek`.
- **Enclave-body-only ratchet:** `blob-set.ts` is allowlisted at **33** (`check-architecture.mjs` PRE_EXISTING_BODY_ACCESS) and is NOT inside `kernel/enclave/`, so the rewrap may live in `blob-set.ts`. Any new `_cek`/`_iv`/`_data` field reads there **re-bank** the 33 (exact count, not a ceiling) — prefer routing new CEK reads through existing helpers; if the count must rise, re-bank with justification and never edit the ratchet to merely pass.
- **Ceilings (exact, checker = `wc -l` + 1):** `collection.ts` **4549**, `vault.ts` **3959**, `noydb.ts` **2396** — all at **1-line slack**. `collection.ts` gains the `syncBlobs` wiring + `hasBlobFields` and loses the `assertTierComposition` call+import: net must stay ≤ ceiling via shrink-joins. `vault.ts`/`noydb.ts` untouched.
- No new deps; no timing assertions. TDD, `packages/hub`.

## Coverage gap

No test combines tiers with blobs (Arc 7 refuses the combo). Tests must build the fixture from scratch: `vault.collection('docs', { tiers: [0,1], perRecordKeys: true, blobFields: { attachment: {} } })` (previously impossible — the refusal is being removed). Cover:
- **Read gate:** elevate a blob-owning record; a caller without the tier DEK gets `null`/not-visible from `blob(id).get(slot)` (both modes).
- **Solo at-rest:** elevate, delete the tier DEK → the raw chunk is undecryptable under the tier-0 `_blob` DEK (rewrapped `_cek`); a sibling tier-0 record's blob is untouched.
- **Shared `isolate`:** two records share bytes (same eTag, refCount 2); elevate one → it gets a private tier-scoped copy, the co-owner (tier 0) still reads its blob, the elevated copy is at-rest-isolated.
- **Shared `dedup`:** same setup, `blobTierPolicy: 'dedup'` → the shared object is untouched, both records read at runtime via the gate, and the at-rest residue is asserted (the shared chunk is still decryptable under `_blob` DEK — the documented property).
- **Reversibility:** elevate → demote restores tier-0 readability (solo + isolate fork); round-trip stable.
- **Slot-map move:** after elevate, the slot map is not readable under the parent-collection tier-0 DEK; after demote it is again.
- **No-blob-fields no-op:** a tiered collection with no blob fields — `syncBlobs` is a fast no-op.

## Tests reference

Working fixtures: `search-retrieve-blob.test.ts` (canonical `blobFields` + `withBlobs()` setup, `docs.blob(id).put/get/list`), `per-blob-cek.test.ts` (content-CEK write/read/shred, raw `_blob_index`/`_blob_chunks` inspection), `tier-composition-guard.test.ts` (the refusal to invert + the leak repro to flip), `hierarchical-tiers.test.ts` (tiers). Raw store inspection via `store.get(vault, BLOB_INDEX_COLLECTION/BLOB_CHUNKS_COLLECTION, key)`.

---

## Correction (post-whole-branch-review, 2026-07-17)

The first implementation (Tasks 1–4, branch `fix/724-blob-tier-handler`) was BLOCKED by the whole-branch review, which reproduced **four Criticals from one root cause**:

> **The blob eTag address space stayed tier-0-global while the CEK *wraps* became tier-scoped — and only the read surface and the tier-move hook were taught about tiers. The write path, the `forget()` erasure path, and published versions were not.**

- **C1** — solo rewrap kept the eTag in the tier-0 HMAC namespace; a later same-bytes tier-0 `put()` dedup-*hits* the tier-N-wrapped object → the innocent tier-0 writer's blob is unreadable, and demote re-derives the same eTag → the elevated record's blob breaks too. Silent cross-writer corruption.
- **C2** — `put()` wraps under the flat `_blob` DEK unconditionally; a blob written to an already-elevated record is tier-0-decryptable at rest (the exact #724 leak) and bricks the next demote.
- **C3** — `forget()` of an elevated blob-owner crashes mid-erasure: the tombstone carries no `_tier`, so `shredAllForRecord` reads the tier-N slot map under the tier-0 DEK → `TamperedError`, record tombstoned but blob not shredded (GDPR erasure broken).
- **C4** — published versions (`_blob_versions_*`) are blob *content* under the tier-0 collection DEK; `publish()` takes an independent refCount hold the fork doesn't release, and versions whose eTag left the slot map are never rehomed → content decryptable at rest.

### Corrected model: a blob's storage tier = its owning record's tier — on write AND on move

The eTag address space is tier-scoped: everything a record's blob touches (chunk eTag HMAC, content-CEK wrap, slot map, version records) is keyed under `getDEK(dekKey('_blob'|collection, ownerTier))`.

1. **Writes are tier-aware (C2).** `put()`/`publish()` resolve the owning record's current `_tier` and key the eTag + CEK wrap + slot map + version record under that tier's DEK. A blob written to a tier-`T` record is born at tier `T`. (The caller can only reach an elevated record if cleared, so it holds the tier DEK.)
2. **Rehome = re-`put()` (C1).** `rehomeForTier(fromTier, toTier)` re-`put()`s each owned blob's plaintext under the `toTier` DEK (a tier-scoped eTag), repoints the slot, `releaseRef`s the old — for **solo and shared-`isolate` alike** (the in-place-rewrap optimization is dropped; solo and shared-isolate converge). Cross-tier dedup can no longer occur (different tiers → different eTags), so C1 is structurally impossible. `dedup` mode still skips the re-`put()` for a shared blob (leaves the slot on the tier-0 object; documented at-rest residue — #741).
3. **Versions follow (C4).** `rehomeForTier` also enumerates and rehomes version-held eTags and re-keys the version records under the tier DEK; `publish()` writes under the owner tier.
4. **`forget()` threads the pre-tombstone tier (C3).** `forget()` reads the live record (which still has `_tier`) before writing the tombstone and passes that tier into `shredAllForRecord`, so the slot map is decrypted under the correct tier DEK.
5. **Composition is enforced (I1).** A tiered collection that uses blobs must set `perRecordKeys` (legacy no-`_cek` blobs cannot be tier-isolated) — refuse at construction otherwise. The `hasBlobFields` fast-path gate on `syncBlobs` is dropped in favor of running the rehome whenever tiers are active (it self-no-ops on an empty slot map), since blobs can be written without a declared `blobFields` (the original #724 repro shape).

### Retained from v1
Task 1's runtime read gate (all 11 read/metadata methods, gate-before-decrypt) is correct and unchanged. Task 3's `blobTierPolicy` isolate/dedup branch for **shared** blobs is retained (isolate now re-`put()`s, which it already did; dedup leaves). Task 4's slot-map move + reversibility framing is retained and extended to versions.

### Deferred as tracked follow-ups (owner-approved)
I2 (mid-loop crash self-healing), I3 (`BlobObject` index-envelope metadata + `_isolated` marker under the flat DEK), I4 (`extract-partition` `reKeyBlobs` tier-blindness), I5 (no `blobAtTier` cleared-read path). Filed as issues, not blockers.
