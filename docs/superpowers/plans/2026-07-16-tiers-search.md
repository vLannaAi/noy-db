# Arc 6 — tiers × search Implementation Plan (#721)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Elevated records leave tier-0 search — `elevate()` purges the record's `_vec` embedding and invalidates the `_ftindex` lexical blob; `demote()` re-embeds and rebuilds; `buildVectorLoad` skips elevated `_vec` rows as defense-in-depth.

**Architecture:** Spec — `docs/superpowers/specs/2026-07-16-tiers-search-design.md` (user-approved decision: purge/rebuild, mirroring #709). The lexical index is cache-driven (`buildRetrievalDocs` iterates the elevated-free `ctx.cache`), so it only needs invalidation; the vector sidecar is per-record and needs purge + re-embed.

**Tech Stack:** TypeScript ESM, vitest. Branch `fix/721-tiers-search` off main 6ff7b6e2.

## Global Constraints

- NEVER add Claude/Anthropic attribution to commits/PRs/changelogs.
- NEVER reference the private pilot client by name — grep the diff before each commit.
- Ceilings exact (checker = `wc -l` + 1): `collection.ts` **4548**, `vault.ts` 3959, `noydb.ts` 2396. Fund additions with mechanical shrink-joins (single-use `const` inlined — the campaign's recurring pattern). Never edit ceiling values; never touch vault.ts/noydb.ts. `search/collection-facade.ts` / `tiers/index.ts` / `tier-visibility.ts` have no ceiling.
- TDD: RED verified before implementing, every test. Run from `packages/hub/`: `pnpm vitest run <path>`.
- No new deps; no timing assertions.
- Sanctioned tier reads (`getAtTier`/`listAtTier`) + merged gates unaffected — existing tiers suites pass untouched.

---

### Task 1: syncSearch — purge/re-embed on tier moves + invalidate the lexical blob

**Files:**
- Modify: `packages/hub/src/with-audit/tiers/index.ts` (`TiersContext` + `elevate`/`demote`/`putAtTier`)
- Modify: `packages/hub/src/with-lookup/search/collection-facade.ts` (new `syncTierSearch` helper)
- Modify: `packages/hub/src/kernel/collection.ts` (one `syncSearch` wiring line; net-zero via shrink-join)
- Create: `packages/hub/__tests__/tiers-search.test.ts`

**Interfaces:**
- Produces: `TiersContext.syncSearch(id, record: T | null, version?: number): Promise<void>` — `null` → `_purgeVector(id)` + invalidate `_ftindex`; a record → `embedOnWrite(...)` + invalidate `_ftindex`. No-op fast with no search.
- Produces: `syncTierSearch<T>(ctx, id, record, version?)` in `search/collection-facade.ts`.
- Consumes: `_purgeVector` (`collection.ts:4196`), `_purgeSearchIndex` (`:4203` — deletes the persisted blob + markDirty), `embedOnWrite` (`search/collection-facade.ts:377`, reached via `this.searchContext()`), `this.searchIndexStore`/`this.vectorSet` (undefined ⇒ no search).

- [ ] **Step 1: Write the failing tests**

Create `packages/hub/__tests__/tiers-search.test.ts`. Copy `memoryStore()` verbatim from `__tests__/hierarchical-tiers.test.ts`. **No repo test combines search with `tiers:`** — build the fixture from scratch: grep existing search tests (`grep -rln "withSearch\|textIndexes\|similarTo\|retrieve(" __tests__/`) for a working config, then add `tiers: [0, 1]` + `perRecordKeys: true`. For a persisted lexical blob you need `textIndexPersist: true`; for `_vec` you need an `embeddings:` descriptor (find how existing search tests supply a mock embedder — do NOT invent a real model).

```ts
/**
 * #721 — tiers × search. The `_ftindex` lexical blob (full verbatim field
 * text) and the `_vec/<id>` embedding are both encrypted under the tier-0 DEK
 * and survive elevate(), leaking an elevated record's derived plaintext to any
 * tier-0 caller. Mirrors the forget() → _purgeSearchIndex/_purgeVector
 * precedent, unapplied to elevate.
 */

describe('#721 lexical (_ftindex)', () => {
  it('elevate: the persisted _ftindex blob no longer contains the elevated record’s text (warm)', async () => {
    const { store, docs } = await openSearch()        // persisted textIndex + tiers + perRecordKeys
    await docs.put('e1', { id: 'e1', body: 'topsecret-alpha-bravo' })
    await docs.put('t0', { id: 't0', body: 'public-charlie' })
    await docs.retrieve('alpha')                       // build + persist the index once
    await docs.elevate('e1', 1)
    await docs.flushIndex?.()                           // if a public flush exists; else next retrieve rebuilds
    // The at-rest blob is decodable under the tier-0 DEK; after the fix it must
    // not carry the elevated record's verbatim text.
    const blob = await store.get('v1', '_ftindex', 'docs')
    // Assert via the public read path: retrieve() must not surface e1 anymore.
    expect((await docs.retrieve('topsecret-alpha-bravo')).map(h => h.id)).toEqual([])
    expect((await docs.retrieve('public-charlie')).map(h => h.id)).toEqual(['t0'])  // tier-0 sibling still found
  })

  it('elevate: warm retrieve() in the elevating session no longer returns the record or its snippet', async () => {
    const { docs } = await openSearch()
    await docs.put('e1', { id: 'e1', body: 'topsecret-alpha' })
    await docs.retrieve('alpha')                        // warms the in-memory index
    await docs.elevate('e1', 1)
    // Pre-#721: warm retrieve returned e1 with a snippet from the index's own text.
    expect((await docs.retrieve('alpha')).map(h => h.id)).toEqual([])
  })

  it('cold session: the elevated record is not in the rebuilt index; tier-0 siblings are', async () => {
    const h = searchHarness()
    const { docs } = await h.open()
    await docs.put('e1', { id: 'e1', body: 'alpha-secret' })
    await docs.put('t0', { id: 't0', body: 'alpha-public' })
    await docs.retrieve('alpha')
    await docs.elevate('e1', 1)
    const cold = await h.open()
    expect((await cold.docs.retrieve('alpha')).map(h => h.id)).toEqual(['t0'])
  })

  it('demote restores lexical searchability', async () => {
    const { docs } = await openSearch()
    await docs.put('e1', { id: 'e1', body: 'alpha-secret' })
    await docs.elevate('e1', 1)
    await docs.demote('e1', 0)
    expect((await docs.retrieve('alpha')).map(h => h.id)).toEqual(['e1'])
  })
})

describe('#721 vector (_vec)', () => {
  it('elevate purges the _vec sidecar; cold similarTo no longer surfaces the record', async () => {
    const h = searchHarness({ embeddings: true })
    const { store, docs } = await h.open()
    await docs.put('e1', { id: 'e1', body: 'alpha' })
    expect(await store.get('v1', '_vec', 'e1')).not.toBeNull()
    await docs.elevate('e1', 1)
    expect(await store.get('v1', '_vec', 'e1')).toBeNull()     // sidecar purged
    const cold = await h.open()
    // Pre-#721: cold similarTo surfaced e1's id + score with no warm cache.
    expect((await cold.docs.similarTo('e1')).map(x => x.id)).not.toContain('e1')  // adapt to the real similarTo API
  })

  it('demote re-embeds: the record is semantically searchable again', async () => {
    const h = searchHarness({ embeddings: true })
    const { store, docs } = await h.open()
    await docs.put('e1', { id: 'e1', body: 'alpha' })
    await docs.elevate('e1', 1)
    await docs.demote('e1', 0)
    expect(await store.get('v1', '_vec', 'e1')).not.toBeNull()
  })
})
```
Adapt every mechanic (the retrieve/similarTo APIs, the embeddings descriptor, `flushIndex`'s real name/existence) to the real code — grep first. The assertions (elevated record absent from search warm+cold; sidecar purged; demote restores) are what matter. If a RED doesn't reproduce, STOP → BLOCKED with output (e.g. the `_vec` cold-leak test needs a real mock embedder to have written a sidecar).

- [ ] **Step 2: RED** — `pnpm vitest run __tests__/tiers-search.test.ts` → elevated record still returned by warm/cold retrieve; `_vec` sidecar survives; cold similarTo surfaces it.

- [ ] **Step 3: Implement**

(a) `search/collection-facade.ts` — `syncTierSearch<T>(ctx, id, record, version?)`: if `record === null` → `await ctx.purgeVector(id)` (or the facade's own `_vec` delete + `vectorSet.markDirty`) then invalidate the lexical index (delete the persisted blob + `markDirty` — reuse whatever `_purgeSearchIndex` does); else → `await embedOnWrite(ctx, id, record, version)` then invalidate the lexical index. No-op immediately when the ctx has neither a search index nor a vector set. Read `_purgeVector`/`_purgeSearchIndex`/`embedOnWrite` and reuse them — do not re-derive.
(b) `TiersContext` — add `syncSearch` (spec doc comment).
(c) `elevate` → `await ctx.syncSearch(id, null)`; `demote` → `await ctx.syncSearch(id, toTier === 0 ? <decoded record> : null, <newEnvelope._v>)` (reuse demote's existing decode); `putAtTier` → `await ctx.syncSearch(id, tier > 0 ? null : record, envelope._v)`. Place each AFTER `adapter.put` (no syncCache ordering constraint — see spec).
(d) `collection.ts` `tiersContext()` — one line: `syncSearch: (id, rec, version) => syncTierSearchImpl(this.searchContext(), id, rec, version)` (mirror the `syncIndexes` wiring at `:4515`). Fund the +1 with a shrink-join; document it. collection.ts must end at exactly **4548**.

- [ ] **Step 4: GREEN + regression** — the new file + `__tests__/hierarchical-tiers.test.ts` + `__tests__/tiers-indexing.test.ts` + any search suites + `__tests__/per-record-cek.test.ts`; then the FULL hub suite from root; `node scripts/check-architecture.mjs`; typecheck; lint. Adjudicate any pre-existing test that changes.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/with-audit/tiers/index.ts packages/hub/src/with-lookup/search/collection-facade.ts packages/hub/src/kernel/collection.ts packages/hub/__tests__/tiers-search.test.ts
git commit -m "fix(hub): tier moves maintain search — elevate purges _vec + invalidates _ftindex, demote restores (#721)"
```

---

### Task 2: defense-in-depth — gate buildVectorLoad against a surviving `_vec`

**Files:**
- Modify: `packages/hub/src/with-lookup/search/collection-facade.ts` (`buildVectorLoad`)
- Modify: `packages/hub/__tests__/tiers-search.test.ts` (append)

**Interfaces:**
- Consumes: `liveRecordIsElevated` (`kernel/tier-visibility.ts`) — envelope peek, no decryption.

Rationale: Task 1's purge is best-effort (the `forget()` path treats `_purgeVector` failures as residue) and cannot reach a `_vec` written before this fix. `buildVectorLoad` (`search/collection-facade.ts:190-204`) loads every `_vec` row ungated; `_vec` envelopes carry no `_tier`, so the gate reads the owning record's tier.

- [ ] **Step 1: Write the failing test** — hand-write a `_vec/<id>` row directly into the store for a record that is then elevated (simulating a legacy/failed-purge sidecar), then assert cold `similarTo()` does not surface it:

```ts
it('#721 defense: buildVectorLoad skips a surviving _vec row whose record is elevated', async () => {
  const h = searchHarness({ embeddings: true })
  const { store, docs } = await h.open()
  await docs.put('leaky', { id: 'leaky', body: 'alpha' })
  const vecRow = await store.get('v1', '_vec', 'leaky')          // capture a real _vec envelope
  await docs.elevate('leaky', 1)                                  // Task 1 purges it…
  await store.put('v1', '_vec', 'leaky', vecRow!)                 // …simulate a legacy/failed-purge survivor
  const cold = await h.open()
  expect((await cold.docs.similarTo('leaky')).map(x => x.id)).not.toContain('leaky')
})
```
(Adapt to the real `similarTo` shape. This must RED against Task 1's HEAD — Task 1's purge doesn't cover a re-planted row.)

- [ ] **Step 2: RED** — the re-planted `_vec` row surfaces in cold `similarTo`.

- [ ] **Step 3: Implement** — in `buildVectorLoad`'s per-row loop, before pushing the vector, skip when the owning record is elevated:
```ts
    // #721 defense-in-depth: a _vec row carries no _tier of its own; the purge
    // on elevate is best-effort and cannot reach a legacy sidecar, so gate on
    // the owning record's live tier. Envelope peek, no decryption.
    if (await liveRecordIsElevated(ctx.adapter, ctx.vault, ctx.name, id)) continue
```
(Confirm `ctx` exposes `adapter`/`vault`/`name`; if `buildVectorLoad`'s ctx is narrower, thread what's needed. Note the one extra `adapter.get` per loaded vector — acceptable on this non-hot path; state it in the report.)

- [ ] **Step 4: GREEN + regression** — the new file + search suites + full hub suite; arch/typecheck/lint.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/with-lookup/search/collection-facade.ts packages/hub/__tests__/tiers-search.test.ts
git commit -m "fix(hub): buildVectorLoad skips _vec rows whose record is elevated — defense against a surviving sidecar (#721)"
```

---

### Final: full suite + whole-branch review + changeset + PR

- [ ] `pnpm --filter @noy-db/hub test` + typecheck + lint + `pnpm check:architecture` — green.
- [ ] Whole-branch review (fable — a CRITICAL at-rest leak arc: ask it to prove no path leaves or rebuilds a tier-0-readable search artifact from elevated plaintext, to sweep for a THIRD search artifact beyond `_vec`/`_ftindex`, and to verify the changeset states the functional loss without overclaiming past #722/#724/#712).
- [ ] Local changeset: `@noy-db/hub` patch — elevating a record now removes it from full-text and semantic search (the persisted `_ftindex` held its verbatim field text, the `_vec` sidecar its text-invertible embedding, both readable at tier 0); demote restores; intended consequence that an elevated record is unsearchable until demoted.
- [ ] PR → main: `Closes #721`.
