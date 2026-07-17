# Forget-Residue Arc (#734 + #750) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the two remaining `forget()` erasure gaps: a forgotten record's plaintext `_ledger_deltas` rows survive the crypto-shred (#734), and its published blob versions (`_blob_versions_*` rows + version-held content) survive `shredAllForRecord` (#750).

**Architecture:** Both fixes extend existing, review-hardened purge machinery — no new crypto. #734 calls the #729-built `LedgerStore.purgeRecordDeltas(collection, id)` from `vault.forget()`'s per-ref loop (chain-safe by construction: `verify()` never re-reads delta rows). #750 folds published-version refCount holds into `shredAllForRecord`'s existing per-eTag `holds` map so each eTag is released exactly once with its combined hold count, then deletes the readable version rows.

**Tech Stack:** TypeScript ESM, vitest, `crypto.subtle` only (no new deps).

## Global Constraints

- `packages/hub/src/kernel/vault.ts` kernel-surface ceiling is **3959** (`scripts/check-architecture.mjs` `KERNEL_SURFACE_BUDGET`), file currently at **3958** — Task 1 must be net-negative on vault.ts (the compressed hoist funds it); Task 3 ratchets the ceiling down to the final actual per the checker's ratchet-to-actual convention.
- `blob-set.ts` has no line ceiling.
- Never add Claude attribution to commits/PRs.
- Hub stays portable: no Node built-ins in `hub/src/**`.
- Branch: `fix/734-750-forget-residue` off `main`.
- Run everything from repo root (`/Users/vicio/lanna-db/noy-db`).

---

### Task 1: #734 — forget() purges `_ledger_deltas`

**Files:**
- Modify: `packages/hub/src/kernel/vault.ts` (forget(): ~2281-2500)
- Modify: `packages/hub/src/with-audit/forget/strategy.ts` (ForgetResult, after `sealedResidue` ~line 147)
- Test (create): `packages/hub/__tests__/forget-ledger-deltas.test.ts`

**Interfaces:**
- Consumes: `LedgerStore.purgeRecordDeltas(collection: string, id: string): Promise<number>` (`with-commit/history/ledger/store.ts:387`), `Vault.getLedgerOrNull()` (private, `vault.ts:2217`), `vault.ledger()` / `ledger.entries()` / `ledger.verify()` (test-side, see `__tests__/ledger-purge.test.ts:94-129`).
- Produces: `ForgetResult.ledgerDeltasPurged: number` and `ForgetResult.ledgerDeltaResidue: readonly string[]` — Task 3's changeset references these names.

- [ ] **Step 1: Write the failing test**

Create `packages/hub/__tests__/forget-ledger-deltas.test.ts`. Copy the inline `memory()` adapter VERBATIM from `packages/hub/__tests__/ledger-purge.test.ts:27-79` (same imports block, lines 17-25 of that file, PLUS `import { withForgetCascade } from '../src/with-audit/forget/index.js'`; the `withTiers` import is not needed — drop it):

