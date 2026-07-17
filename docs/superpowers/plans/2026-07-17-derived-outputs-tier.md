# Arc 9 — Derived Outputs Follow Tier Implementation Plan (#722)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Checkbox (`- [ ]`) steps.

**Goal:** On a tier move, recompute the source record's derived outputs (MV rows, rollup contributions, `withDerivation` outputs) from the tier-aware cache — so an elevated source's plaintext no longer sits in tier-0 output collections; demote restores. Reuses the forget-fanout recompute. Owner chose RECOMPUTE (drop the contribution), reversible.

**Architecture:** Spec — `docs/superpowers/specs/2026-07-17-derived-outputs-tier-design.md`. New `TiersContext.syncDerived` hook reusing `dispatchMaterializedViewsOnDelete`/`dispatchRollupsOnDelete`/`dispatchArrayDerivationsOnDelete` (remove, on elevate) and the local-write dispatchers (add, on demote). Recompute is tier-safe because the source scan reads the elevated-excluding cache.

**Tech Stack:** TypeScript ESM, vitest. Branch `fix/722-derived-outputs-tier` off main b2b164e3.

## Global Constraints

- NEVER add Claude/Anthropic attribution; never reference the private pilot client — grep the diff.
- Ceilings exact (checker = `wc -l` + 1): `collection.ts` **4549**, `vault.ts` 3959, `noydb.ts` 2396. The one `syncDerived` wiring line needs a mechanical shrink-join. Never edit ceiling values or check-architecture ratchets. `vault.ts`/`noydb.ts` untouched.
- TDD: RED before implementing. Run from `packages/hub/`: `pnpm vitest run <path>`.
- No new deps; no timing assertions. **Reuse the forget-fanout dispatchers — do NOT write a new recompute engine.**

---

### Task 1: `syncDerived` hook + recompute-as-remove on elevate

**Files:**
- Modify: `packages/hub/src/with-audit/tiers/index.ts` (`TiersContext.syncDerived` + call in `elevate`/`putAtTier(>0)`)
- Modify: `packages/hub/src/kernel/collection.ts` (one wiring line; net-zero via shrink-join)
- Create: `packages/hub/__tests__/tiers-derived.test.ts`

**Interfaces:**
- Produces: `TiersContext.syncDerived(id: string, record: T | null, elevated: boolean): Promise<void>` — `elevated` (landing tier > 0) → remove the source's derived outputs (reuse the onDelete fanout); else → add (Task 2). No-op fast when the collection has no MV/derivation source.
- Consumes (all existing): `dispatchMaterializedViewsOnDelete(id)` (`collection.ts:2935`), `dispatchRollupsOnDelete(id, priorRecord)` (`~:2287`), `dispatchArrayDerivationsOnDelete(id, internal)` (`~:2888`); `this.materializedViewSource`/`this.derivationSource` (undefined → no derivations).
- STUDY FIRST: `forgetDerivedFanout` (`kernel/via/dispatch.ts:305-361`) — it fans out per edge kind (`'mv'`/`'rollup'`/`'derivation'`) over `vault.graph.derivedArtifactsOf(collection)` and calls exactly those dispatchers. The elevate-remove path mirrors it (minus the `'ref'` cascade). Reuse its shape; the rollup path needs the pre-move record (the tier op already decodes it) as `priorRecord`.

- [ ] **Step 1: Write the failing tests**

Create `packages/hub/__tests__/tiers-derived.test.ts`. **No repo test combines tiers with MV/rollup/derivation — build the fixtures from scratch.** Grep working derivation tests (`grep -rln "withMaterializedView\|materializedViews:\|withRollup\|withDerivation" __tests__/`) for the real config of EACH kind, then make the SOURCE collection `tiers: [0,1]` + `perRecordKeys: true`. Cover the remove direction:

```ts
/**
 * #722 — derived outputs must follow the source's tier. Elevating a source
 * record must remove its contribution from every derived output (MV rows,
 * rollup/aggregate values, derivation outputs) — those output rows live in
 * tier-0 output collections and held the source's tier-0-era plaintext.
 * Reuses the forget-fanout recompute; recompute reads the elevated-excluding
 * cache so it drops the now-invisible source.
 */
describe('#722 elevate removes the source from derived outputs', () => {
  it('record-grain MV: the elevated source’s output row vanishes; the output collection holds no source plaintext', async () => {
    // source coll tiers:[0,1]+perRecordKeys feeding a record-grain MV (e.g. a filtered projection);
    // put source 'a' and 'b'; assert the MV output collection has rows for both (with source fields);
    await src.elevate('a', 1)
    // assert: the MV output row derived from 'a' is GONE; 'b' remains; the output collection contains no 'a' plaintext.
  })

  it('aggregate MV: elevating a contributor drops it from the group aggregate', async () => {
    // groupBy(dept).sum(salary); put two source records in the same group; assert the aggregate;
    // elevate one; assert the aggregate DROPPED that contribution (owner-accepted inference channel).
  })

  it('rollup: elevating a child drops its contribution from the parent rollup field', async () => { /* … */ })

  it('record/array withDerivation: the elevated source’s derived output is removed', async () => { /* … */ })

  it('a sibling non-elevated source’s derived outputs are untouched', async () => { /* … */ })

  it('a collection with NO derivations is unaffected (syncDerived is a fast no-op)', async () => { /* … */ })
})
```
Fill each in fully against the REAL derivation APIs (grep first — do NOT invent). The assertion (the elevated source's plaintext/contribution is gone from the output collection; siblings intact) is what matters. If a RED doesn't reproduce (e.g. the output row didn't exist pre-elevate, or already excluded the source), STOP → BLOCKED with output — that would refute the leak premise for that kind.

- [ ] **Step 2: RED** — post-elevate the output row / aggregate contribution / derivation output still reflects the elevated source.

- [ ] **Step 3: Implement**

(a) `TiersContext.syncDerived(id, record, elevated)` (spec doc comment). (b) Wire in `collection.ts` `tiersContext()` (beside `syncLedger`) to a helper that, for `elevated`, runs the remove-dispatchers for the source id (mirror `forgetDerivedFanout`'s per-edge dispatch, using the graph edges of THIS collection); guard `this.materializedViewSource !== undefined || this.derivationSource !== undefined` → else no-op. (c) `elevate` → `await ctx.syncDerived(id, <pre-move decoded record>, true)`; `putAtTier(tier > 0)` → same with `true`. Place after the live `adapter.put`. collection.ts must end at exactly **4548** — one shrink-join.

- [ ] **Step 4: GREEN + regression** — the new file + the MV/rollup/derivation suites + `__tests__/hierarchical-tiers.test.ts`; `node scripts/check-architecture.mjs`; typecheck; lint.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/with-audit/tiers/index.ts packages/hub/src/kernel/collection.ts packages/hub/__tests__/tiers-derived.test.ts
git commit -m "fix(hub): elevate removes the source from derived outputs (MV/rollup/derivation) (#722)"
```

---

### Task 2: recompute-as-add on demote (reversibility) + the full matrix

**Files:**
- Modify: `packages/hub/src/with-audit/tiers/index.ts` (`syncDerived` add-branch + calls in `demote`/`putAtTier(0)`)
- Modify: `packages/hub/__tests__/tiers-derived.test.ts` (append)

**Interfaces:**
- Consumes: the local-write dispatchers `dispatchMaterializedViews(id, record)` / `dispatchDerivations(id, record, version)` / the rollup add path (`collection.ts:3866-3876`).

- [ ] **Step 1: Write the failing tests**

```ts
describe('#722 demote restores the source to derived outputs (reversible)', () => {
  it('record-grain MV: demote re-creates the output row', async () => {
    // elevate 'a' (row gone), then demote 'a' to 0; assert the MV output row for 'a' is BACK with its fields.
  })
  it('aggregate MV: demote restores the contribution to the group aggregate', async () => { /* … */ })
  it('rollup + derivation: demote restores the contribution/output', async () => { /* … */ })
  it('putAtTier(0) over an elevated record restores its derived outputs', async () => { /* … */ })
  it('elevate → demote → elevate round-trips cleanly (outputs match the current tier each time)', async () => { /* … */ })
})
```

- [ ] **Step 2: RED** — after demote, the output row/contribution is NOT restored (elevate removed it, demote doesn't re-add).

- [ ] **Step 3: Implement** the add-branch of `syncDerived` (`elevated === false` → run the local-write dispatchers with the record). Wire `demote(→0)` → `await ctx.syncDerived(id, <decoded record>, false)`; `demote(→ intermediate >0)` → `true` (still removed); `putAtTier(0)` → `false`. Reuse demote's existing record decode (no double-decrypt). collection.ts untouched this task (Task 1 wired the callback).

- [ ] **Step 4: GREEN + regression** — the new file + MV/rollup/derivation suites + `__tests__/hierarchical-tiers.test.ts` + the merged tier suites (`tier0-read-paths`, `history-at-rest`, `ledger-purge`, `tiers-search`, `tiers-indexing`); then the FULL hub suite from root; `node scripts/check-architecture.mjs`; typecheck; lint. Adjudicate any pre-existing test that changes.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/with-audit/tiers/index.ts packages/hub/__tests__/tiers-derived.test.ts
git commit -m "fix(hub): demote restores the source to derived outputs — reversible (#722)"
```

---

### Final: full suite + whole-branch review + changeset + PR

- [ ] `pnpm --filter @noy-db/hub test` + typecheck + lint + `pnpm check:architecture` — green.
- [ ] Whole-branch review (fable — prove NO derived output retains an elevated source's plaintext/contribution on any path/kind; prove recompute doesn't RE-EMBED elevated plaintext (the source scan reads the elevated-excluding cache — verify); prove reversibility (demote restores) and round-trip stability; sweep for a derivation kind or dispatch edge the arc missed; confirm the aggregate-drop inference channel is the only new observable and is documented).
- [ ] Local changeset: `@noy-db/hub` patch — elevating a record now removes its contribution from materialized-view rows, rollups, and derivation outputs (they held the source's plaintext at tier 0); demote restores. Document the aggregate-drop inference channel (an aggregate/rollup value changes observably when a contributor is elevated) as a known, accepted property (#722).
- [ ] PR → main: `Closes #722`.
