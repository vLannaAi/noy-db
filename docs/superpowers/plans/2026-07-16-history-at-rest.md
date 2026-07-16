# Arc 4 — history at-rest Implementation Plan (#712, closes it)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On a tier move, rewrap every history snapshot's key material from the record's current-tier DEK to its new-tier DEK, so an elevated record's prior versions are not decryptable at rest under the tier-0 DEK. Closes #712 (the read-gate shipped Arc 1).

**Architecture:** Spec — `docs/superpowers/specs/2026-07-16-history-at-rest-design.md` (user-approved). Reuses `rewrapBodyToDek`; a `rewrapHistory` primitive + `TiersContext.syncHistory` callback called by elevate/demote/putAtTier, mirroring `syncSearch`/`syncIndexes`.

**Tech Stack:** TypeScript ESM, vitest. Branch `fix/712-history-at-rest` off main 03a80f96.

## Global Constraints

- NEVER add Claude/Anthropic attribution to commits/PRs/changelogs.
- NEVER reference the private pilot client by name — grep the diff before each commit.
- Ceilings exact (checker = `wc -l` + 1): `collection.ts` **4548**, `vault.ts` 3959, `noydb.ts` 2396. Fund the one wiring line with a mechanical shrink-join. Never edit ceiling values; never touch vault.ts/noydb.ts. `history.ts`/`tiers/index.ts` have no ceiling.
- TDD: RED verified before implementing, every test. Run from `packages/hub/`: `pnpm vitest run <path>`.
- No new deps; no timing assertions.
- REUSE `rewrapBodyToDek` — do not hand-roll crypto. The read-gate (Arc 1) must stay unaffected — its tests pass untouched.

---

### Task 1: the `rewrapHistory` primitive + strategy method

**Files:**
- Modify: `packages/hub/src/with-commit/history/history.ts` (new `rewrapHistory`)
- Modify: `packages/hub/src/with-commit/history/strategy.ts` (add to `HistoryStrategy` + `NO_HISTORY` no-op)
- Create: `packages/hub/__tests__/history-at-rest.test.ts`

**Interfaces:**
- Produces: `rewrapHistory(adapter, vault, collection, recordId, fromDek, toDek): Promise<void>` — lists `_history` entries for the id (reuse the `historyId` prefix / `getHistory` enumerate), rewraps each via `rewrapBodyToDek(env, fromDek, toDek)`, `adapter.put`s back at the same id. Skips tombstone-shaped entries (blanked `_data` — a forgotten version has nothing to rewrap). **Legacy fallback:** if `rewrapBodyToDek` throws on unwrap/decrypt (a pre-fix tier-0-wrapped snapshot whose `fromDek` is a tier-N DEK), retry with the tier-0 DEK; the output is always wrapped under `toDek`.
- Consumes: `rewrapBodyToDek` (`kernel/enclave/record-keys/lifecycle.ts`), `historyId`/`HISTORY_COLLECTION` (`history.ts:12-17`), `isTombstoneShape`/tombstone predicate.
- Study first: `tombstoneHistory` (`history.ts:182-212`) — the structural template (list `_history` by prefix, mutate each, put back); you rewrap instead of blank.

- [ ] **Step 1: Write the failing tests (primitive-level)**

Create `packages/hub/__tests__/history-at-rest.test.ts`. Base the fixture on `__tests__/per-record-cek.test.ts` (it already composes `withHistory()` + `withTiers()` + `perRecordKeys: true` + tiers, and uses `store.get`/`store.raw` to inspect raw envelopes). Grep it for the exact `createNoydb`/collection config and the DEK-access pattern (how it reaches the collection/tier DEKs to attempt an unwrap).

First, the primitive in isolation is hard to unit-test without DEKs; the meaningful RED is the integration behavior (Task 2). For Task 1, pin the primitive's contract with a focused test that calls `rewrapHistory` directly with two hand-derived DEKs (or, if DEK derivation is awkward in isolation, fold these assertions into Task 2 and make Task 1 a pure add of the primitive + strategy method verified by typecheck + the NO_HISTORY no-op). Minimum Task-1 test:

```ts
// NO_HISTORY.rewrapHistory is a no-op (does not throw, touches nothing).
it('NO_HISTORY.rewrapHistory no-ops', async () => {
  const store = /* memoryStore */;
  await expect(NO_HISTORY.rewrapHistory(store, 'v', 'c', 'id', dekA, dekB)).resolves.toBeUndefined()
})
```
(Adapt `NO_HISTORY` import + the DEK values — any two `EnclaveKey`s; the no-op must not use them.)

- [ ] **Step 2: RED** — the strategy method doesn't exist yet → typecheck/test fails.

- [ ] **Step 3: Implement** `rewrapHistory` in `history.ts` (mirror `tombstoneHistory`'s list-and-mutate shape; rewrap via `rewrapBodyToDek` + the tier-0 fallback; skip tombstoned entries), add it to the `HistoryStrategy` interface + the real strategy impl, and the `NO_HISTORY` no-op.

- [ ] **Step 4: GREEN + regression** — the new test + `__tests__/per-record-cek.test.ts` + any history suites; `node scripts/check-architecture.mjs`; typecheck; lint.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/with-commit/history/history.ts packages/hub/src/with-commit/history/strategy.ts packages/hub/__tests__/history-at-rest.test.ts
git commit -m "feat(hub): rewrapHistory — re-key a record's history snapshots between tier DEKs (#712)"
```

---

### Task 2: wire syncHistory into the tier ops + the at-rest tests

**Files:**
- Modify: `packages/hub/src/with-audit/tiers/index.ts` (`TiersContext.syncHistory` + calls in `elevate`/`demote`/`putAtTier`)
- Modify: `packages/hub/src/kernel/collection.ts` (one wiring line; net-zero via shrink-join)
- Modify: `packages/hub/__tests__/history-at-rest.test.ts` (append the integration/at-rest tests)

**Interfaces:**
- Produces: `TiersContext.syncHistory(id, fromDek, toDek): Promise<void>`.
- Consumes: Task 1's `rewrapHistory` (via the history strategy on the context); the `fromDek`/`toDek` each tier op already computes for the live rewrap.

- [ ] **Step 1: Write the failing tests (the crux — at-rest key inspection)**

Append. The decisive assertions read the RAW `_history` envelope after `elevate` and check its key material — because the read-gate hides `history()`, only a raw-envelope inspection pins the at-rest property. Reuse `per-record-cek.test.ts`'s DEK-access pattern.

```ts
describe('#712 at-rest: history snapshots follow the record’s tier', () => {
  it('elevate rewraps history _cek to the tier-N DEK — no longer unwrappable under tier-0', async () => {
    const { store, docs, tier0Dek, tier1Dek } = await openHistoryTiers()  // perRecordKeys + withHistory + tiers:[0,1]
    await docs.put('d1', { id: 'd1', body: 'v1-secret' })
    await docs.put('d1', { id: 'd1', body: 'v2-secret' })      // v1 snapshot now in _history under tier-0
    const histId = 'docs:d1:0000000001'
    const before = await store.get('v1', '_history', histId)
    // Pre-#712: `before._cek` unwraps under the tier-0 DEK → the leak.
    await expect(unwrapCek(before._cek, tier0Dek)).resolves.toBeDefined()  // adapt unwrap import

    await docs.elevate('d1', 1)

    const after = await store.get('v1', '_history', histId)
    // AT-REST GUARANTEE: the snapshot's _cek no longer unwraps under tier-0…
    await expect(unwrapCek(after._cek, tier0Dek)).rejects.toThrow()
    // …and DOES under tier-1 (content preserved, moved not destroyed).
    await expect(unwrapCek(after._cek, tier1Dek)).resolves.toBeDefined()
  })

  it('a cold tier-0-only session cannot decrypt an elevated record’s history at rest', async () => {
    // Reopen holding only the tier-0 DEK (strip docs#1, as the invisibility tests do).
    // The raw _history body must be undecryptable; and history() stays [] (read-gate, unchanged).
  })

  it('demote restores tier-0 readability of history', async () => {
    const { store, docs, tier0Dek } = await openHistoryTiers()
    await docs.put('d1', { id: 'd1', body: 'v1' })
    await docs.put('d1', { id: 'd1', body: 'v2' })
    await docs.elevate('d1', 1)
    await docs.demote('d1', 0)
    const env = await store.get('v1', '_history', 'docs:d1:0000000001')
    await expect(unwrapCek(env._cek, tier0Dek)).resolves.toBeDefined()   // readable at tier-0 again
  })

  it('putAtTier(>0) over a record with history rewraps that history too', async () => {
    const { store, docs, tier0Dek } = await openHistoryTiers()
    await docs.put('d1', { id: 'd1', body: 'v1' })
    await docs.put('d1', { id: 'd1', body: 'v2' })
    await docs.putAtTier('d1', { id: 'd1', body: 'v3' }, 1)
    const env = await store.get('v1', '_history', 'docs:d1:0000000001')
    await expect(unwrapCek(env._cek, tier0Dek)).rejects.toThrow()        // no longer tier-0-readable
  })

  it('the Arc-1 read-gate is unaffected: history()/getVersion() still return empty when elevated', async () => {
    const { docs } = await openHistoryTiers()
    await docs.put('d1', { id: 'd1', body: 'v1' })
    await docs.put('d1', { id: 'd1', body: 'v2' })
    await docs.elevate('d1', 1)
    expect(await docs.history('d1')).toEqual([])
    expect(await docs.getVersion('d1', 1)).toBeNull()
  })

  it('legacy fallback: a tier-0-wrapped history under a pre-fix elevated record demotes cleanly', async () => {
    // Simulate the pre-fix state: elevate WITHOUT rewrapping history (hand-write a tier-0-wrapped
    // _history entry under a tier-1 record), then demote and assert it becomes tier-0-readable
    // (the rewrap's tier-0 fromDek fallback handled the unwrap).
  })
})
```
Write every stubbed test fully; adapt the DEK access + `unwrapCek` import + the non-perRecordKeys (legacy) variant to the real code. If a RED doesn't reproduce (e.g. `before._cek` doesn't unwrap under tier-0 pre-fix — which would refute the leak premise), STOP → BLOCKED with output. Never weaken an assert.

- [ ] **Step 2: RED** — post-elevate, `after._cek` STILL unwraps under tier-0 (the leak); putAtTier(>0) history stays tier-0-readable.

- [ ] **Step 3: Implement**

(a) `TiersContext` — add `syncHistory(id, fromDek, toDek): Promise<void>` (spec doc comment). (b) `elevate`/`demote`/`putAtTier` — one `await ctx.syncHistory(id, fromDek, toDek)` each, AFTER the live `adapter.put`, reusing the `fromDek`/`toDek` already computed for the live rewrap (`putAtTier` computes `from = dekKey(name, existing._tier ?? 0)`, `to = dekKey(name, tier)`; skip if `from === to`). (c) `collection.ts` `tiersContext()` — one line: `syncHistory: (id, fromDek, toDek) => this.historyStrategy.rewrapHistory(this.adapter, this.vault, this.name, id, fromDek, toDek)`. Fund the +1 with a shrink-join; collection.ts must end at exactly **4548**.

- [ ] **Step 4: GREEN + regression** — the new file + `__tests__/per-record-cek.test.ts` + `__tests__/hierarchical-tiers.test.ts` + `__tests__/tier0-read-paths.test.ts` (the read-gate) + the history suites; then the FULL hub suite from root; `node scripts/check-architecture.mjs`; typecheck; lint. Adjudicate any pre-existing test that changes.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/with-audit/tiers/index.ts packages/hub/src/kernel/collection.ts packages/hub/__tests__/history-at-rest.test.ts
git commit -m "fix(hub): tier moves rewrap history snapshot keys — prior versions not tier-0-decryptable at rest (#712)"
```

---

### Final: full suite + whole-branch review + changeset + PR

- [ ] `pnpm --filter @noy-db/hub test` + typecheck + lint + `pnpm check:architecture` — green.
- [ ] Whole-branch review (fable — a CRITICAL at-rest crypto arc: prove no history snapshot remains tier-0-decryptable after elevate on ANY path; verify the tier-0 legacy fallback cannot leak (it only changes the unwrap key tried); confirm the DEK-tracking holds across multi-step moves (0→1→2→0); confirm no history entry created while elevated is missed; sweep for any OTHER at-rest artifact keyed off history/version; verify the read-gate is unaffected).
- [ ] Local changeset: `@noy-db/hub` patch — elevating a record now re-keys its history snapshots to the tier DEK so prior versions are not decryptable at rest under the tier-0 DEK (completing #712, whose read-gate shipped earlier); demote restores.
- [ ] PR → main: `Closes #712`.