```ts
/**
 * #734 — vault.forget() purges the forgotten record's plaintext
 * `_ledger_deltas` rows (the erasure twin of #729's elevate-side purge).
 *
 * Coverage:
 *   - forget() deletes the subject record's delta rows, keeps the
 *     tamper-chain valid, leaves a sibling record's deltas intact, and
 *     reports the count in ForgetResult.ledgerDeltasPurged
 *   - forget() without a history strategy fails FAST — nothing shredded
 */

interface Doc { id: string; body: string; buyerId: string }

describe('vault.forget() purges _ledger_deltas (#734)', () => {
  it('deletes the forgotten record’s delta rows, keeps verify() ok, leaves siblings intact', async () => {
    const adapter = memory()
    const db = await createNoydb({
      store: adapter,
      user: 'alice', historyStrategy: withHistory(),
      forgetStrategy: withForgetCascade({ subjects: { docs: 'buyerId' } }),
      secret: 'test-passphrase-1234',
    })
    const company = await db.openVault('demo-co')
    const docs = company.collection<Doc>('docs')
    const ledger = company.ledger()

    // 'a' (subject B-1) updated twice → delta rows; 'b' (B-2) too — must survive.
    await docs.put('a', { id: 'a', body: 'a-v1', buyerId: 'B-1' })
    await docs.put('a', { id: 'a', body: 'a-v2', buyerId: 'B-1' })
    await docs.put('b', { id: 'b', body: 'b-v1', buyerId: 'B-2' })
    await docs.put('b', { id: 'b', body: 'b-v2', buyerId: 'B-2' })

    const entries = await ledger.entries()
    const aDeltaEntry = entries.find((e) => e.collection === 'docs' && e.id === 'a' && e.deltaHash !== undefined)
    const bDeltaEntry = entries.find((e) => e.collection === 'docs' && e.id === 'b' && e.deltaHash !== undefined)
    expect(aDeltaEntry).toBeDefined()
    expect(bDeltaEntry).toBeDefined()
    expect(await adapter.get('demo-co', '_ledger_deltas', paddedIndex(aDeltaEntry!.index))).not.toBeNull()

    const result = await company.forget('B-1')

    // THE FIX: a's plaintext delta rows are gone; b's survive; chain stays valid.
    expect(result.ledgerDeltasPurged).toBeGreaterThan(0)
    expect(result.ledgerDeltaResidue).toEqual([])
    expect(await adapter.get('demo-co', '_ledger_deltas', paddedIndex(aDeltaEntry!.index))).toBeNull()
    expect(await adapter.get('demo-co', '_ledger_deltas', paddedIndex(bDeltaEntry!.index))).not.toBeNull()
    expect((await ledger.verify()).ok).toBe(true)
    // The summary forget entry + a's entry metadata (audit trail) survive.
    expect((await ledger.entries()).some((e) => e.op === 'forget')).toBe(true)
    expect((await ledger.entries()).some((e) => e.id === 'a')).toBe(true)
    db.close()
  })

  it('fails FAST without a history strategy — nothing shredded', async () => {
    const adapter = memory()
    const db = await createNoydb({
      store: adapter,
      user: 'alice',
      forgetStrategy: withForgetCascade({ subjects: { docs: 'buyerId' } }),
      secret: 'test-passphrase-1234',
    })
    const company = await db.openVault('demo-co')
    const docs = company.collection<Doc>('docs')
    await docs.put('a', { id: 'a', body: 'a-v1', buyerId: 'B-1' })

    await expect(company.forget('B-1')).rejects.toThrow(/requires the history strategy/)
    // Fail-fast: the record was NOT tombstoned first.
    expect(await docs.get('a')).not.toBeNull()
    db.close()
  })
})
```

