# Blob Tier-Completeness (#747 + #749) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the tiers×blobs at-rest story: the `BlobObject` index envelope follows the owning eTag's tier DEK (#747, metadata leak), and cleared callers get a sanctioned read path to an elevated record's blobs (#749, `blob(id).atTier()` — the `getAtTier` analogue).

**Architecture:** #747 threads an explicit/defaulted `tier` through the four `BlobObject` I/O helpers (`loadBlobObject`/`writeBlobObject`/`casUpdateRefCount`/`releaseRef`), defaulting to `ownerTier()` exactly like `loadSlots` already does, with a **flat-DEK fallback read** for the two legitimate flat-object classes (dedup-shared and legacy). #749 adds a `clearedRead` mode to `BlobSet` that skips the `recordIsElevated()` hidden-gate; clearance is enforced cryptographically (resolving the record's tier DEK is the gate — owners/admins mint, uncleared members throw), consistent with the family's key-possession philosophy.

**No migration needed (load-bearing fact):** the entire #724/#751 tiers×blobs arc is merged-but-UNPUBLISHED (everything after `0.3.0-pre.12`). No elevated blob exists at rest outside this repo's tests, so #747 can change the at-rest keying of elevated index envelopes without a compatibility read path for "old elevated" data. Tier-0 envelopes are untouched by construction (`dekKey('_blob', 0) === '_blob'`).

**Tech Stack:** TypeScript ESM, vitest, `crypto.subtle` only.

## Global Constraints

