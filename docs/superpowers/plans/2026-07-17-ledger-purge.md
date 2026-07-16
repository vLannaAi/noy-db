# Arc 8 — Ledger Purge Implementation Plan (#729)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** On a tier move to tier > 0, purge the record's tier-0-era plaintext `_ledger_deltas` rows — closing #729 at rest, with the tamper-chain left valid. Owner chose PURGE (irreversible, metadata retained).

**Architecture:** Spec — `docs/superpowers/specs/2026-07-17-ledger-purge-design.md`. New `LedgerStore.purgeRecordDeltas` + `TiersContext.syncLedger` hook, parallel to `syncHistory`. The ledger is a flat vault-wide hash-chained log; purge (not rewrap) is the fix because deltas have no per-record key and are chain-bound.

**Tech Stack:** TypeScript ESM, vitest. Branch `fix/729-ledger-purge` off main (current HEAD after Arc 7 merges — rebase if needed).

## Global Constraints

- NEVER add Claude/Anthropic attribution; never reference the private pilot client — grep the diff.
- Ceilings exact (checker = `wc -l` + 1): `collection.ts` **4549**, `vault.ts` 3959, `noydb.ts` 2396. The one `syncLedger` wiring line in collection.ts needs a mechanical shrink-join. Never edit ceiling values or check-architecture.mjs ratchets. `vault.ts`/`noydb.ts` untouched (forget-side #734 is a separate PR).
- TDD: RED before implementing. Run from `packages/hub/`: `pnpm vitest run <path>`.
- No new deps; no timing assertions.
- **THE INVARIANT: `ledger.verify()` must return `{ok:true}` after every purge.** Any test path must assert it.

---

### Task 1: `LedgerStore.purgeRecordDeltas` primitive

**Files:**
- Modify: `packages/hub/src/with-commit/history/ledger/store.ts`
- Create: `packages/hub/__tests__/ledger-purge.test.ts`

**Interfaces:**
- Produces: `async purgeRecordDeltas(collection: string, id: string): Promise<number>` on `LedgerStore` — deletes each `_ledger_deltas/<paddedIndex(e.index)>` row whose entry matches `(collection, id)` and has a delta (`e.deltaHash !== undefined`); returns the count. Touches NO `_ledger` entry; no re-encryption.
- Consumes: `loadAllEntries()` (`store.ts:398`), `paddedIndex` (imported at `store.ts:54`), `LEDGER_DELTAS_COLLECTION` (`store.ts:60`), `this.adapter.delete`.

- [ ] **Step 1: Write the failing test**

Create `packages/hub/__tests__/ledger-purge.test.ts`. Grep an existing ledger test (`__tests__/*ledger*`) for how to construct a vault with `withHistory()` (which enables the ledger), do puts that produce deltas, and reach `vault.ledger()` (`verify`, `loadDelta`, `reconstruct`, `entries`) + the raw `store.get(vault, '_ledger_deltas', paddedIndex(i))`. Then:

```ts
/**
 * #729 — LedgerStore.purgeRecordDeltas deletes a record's plaintext delta
 * rows while leaving the tamper-chain valid (verify() reads entry fields,
 * never the delta rows) and a sibling record's deltas untouched.
 */
it('purges a record’s delta rows, keeps the chain valid, leaves siblings intact', async () => {
  // … build a withHistory vault + collection, put 'a' twice (→ a delta) and 'b' twice …
  const ledger = vault.ledger()
  expect((await ledger.verify()).ok).toBe(true)
  // a's v1->v2 delta exists at rest:
  // (find a's delta index via ledger.entries(), assert store.get(_ledger_deltas, paddedIndex) !== null)
  const purged = await ledger.purgeRecordDeltas('docs', 'a')
  expect(purged).toBeGreaterThan(0)
  // a's delta rows are gone; b's remain:
  // (assert store.get for a's delta index === null, b's !== null)
  expect((await ledger.verify()).ok).toBe(true)                 // CHAIN STILL VALID — the invariant
  expect((await ledger.entries()).some(e => e.id === 'a')).toBe(true) // metadata retained
})

it('is idempotent — purging already-purged deltas is a no-op that keeps verify() ok', async () => {
  // purge twice; second returns 0; verify() still ok
})
```
Fill in fully against the real `vault.ledger()` API (grep the existing ledger test — do NOT invent method names). If `entries()` doesn't expose the index directly, derive it. Never weaken an assert. If RED doesn't reproduce (e.g. no delta was written), check the delta is produced only on an UPDATE (genesis put + delete carry none — `entry.ts:151-173`), so put the same id twice.

- [ ] **Step 2: RED** — `purgeRecordDeltas` doesn't exist → fails.

- [ ] **Step 3: Implement** `purgeRecordDeltas` per the spec. Match the file-header/method style of `loadDelta`/`loadAllEntries`. Document the chain-safety rationale in the doc comment.

- [ ] **Step 4: GREEN + regression** — the new file + `__tests__/*ledger*` + any history suites; `node scripts/check-architecture.mjs`; typecheck; lint.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/with-commit/history/ledger/store.ts packages/hub/__tests__/ledger-purge.test.ts
git commit -m "feat(hub): LedgerStore.purgeRecordDeltas — delete a record's plaintext deltas, chain-safe (#729)"
```

---

### Task 2: wire `syncLedger` into the tier ops + at-rest tests

**Files:**
- Modify: `packages/hub/src/with-audit/tiers/index.ts` (`TiersContext.syncLedger` + calls in `elevate`/`putAtTier`)
- Modify: `packages/hub/src/kernel/collection.ts` (one wiring line; net-zero via shrink-join)
- Modify: `packages/hub/__tests__/ledger-purge.test.ts` (append the integration/at-rest tests)

**Interfaces:**
- Produces: `TiersContext.syncLedger(id: string): Promise<void>`.
- Consumes: Task 1's `purgeRecordDeltas`, `this.ledger` (`collection.ts:668`).

- [ ] **Step 1: Write the failing tests**

```ts
describe('#729 elevate purges the ledger deltas at rest', () => {
  it('elevate deletes the record’s _ledger_deltas rows; verify() stays ok; reconstruct can’t recover pre-elevation plaintext', async () => {
    // put 'd1' with body v1, then update to v2 (→ a delta capturing v1's fields), withHistory + tiers:[0,1] + perRecordKeys
    // pre-elevate: reconstruct(or loadDelta) recovers v1's plaintext; the raw _ledger_deltas row exists
    await docs.elevate('d1', 1)
    // POST: the raw _ledger_deltas row for d1 is gone; ledger.verify().ok === true;
    // reconstruct('docs','d1',current, v1) no longer yields v1's old fields (pruned);
    // a sibling tier-0 record's deltas are untouched.
  })

  it('putAtTier(>0) over a record with deltas also purges them', async () => { /* … */ })

  it('a non-elevated (tier-0) record keeps its deltas', async () => { /* … */ })

  it('entries() still lists d1’s mutation metadata after elevate (audit record of the change survives)', async () => { /* … */ })
})
```
Base the fixture on `history-at-rest.test.ts` (withHistory ⇒ ledger, + tiers + perRecordKeys). Adapt reconstruct/verify/entries to the real API. RED: pre-fix, elevate leaves the delta row in the store and reconstruct still recovers v1. If a RED doesn't reproduce, STOP → BLOCKED.

- [ ] **Step 2: RED** — post-elevate the delta row survives / reconstruct still recovers the old plaintext.

- [ ] **Step 3: Implement**

(a) `TiersContext` — add `syncLedger(id): Promise<void>` (spec doc comment). (b) `elevate` → `await ctx.syncLedger(id)` after the live `adapter.put` (in the same after-put block as the other sync hooks; ordering-independent). `putAtTier` → `await ctx.syncLedger(id)` when `tier > 0` (skip for tier 0). Do NOT call in `demote` or `putAtTier(0)` (irreversible; nothing to restore). (c) `collection.ts` `tiersContext()` — one line: `syncLedger: (id) => this.ledger?.purgeRecordDeltas(this.name, id) ?? Promise.resolve()` (or match the `syncHistory` wiring shape; the `?.` no-ops when no ledger). Fund the +1 with a shrink-join; collection.ts must end at exactly **4548**.

- [ ] **Step 4: GREEN + regression** — the new file + `__tests__/hierarchical-tiers.test.ts` + `__tests__/history-at-rest.test.ts` + `__tests__/per-record-cek.test.ts` + `__tests__/*ledger*`; then the FULL hub suite from root; `node scripts/check-architecture.mjs`; typecheck; lint. Adjudicate any pre-existing test that changes.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/with-audit/tiers/index.ts packages/hub/src/kernel/collection.ts packages/hub/__tests__/ledger-purge.test.ts
git commit -m "fix(hub): elevate purges the record's tier-0-era ledger deltas (#729)"
```

---

### Final: full suite + whole-branch review + changeset + PR

- [ ] `pnpm --filter @noy-db/hub test` + typecheck + lint + `pnpm check:architecture` — green.
- [ ] Whole-branch review (fable — tamper-chain integrity is the crux: prove `verify()` holds after a purge on EVERY path; prove no delta of a non-elevated record is touched; confirm the metadata-retained/plaintext-purged split is exactly as the owner decided; sweep for any other ledger read path that still recovers an elevated record's plaintext deltas via backup/sync/`dump()`).
- [ ] Local changeset: `@noy-db/hub` patch — elevating a record purges its tier-0-era plaintext audit deltas from `_ledger_deltas` (the tamper-chain and the mutation metadata are retained; the change is irreversible — demote does not restore delta reconstruction) (#729).
- [ ] PR → main: `Closes #729`. Note #734 (the forget-side twin) reuses this primitive in a follow-up.
