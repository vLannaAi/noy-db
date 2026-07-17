# Arc 10 Re-Architecture — tier-scope the blob eTag address space (#724 / #741)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Fix the 4 Criticals the whole-branch review reproduced by making a blob's storage tier = its owning record's tier on WRITE and on MOVE (tier-scoped eTag address space), then covering the forget/version/composition surfaces. Builds ON branch `fix/724-blob-tier-handler` (HEAD `ed241b8b`). Task 1's read gate is kept; Task 2's in-place-rewrap mechanism is REPLACED.

**Architecture:** Spec `docs/superpowers/specs/2026-07-17-blob-tier-handler-design.md` — read the "## Correction" section (the corrected model). Root cause: eTag address space was tier-0-global while CEK wraps became tier-scoped; writes/erasure/versions never learned tiers.

**Tech Stack:** TypeScript ESM, vitest. `packages/hub`.

## Global Constraints

- NEVER add Claude/Anthropic attribution; never reference the private pilot client — grep the diff before every commit.
- Ceilings exact (checker = `wc -l` + 1): `collection.ts` **4549** (at 4548), `vault.ts` **3959** (at 3958), `noydb.ts` **2396** (at 2395) — none may regress; shrink-join to fund additions. Never edit ceiling values or check-architecture ratchets.
- `blob-set.ts` enclave-body-only ratchet is at **36** (exact). Route new CEK access through `wrapCek`/`unwrapCek`/`put`/`putUnderDEK`/`resolveChunkKey`; if the count must change, re-bank with a one-line justification, NEVER edit to merely pass.
- TDD: RED before GREEN. The whole-branch review's repro probes are preserved at `.superpowers/sdd/repro-724-dedup-collision.test.ts` (C1×2, C2, C4) and `.superpowers/sdd/repro-724-forget-elevated.test.ts` (C3) — port the relevant cases into `__tests__/tiers-blobs.test.ts` as the RED for each fix, then make them GREEN. Run from `packages/hub/`.
- No new deps; no timing assertions.

---

### Fix Task 1: tier-scope the eTag on WRITES and MOVES (closes C1 + C2)

**The core fix.** A blob's eTag + content-CEK wrap + slot map are keyed under the OWNING RECORD's current tier: `getDEK(dekKey('_blob', ownerTier))` / `getDEK(dekKey(collection, ownerTier))`.

**Files:**
- Modify: `packages/hub/src/with-shape/blobs/blob-set.ts` (`put`/`putUnderDEK` resolve owner tier; `rehomeForTier` solo path re-`put()`s instead of in-place rewrap)
- Modify: `packages/hub/__tests__/tiers-blobs.test.ts` (port probe C1 + C2 cases as RED; update the Task-2 at-rest solo tests that asserted eTag-stable)

**Interfaces:**
- `put()`/`publish()` write path: before computing the eTag/wrapping the CEK, resolve the owning record's current tier (the `ownerTier()` helper Task 4 added, or `liveRecordIsElevated`'s underlying `_tier` read) and use `getDEK(dekKey('_blob', ownerTier))` for BOTH the eTag HMAC and the CEK wrap, and `getDEK(dekKey(this.collection, ownerTier))` for the slot map. A tier-0 record is byte-identical to today (`dekKey(x,0)===x`).
- `rehomeForTier(fromTier, toTier, policy)`: the SOLO (`refCount===1`) branch now RE-`put()`s the plaintext under the `toTier` DEK (new tier-scoped eTag), repoints the slot, `releaseRef`s the old — identical to the shared-`isolate` fork. The in-place `wrapCek(unwrapCek(...))` rewrite is REMOVED. Net: solo and shared-isolate share one re-put path; `dedup` still skips shared.
- STUDY: `putUnderDEK` dedup-by-eTag (`blob-set.ts:~950`) — with tier-scoped eTags, cross-tier dedup can no longer match (that is the fix). Confirm the dedup match is by eTag alone and that tier-scoped eTags make C1 structurally impossible.