- `blob-set.ts` has NO line ceiling; `collection.ts` (4549) and `vault.ts` (3959) ceilings must NOT be touched — that is why #749 lives on `BlobSet`, not `Collection`.
- The `enclave-body-only` grandfather count for blob-set.ts in `scripts/check-architecture.mjs` is 37 — do not add raw `_data`/`_iv` reads beyond existing patterns; if a new one is unavoidable, ratchet with a comment (as #750 did 36→37).
- Never add Claude attribution. Hub stays portable (no Node built-ins).
- Branch: `fix/747-749-blob-tier-completeness` off `main` (create AFTER PR #755 merges; base on the updated main).
- Repo root: `/Users/vicio/lanna-db/noy-db`. TDD throughout.

---

### Task 1: #747 — BlobObject index envelope follows the eTag's tier DEK

**Files:**
- Modify: `packages/hub/src/with-shape/blobs/blob-set.ts` (`loadBlobObject` ~387, `writeBlobObject` ~400, `casUpdateRefCount` ~426, `releaseRef` ~460, plus the tier-knowing call sites listed below)
- Test: `packages/hub/__tests__/tiers-blobs.test.ts` if it exists (check; the #724 arc's tests live somewhere — `grep -rln 'rehomeForTier' packages/hub/__tests__/`), else append to `packages/hub/__tests__/blob-set.test.ts`

**Interfaces:**
- Produces: `loadBlobObject(eTag, tier?)`, `writeBlobObject(blob, expectedVersion?, tier?)`, `casUpdateRefCount(eTag, delta, tier?)`, `releaseRef(eTag, n, reclaimLegacy, tier?)` — all `tier?: number`, default resolution `tier ?? await this.ownerTier()`. All private; no public-surface change.

- [ ] **Step 1: Write the failing at-rest key-inspection tests**

Mirror the #712/#724 at-rest test style (find it: `grep -rn 'not.*decrypt\|TamperedError' packages/hub/__tests__/ | grep -i 'tier\|rest' | head`). Cases (use `withTiers()` + `withTeam()` + `withBlobs()` + a `perRecordKeys: true` tiered collection; elevate via the collection's tier API):

```ts
// 1. THE LEAK (RED): after elevate(id, 1), the record's blob's _blob_index envelope
//    must NOT decrypt under the flat '_blob' DEK — assert openEnvelopeJson (or a
//    direct decrypt attempt via a second tier-0-only session reading the store)
//    fails; and the blob still round-trips for the elevated owner (rehome intact).
// 2. Demote(→0) re-keys the index envelope back to the flat DEK (decryptable again).
// 3. Tier-0 record: envelope keyed exactly as before (flat DEK) — pre-existing
//    blob-set tests already cover behavior; add one explicit decrypt-under-flat assert.
// 4. dedup policy: elevated owner, shared blob left in place — index envelope STAYS
//    flat (documented residue), reads still work via the fallback.
```

Write them as real tests (two sessions where needed: writer session + a reader session holding only tier-0 keys). RED: case 1 currently decrypts fine under the flat DEK.

- [ ] **Step 2: Implement the tier threading**

In `blob-set.ts`:

1. `loadBlobObject(eTag: string, tier?: number)`: resolve `const t = tier ?? await this.ownerTier()`; if `t > 0`, try `getDEK(dekKey(BLOB_COLLECTION, t))` first and on decrypt failure (catch around `openEnvelopeJson`) retry under the flat `getDEK(BLOB_COLLECTION)` — the fallback covers the two legitimate flat classes (dedup-shared object pointed at by an elevated slot; legacy `_cek`-less object). `t === 0` → flat only (today's path). Return shape unchanged.
2. `writeBlobObject(blob, expectedVersion?, tier?)`: encrypt under `getDEK(dekKey(BLOB_COLLECTION, tier ?? await this.ownerTier()))`. IMPORTANT: every write site that MUTATES an existing object (refCount CAS) must write back under the SAME DEK it decrypted with — extend `loadBlobObject` to also return which tier key opened it (`{ blob, version, atTier: number }`, internal), and have `casUpdateRefCount` pass that through to `writeBlobObject`. This is what keeps a dedup-shared flat object flat when an elevated owner releases a ref.
3. `casUpdateRefCount(eTag, delta, tier?)` / `releaseRef(eTag, n, reclaimLegacy, tier?)`: accept and forward `tier`.
4. Call sites that must pass an explicit tier (they know better than `ownerTier()`, which is wrong mid-move or post-tombstone):
   - `rehomeForTier`'s loop (~639): `loadBlobObject(eTag, fromTier)`; its NEW object creation lands via `putUnderDEK` → `writeBlobContent` → the fresh `writeBlobObject` must use `toTier` — thread it (writeBlobContent already receives the target `blobDEK`; add the tier param alongside).
   - `rehomeVersionRecords`/`rehomeVersionETag` (~742-767): `fromTier` for loads, `toTier` for the re-put.
   - `shredAllForRecord`/`collectVersionHolds`: pass the method's `ownerTier` param down to `releaseRef` (post-tombstone, the default would resolve 0).
   - `deleteVersion`, `delete`, `put`'s old-eTag decrement, `publish`'s +1: default (`ownerTier()`) is correct — leave them.
   - `migrate()` (~855): legacy-only by definition → pass `0` explicitly.
5. Keep the raw `_data` reads structurally as they are (same `!this.encrypted` branches) — no new grandfather entries expected.

- [ ] **Step 3: GREEN + regression**

Run the new tests + `pnpm vitest run packages/hub/__tests__/blob-set.test.ts packages/hub/__tests__/tier-composition-guard.test.ts packages/hub/__tests__/per-blob-cek.test.ts packages/hub/__tests__/forget.test.ts` and whichever file holds the #724 rehome tests. All green.

- [ ] **Step 4: Commit**

```bash
git commit -m "fix(hub): BlobObject index envelope follows the eTag's tier DEK — elevated blob metadata not tier-0-readable at rest (#747)"
```

---

### Task 2: #749 — `blob(id).atTier()` cleared-read path

**Files:**
- Modify: `packages/hub/src/with-shape/blobs/blob-set.ts` (constructor opts + `recordIsElevated` gate + new `atTier()`)
- Test: same file as Task 1's tests

**Interfaces:**
> **CORRECTION (2026-07-17, mid-arc):** the original design below — `getDEK` resolution as the
> clearance gate — was WRONG and is retired. The implementer's probe proved `getDEK` (via
> `ensureCollectionDEK`) auto-mints a fresh DEK for ANY role and never throws, so it cannot gate
> anything and would mint junk key material into an ungranted keyring. The shipped design: the
> keyring is threaded from `collection.ts`'s `blob()` opts (zero net lines, appended to the
> existing joined line) and `atTier()` calls `assertTierAccess(keyring, collection, tier)` —
> and, after the whole-branch review (M3), `assertTierAccess(keyring, BLOB_COLLECTION, tier)` —
> BEFORE any `getDEK`, throwing `TierNotGrantedError` with no key material minted. Tests lock
> the no-junk-mint property. The struck-through paragraph is retained for the spec trail only.
- ~~Produces: `BlobSet.atTier(): Promise<BlobSet>` — resolves the record's live tier; tier 0 → returns `this`; tier N > 0 → resolves `getDEK(dekKey(collection, N))` (the cryptographic clearance gate: owner/admin/custodian mint, an uncleared member's getDEK throws → surfaces as `TierNotGrantedError` if that's what getDEK throws, else propagate as-is), then returns a NEW `BlobSet` sharing all opts plus internal `clearedTier: N`.~~
- A `BlobSet` with `clearedTier` set: `recordIsElevated()` returns `false` (gate off) and `ownerTier()` returns `clearedTier` without re-peeking (stable view; a concurrent demote just means the next `atTier()` call sees the new tier).

- [ ] **Step 1: Failing tests**

```ts
// 1. Elevated record, cleared caller (owner role): blob(id).get() → null/hidden (existing
//    gate), but (await blob(id).atTier()).get(slot) returns the bytes. Publish/list/
//    blobInfo work through the cleared view too (spot-check list()).
// 2. Elevated record, tier-0-only member session (grant NOT issued): atTier() rejects
//    (TierNotGrantedError or the getDEK failure — assert rejects.toThrow, match the
//    actual error the keyring throws for a member without the DEK; name it in the test).
// 3. Tier-0 record: atTier() returns an equivalent working view (round-trip put/get).
// 4. blob(id) WITHOUT atTier() still hides the elevated record's blobs (regression lock).
```

For case 2 you need a member-role session — mirror however the existing tier tests build a non-admin keyring (`grep -n "role: 'member'\|withTeam" packages/hub/__tests__/hierarchical-tiers.test.ts | head`).

- [ ] **Step 2: Implement**

- Constructor opts: add optional `clearedTier?: number` (internal; `openSlot` never sets it).
- `recordIsElevated()`: `if (this.clearedTier !== undefined) return false` first line.
- `ownerTier()`: `if (this.clearedTier !== undefined) return this.clearedTier` first line.
- `atTier()`: live-peek tier via `liveRecordTier(...)` (already imported); `tier === 0 → return this`; else `await this.getDEK(dekKey(this.collection, tier))` (clearance gate — let the keyring's own error propagate), then construct the cleared clone (`new BlobSet({ ...same opts, clearedTier: tier })` — check how the constructor stores opts; replicate faithfully).
- Doc comment: state the law — `blob(id)` stays the tier-0 surface (elevated → invisible); `atTier()` is the sanctioned cleared path, the `getAtTier` analogue; the DEK resolution IS the authorization check.

- [ ] **Step 3: GREEN + regression** — same suites as Task 1 Step 3.

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(hub): blob(id).atTier() — sanctioned cleared-read path to an elevated record's blobs (#749)"
```

---

### Task 3: Guards + changeset

- [ ] Full verification: `pnpm --filter @noy-db/hub test`, `typecheck`, `lint`, `pnpm check:architecture` — all green. If `enclave-body-only` moved, justify or eliminate.
- [ ] Create `.changeset/blob-tier-completeness.md` (local-only, gitignored):

```md
---
"@noy-db/hub": patch
---

Tiers×blobs completeness (#747, #749). The `BlobObject` index envelope (size/mimeType/compression/chunkCount/refCount/createdAt) now follows its eTag's tier `_blob` DEK, so an elevated record's blob metadata is no longer readable by a tier-0 DEK holder at rest — content was already tier-isolated (#724); this closes the metadata sidecar. Dedup-policy shared blobs and legacy blobs legitimately stay under the flat DEK (documented residue; reads fall back). No migration: the tiers×blobs arc has never been published. And `blob(id).atTier()` is the new sanctioned cleared-read path to an elevated record's blobs — the `getAtTier` analogue; resolving the record's tier DEK is the authorization gate (owners/admins/custodians mint; an ungranted member throws), while plain `blob(id)` keeps treating the elevated record's blobs as nonexistent.
```

- [ ] Commit anything tracked; report if nothing.

## Self-Review Notes

- The `atTier: number` return-through on `loadBlobObject` (Task 1 impl point 2) is the load-bearing correctness piece: CAS write-backs must re-key under the DEK that opened the object, or a dedup-flat object gets silently lifted to the owner's tier on a refCount change (corrupting the co-owner's read path).
- Task 2's stable `clearedTier` view means a record demoted after `atTier()` keeps serving through the old tier DEK for that BlobSet instance — acceptable (keys don't vanish on demote) and documented.
- #748 and #746/#753 are NOT in this arc (audit and durability-journal arcs respectively).
