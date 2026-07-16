# Arc 2 — tiers × indexing Implementation Plan (#709)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Elevated records leave tier-0 indexes — purge their persisted sidecars (which hold **plaintext** field values under the tier-0 DEK) and in-memory entries on elevation, rebuild on demotion, and skip elevated envelopes in the facade's rebuild/reconcile loops.

**Architecture:** Spec — `docs/superpowers/specs/2026-07-16-tiers-indexing-design.md` (user-approved). Mirrors the existing `forget()` → `purgePersistedIndexes` precedent. One new `TiersContext.syncIndexes` callback, following the established `syncCache` pattern.

**Tech Stack:** TypeScript ESM, vitest. Branch `fix/709-tiers-indexing` off main a6d50c93.

## Global Constraints

- NEVER add Claude/Anthropic attribution to commits/PRs/changelogs.
- NEVER reference the private pilot client by name — grep the diff before each commit.
- Ceilings exact (checker = `wc -l` + 1): `collection.ts` **4548**, `vault.ts` 3959, `noydb.ts` 2396. Fund additions with mechanical shrink-joins (single-use `const` inlined into its sole use is the pattern used repeatedly in this campaign — see `git log` for `count()`, tx-revert, `_compensateRevertedWrite`). Never edit ceiling values; never touch vault.ts/noydb.ts. `collection-facade.ts` / `tiers/index.ts` have no ceiling.
- TDD: RED verified before implementing, every test. Run from `packages/hub/`: `pnpm vitest run <path>`.
- No new deps; no timing assertions.
- The sanctioned tier reads (`getAtTier`/`listAtTier`) and the merged read/write gates must be unaffected — existing tiers suites pass untouched.

---

### Task 1: gate the facade's rebuild/reconcile loops (the amplifiers)

**Files:**
- Modify: `packages/hub/src/with-lookup/indexing/collection-facade.ts` (2 in-line folds)
- Create: `packages/hub/__tests__/tiers-indexing.test.ts`

**Interfaces:**
- Consumes: `EncryptedEnvelope._tier`.
- Produces: the test file's fixture (a lazy, tiered, indexed collection) that Task 2 extends.

Sites (line numbers ±5 — anchor on the code): `rebuildIndexes`'s lazy loop (`:203-209`) and `reconcileIndex`'s loop (`:279-281`), each doing `const record = await ctx.codec.decryptRecord(envelope, ...)` with no tier gate.

- [ ] **Step 1: Write the failing tests**

Create `packages/hub/__tests__/tiers-indexing.test.ts`. Copy the `memoryStore()` fixture verbatim from `__tests__/hierarchical-tiers.test.ts`. **NOTE: no test in the repo combines `tiers:` with `indexes:` — you are building this fixture from scratch.** Find the real indexing API first: grep `withIndexing`/`indexStrategy`/`indexes:` in `__tests__/` (e.g. `unique-index.test.ts`, any `lazy-indexes-*.test.ts`) and mirror a working lazy-indexed collection config, then add `tiers: [0, 1]` + `perRecordKeys: true`.

```ts
/**
 * #709 — tiers × indexing. Elevated records leave tier-0 indexes: their
 * persisted sidecars hold PLAINTEXT field values under the tier-0 DEK
 * (collection-facade.ts:370-377 + record-codec.ts:257), so leaving them in
 * place means elevating a record never hid what it was indexed by. Mirrors
 * the forget() → purgePersistedIndexes precedent (facade:426-429).
 */

describe('#709 facade loops skip elevated records', () => {
  it('rebuildIndexes: warm session must NOT mint a tier-0 sidecar from an elevated record', async () => {
    const { store, docs } = await openLazyIndexed()          // lazy + tiers:[0,1] + perRecordKeys + indexes:['salary']
    await docs.put('e1', { id: 'e1', salary: 200000 })
    await docs.elevate('e1', 1)                              // warm: seeds the CEK cache
    await docs.rebuildIndexes()
    // Pre-#709: the warm cekCache let the ungated decrypt succeed and MINTED a
    // tier-0-encrypted sidecar holding the elevated record's salary.
    expect(await store.get('v1', 'docs', '_idx/salary/e1')).toBeNull()
  })

  it('rebuildIndexes: cold session survives an elevated record (was a brick)', async () => {
    const h = lazyIndexedHarness()
    const { docs } = await h.open()
    await docs.put('e1', { id: 'e1', salary: 200000 })
    await docs.put('t0', { id: 't0', salary: 50000 })
    await docs.elevate('e1', 1)
    const cold = await h.open()
    // Pre-#709: unwrapCek under the tier-0 DEK threw → rebuildIndexes() bricked.
    await expect(cold.docs.rebuildIndexes()).resolves.not.toThrow()
    expect(await cold.store.get('v1', 'docs', '_idx/salary/t0')).not.toBeNull()  // tier-0 sibling still indexed
  })

  it('reconcileIndex: does not re-create a purged sidecar for an elevated record', async () => {
    const { store, docs } = await openLazyIndexed()
    await docs.put('e1', { id: 'e1', salary: 200000 })
    await docs.elevate('e1', 1)
    await docs.reconcileIndex('salary')
    expect(await store.get('v1', 'docs', '_idx/salary/e1')).toBeNull()
  })
})
```
Verify the sidecar id shape against `persisted-indexes.ts:33-35` (`_idx/<field>/<recordId>`) and the real `rebuildIndexes`/`reconcileIndex` signatures before asserting. Adapt mechanics; never weaken an assert. If a RED doesn't reproduce, STOP → BLOCKED with output (the warm test needs `perRecordKeys: true` for a CEK to cache — without it there's no warm leak to pin).

