# #706 listPage/scan Tier Gates — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the last ordinary public tier-0 read surface violating the #691 law: `listPage`/`scan` (warm-session plaintext leak, cold-session brick, eager-cache poisoning amplifier) + the lazy `count()` divergence (#706).

**Architecture:** The #691 law (spec `docs/superpowers/specs/2026-07-15-tier-unaware-reads-design.md`, user-approved; extended by #700/#710): elevated (`_tier > 0`) records are invisible on tier-0 surfaces — explicit gates BEFORE any decrypt, never try/catch. Gating `decryptPage` + the scan fallback also kills the poisoning amplifier for free (the opportunistic cache fill only sees decrypt survivors). Lazy `count()` gains eager-parity by counting only live tier-0 envelopes via a small extracted helper (`kernel/lazy-count.ts`) — collection.ts is at its exact ceiling, and the ceiling ratchet exists precisely to push such logic off the god-file.

**Tech Stack:** TypeScript ESM, vitest. Branch `fix/706-listpage-scan-tier-gate` (created, on main fb6cb93c).

## Global Constraints

- NEVER add Claude/Anthropic attribution to commits/PRs/changelogs.
- NEVER reference the private pilot client by name — grep the diff before each commit.
- Ceilings exact zero slack (checker = `wc -l` + 1): collection.ts 4549, vault.ts 3959, noydb.ts 2396. collection.ts edits must be NET-ZERO overall per task (in-line folds; comment-line compression; the count() rewrite trades its body for a helper call — see Task 2's line budget). Never edit ceiling values; never touch vault.ts/noydb.ts.
- TDD: RED verified before implementing, every test. Run from `packages/hub/`: `pnpm vitest run <path>`.
- No new deps; no timing assertions.

---

### Task 1: gate decryptPage + the scan fallback (the CRITICAL leak/brick/poisoning)

**Files:**
- Modify: `packages/hub/src/kernel/collection.ts` (2 sites, net-zero)
- Modify: `packages/hub/__tests__/tier0-read-paths.test.ts` (append describe; fixtures exist)

**Interfaces:**
- Consumes: existing `memoryStore` fixture; `EncryptedEnvelope._tier`.
- Produces: a `memoryStoreWithListPage()` fixture variant (Task 2 does not need it, but keep it exported-in-file for future tests).

- [ ] **Step 1: Write the failing tests**

Append to `packages/hub/__tests__/tier0-read-paths.test.ts`. The existing `memoryStore()` has no `listPage`, so `collection.listPage()` takes the **fallback** path with it. For the **native** path, add a fixture variant wrapping `memoryStore()` with a `listPage(vault, coll, cursor, limit)` implementation (sorted ids, `{ items: [{ id, envelope }...], nextCursor }` — check the exact `ListPageResult` shape in `src/kernel/types.ts` and any existing adapter listPage for reference, e.g. to-memory's, and mirror it).

```ts
describe('#706 listPage/scan: elevated records are invisible — no leak, no brick, no cache poisoning', () => {
  function pageHarness(native: boolean) {
    const base = memoryStore()
    const store = native ? withListPage(base) : base   // withListPage = the new fixture wrapper
    const open = async () => {
      const db = await createNoydb({ store, user: 'owner', secret: 'pw-706', tiersStrategy: withTiers() })
      const vault = await db.openVault('v1')
      const docs = vault.collection<User>('docs', { tiers: [0, 1], perRecordKeys: true })
      return { docs }
    }
    return { open }
  }

  for (const native of [false, true]) {
    const label = native ? 'native adapter.listPage' : 'fallback list()+get()'
    it(`${label}: warm session — elevated record absent from the page, cache NOT poisoned`, async () => {
      const h = pageHarness(native)
      const { docs } = await h.open()
      await docs.put('a', { name: 'stays' })
      await docs.put('b', { name: 'moves' })
      await docs.elevate('b', 1)
      // Pre-#706 (warm, perRecordKeys): b's plaintext egressed in page.items
      // via the warm cekCache — audit-free — and the opportunistic cache fill
      // seeded the eager cache with it.
      const page = await docs.listPage({ limit: 10 })
      expect(page.items.map(r => r.name)).toEqual(['stays'])
      expect(await docs.get('b')).toBeNull() // poisoning pin: the fill never saw b
    })

    it(`${label}: cold session — the scan survives the elevated record`, async () => {
      const h = pageHarness(native)
      const { docs } = await h.open()
      await docs.put('a', { name: 'stays' })
      await docs.put('b', { name: 'moves' })
      await docs.elevate('b', 1)
      const cold = await h.open()
      // Pre-#706: InvalidKeyError from the first elevated envelope bricked
      // every listPage/scan/aggregate over the collection.
      const page = await cold.docs.listPage({ limit: 10 })
      expect(page.items.map(r => r.name)).toEqual(['stays'])
    })
  }

  it('scan (and aggregate) over a collection with an elevated record yields only tier-0 rows', async () => {
    const h = pageHarness(false)
    const { docs } = await h.open()
    await docs.put('a', { name: 'stays' })
    await docs.put('b', { name: 'moves' })
    await docs.elevate('b', 1)
    const seen: string[] = []
    for await (const rec of docs.scan({ pageSize: 1 })) seen.push(rec.name as string)
    expect(seen).toEqual(['stays'])
  })
})
```

Adapt only mechanics (option/response shapes) from real code; never weaken asserts. If a RED expectation doesn't reproduce (the whole-branch reviewer of #710 repro'd both: warm `['moves','stays']`, cold `InvalidKeyError`), STOP → BLOCKED with output.

- [ ] **Step 2: Run to verify RED**

`pnpm vitest run __tests__/tier0-read-paths.test.ts -t '#706'`
Expected: warm tests FAIL with the elevated name present (and/or `get('b')` non-null); cold tests reject with `InvalidKeyError`.

- [ ] **Step 3: Implement — two net-zero edits in collection.ts**

(a) `decryptPage` (~:3730): compress the two comment lines into one and add the gate, keeping the loop net-zero:
```ts
    for (const { id, envelope } of items) {
      // Public scan/listPage output + opportunistic cache fill — sealed fields stay handles; elevated records are invisible (#706: gate BEFORE decrypt or the warm cekCache leaks tier plaintext, audit-free).
      if ((envelope._tier ?? 0) > 0) continue
      const record = await this.codec.decryptRecord(envelope, { id, sealedAsHandles: true })
      if (record === null) continue // shredded (tombstone) — skip the page row
```
(b) scan fallback (~:3630) — in-place fold:
```ts
      if (envelope && (envelope._tier ?? 0) === 0) {
```
Verify `wc -l` on collection.ts is unchanged vs `git show fb6cb93c:packages/hub/src/kernel/collection.ts | wc -l`.

- [ ] **Step 4: GREEN + regression**

`pnpm vitest run __tests__/tier0-read-paths.test.ts __tests__/hierarchical-tiers.test.ts` → PASS. `node scripts/check-architecture.mjs` (root) → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/kernel/collection.ts packages/hub/__tests__/tier0-read-paths.test.ts
git commit -m "fix(hub): listPage/scan skip elevated records — no page leak, no cold-session brick, no cache poisoning (#706)"
```

---

### Task 2: lazy count() eager-parity (live tier-0 envelopes only)

**Files:**
- Create: `packages/hub/src/kernel/lazy-count.ts`
- Modify: `packages/hub/src/kernel/collection.ts` (lazy branch of `count()` + one import; net-zero — see budget)
- Modify: `packages/hub/__tests__/tier0-read-paths.test.ts` (append tests)

**Interfaces:**
- Consumes: `NoydbStore`, `isTombstone`/`isDeleteMarker` from `./enclave/index.js` (check the exact barrel path used by collection.ts's own imports).
- Produces: `export async function countLiveEnvelopes(adapter: NoydbStore, vault: string, name: string, storeCiphertext: boolean): Promise<number>` — counts ids whose envelope exists, is not a tombstone/delete-marker, and has `(env._tier ?? 0) === 0`. No decryption — envelope inspection only.

- [ ] **Step 1: Write the failing tests**

```ts
describe('#706 lazy count(): eager parity — elevated and deleted envelopes are not counted', () => {
  it('lazy count matches eager count with an elevated record present', async () => {
    const store = memoryStore()
    const open = async (lazy: boolean) => {
      const db = await createNoydb({ store, user: 'owner', secret: 'pw-706-count', tiersStrategy: withTiers() })
      const vault = await db.openVault('v1')
      return vault.collection<User>(lazy ? 'lc' : 'lc', lazy
        ? { tiers: [0, 1], perRecordKeys: true, prefetch: false, cache: { maxRecords: 100 } }
        : { tiers: [0, 1], perRecordKeys: true })
    }
    const docs = await open(true)
    await docs.put('a', { name: 'a' })
    await docs.put('b', { name: 'b' })
    await docs.elevate('b', 1)
    // Pre-#706: lazy count() returned raw adapter.list().length = 2.
    expect(await docs.count()).toBe(1)
    const eager = await open(false) // cold second session, eager mode, same store
    expect(await eager.count()).toBe(1) // parity (hydration skips elevated, #701)
  })

  it('lazy count skips a hand-written delete-marker (raw list() counted it)', async () => {
    // Build on the tombstone fixture pattern from hierarchical-tiers.test.ts
    // ('#691 fold-ins' third test): write buildDeleteMarker(...) into the store
    // for an id, then assert lazy count() excludes it.
  })
})
```
Write the second test fully (the pattern — `buildDeleteMarker(live._v, 'owner')` after a put — is in `__tests__/hierarchical-tiers.test.ts`'s '#691 fold-ins' block; import path per that file).

- [ ] **Step 2: Run to verify RED** — lazy count returns 2 (and the marker test counts the marker).

- [ ] **Step 3: Create `kernel/lazy-count.ts`**

```ts
/**
 * Lazy-mode `count()` support (#706): count ids whose envelope is LIVE at
 * tier 0 — parity with eager count (the hydrated cache excludes tombstones,
 * delete markers, and elevated records, #701). Envelope inspection only —
 * no record body is ever decrypted here.
 */
import type { NoydbStore } from './types.js'
import { isTombstone, isDeleteMarker } from './enclave/index.js'

export async function countLiveEnvelopes(
  adapter: NoydbStore, vault: string, name: string, storeCiphertext: boolean,
): Promise<number> {
  const ids = await adapter.list(vault, name)
  let n = 0
  for (const id of ids) {
    const env = await adapter.get(vault, name, id)
    if (env && !isTombstone(env, storeCiphertext) && !isDeleteMarker(env) && (env._tier ?? 0) === 0) n++
  }
  return n
}
```
(Verify the predicate import path/signature against collection.ts's own imports; match file-header style of siblings like `best-effort-revert.ts`.)

- [ ] **Step 4: Rewire collection.ts count() — NET-ZERO budget**

Replace the lazy branch's single line:
```ts
      return countLiveEnvelopes(this.adapter, this.vault, this.name, this.storeCiphertext)
```
(1-for-1 swap) and update the method's doc comment IN PLACE (same line count) — it currently claims lazy mode "avoids loading any record bodies" and is "still correct"; keep the no-bodies claim (true — envelope inspection only) and note tier/tombstone parity (#706). The new `import { countLiveEnvelopes } from './lazy-count.js'` line costs +1 → remove one line elsewhere via a mechanical join (or append the named import to an existing `./`-sibling import line if one matches the module path — it won't, so plan the shrink-join; document it in your report). `node scripts/check-architecture.mjs` must pass with values unedited.

- [ ] **Step 5: GREEN + regression** — the #706 tests + `__tests__/hierarchical-tiers.test.ts` + full-file `tier0-read-paths.test.ts`; typecheck + lint (new file included).

- [ ] **Step 6: Commit**

```bash
git add packages/hub/src/kernel/lazy-count.ts packages/hub/src/kernel/collection.ts packages/hub/__tests__/tier0-read-paths.test.ts
git commit -m "fix(hub): lazy count() counts only live tier-0 envelopes — eager parity (#706)"
```

---

### Final: full suite + whole-branch review + changeset + PR

- [ ] `pnpm --filter @noy-db/hub test` + typecheck + lint + `pnpm check:architecture` — green.
- [ ] Whole-branch review (fable — the leak class earned it twice already).
- [ ] Local changeset: `@noy-db/hub` patch — listPage/scan/aggregate skip elevated records (no page leak, no cold brick, no cache poisoning); lazy count() eager parity (#706).
- [ ] PR → main with `Closes #706`.