- [ ] **Step 1: RED** — port from `.superpowers/sdd/repro-724-dedup-collision.test.ts`: (C1a) d1 put X → elevate(d1,1) → d2 (tier0) put X → `d2.blob().get()` must succeed (currently throws InvalidKeyError); (C1b) then `demote(d1,0)` → `d1.blob().get()` must succeed; (C2) elevate(d1,1) → `d1.blob().put(secret)` → raw `_cek` must NOT unwrap under tier-0 `_blob` DEK. Run RED.
- [ ] **Step 2: Implement** the write-tier resolution + solo re-put. Delete the in-place-rewrap code path. Update the Task-2 tests that asserted the eTag stays stable / chunks unchanged — under the corrected model a solo elevate re-puts (new eTag, new chunks); assert the NEW correct behavior (eTag changes to the tier-scoped one; tier-0 can't decrypt), not the old.
- [ ] **Step 3: GREEN + regression** — `tiers-blobs` + `per-blob-cek` + `blob-set` + `blob-large-roundtrip` + `blob-compaction` + `hierarchical-tiers` + `tier-composition-guard`; `node scripts/check-architecture.mjs`; typecheck; lint. Watch the ratchet-36.
- [ ] **Step 4: Commit** — `git commit -m "fix(hub): tier-scope the blob eTag on writes and moves — no cross-tier dedup collision (#724 C1/C2)"`

---

### Fix Task 2: published versions follow tier (closes C4)

**Files:**
- Modify: `packages/hub/src/with-shape/blobs/blob-set.ts` (`publish` writes under owner tier; `rehomeForTier` enumerates + rehomes version-held eTags and re-keys version records)
- Modify: `packages/hub/__tests__/tiers-blobs.test.ts` (port probe C4)

**Interfaces:**
- `publish(slot, label)`: resolve owner tier; write the version record (`writeVersionRecord`, `blob-set.ts:~775`) under `getDEK(dekKey(this.collection, ownerTier))` and ensure the version's refCount hold is on a tier-scoped object.
- `rehomeForTier`: after the slot loop, enumerate this record's version records (`_blob_versions_{coll}/{recordId}::*`), rehome any version-held eTag not already covered by the slot loop (re-`put()` under `toTier`, repoint the version record's eTag, releaseRef old), and re-key the version records under the `toTier` collection DEK. STUDY `listVersions`/`loadVersionRecord`/`writeVersionRecord` (`blob-set.ts:~763-1336`).

- [ ] **Step 1: RED** — port probe C4: put + `publish` + `elevate(d1,1)` → the version-held object's `_cek` must NOT unwrap under the tier-0 `_blob` DEK, and the version record must NOT decrypt under the tier-0 collection DEK. Run RED.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: GREEN + regression** — the above + any version/publish test suites (grep `__tests__` for `publish`/`version`); check-architecture; typecheck; lint.
- [ ] **Step 4: Commit** — `git commit -m "fix(hub): published blob versions follow the owning record's tier (#724 C4)"`

---

### Fix Task 3: forget() threads the pre-tombstone tier (closes C3)