- [ ] **Step 2: RED** — `pnpm vitest run __tests__/tiers-indexing.test.ts` → the warm tests show a minted sidecar; the cold test throws.

- [ ] **Step 3: Implement** — the campaign's standard fold at BOTH loops, before the decrypt:
```ts
    // #709: an elevated record must not be (re)indexed — the sidecar stores the
    // PLAINTEXT field value under the tier-0 DEK, so minting one here would
    // publish what elevation is meant to hide. Gate BEFORE the decrypt: a warm
    // cekCache would otherwise let it succeed (and a cold session throw).
    if ((envelope._tier ?? 0) > 0) continue
```
(Full comment on the first site; a one-liner referencing it on the second.)

- [ ] **Step 4: GREEN + regression** — the new file + `__tests__/hierarchical-tiers.test.ts` + any lazy-index suites your grep surfaced; `node scripts/check-architecture.mjs`; typecheck; lint.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/with-lookup/indexing/collection-facade.ts packages/hub/__tests__/tiers-indexing.test.ts
git commit -m "fix(hub): index rebuild/reconcile skip elevated records — no tier-0 sidecar minted from tier-1 plaintext (#709)"
```

---

### Task 2: tier ops maintain indexes (purge on elevate, rebuild on demote)

**Files:**
- Modify: `packages/hub/src/with-audit/tiers/index.ts` (`TiersContext` + `elevate`/`demote`/`putAtTier`)
- Modify: `packages/hub/src/kernel/collection.ts` (one `syncIndexes` wiring line; net-zero via shrink-join)
- Modify: `packages/hub/__tests__/tiers-indexing.test.ts` (append)

**Interfaces:**
- Produces: `TiersContext.syncIndexes(id: string, record: T | null): Promise<void>` — `null` → purge persisted sidecars + drop in-memory entries; a record → (re)build entries from it.
- Consumes (all already wrapped as Collection methods): `purgePersistedIndexes` (`collection.ts:47`, impl `collection-facade.ts:437`), `maintainPersistedIndexesOnPut` (`collection.ts:45`, impl `:337`, called at `:2065`), `this.indexes?.upsert(id, rec, prior)` (`:2070`) / `?.remove(id, rec)` (`:2789`).

- [ ] **Step 1: Write the failing tests**

Append. Cover lazy (sidecars) AND eager (in-memory only):

```ts
describe('#709 tier ops maintain indexes', () => {
  it('LAZY: elevate purges the record’s persisted sidecar; demote restores it', async () => {
    const { store, docs } = await openLazyIndexed()
    await docs.put('e1', { id: 'e1', salary: 200000 })
    expect(await store.get('v1', 'docs', '_idx/salary/e1')).not.toBeNull()
    await docs.elevate('e1', 1)
    // Pre-#709: the sidecar survived, tier-0-readable, holding salary=200000 —
    // elevating never hid the indexed value (the forget() precedent, unapplied).
    expect(await store.get('v1', 'docs', '_idx/salary/e1')).toBeNull()
    await docs.demote('e1', 0)
    expect(await store.get('v1', 'docs', '_idx/salary/e1')).not.toBeNull()   // tier-0 again → indexed again
  })

  it('LAZY: putAtTier(>0) purges; putAtTier(0) maintains the sidecar at the NEW value', async () => {
    const { store, docs } = await openLazyIndexed()
    await docs.put('p1', { id: 'p1', salary: 100 })
    await docs.putAtTier('p1', { id: 'p1', salary: 999 }, 1)
    expect(await store.get('v1', 'docs', '_idx/salary/p1')).toBeNull()
    await docs.putAtTier('p1', { id: 'p1', salary: 555 }, 0)
    expect(await store.get('v1', 'docs', '_idx/salary/p1')).not.toBeNull()
  })

  it('EAGER: an elevated record is not returned by an index-driven query', async () => {
    const { docs } = await openEagerIndexed()   // eager + tiers + indexes
    await docs.put('e1', { id: 'e1', salary: 200000 })
    await docs.put('t0', { id: 't0', salary: 200000 })
    await docs.elevate('e1', 1)
    const hits = await docs.query().where('salary', '==', 200000).toArray()   // adapt to the real query API
    expect(hits.map(r => r.id)).toEqual(['t0'])
  })

  it('EAGER: putAtTier(id, rec, 0) refreshes the index — no stale false positive on the OLD value', async () => {
    const { docs } = await openEagerIndexed()
    await docs.put('p1', { id: 'p1', salary: 100 })
    await docs.putAtTier('p1', { id: 'p1', salary: 555 }, 0)
    // Pre-#709: the stale entry 100→p1 survived AND index hits are never
    // re-verified (builder.ts:1160-1166 drops the clause) → a silent false positive.
    expect((await docs.query().where('salary', '==', 100).toArray()).length).toBe(0)
    expect((await docs.query().where('salary', '==', 555).toArray()).map(r => r.id)).toEqual(['p1'])
  })
})
```
Adapt the query API to the real one (grep an existing eager index test). If eager+tiers+indexes cannot be configured, report it — don't fake it.

- [ ] **Step 2: RED** — sidecar survives elevate; putAtTier(0) leaves the stale entry / the elevated record appears in query results.

- [ ] **Step 3: Implement**

(a) `TiersContext` — add beside `syncCache`, with the doc comment from the spec (state WHY: sidecars hold plaintext under the tier-0 DEK; cite the `forget()` precedent):
```ts
  syncIndexes(id: string, record: T | null): Promise<void>
