# Arc 1 — Read-side Tier Gates (#707 + #712 read-gate + CRDT getRaw + #713)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the write-path prior-read leak (#707), the with-history read leak (#712 *read-gate* — the at-rest hardening is a separate later arc), the CRDT `getRaw` oracle, and make lazy `count()` O(pages) not O(records) (#713).

**Architecture:** The tier-invisibility law (spec `docs/superpowers/specs/2026-07-15-tier-unaware-reads-design.md`, extended by PRs #700/#710/#714): elevated (`_tier > 0`) records are invisible on tier-0 surfaces — explicit gates before any decrypt, never try/catch (a warm CEK cache otherwise leaks tier plaintext). **Key #712 mechanism:** history snapshots keep their tier-0-wrapped CEKs and carry no `_tier`, so `history()`/`getVersion()` cannot gate on the history envelope's tier — they gate on the **live** record's tier (a cheap envelope peek) plus a defensive per-entry `_tier` skip.

**Tech Stack:** TypeScript ESM, vitest. Branch `fix/707-712rg-write-history-gates` (created, on main 1fed09c8).

## Global Constraints

- NEVER add Claude/Anthropic attribution to commits/PRs/changelogs.
- NEVER reference the private pilot client by name — grep the diff before each commit.
- Ceilings exact zero slack (checker = `wc -l` + 1): collection.ts 4549, vault.ts 3959, noydb.ts 2396. **Line budget across this arc:** Task 1 removes `resolveGatePrior`'s 5-line try/catch → 2-line gate (frees ~3 lines); Task 2 adds ~+4 (import + history peek/skip + getVersion peek). Net ~+1 → fund with ONE mechanical shrink-join. Verify collection.ts `wc -l` == `git show 1fed09c8:packages/hub/src/kernel/collection.ts | wc -l` after EACH task. Never edit ceiling values; never touch vault.ts/noydb.ts.
- TDD: RED verified before implementing, every test. Run from `packages/hub/`: `pnpm vitest run <path>`.
- No new deps; no timing assertions.

---

### Task 1: #707 — gate write-path prior reads (elevated ≡ missing to hooks/gates)

**Files:**
- Modify: `packages/hub/src/kernel/collection.ts` (4 prior-read helpers; net ≤0 lines)
- Modify: `packages/hub/__tests__/tier0-read-paths.test.ts` (append describe; fixtures exist)

**Interfaces:**
- Consumes: existing `tieredClassifiedHarness` / `memoryStore`; `EncryptedEnvelope._tier`.
- Produces: nothing downstream (Tasks 2/3 independent).

Background — the four helpers each already have a "no prior" branch (missing/tombstone). An elevated existing record must take that same branch so no elevated plaintext reaches write hooks / gate handlers / the i18n audit accessor. Current sites (line numbers ±3):
- `resolveDensifyPrior` (~1616): lazy branch `if (!env) return undefined`.
- `#priorForHook` (~1668): lazy branch `if (!env) return { record: null, version: 0 }`.
- `resolvePriorValues` (~1692): `if (!env || isTombstone(env, this.storeCiphertext)) return undefined`.
- `resolveGatePrior` (~1704–1709): `if (!env) return …`; then a `try { decryptRecord } catch { record: null }` — the spec-forbidden shape.

- [ ] **Step 1: Write the failing tests**

Append to `packages/hub/__tests__/tier0-read-paths.test.ts`:

```ts
describe('#707 write-path prior reads: elevated ≡ missing to hooks/gates/audit', () => {
  it('a write hook fired for a put over an elevated id receives a null prior, never elevated plaintext', async () => {
    const store = memoryStore()
    const priors: unknown[] = []
    const db = await createNoydb({ store, user: 'owner', secret: 'pw-707', tiersStrategy: withTiers() })
    const vault = await db.openVault('v1')
    const docs = vault.collection<User>('docs', {
      tiers: [0, 1], perRecordKeys: true, prefetch: false, cache: { maxRecords: 100 },
      hooks: { beforePut: ({ prior }) => { priors.push(prior); return undefined } }, // adapt to the real hook shape
    })
    await docs.put('d1', { name: 'secret' })
    await docs.elevate('d1', 1)
    await docs.put('d1', { name: 'overwrite' })       // tier-0 write over an elevated id
    // Pre-#707 (warm cekCache): the hook's `prior` was the elevated plaintext { name: 'secret' }.
    expect(priors.every(p => p === null || (p as User)?.name !== 'secret')).toBe(true)
  })

  it('i18nProvenance over an elevated id returns undefined, not the prior marker', async () => {
    const store = memoryStore()
    const db = await createNoydb({ store, user: 'owner', secret: 'pw-707b', tiersStrategy: withTiers() })
    const vault = await db.openVault('v1')
    const docs = vault.collection<User>('docs', { tiers: [0, 1], perRecordKeys: true, prefetch: false, cache: { maxRecords: 100 } })
    await docs.put('d1', { name: 'x' })
    await docs.elevate('d1', 1)
    expect(await docs.i18nProvenance('d1')).toBeUndefined()
  })
})
```

Inspect the actual write-hook registration API (grep `beforePut`/`writeHooks`/`hooks:` in the kernel + existing tests, e.g. `__tests__/*hook*`, and the `HookContext`/`before` shape used by `#priorForHook`) and adapt the hook fixture to the real surface — the assertion (prior is never the elevated plaintext) is what matters. If no public hook seam exercises `#priorForHook` cleanly, drive it through whichever public write path fires `beforePut`/gate priors; if `resolveGatePrior` needs a gate subsystem (`subsystemBus.gateNeedsPrior`), reuse the pattern from an existing gate test (grep `resolveGatePrior`/`gateNeedsPrior` tests). Never weaken an assert; if a RED doesn't reproduce, STOP → BLOCKED with output.

- [ ] **Step 2: Run to verify RED**

`pnpm vitest run __tests__/tier0-read-paths.test.ts -t '#707'` → FAIL (hook prior is the elevated plaintext; i18nProvenance returns the marker). If the warm-leak path can't be hit through the chosen public API, note it and construct the minimal driver that does.

- [ ] **Step 3: Implement the gates (net ≤ 0 lines)**

(a) `resolveDensifyPrior` lazy branch: `if (!env || (env._tier ?? 0) > 0) return undefined` (net-zero).
(b) `#priorForHook` lazy branch: `if (!env || (env._tier ?? 0) > 0) return { record: null, version: 0 }` (net-zero — elevated ≡ fully missing; version 0 matches the missing case).
(c) `resolvePriorValues`: `if (!env || isTombstone(env, this.storeCiphertext) || (env._tier ?? 0) > 0) return undefined` (net-zero).
(d) `resolveGatePrior` — replace the `try/catch` (frees ~3 lines):
```ts
    if ((env._tier ?? 0) > 0) return { env, record: null, elided: false } // #707: elevated invisible to gate handlers — deterministic, not a swallowed InvalidKeyError
    return { env, record: await this.codec.decryptRecord(env, { skipValidation: true, id }), elided: false }
```
Removing the catch means a genuine (non-tier) decrypt failure now propagates instead of silently nulling — this is intended (the catch was the spec-forbidden shape masking the tier error). Flag it to the reviewer; if a regression test relied on the swallow for a NON-tier reason, STOP and report rather than re-adding the catch.

- [ ] **Step 4: GREEN + regression + ceiling**

`pnpm vitest run __tests__/tier0-read-paths.test.ts __tests__/hierarchical-tiers.test.ts __tests__/classified` → PASS (plus any hook/gate suites the grep surfaced). `node scripts/check-architecture.mjs` → PASS. Confirm collection.ts `wc -l` ≤ the base (Task 2 needs the freed lines). Also: does a plain `put()` over an elevated id silently write it back at tier 0 (demotion)? Note the observed behavior in your report — if it silently demotes, that's a **separate finding to file**, not part of this task.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/kernel/collection.ts packages/hub/__tests__/tier0-read-paths.test.ts
git commit -m "fix(hub): write-path prior reads treat elevated records as missing — no elevated plaintext to hooks/gates (#707)"
```

---

### Task 2: #712 read-gate — history/getVersion/revert + CRDT getRaw

**Files:**
- Create: `packages/hub/src/kernel/tier-visibility.ts`
- Modify: `packages/hub/src/kernel/collection.ts` (history, getVersion, getRaw; funded by Task 1's freed lines + ≤1 shrink-join)
- Modify: `packages/hub/__tests__/tier0-read-paths.test.ts` (append)

**Interfaces:**
- Consumes: `NoydbStore`, `EncryptedEnvelope._tier`.
- Produces: `export async function liveRecordIsElevated(adapter: NoydbStore, vault: string, name: string, id: string): Promise<boolean>` — peeks the live envelope, returns `(env?._tier ?? 0) > 0`. No decryption.

- [ ] **Step 1: Write the failing tests**

```ts
describe('#712 read-gate: elevated records leak no prior-version plaintext, warm or cold', () => {
  function historyHarness() {
    const store = memoryStore()
    const open = async () => {
      const db = await createNoydb({ store, user: 'owner', secret: 'pw-712', tiersStrategy: withTiers(), historyStrategy: withHistory() })
      const vault = await db.openVault('v1')
      const docs = vault.collection<User>('docs', { tiers: [0, 1], perRecordKeys: true })
      return { docs }
    }
    return { store, open }
  }

  it('history() and getVersion() are empty for an elevated record — warm AND cold', async () => {
    const h = historyHarness()
    const { docs } = await h.open()
    await docs.put('d1', { name: 'v1-secret' })
    await docs.put('d1', { name: 'v2-secret' })
    await docs.elevate('d1', 1)
    // Pre-#712: BOTH returned the prior-version plaintext (history envelopes keep tier-0 CEKs).
    expect(await docs.history('d1')).toEqual([])
    expect(await docs.getVersion('d1', 1)).toBeNull()
    await expect(docs.revert('d1', 1)).rejects.toThrow()      // inherits getVersion → not found
    const cold = await h.open()
    expect(await cold.docs.history('d1')).toEqual([])
    expect(await cold.docs.getVersion('d1', 1)).toBeNull()
  })

  it('history stays readable after demote back to tier 0', async () => {
    const h = historyHarness()
    const { docs } = await h.open()
    await docs.put('d2', { name: 'a' })
    await docs.put('d2', { name: 'b' })
    await docs.elevate('d2', 1)
    await docs.demote('d2', 0)
    expect((await docs.history('d2')).length).toBeGreaterThan(0) // demoted record IS tier-0
  })

  it('CRDT getRaw returns null for an elevated record instead of throwing', async () => {
    const store = memoryStore()
    const db = await createNoydb({ store, user: 'owner', secret: 'pw-712c', tiersStrategy: withTiers() })
    const vault = await db.openVault('v1')
    const docs = vault.collection<User>('cdocs', { tiers: [0, 1], crdt: 'lww-map' })
    await docs.put('c1', { name: 'x' })
    await docs.elevate('c1', 1)
    expect(await docs.getRaw('c1')).toBeNull()
  })
}) 
```
Check `withHistory`'s real import + option name (grep existing history tests, e.g. `__tests__/*histor*`); check the CRDT collection option shape (`crdt: 'lww-map'`) and whether tiers+crdt compose in a fixture — if not, adapt to whatever minimal config reaches `getRaw`, keeping the assert (elevated → null, no throw).

- [ ] **Step 2: RED** — `pnpm vitest run __tests__/tier0-read-paths.test.ts -t '#712'` → history/getVersion return the elevated plaintext (warm) / throw (cold); getRaw throws.

- [ ] **Step 3: Create `kernel/tier-visibility.ts`**

```ts
/**
 * Tier visibility helper (#712/#707): a tier-0 code path treats an elevated
 * (_tier > 0) record as invisible. History reads gate on the LIVE record's
 * tier — history snapshots keep their tier-0-wrapped CEKs and carry no _tier
 * of their own, so an elevated record's prior versions would otherwise stay
 * tier-0-decryptable (the read-gate closes the API surface; #712's at-rest
 * arc rewraps the snapshot keys). Envelope inspection only — no decryption.
 */
import type { NoydbStore } from './types.js'

export async function liveRecordIsElevated(
  adapter: NoydbStore, vault: string, name: string, id: string,
): Promise<boolean> {
  const env = await adapter.get(vault, name, id)
  return (env?._tier ?? 0) > 0
}
```
(Match the file-header style of `lazy-count.ts` / `best-effort-revert.ts`. `hub-portable` guard: no Node built-ins — clean.)

- [ ] **Step 4: Wire collection.ts (funded by Task 1)**

Import: `import { liveRecordIsElevated } from './tier-visibility.js'`.
- `history()` — after the `getHistoryEntries` fetch, guard the whole call and add a per-entry skip:
```ts
    if (await liveRecordIsElevated(this.adapter, this.vault, this.name, id)) return [] // #712: elevated ≡ invisible
    ...
    for (const env of envelopes) {
      if ((env._tier ?? 0) > 0) continue // #712: defensive — a per-version tiered snapshot
```
- `getVersion()` — `if (!envelope || (envelope._tier ?? 0) > 0) return null` (net-zero fold) then `if (await liveRecordIsElevated(this.adapter, this.vault, this.name, id)) return null` (+1).
- `getRaw()` (CRDT) — `if (!envelope || (envelope._tier ?? 0) > 0) return null` (net-zero fold).
- `revert()` — unchanged (inherits `getVersion` → throws not-found).

Confirm collection.ts `wc -l` == base; if +1 over, apply one mechanical shrink-join and document it.

- [ ] **Step 5: GREEN + regression + ceiling** — the #712 tests + `__tests__/hierarchical-tiers.test.ts` + any history suite; `node scripts/check-architecture.mjs`; typecheck + lint (new file). Line count == base.

- [ ] **Step 6: Commit**

```bash
git add packages/hub/src/kernel/tier-visibility.ts packages/hub/src/kernel/collection.ts packages/hub/__tests__/tier0-read-paths.test.ts
git commit -m "fix(hub): history/getVersion/getRaw treat elevated records as missing — no prior-version plaintext leak (#712 read-gate)"
```

---

### Task 3: #713 — lazy count() batches via adapter.listPage

**Files:**
- Modify: `packages/hub/src/kernel/lazy-count.ts`
- Modify: `packages/hub/__tests__/tier0-read-paths.test.ts` (extend the lazy-count block, or a to-memory-native fixture)

**Interfaces:**
- Consumes: `NoydbStore.listPage?` (optional method — `ListPageResult` in `src/kernel/types.ts`), the existing live-tier-0 predicate.
- Produces: same `countLiveEnvelopes` signature/behavior, fewer round-trips.

- [ ] **Step 1: Write/extend the failing test** — assert `countLiveEnvelopes` (via lazy `count()`) is correct on a **native-listPage** store (use the `withListPage` fixture from the #706 tests) with a mix of live tier-0, elevated, and delete-marker ids; the current N+1 `list()+get()` path is correct but the test pins behavior parity when the batched path is used. (This task is a perf refactor: the RED is optional — its real gate is "same counts, fewer round-trips." Add a round-trip counter to the fixture — increment on each `get`/`listPage` — and assert the native path makes ≤ ⌈N/pageSize⌉+1 calls, while the fallback still works.)

- [ ] **Step 2: Implement** — when `adapter.listPage` exists, page through `{ id, envelope }` items applying the same `!isTombstone && !isDeleteMarker && (env._tier ?? 0) === 0` predicate; else keep the `list()+get()` loop. No behavior change to the count.

- [ ] **Step 3: GREEN + regression** — the #706 lazy-count tests + the new native-batched test + full `tier0-read-paths.test.ts`; typecheck + lint; `check:architecture` (hub-portable on lazy-count.ts).

- [ ] **Step 4: Commit**

```bash
git add packages/hub/src/kernel/lazy-count.ts packages/hub/__tests__/tier0-read-paths.test.ts
git commit -m "perf(hub): lazy count() batches via adapter.listPage when available — O(pages) not O(records) (#713)"
```

---

### Final: full suite + whole-branch review + changeset + PR

- [ ] `pnpm --filter @noy-db/hub test` + typecheck + lint + `pnpm check:architecture` — green.
- [ ] Whole-branch review (fable — gate correctness, `resolveGatePrior` catch-removal error semantics, no elevated-vs-missing distinguisher, the live-peek mechanism).
- [ ] Local changeset: `@noy-db/hub` patch — write-path prior reads, history/getVersion/getRaw, treat elevated records as missing; lazy count() batches via listPage (#707, #712 read-gate, #713).
- [ ] PR → main. `Closes #707`, `Closes #713`. **#712 stays open** (at-rest hardening is a follow-up arc) — reference it as "read-gate only."