**Files:**
- Modify: `packages/hub/src/kernel/vault.ts` (`forget` passes the live record's `_tier` into `shredAllForRecord`) — or `blob-set.ts` if the tier can be threaded through the BlobSet accessor
- Modify: `packages/hub/src/with-shape/blobs/blob-set.ts` (`shredAllForRecord(ownerTier?)` uses the passed tier instead of peeking the tombstone)
- Modify: `packages/hub/__tests__/tiers-blobs.test.ts` (port probe C3)

**Interfaces:**
- `forget()` (`vault.ts:~2411`) reads the live record BEFORE `_writeTombstone` — capture its `_tier` and pass it to `shredAllForRecord(tier)`. `shredAllForRecord` uses `getDEK(dekKey(this.collection, tier))` for `loadSlots` (and any per-blob tier DEK) instead of `ownerTier()` (which peeks the now-tombstoned, tier-0 record).
- STUDY: `vault.ts` forget ordering (`_writeTombstone` at `tombstone.ts:56-65` drops `_tier`), `shredAllForRecord` (`blob-set.ts:~460`), `ownerTier()`.
- Ceiling: `vault.ts` ≤ **3958** — shrink-join if the threading adds a line.

- [ ] **Step 1: RED** — port `.superpowers/sdd/repro-724-forget-elevated.test.ts`: put + blob + `elevate(d1,1)` + `vault.forget(d1)` must NOT throw and must crypto-shred the blob (raw chunks gone). Run RED (currently `TamperedError`).
- [ ] **Step 2: Implement.**
- [ ] **Step 3: GREEN + regression** — the above + `hierarchical-tiers` + forget/delete/tombstone suites (grep `__tests__` for `forget`) + `blob-legalhold-retention`; check-architecture; typecheck; lint; `wc -l vault.ts`.
- [ ] **Step 4: Commit** — `git commit -m "fix(hub): forget() threads the pre-tombstone tier into blob shred — erasure of an elevated blob-owner (#724 C3)"`

---

### Fix Task 4: composition enforcement + drop the hasBlobFields gate (closes I1)

**Files:**
- Modify: `packages/hub/src/kernel/collection-config.ts` or `collection.ts` (enforce `perRecordKeys` when tiers + blobs; the `syncBlobs` gate)
- Modify: `packages/hub/__tests__/tiers-blobs.test.ts`

**Interfaces:**
- At construction, a collection with `tiers` AND blob usage (declared `blobFields` OR — since blobs can be written without declaration — any tiered collection) must have `perRecordKeys: true`; else throw `UnsupportedTierCompositionError` with a message naming `perRecordKeys` (legacy no-`_cek` blobs cannot be tier-isolated). Decide the trigger: simplest correct rule = a tiered collection requires `perRecordKeys` if it could ever hold blobs; since that's not statically known, require `perRecordKeys` on ANY tiered collection that declares `blobFields`, AND make `syncBlobs` run for every tiered collection (drop the `hasBlobFields` fast-path gate) so undeclared-blobFields blobs still rehome. `rehomeForTier` already self-no-ops on an empty slot map, so the cost is one `loadSlots` per tier move.
- STUDY: `hasBlobFields` (added Task 1, `collection.ts:~4513`), how other composition guards throw (`assertTierComposition` in `unique-constraints.ts`).

- [ ] **Step 1: RED** — (a) a tiered collection with `blobFields` but WITHOUT `perRecordKeys` must throw at construction (currently constructs, then leaks legacy blobs); (b) a tiered collection with NO declared `blobFields` but a blob written via `blob(id).put()` then `elevate` → the blob must be at-rest-isolated (currently `syncBlobs` no-ops because `hasBlobFields` is false → leak). Run RED.
- [ ] **Step 2: Implement.** Update any existing test relying on the old `hasBlobFields` no-op or on constructing tiers+blobs without perRecordKeys.
- [ ] **Step 3: GREEN + regression** — `tiers-blobs` + `tier-composition-guard` + `per-blob-cek` + `hierarchical-tiers`; check-architecture; typecheck; lint.
- [ ] **Step 4: Commit** — `git commit -m "fix(hub): enforce perRecordKeys on tiered blob collections + rehome undeclared-blobFields blobs (#724 I1)"`

---

### Final: full suite + re-run whole-branch review + follow-ups + changeset + PR

- [ ] Full hub suite `pnpm --filter @noy-db/hub test` + typecheck + lint + `pnpm check:architecture` — green. Delete/park the ported probe scaffolding if duplicated by the committed tests.
- [ ] File follow-up issues: I2 (mid-loop crash self-healing / atomicity across a multi-blob rehome), I3 (`BlobObject` index-envelope metadata + `_isolated` marker readable under the flat `_blob` DEK — timestamps elevation), I4 (`extract-partition` `reKeyBlobs` tier-blindness — verify elevated records reachable in a closure), I5 (no `blobAtTier` cleared-read path — an elevated record's own attachment is unreachable via any API until demote). Reference #724.
- [ ] **Re-run the whole-branch fable review** (this branch was BLOCKED once — the re-review must confirm C1–C4 + I1 are closed, the repro probes are GREEN, no NEW interaction bug was introduced by the re-architecture, and the deferred I2–I5 are the only residue; scrutinize the write-tier resolution for a new leak, and the multi-blob rehome atomicity).
- [ ] Local changeset: `@noy-db/hub` minor (new public `blobTierPolicy` option; tiers now compose with blobFields, Arc-7 refusal removed) — an elevated record's blob content, published versions, and slot-map metadata are runtime-gated and at-rest-isolated under the owning record's tier; writes to an elevated record and `forget()` erasure are tier-correct; a tiered blob collection requires `perRecordKeys`. Document `blobTierPolicy: 'dedup'` (#741) at-rest residue and the deferred I2–I5. (#724, #741)
- [ ] PR update (branch already pushed as #? — check `gh pr list --head fix/724-blob-tier-handler`; if no PR yet, open one): `Closes #724`, `Closes #741`. Do NOT merge until the re-run whole-branch review passes.