```
(b) `elevate` → `await ctx.syncIndexes(id, null)`; `demote` → `await ctx.syncIndexes(id, <the decoded tier-0 record>)` when `toTier === 0`, else `null`; `putAtTier` → `null` when `tier > 0`, else the record. **Place each AFTER its `adapter.put` lands** (the ordering rule #691 set for `syncCache`: never blind a cache for a write that then throws). `demote`-to-0 already decodes the record for `syncCache`'s re-seed — reuse that decode, do not decrypt twice.
(c) `collection.ts` `tiersContext()` — one line:
```ts
      syncIndexes: async (id: string, rec: T | null) => { if (rec === null) { await this.purgePersistedIndexes(id); this.indexes?.remove(id, ???) } else { await this.maintainPersistedIndexesOnPut(id, rec, null, ???); this.indexes?.upsert(id, rec, null) } },
```
Resolve the `???`s against the real signatures (`indexes.remove` needs the record to compute its keys — if the record isn't available on the purge path, read what `_doDelete` does at `collection.ts:2789` and mirror it; `maintainPersistedIndexesOnPut` needs a version — use the freshly-written envelope's `_v`, threading it through the callback if needed). If the callback grows past one line, extract the body into a small helper module rather than blowing the ceiling — that extraction is what the ratchet is for. Must no-op fast when the collection has no indexes.

collection.ts must end at exactly **4548** (`git show a6d50c93:packages/hub/src/kernel/collection.ts | wc -l`). Document each shrink-join.

- [ ] **Step 4: GREEN + regression** — the new file + `__tests__/hierarchical-tiers.test.ts` + `__tests__/tier0-read-paths.test.ts` + `__tests__/tier-write-ring.test.ts` + `__tests__/per-record-cek.test.ts` + index suites; then the FULL hub suite from root; `node scripts/check-architecture.mjs`; typecheck; lint. Report any pre-existing test that changes behavior and adjudicate it (do not edit a test green without stating why the old assertion was wrong).

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/with-audit/tiers/index.ts packages/hub/src/kernel/collection.ts packages/hub/__tests__/tiers-indexing.test.ts
git commit -m "fix(hub): tier moves maintain indexes — elevate purges sidecars, demote restores them (#709)"
```

---

### Final: full suite + whole-branch review + changeset + PR

- [ ] `pnpm --filter @noy-db/hub test` + typecheck + lint + `pnpm check:architecture` — green.
- [ ] Whole-branch review (fable — an at-rest leak arc: ask it to hunt for any surviving path that leaves or mints a tier-0-readable artifact derived from an elevated record's plaintext, and to check the intended consequence — elevated records are unindexed even for cleared callers — is documented, not accidental).
- [ ] Local changeset: `@noy-db/hub` **patch** — state that elevating a record now purges its persisted index sidecars (they held plaintext field values readable at tier 0), that tier-0 index queries no longer surface elevated records, and the intended consequence that elevated records are not index-findable at all.
- [ ] PR → main: `Closes #709`.
