# Arc 10 — Blob Content Follows Tier Implementation Plan (#724 / #741)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make an elevated record's blob content tier-invisible — replacing the Arc-7 refusal. Unconditional read-path tier gate + solo-blob in-place CEK rewrap + shared-blob policy (`blobTierPolicy: 'isolate'` default fork / `'dedup'` opt-in) + slot-map metadata move; reversible on demote.

**Architecture:** Spec — `docs/superpowers/specs/2026-07-17-blob-tier-handler-design.md`. A blob's home tier = its owning record's tier; the `_blob` DEK becomes tier-scoped via `getDEK(dekKey('_blob', tier))` (tier-0 byte-identical, no migration). New `TiersContext.syncBlobs` hook → `BlobSet.rehomeForTier`. Reuses enclave `wrapCek`/`unwrapCek`; the fork re-`put()`s through the normal blob write path.

**Tech Stack:** TypeScript ESM, vitest. Branch `fix/724-blob-tier-handler` off main (current HEAD after #722 merge, `0a746e73` — rebase if newer).

## Global Constraints

- NEVER add Claude/Anthropic attribution; never reference the private pilot client — grep the diff before every commit.
- Ceilings exact (checker = `wc -l` + 1): `collection.ts` **4549**, `vault.ts` **3959**, `noydb.ts` **2396** — all at 1-line slack. `collection.ts` gains the `syncBlobs`/`hasBlobFields` wiring and loses the `assertTierComposition` call + import — net must stay ≤ 4548 via mechanical shrink-joins. Never edit ceiling values or check-architecture ratchets. `vault.ts`/`noydb.ts` untouched.
- Enclave-body-only ratchet: `blob-set.ts` is allowlisted at **33** (exact, not a ceiling). Route new CEK access through existing `wrapCek`/`unwrapCek`/`resolveChunkKey` helpers; if a new `_cek`/`_iv`/`_data` read is unavoidable, re-bank the 33 with justification — NEVER edit the ratchet merely to pass.
- Zero-knowledge: rewrap uses `wrapCek`/`unwrapCek` + `getDEK(dekKey('_blob', tier))` only — never raw keyring/DEK material; `rewrapEnvelope`/`rewrapBodyToDek` are NOT reusable for blob CEKs.
- TDD: RED before implementing. Run from `packages/hub/`: `pnpm vitest run <path>`. No new deps; no timing assertions.

---

### Task 1: remove the Arc-7 refusal + unconditional read-path tier gate

**Files:**
- Modify: `packages/hub/src/kernel/collection.ts` (delete `assertTierComposition` call `:895` + import `:82`; add `hasBlobFields`; gate `blob(id)` `:4060`)
- Modify: `packages/hub/src/with-shape/blobs/blob-set.ts` (or the `blob()` accessor path) — the read gate
- Modify: `packages/hub/__tests__/tier-composition-guard.test.ts` (invert describe #2; flip describe #1 post-fix assertion)
- Create: `packages/hub/__tests__/tiers-blobs.test.ts`

**Interfaces:**
- Produces: `collection.blob(id)` refuses (returns the not-visible outcome — match `get()`'s tier-0 gate) when the owning record's `_tier` exceeds the caller's clearance. A `hasBlobFields: boolean` on the collection (true when `blobFields` declares ≥1 field) for the Task-2 no-op guard.
- STUDY FIRST: how `get()`/`getAtTier` gate an elevated record for a tier-0 caller (grep `assertTierAccess`, `_tier`, the #701/#709/#712 read gates in `collection.ts`). The blob gate must reuse the SAME clearance check + read `_tier` from the record envelope metadata BEFORE any blob decrypt (campaign law: gate precedes decrypt). Do not invent a new clearance predicate.
- STUDY: `assertTierComposition` (`with-lookup/indexing/unique-constraints.ts:221`), its sole caller `collection.ts:895`. Keep the `UnsupportedTierCompositionError` class + barrel export (avoids `root-barrel-surface.golden.json` churn).

- [ ] **Step 1: Write the failing tests**

Create `packages/hub/__tests__/tiers-blobs.test.ts`. Build the fixture from `search-retrieve-blob.test.ts` (blobFields + `withBlobs()`), now with tiers (previously impossible — the refusal is being removed):
```ts
/**
 * #724 — an elevated record's blob content must be invisible to a tier-0
 * caller. Task 1: the runtime read gate. collection.blob(id) consults the
 * owning record's _tier before returning bytes, exactly as get() does.
 */
describe('#724 blob read gate', () => {
  it('a tiered collection with blobFields constructs (Arc-7 refusal removed)', async () => {
    // vault.collection('docs', { tiers: [0,1], perRecordKeys: true, blobFields: { attachment: {} } })
    // — no throw (was UnsupportedTierCompositionError).
  })
  it('elevating a blob-owning record hides its blob from a tier-0 caller', async () => {
    // put 'd1' + blob 'attachment'; assert blob(id).get('attachment') returns the bytes;
    // elevate('d1', 1); a tier-0 caller (drop/without the docs#1 tier grant) → blob('d1').get('attachment') is null/not-visible.
    // A sibling tier-0 record 'd2' with its own blob is still readable.
  })
})
```
Then convert `tier-composition-guard.test.ts`: invert describe #2's 6 "throws `UnsupportedTierCompositionError`" cases into "constructs + the blob is reachable"; in describe #1 (the leak repro), flip the post-elevate assertion from "still returns plaintext" to "returns null/not-visible" (the gate now covers it).

- [ ] **Step 2: RED** — construction throws (refusal still present) / the elevated blob still returns plaintext (no gate).

- [ ] **Step 3: Implement** — (a) delete the `assertTierComposition` call `collection.ts:895` + import `:82`; (b) add `hasBlobFields`; (c) gate `blob(id)`: resolve the owning record's `_tier` and apply the same clearance check `get()` uses before returning the blob accessor's bytes. Fund any collection.ts line growth with a shrink-join → end ≤ 4548.

- [ ] **Step 4: GREEN + regression** — the new file + `tier-composition-guard.test.ts` + `search-retrieve-blob.test.ts` + `per-blob-cek.test.ts` + `hierarchical-tiers.test.ts`; `node scripts/check-architecture.mjs`; typecheck; lint.

- [ ] **Step 5: Commit**
```bash
git add packages/hub/src/kernel/collection.ts packages/hub/src/with-shape/blobs/blob-set.ts packages/hub/__tests__/tiers-blobs.test.ts packages/hub/__tests__/tier-composition-guard.test.ts
git commit -m "fix(hub): tiers+blobs read gate — blob(id) hides an elevated record's blob; remove Arc-7 refusal (#724)"
```

---

### Task 2: `syncBlobs` hook + tier-scoped `_blob` DEK + solo-blob in-place CEK rewrap (at rest)

**Files:**
- Modify: `packages/hub/src/with-shape/blobs/blob-set.ts` (`rehomeForTier` + tier-scoped blobDEK selection + solo rewrap)
- Modify: `packages/hub/src/with-audit/tiers/index.ts` (`TiersContext.syncBlobs` + calls in `elevate`/`demote`/`putAtTier`)
- Modify: `packages/hub/src/kernel/collection.ts` (one wiring line in `tiersContext()`; net-zero via shrink-join)
- Modify: `packages/hub/__tests__/tiers-blobs.test.ts` (append at-rest solo tests)

**Interfaces:**
- Produces: `BlobSet.rehomeForTier(fromTier: number, toTier: number, policy: 'isolate' | 'dedup'): Promise<void>` — enumerates the record's eTags via the slot map (mirror `shredAllForRecord:404`), and for each **solo-owned** (`refCount === 1`) `BlobObject`, rewraps `_cek` from `getDEK(dekKey('_blob', fromTier))` to `getDEK(dekKey('_blob', toTier))` and rewrites the object. (Shared blobs handled in Task 3; this task's `rehomeForTier` no-ops on `refCount > 1`.)
- Produces: `TiersContext.syncBlobs(id: string, fromTier: number, toTier: number): Promise<void>` (7th sync hook beside `syncHistory:110`), wired in `collection.ts` `tiersContext()` to `hasBlobFields ? this.blob(id).rehomeForTier(fromTier, toTier, blobTierPolicy) : Promise.resolve()`. Called by `elevate`/`demote`/`putAtTier` in the "after the live adapter.put" block alongside `syncHistory` (order-independent — touches only blob side structures).
- Consumes: `dekKey` (`with-party/team/tiers.ts:24`), `wrapCek`/`unwrapCek` (already imported `blob-set.ts:22-27`), `releaseRef`/`loadSlots` (`blob-set.ts:366,211`). STUDY: `resolveChunkKey:193` (how `_cek` is unwrapped today) and `getDEK` threading (`collection.ts:4072`).

- [ ] **Step 1: Write the failing tests** (append)
```ts
describe('#724 solo blob at-rest isolation', () => {
  it('elevate rewraps a solo blob’s CEK under the tier _blob DEK — undecryptable at tier 0', async () => {
    // put 'd1' + unique blob (refCount 1). elevate('d1', 1).
    // Raw: the BlobObject._cek at _blob_index/{eTag} no longer unwraps under getDEK('_blob') (tier-0);
    // it unwraps under getDEK(dekKey('_blob',1)). Chunks unchanged (same content CEK). A tier-1-cleared caller reads; tier-0 cannot.
    // A sibling solo tier-0 blob is untouched (still unwraps under '_blob').
  })
  it('putAtTier(>0) over a blob-owning record rewraps its solo blob CEK', async () => { /* … */ })
  it('a tiered collection with NO blobFields — syncBlobs is a fast no-op (hasBlobFields false)', async () => { /* … */ })
})
```
Assert at rest via raw `store.get(vault, BLOB_INDEX_COLLECTION, eTag)` + attempting an unwrap under each DEK (grep `per-blob-cek.test.ts` for the raw-inspection idiom). Find the eTag via the slot map or the known plaintext. If a RED doesn't reproduce (e.g. the CEK already moved), STOP → BLOCKED.

- [ ] **Step 2: RED** — post-elevate the `_cek` still unwraps under the flat tier-0 `_blob` DEK.

- [ ] **Step 3: Implement** `rehomeForTier` (solo path only) + `syncBlobs` + wiring. `demote(→0)` rewraps back (fromTier→0); `demote(→ intermediate)` rehomes to the intermediate; `putAtTier(0)` rewraps back. collection.ts ends ≤ 4548 (shrink-join for the wiring line). Watch the blob-set.ts allowlist-33 count — reuse `wrapCek`/`unwrapCek`, don't add raw `_cek` reads beyond what's banked.

- [ ] **Step 4: GREEN + regression** — new file + `per-blob-cek.test.ts` + `blob-set.test.ts` + `hierarchical-tiers.test.ts` + `tier-composition-guard.test.ts`; `node scripts/check-architecture.mjs`; typecheck; lint.

- [ ] **Step 5: Commit**
```bash
git add packages/hub/src/with-shape/blobs/blob-set.ts packages/hub/src/with-audit/tiers/index.ts packages/hub/src/kernel/collection.ts packages/hub/__tests__/tiers-blobs.test.ts
git commit -m "fix(hub): elevate rewraps a solo blob's CEK under the tier _blob DEK — at-rest isolation (#724)"
```

---

### Task 3: `blobTierPolicy` option + shared-blob isolate(fork) / dedup(leave)

**Files:**
- Modify: `packages/hub/src/with-shape/blobs/blob-set.ts` (`rehomeForTier` shared-blob branch)
- Modify: `packages/hub/src/kernel/collection.ts` or the collection-config path (thread the `blobTierPolicy` option; default `'isolate'`)
- Modify: `packages/hub/src/kernel/types.ts` (collection-options type: `blobTierPolicy?: 'isolate' | 'dedup'`)
- Modify: `packages/hub/__tests__/tiers-blobs.test.ts` (append shared-blob tests, both modes)

**Interfaces:**
- Consumes: `put()` (`blob-set.ts:661`) for the fork (re-put plaintext under the tier DEK), `releaseRef` for the shared-ref decrement. STUDY: `put()`'s dedup-by-eTag (`:743-749`) and `eTag = HMAC(blobDEK, plaintext)` (`:716`) — the fork re-puts under the tier-`T` blobDEK, yielding a private tier-scoped eTag.
- Produces: extend `rehomeForTier`'s shared (`refCount > 1`) branch: `policy === 'isolate'` → read the plaintext, re-`put()` under the tier-`toTier` `_blob` DEK, repoint the record's slot to the new eTag, `releaseRef(oldETag)`; `policy === 'dedup'` → leave the slot on the shared eTag (read gate covers runtime).

- [ ] **Step 1: Write the failing tests** (append)
```ts
describe('#724 shared blob — blobTierPolicy', () => {
  it('isolate (default): elevating one co-owner forks a private tier-scoped copy; the tier-0 co-owner is untouched', async () => {
    // 'a' (tier0) and 'b' (tier0) upload IDENTICAL bytes → same eTag, refCount 2.
    // elevate('b', 1). Assert: 'b'’s slot now points to a NEW tier-scoped eTag (refCount 1, _cek under dekKey('_blob',1));
    // 'a' still reads its blob (old eTag survives, refCount decremented to 1); 'b'’s copy is at-rest tier-0-undecryptable.
  })
  it('dedup (#741): the shared object is left in place; both read via the gate; at-rest residue asserted', async () => {
    // same setup, blobTierPolicy: 'dedup'. elevate('b',1). Assert: 'b'’s slot STILL points to the shared eTag;
    // the shared chunk is STILL decryptable under getDEK('_blob') (the documented residue);
    // a tier-0 caller is nonetheless refused at runtime by the read gate (Task 1).
  })
})
```

- [ ] **Step 2: RED** — isolate: the shared object is rewrapped in place (corrupting 'a') or not forked; dedup: no distinct behavior.

- [ ] **Step 3: Implement** the shared branch + thread `blobTierPolicy` (default `'isolate'`). No ceiling file grows beyond slack (types.ts/blob-set.ts have no ceiling; collection.ts only if it threads the option — shrink-join if so).

- [ ] **Step 4: GREEN + regression** — new file + blob suites + `tier-composition-guard.test.ts`; `node scripts/check-architecture.mjs`; typecheck; lint.

- [ ] **Step 5: Commit**
```bash
git add packages/hub/src/with-shape/blobs/blob-set.ts packages/hub/src/kernel/collection.ts packages/hub/src/kernel/types.ts packages/hub/__tests__/tiers-blobs.test.ts
git commit -m "feat(hub): blobTierPolicy isolate(fork)/dedup(leave) for shared blobs on elevate (#724, #741)"
```

---

### Task 4: slot-map metadata move + reversibility matrix

**Files:**
- Modify: `packages/hub/src/with-shape/blobs/blob-set.ts` (slot-map DEK move in `rehomeForTier`)
- Modify: `packages/hub/__tests__/tiers-blobs.test.ts` (append slot-map + reversibility tests)

**Interfaces:**
- Consumes: `loadSlots`/`saveSlots` (`blob-set.ts:211-268`, currently under `getDEK(this.collection)`). Extend `rehomeForTier` to re-encrypt the slot map under `getDEK(dekKey(this.collection, toTier))` on the move and back on demote. STUDY: the slot map is per-record (`_blob_slots_{collection}/{recordId}`), so this is a clean per-record rewrap.

- [ ] **Step 1: Write the failing tests** (append)
```ts
describe('#724 slot-map metadata + reversibility', () => {
  it('after elevate the slot map (filenames/eTags) is not readable under the parent-collection tier-0 DEK', async () => { /* raw read under tier-0 DEK fails; under tier DEK succeeds */ })
  it('demote restores tier-0 readability — solo blob CEK back, isolate fork rejoined/rewrapped, slot map back', async () => {
    // elevate('d1',1) then demote('d1',0): blob(id).get(slot) readable by a tier-0 caller again; _cek unwraps under '_blob'.
  })
  it('elevate → demote → elevate round-trips cleanly (blob readable at the current tier each time)', async () => { /* … */ })
  it('demote of an isolate-forked shared blob re-joins the tier-0 dedup pool if the eTag exists', async () => { /* … */ })
})
```

- [ ] **Step 2: RED** — the slot map still decrypts under the tier-0 DEK after elevate / demote doesn't restore.

- [ ] **Step 3: Implement** the slot-map move + demote reversal for all three cases (solo rewrap-back, isolate fork re-put under tier-0, slot map back). `dedup` shared has nothing to reverse.

- [ ] **Step 4: GREEN + regression** — new file + ALL blob suites + `hierarchical-tiers.test.ts` + the merged tier suites (`tier0-read-paths`, `history-at-rest`, `ledger-purge`, `tiers-search`, `tiers-indexing`, `tiers-derived`); then the FULL hub suite from root; `node scripts/check-architecture.mjs`; typecheck; lint. Adjudicate any pre-existing test that changes.

- [ ] **Step 5: Commit**
```bash
git add packages/hub/src/with-shape/blobs/blob-set.ts packages/hub/__tests__/tiers-blobs.test.ts
git commit -m "fix(hub): move blob slot-map metadata to the tier DEK + demote reversal — full reversibility (#724)"
```

---

### Final: full suite + whole-branch review + changeset + PR

- [ ] `pnpm --filter @noy-db/hub test` + typecheck + lint + `pnpm check:architecture` — green.
- [ ] Whole-branch review (fable — the crux is the SHARED/dedup interaction: prove `isolate` fork NEVER corrupts a co-owning tier-0 record (releaseRef math, the co-owner's eTag survives); prove the read gate covers EVERY blob read entry point (`get`/`response`/`getVersion`/`objectURL`/`presignedUrl`/`url`/`decryptResponse` — grep them all, a gate on `get` alone leaks via the others); prove solo rewrap doesn't re-encrypt chunks yet still isolates at rest; prove reversibility (demote restores) and round-trip stability; prove `dedup` mode's residue is EXACTLY the documented one (shared chunk under `_blob` DEK) and nothing more; sweep for a blob read path or an eTag/refCount edge the arc missed; confirm the enclave-body-only 33 count and all three ceilings hold).
- [ ] Local changeset: `@noy-db/hub` minor (new public `blobTierPolicy` option) — tiers now compose with blobFields (the Arc-7 refusal is removed); an elevated record's blob content is runtime-gated and at-rest-isolated (solo blobs rewrap in place; shared blobs fork under `isolate`, the default). Document `blobTierPolicy: 'dedup'` (#741) and its accepted at-rest residue for shared blobs. (#724)
- [ ] PR → main: `Closes #724`, `Closes #741`.
