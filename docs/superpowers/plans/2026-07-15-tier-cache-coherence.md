# #701 + #702 Tier Cache Coherence — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend #691's invisible-everywhere semantics to the remaining tier-unaware paths: hydration (eager cold-session bricking, #701), lazy direct-address reads (warm-cache leak / cold throw, #701), `reveal()` (raw crypto error, #701), and `putAtTier` cache coherence (#702).

**Architecture:** Same law as #691 (spec: `docs/superpowers/specs/2026-07-15-tier-unaware-reads-design.md`, user-approved): elevated (`_tier > 0`) records are invisible on tier-0 surfaces — explicit gates before key resolution, never try/catch (the elevating session's warm `cekCache` otherwise leaks plaintext: `decryptRecord(env, {id})` passes the id → cache hit → plaintext, audit-free). `putAtTier` reuses `TiersContext.syncCache` (#700): evict for tier > 0, re-seed for tier 0.

**Tech Stack:** TypeScript ESM, vitest. Branch `fix/701-702-tier-cache-coherence` (created, on main 6ea92d52+).

## Global Constraints

- NEVER add Claude/Anthropic attribution to commits/PRs/changelogs.
- NEVER reference the private pilot client by name — grep the diff before each commit.
- Ceilings exact zero slack (checker = `wc -l` + 1): collection.ts 4549, vault.ts 3959, noydb.ts 2396. **Every collection.ts edit in this plan is a NET-ZERO in-line condition fold** — extend existing lines, add no new lines (comment text may be extended on existing lines; if a genuinely new line becomes unavoidable, make one mechanical shrink-join and document it). Never edit ceiling values; never touch vault.ts/noydb.ts.
- TDD: RED verified before implementing, every test. Run from `packages/hub/`: `pnpm vitest run <path>`.
- No new deps; no timing assertions.

---

### Task 1: #701 — gate hydration, lazy reads, and reveal

**Files:**
- Modify: `packages/hub/src/kernel/collection.ts` (3 in-line condition folds, net-zero)
- Modify: `packages/hub/src/kernel/enclave/classify/reveal.ts` (1 condition fold)
- Modify: `packages/hub/__tests__/tier0-read-paths.test.ts` (append describe block)

**Interfaces:**
- Consumes: `EncryptedEnvelope._tier?: number`; existing fixtures in tier0-read-paths.test.ts (`memoryStore`, `tieredClassifiedHarness`); `ClassifiedRevealError`.
- Produces: nothing downstream (Task 2 is independent).

- [ ] **Step 1: Write the failing tests**

Append to `packages/hub/__tests__/tier0-read-paths.test.ts`:

```ts
describe('#701 hydration / lazy reads / reveal: elevated records are invisible, never a brick or leak', () => {
  function eagerTierHarness() {
    const store = memoryStore()
    const open = async () => {
      const db = await createNoydb({ store, user: 'owner', secret: 'pw-701', tiersStrategy: withTiers() })
      const vault = await db.openVault('v1')
      const docs = vault.collection<User>('docs', { tiers: [0, 1], perRecordKeys: true })
      return { vault, docs }
    }
    return { store, open }
  }

  it('cold-session eager hydration skips the elevated record instead of bricking the collection', async () => {
    const h = eagerTierHarness()
    const { docs } = await h.open()
    await docs.put('a', { name: 'stays' })
    await docs.put('b', { name: 'moves' })
    await docs.elevate('b', 1)

    // Pre-#701: the first decrypt of b's tier-wrapped envelope during cold
    // hydration threw, aborting the loop — get('a') / any read or write on
    // the whole collection rejected.
    const cold = await h.open()
    expect((await cold.docs.get('a'))?.name).toBe('stays')
    expect(await cold.docs.get('b')).toBeNull()          // invisible, not an error
    await cold.docs.put('c', { name: 'writable' })       // collection is usable
    expect((await cold.docs.get('c'))?.name).toBe('writable')
  })

  it('lazy direct-address read: null in BOTH sessions (warm pre-#701 LEAKED via cekCache, cold threw)', async () => {
    const store = memoryStore()
    const open = async () => {
      const db = await createNoydb({ store, user: 'owner', secret: 'pw-701-lazy', tiersStrategy: withTiers() })
      const vault = await db.openVault('v1')
      const docs = vault.collection<User>('ldocs', { tiers: [0, 1], perRecordKeys: true, prefetch: false, cache: { maxRecords: 100 } })
      return { docs }
    }
    const { docs } = await open()
    await docs.put('e1', { name: 'leaky' })
    await docs.elevate('e1', 1) // evicts the LRU (#700) and caches the CEK
    expect(await docs.get('e1')).toBeNull()   // warm: pre-#701 returned plaintext (leak)
    const cold = await open()
    expect(await cold.docs.get('e1')).toBeNull() // cold: pre-#701 threw
  })

  it('reveal on an elevated record throws the domain not-found error, not a raw crypto error', async () => {
    const h = tieredClassifiedHarness()
    const { users } = await h.open()
    await users.put('r1', { name: 'n', password: 'pw-reveal-r1-xx', email: 'r@example.com', a1: 'x', a2: 'y' })
    expect(await users.reveal('r1', 'email')).toBe('r@example.com')
    await users.elevate('r1', 1)
    // Elevated ≡ missing on this tier-0 surface — same error/message class as
    // a genuinely absent id, no elevation disclosure, never InvalidKeyError.
    await expect(users.reveal('r1', 'email')).rejects.toThrow(/not found/)
  }, 60_000)
})
```