Note: if `company.forget('B-1')` in test 2 throws `ForgetStrategyNotConfiguredError` instead, the subject declaration is wrong — fix the test setup, not the assertion. If the fail-fast test's `docs.get('a')` returns null even after the fix, check that the hoisted throw sits BEFORE `lookupSubject`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/hub/__tests__/forget-ledger-deltas.test.ts`
Expected: Test 1 FAILS — `result.ledgerDeltasPurged` is `undefined` (property doesn't exist) and/or the `aDeltaEntry` row is still present after forget. Test 2 FAILS — `docs.get('a')` is null (old order shreds before throwing).

- [ ] **Step 3: Implement**

**(a) `packages/hub/src/with-audit/forget/strategy.ts`** — in `interface ForgetResult`, immediately after the `sealedResidue` member:

```ts
  /** Count of `_ledger_deltas` rows hard-deleted across the shredded records (#734) — the
   * erasure twin of #729's elevate-side purge. Entry metadata (that the record was mutated,
   * at which version/timestamp/actor) is retained; only the plaintext delta content is removed. */
  readonly ledgerDeltasPurged: number
  /** `collection:id` refs whose `_ledger_deltas` purge failed — plaintext delta residue still
   * readable under the retained ledger DEK. Non-empty means erasure is INCOMPLETE. */
  readonly ledgerDeltaResidue: readonly string[]
```

**(b) `packages/hub/src/kernel/vault.ts`** — four edits inside `forget()`:

1. Directly after the `ForgetStrategyNotConfiguredError` guard (currently lines 2282-2284), BEFORE `lookupSubject`, insert the ledger resolution (hoisted from below, compressed — this is the fail-fast move AND the line funding):

```ts
    // #734: resolve the ledger BEFORE any shred — the loop purges each record's
    // plaintext deltas and the summary entry appends after, so a missing history
    // strategy must abort with NOTHING erased (was: shred-then-throw).
    const ledger = this.getLedgerOrNull()
    if (!ledger) throw new Error('vault.forget() requires the history strategy for the erasure-proof ledger entry. Pass `historyStrategy: withHistory()` from "@noy-db/hub/history" to createNoydb().')
```

2. At the OLD site (currently lines 2445-2453), delete the `const ledger = ...` + `if (!ledger) { throw ... }` block entirely, keeping only `const subjectHash = await sha256Hex(subjectId)`. (Net across edits 1+2: −3 lines.)

3. Accumulators — extend the two existing joined declaration lines (currently 2295-2296), adding to the END of each (no new lines):

```ts
    let sealedFieldsShredded = 0; let sealedCekEnvelopesPurged = 0; let ledgerDeltasPurged = 0
    const sealedCekResidue: string[] = []; const sealedResidue: string[] = []; const indexResidue: string[] = []; const ledgerDeltaResidue: string[] = []
```

4. In the per-ref loop, immediately AFTER the `tombstoneHistory` call block (currently ends line 2387), insert:

```ts
      // #734: purge the record's plaintext `_ledger_deltas` rows — the erasure twin
      // of #729's elevate purge. Chain-safe: verify() never re-reads delta rows; the
      // summary `forget` entry appended below is the retained proof of erasure.
      try { ledgerDeltasPurged += await ledger.purgeRecordDeltas(ref.collection, ref.id) } catch { ledgerDeltaResidue.push(`${ref.collection}:${ref.id}`) }
```

5. Summary-entry `reason` JSON (the `JSON.stringify({...})` currently at 2461-2475): extend the `sealedResidueCount` line in place:

```ts
        sealedResidueCount: sealedResidue.length, ledgerDeltasPurged, ledgerDeltaResidueCount: ledgerDeltaResidue.length,
```

6. Return object (currently 2479-2499): extend the existing joined final line in place:

```ts
      lookupReferencesCascaded: fanoutStats.lookupReferencesCascaded, lookupReferencesNullified: fanoutStats.lookupReferencesNullified, lookupReferencesResidue: fanoutStats.lookupReferencesResidue, scopedPurgeResidue, ledgerDeltasPurged, ledgerDeltaResidue, // #650 Task 5 (+ review Important fix: residue) + #633 + #734
    }
```

Net vault.ts budget: +5 (edit 1) −8 (edit 2) +4 (edit 4) = **−0 to −1 net** (verify with `wc -l`; must be ≤ 3959).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/hub/__tests__/forget-ledger-deltas.test.ts`
Expected: PASS (both tests).

- [ ] **Step 5: Run the neighboring forget/ledger suites (regression)**

Run: `pnpm vitest run packages/hub/__tests__/forget.test.ts packages/hub/__tests__/ledger-purge.test.ts packages/hub/__tests__/forget-sealed-erasure.test.ts packages/hub/__tests__/satellites-forget.test.ts`
Expected: PASS. If any test asserted the old shred-then-throw ordering (forget without history shredding records before erroring), update that test to the new fail-fast contract and say so in the commit message.

- [ ] **Step 6: Commit**

```bash
git add packages/hub/src/kernel/vault.ts packages/hub/src/with-audit/forget/strategy.ts packages/hub/__tests__/forget-ledger-deltas.test.ts
git commit -m "fix(hub): forget() purges the record's plaintext _ledger_deltas rows (#734)"
```

---

### Task 2: #750 — shredAllForRecord shreds published blob versions

**Files:**
- Modify: `packages/hub/src/with-shape/blobs/blob-set.ts` (`shredAllForRecord`, lines ~516-560, + one new private method below it)
- Test: `packages/hub/__tests__/blob-set.test.ts` (append a new `describe` block)

**Interfaces:**
- Consumes: `this.releaseRef(eTag, n, reclaimLegacy): Promise<'shredded' | 'retainedShared' | 'residue'>` (line 460), `this.loadSlots(tier?)` (282), `this.ownerTier()` (259), `this.versionsCollection` (269), `openEnvelopeJson`, `dekKey`, `VersionRecord` (fields used: `eTag`) — all already imported/in-file.
- Produces: unchanged public signature `shredAllForRecord(ownerTier?: number): Promise<{ shredded: string[]; retainedShared: string[]; residue: string[] }>`; new private `collectVersionHolds(ownerTier: number | undefined, holds: Map<string, number>, residue: string[]): Promise<string[]>`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/hub/__tests__/blob-set.test.ts` (inside the top-level describe, after the published-versions tests; reuse the file's existing `store`, `VAULT`, `SECRET`, `textBytes` helpers — check `beforeEach` for how `store` is reset):

```ts
  // ─── #750: forget shreds published versions ────────────────────────

  it('#750: shredAllForRecord shreds version-held content and deletes the version rows', async () => {
    const db = await createNoydb({ teamStrategy: withTeam(), store, user: 'alice', secret: SECRET, blobStrategy: withBlobs() })
    const vault = await db.openVault(VAULT)
    const col = vault.collection<{ x: number }>('docs')
    await col.put('d-001', { x: 1 })

    const blobs = col.blob('d-001')
    await blobs.put('file.txt', textBytes('original content'))
    await blobs.publish('file.txt', 'v1')
    // Overwrite the slot: the v1 content is now held ONLY by the published version.
    await blobs.put('file.txt', textBytes('amended content'))

    const result = await blobs.shredAllForRecord()
    expect(result.residue).toEqual([])

    // Version rows for the record are gone…
    const versionKeys = await store.list(VAULT, `${BLOB_VERSIONS_PREFIX}docs`)
    expect(versionKeys.filter((k) => k.startsWith('d-001::'))).toEqual([])
    // …and BOTH contents (slot-held and version-held) are crypto-shredded.
    expect(await store.list(VAULT, BLOB_INDEX_COLLECTION)).toEqual([])
    expect(await store.list(VAULT, BLOB_CHUNKS_COLLECTION)).toEqual([])
    db.close()
  })

  it('#750: version content shared with another record is retained for the co-owner', async () => {
    const db = await createNoydb({ teamStrategy: withTeam(), store, user: 'alice', secret: SECRET, blobStrategy: withBlobs() })
    const vault = await db.openVault(VAULT)
    const col = vault.collection<{ x: number }>('docs')
    await col.put('d-001', { x: 1 })
    await col.put('d-002', { x: 2 })

    const a = col.blob('d-001')
    await a.put('file.txt', textBytes('shared bytes'))
    await a.publish('file.txt', 'v1')
    const b = col.blob('d-002')
    await b.put('copy.txt', textBytes('shared bytes')) // dedup: same eTag, refCount 3

    const result = await a.shredAllForRecord()
    // d-001's two holds (slot + version) released in ONE outcome: retainedShared.
    expect(result.retainedShared).toHaveLength(1)
    expect(result.shredded).toEqual([])
    // Co-owner still reads.
    expect(new TextDecoder().decode((await b.get('copy.txt'))!)).toBe('shared bytes')
    db.close()
  })

  it('#750: versions are shredded even when the slot map is empty (version outlived its slot)', async () => {
    const db = await createNoydb({ teamStrategy: withTeam(), store, user: 'alice', secret: SECRET, blobStrategy: withBlobs() })
    const vault = await db.openVault(VAULT)
    const col = vault.collection<{ x: number }>('docs')
    await col.put('d-001', { x: 1 })

    const blobs = col.blob('d-001')
    await blobs.put('file.txt', textBytes('published then unlinked'))
    await blobs.publish('file.txt', 'v1')
    await blobs.delete('file.txt') // slot gone; the version keeps its hold

    const result = await blobs.shredAllForRecord()
    expect(result.shredded).toHaveLength(1)
    expect(await store.list(VAULT, `${BLOB_VERSIONS_PREFIX}docs`)).toEqual([])
    expect(await store.list(VAULT, BLOB_CHUNKS_COLLECTION)).toEqual([])
    db.close()
  })

  it('#750: an unreadable version row is reported as residue and left in place', async () => {
    const db = await createNoydb({ teamStrategy: withTeam(), store, user: 'alice', secret: SECRET, blobStrategy: withBlobs() })
    const vault = await db.openVault(VAULT)
    const col = vault.collection<{ x: number }>('docs')
    await col.put('d-001', { x: 1 })

    const blobs = col.blob('d-001')
    await blobs.put('file.txt', textBytes('content'))
    await blobs.publish('file.txt', 'v1')

    // Corrupt the version row at rest.
    const versionsColl = `${BLOB_VERSIONS_PREFIX}docs`
    const [key] = (await store.list(VAULT, versionsColl)).filter((k) => k.startsWith('d-001::'))
    const envelope = (await store.get(VAULT, versionsColl, key!))!
    await store.put(VAULT, versionsColl, key!, { ...envelope, _data: 'corrupted' }, envelope._v)

    const result = await blobs.shredAllForRecord()
    expect(result.residue).toEqual([`docs:d-001:${key}`])
    // The row is NOT deleted (deleting blind would orphan its refCount hold).
    expect(await store.get(VAULT, versionsColl, key!)).not.toBeNull()
    db.close()
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/hub/__tests__/blob-set.test.ts -t '#750'`
Expected: 4 FAILURES — version rows survive, `_blob_index`/`_blob_chunks` non-empty, residue empty where corruption expected.

- [ ] **Step 3: Implement**

In `packages/hub/src/with-shape/blobs/blob-set.ts`, replace the body of `shredAllForRecord` (lines ~516-560) with the version-aware version. Keep the existing doc comments on the method and its slot-map catch (they are review artifacts — extend, don't delete):

```ts
  async shredAllForRecord(ownerTier?: number): Promise<{
    shredded: string[]
    retainedShared: string[]
    residue: string[]
  }> {
    const shredded: string[] = []
    const retainedShared: string[] = []
    const residue: string[] = []
    let slots: Record<string, SlotRecord> = {}
    try {
      slots = (await this.loadSlots(ownerTier)).slots
    } catch {
      // [keep the existing #724 re-review comment here]
      // #750: an unreadable slot map no longer aborts the cascade — published
      // versions are independently-keyed rows and must still be shredded below.
      residue.push(`${this.collection}:${this.recordId}:_blob_slots`)
    }

    // Reference count from THIS record per eTag — slot holds and published-
    // version holds (#750) merged, so a shared eTag releases ALL of this
    // record's holds in ONE releaseRef call and reports ONE outcome.
    const holds = new Map<string, number>()
    for (const name of Object.keys(slots)) {
      const eTag = slots[name]!.eTag
      holds.set(eTag, (holds.get(eTag) ?? 0) + 1)
    }
    const versionKeys = await this.collectVersionHolds(ownerTier, holds, residue)

    for (const [eTag, n] of holds) {
      // Forget erasure reclaims legacy orphans too (the record is being erased),
      // so reclaimLegacy = true — but only erasable blobs count as a crypto-shred.
      const outcome = await this.releaseRef(eTag, n, true)
      if (outcome === 'shredded') shredded.push(eTag)
      else if (outcome === 'retainedShared') retainedShared.push(eTag)
      else residue.push(eTag)
    }

    // Sever the subject's links: the slot map + the readable version rows (#750).
    if (Object.keys(slots).length > 0) await this.store.delete(this.vault, this.slotsCollection, this.recordId)
    for (const key of versionKeys) await this.store.delete(this.vault, this.versionsCollection, key)
    return { shredded, retainedShared, residue }
  }

  /**
   * #750: enumerate this record's published-version rows (`{recordId}::*` in
   * `_blob_versions_{collection}` — the same raw prefix scan as
   * `rehomeVersionRecords`) and fold each version's independent refCount hold
   * into `holds`. Returns the READABLE version keys — safe to delete once
   * their holds are released. An unreadable row is pushed onto `residue` and
   * NOT returned: deleting it blind would orphan its refCount hold and strand
   * the content undecryptable-but-undeleted forever, so it stays in place for
   * out-of-band repair (mirrors the unreadable-slot-map posture above).
   */
  private async collectVersionHolds(
    ownerTier: number | undefined,
    holds: Map<string, number>,
    residue: string[],
  ): Promise<string[]> {
    const prefix = `${this.recordId}::`
    const keys = (await this.store.list(this.vault, this.versionsCollection)).filter((k) => k.startsWith(prefix))
    if (keys.length === 0) return []
    const readable: string[] = []
    const dek = this.encrypted ? await this.getDEK(dekKey(this.collection, ownerTier ?? await this.ownerTier())) : null
    for (const key of keys) {
      const envelope = await this.store.get(this.vault, this.versionsCollection, key)
      if (!envelope) continue
      try {
        const record = this.encrypted
          ? JSON.parse(await openEnvelopeJson(envelope, dek!)) as VersionRecord
          : JSON.parse(envelope._data) as VersionRecord
        holds.set(record.eTag, (holds.get(record.eTag) ?? 0) + 1)
        readable.push(key)
      } catch {
        residue.push(`${this.collection}:${this.recordId}:${key}`)
      }
    }
    return readable
  }
```

Behavioral notes to preserve:
- The zero-slots early return is GONE by design: a record can hold versions with an empty/absent slot map (test 3). `store.delete` on an absent slot row is a void no-op, but the `if` guard keeps parity with the old behavior of not touching the row when there were no slots.
- Every ref now pays one extra `store.list` on `_blob_versions_{collection}` per forget — accepted (correctness over micro-perf; flagged for the reviewer).
- Do NOT reorder: holds must be fully collected (slots + versions) BEFORE any `releaseRef`, or a shared eTag double-reports.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/hub/__tests__/blob-set.test.ts`
Expected: PASS — the 4 new tests AND every pre-existing test in the file (slot-only shred behavior unchanged).

- [ ] **Step 5: Run the blob + forget regression suites**

Run: `pnpm vitest run packages/hub/__tests__/per-blob-cek.test.ts packages/hub/__tests__/forget.test.ts packages/hub/__tests__/blob-legalhold-retention.test.ts packages/hub/__tests__/tier-composition-guard.test.ts packages/hub/__tests__/blob-compaction.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/hub/src/with-shape/blobs/blob-set.ts packages/hub/__tests__/blob-set.test.ts
git commit -m "fix(hub): shredAllForRecord shreds published blob versions — forget() erasure covers _blob_versions_* (#750)"
```

---

### Task 3: Guards, ceiling ratchet, changeset

**Files:**
- Modify: `scripts/check-architecture.mjs` (vault.ts ceiling, line ~1012)
- Create: `.changeset/forget-residue.md`

**Interfaces:**
- Consumes: Task 1's `ledgerDeltasPurged`/`ledgerDeltaResidue` names, Task 2's version-shred behavior (for the changeset text).

- [ ] **Step 1: Full verification**

Run, from repo root:
```bash
pnpm --filter @noy-db/hub test
pnpm --filter @noy-db/hub typecheck
pnpm --filter @noy-db/hub lint
pnpm check:architecture
```
Expected: all PASS. If `kernel-surface` fails on vault.ts, Task 1's line budget was overrun — compress (join declaration lines) rather than bumping the ceiling.

- [ ] **Step 2: Ratchet the vault.ts ceiling to actual**

`wc -l packages/hub/src/kernel/vault.ts` → if the actual is BELOW 3959, lower `'packages/hub/src/kernel/vault.ts'` in `KERNEL_SURFACE_BUDGET` to the actual count, with a one-line comment following the file's existing convention:

```js
  // Lowered 3959→<actual> (2026-07-17, #734): the ledger-check hoist (fail-fast,
  // compressed) more than funded the in-loop delta purge — ratchet-to-actual.
  'packages/hub/src/kernel/vault.ts': <actual>,
```
Re-run `pnpm check:architecture` → PASS.

- [ ] **Step 3: Changeset**

Create `.changeset/forget-residue.md`:

```md
---
"@noy-db/hub": patch
---

`vault.forget()` erasure now covers two residue classes it previously left at rest (#734, #750). (1) The forgotten record's plaintext `_ledger_deltas` rows are purged via the #729 primitive — chain-safe (`verify()` recomputes the tamper-chain from the retained entries, never the delta rows), with the count reported as `ForgetResult.ledgerDeltasPurged` and failures surfaced in `ForgetResult.ledgerDeltaResidue` rather than swallowed. As part of this, forget() without a history strategy now fails FAST with nothing shredded (was: shred everything, then throw on the summary-entry step). (2) `shredAllForRecord` now enumerates the record's published blob versions (`_blob_versions_*`): each version's independent refCount hold is released (crypto-shredding version-held content at refCount 0, retaining shared content for co-owners) and the version rows are deleted; an unreadable version row is reported as blob residue and left in place rather than blind-deleted (which would orphan its refCount hold).
```

- [ ] **Step 4: Commit**

```bash
git add scripts/check-architecture.mjs .changeset/forget-residue.md
git commit -m "chore(hub): ratchet vault.ts ceiling + changeset for the forget-residue arc (#734, #750)"
```

---

## Self-Review Notes

- Spec coverage: #734 (in-loop purge + result candor + fail-fast hoist) → Task 1; #750 (version holds + row deletion + unreadable-row residue + empty-slot-map path) → Task 2; ceiling + changeset → Task 3. Both issues' "Fix" sections are implemented as written.
- Type consistency: `ledgerDeltasPurged`/`ledgerDeltaResidue` names match across strategy.ts, vault.ts, test, changeset. `collectVersionHolds` signature matches its call site.
- Known intentional behavior changes (call out in PR body): fail-fast forget without history; unreadable slot map no longer skips the version pass; zero-slot records now pay a `_blob_versions` list() per forget ref.