Adapt only mechanics if needed (e.g. the exact lazy-mode option names — copy from Task 2's det harness in this same file; `reveal`'s call shape — check an existing reveal test under `__tests__/classified/`). Never weaken an assertion; if a RED expectation doesn't reproduce as documented, STOP and report BLOCKED.

Fixture-path note: cold `open()` may hydrate through `hydrateFromSnapshot` (vault `loadAll` snapshot) rather than `ensureHydrated`. Both loops get the same gate in Step 3 — after GREEN, temporarily comment out ONE of the two gates and confirm at least one test fails, then restore it, to prove both paths are exercised or add a variant that exercises the other (e.g. a collection first declared after the vault opened). Record which path each test hits in your report.

- [ ] **Step 2: Run to verify RED**

Run: `pnpm vitest run __tests__/tier0-read-paths.test.ts -t '#701'`
Expected: FAIL — test 1 rejects during cold reads (hydration abort), test 2 warm leg returns the record (leak) and cold leg rejects, test 3 rejects with `InvalidKeyError`, not `/not found/`.

- [ ] **Step 3: Implement — four in-line condition folds**

(a) `collection.ts` `ensureHydrated` (~:3927) — extend the decrypt precondition:
```ts
      if (envelope && !isTombstone(envelope, this.storeCiphertext) && !isDeleteMarker(envelope) && (envelope._tier ?? 0) === 0) {
```
(b) `collection.ts` `hydrateFromSnapshot` (~:3943) — extend the skip:
```ts
      if (isTombstone(envelope, this.storeCiphertext) || (envelope._tier ?? 0) > 0) continue
```
(c) `collection.ts` lazy `#getRaw` miss branch (~:1451) — extend the tolerance return (and extend the comment ON ITS EXISTING LINES to mention `#701: elevated records are invisible — gate BEFORE decrypt, or the warm cekCache serves tier plaintext`):
```ts
        if (isTombstone(envelope, this.storeCiphertext) || isDeleteMarker(envelope) || (envelope._tier ?? 0) > 0) return null
```
(d) `reveal.ts` `revealSealedField` (:24) — fold into the existing not-found branch (message unchanged — elevated ≡ missing, no elevation disclosure):
```ts
  if (env === null || isTombstone(env, ctx.encrypted) || (env._tier ?? 0) > 0) {
```
All three collection.ts edits are single-line replacements — file line count MUST be unchanged (`node scripts/check-architecture.mjs` passes with values unedited).

- [ ] **Step 4: Run GREEN + regression**

`pnpm vitest run __tests__/tier0-read-paths.test.ts __tests__/hierarchical-tiers.test.ts __tests__/per-record-cek.test.ts __tests__/classified` → PASS. `node scripts/check-architecture.mjs` (repo root) → PASS. Then the gate-coverage check from Step 1's fixture-path note.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/kernel/collection.ts packages/hub/src/kernel/enclave/classify/reveal.ts packages/hub/__tests__/tier0-read-paths.test.ts
git commit -m "fix(hub): hydration, lazy reads, and reveal skip elevated records — no cold-session brick, no warm-cache leak (#701)"
```

---

### Task 2: #702 — putAtTier maintains the record cache

**Files:**
- Modify: `packages/hub/src/with-audit/tiers/index.ts` (putAtTier only)
- Modify: `packages/hub/__tests__/hierarchical-tiers.test.ts` (append to the '#691 fold-ins' describe or a sibling '#702' block)

**Interfaces:**
- Consumes: `TiersContext.syncCache` (shipped in #700), `ctx.codec.decryptRecord(env, { id, sealedAsHandles: true })` (same call shape as demote-to-0's re-seed — read that block in `demote()` first and mirror it exactly).
- Produces: nothing downstream.

- [ ] **Step 1: Write the failing tests**

```ts
describe('#702 putAtTier maintains the record cache', () => {
  it('putAtTier(tier>0) over a cached id evicts — plain get() stops serving the pre-move plaintext', async () => {
    const { vault } = await freshVault()
    const docs = vault.collection<Doc>('docs', { tiers: [0, 1] })
    await docs.put('p1', { id: 'p1', title: 'Old', body: 'plain' })
    expect((await docs.get('p1'))?.title).toBe('Old') // cache warm
    await docs.putAtTier('p1', { id: 'p1', title: 'New', body: 'secret' }, 1)
    // Pre-#702: the eager cache still served { title: 'Old' } — clearance-free.
    expect(await docs.get('p1')).toBeNull()
    expect(((await docs.getAtTier('p1')) as Doc | null)?.title).toBe('New')
  })

  it('putAtTier(tier 0) over a cached id re-seeds — plain get() serves the NEW content', async () => {
    const { vault } = await freshVault()
    const docs = vault.collection<Doc>('docs', { tiers: [0, 1] })
    await docs.put('p2', { id: 'p2', title: 'V1', body: 'x' })
    expect((await docs.get('p2'))?.title).toBe('V1')
    await docs.putAtTier('p2', { id: 'p2', title: 'V2', body: 'y' }, 0)
    // Pre-#702: stale 'V1' from the untouched cache.
    expect((await docs.get('p2'))?.title).toBe('V2')
  })
})
```

- [ ] **Step 2: Run to verify RED**

Run: `pnpm vitest run __tests__/hierarchical-tiers.test.ts -t '#702'`
Expected: FAIL — test 1 `get('p1')` returns `{ title: 'Old' }`; test 2 returns `'V1'`.

- [ ] **Step 3: Implement**

In `putAtTier` (tiers/index.ts), after `await ctx.adapter.put(...)`:
```ts
  // #702: keep the record cache coherent with the raw write — same law as
  // elevate/demote (#691): tier > 0 → invisible on tier-0 surfaces (evict);
  // tier 0 → this is an ordinary write, re-seed via the canonical decode.
  if (tier > 0) {
    ctx.syncCache(id, null)
  } else {
    const rec = await ctx.codec.decryptRecord(envelope, { id, sealedAsHandles: true })
    ctx.syncCache(id, rec !== null ? { record: rec, version: envelope._v } : null)
  }
```
(Mirror demote-to-0's exact decode call shape; place before the `emitCrossTierEvent` block.)

- [ ] **Step 4: Run GREEN + regression**

`pnpm vitest run __tests__/hierarchical-tiers.test.ts __tests__/tier0-read-paths.test.ts __tests__/per-record-cek.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/with-audit/tiers/index.ts packages/hub/__tests__/hierarchical-tiers.test.ts
git commit -m "fix(hub): putAtTier keeps the record cache coherent — evict above tier 0, re-seed at tier 0 (#702)"
```

---

### Final: full suite + whole-branch review + changeset + PR

- [ ] `pnpm --filter @noy-db/hub test` + typecheck + lint + `pnpm check:architecture` — green.
- [ ] Whole-branch review (fable — kernel hydration + tier cache coherence).
- [ ] Local changeset: `@noy-db/hub` patch — hydration/lazy/reveal skip elevated records (no cold-session brick, no warm-cache leak); putAtTier cache coherence (#701, #702).
- [ ] PR → main with `Closes #701` + `Closes #702`.
