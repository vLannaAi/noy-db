# Arc 5 — Write Ring Refusal Implementation Plan (#715 + #716)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refuse tier-0 `put()`/`delete()` targeting an elevated (`_tier > 0`) record with one uniform error, making all seven ungated write-path sites unreachable and closing #716's read-gate bypass.

**Architecture:** Spec — `docs/superpowers/specs/2026-07-16-write-ring-refusal-design.md` (user-approved 2026-07-16). Two choke points (`_putInternal`, `_doDelete`), guarded by `this.tiers !== null` so non-tiered collections pay nothing. Reuses `liveRecordIsElevated` from `kernel/tier-visibility.ts` (#717).

**Tech Stack:** TypeScript ESM, vitest. Branch `fix/715-716-write-ring-refusal` off main 6dd823e3.

## Global Constraints

- NEVER add Claude/Anthropic attribution to commits/PRs/changelogs.
- NEVER reference the private pilot client by name — grep the diff before each commit.
- Ceilings exact zero slack (checker = `wc -l` + 1): `collection.ts` **4548**, `vault.ts` 3959, `noydb.ts` 2396. This arc adds ~+3 to collection.ts → fund with mechanical semantics-preserving shrink-joins, each documented. Never edit ceiling values; never touch vault.ts/noydb.ts. `errors.ts` and `tier-visibility.ts` have no ceiling.
- TDD: RED verified before implementing, every test. Run from `packages/hub/`: `pnpm vitest run <path>`.
- No new deps; no timing assertions.
- The sanctioned tier paths (`putAtTier`/`elevate`/`demote`/`getAtTier`/`listAtTier`) must be UNAFFECTED — the existing tiers suites must pass untouched.

---

### Task 1: the refusal error + assertion helper

**Files:**
- Modify: `packages/hub/src/kernel/errors.ts` (new error class)
- Modify: `packages/hub/src/kernel/tier-visibility.ts` (new assertion beside `liveRecordIsElevated`)
- Modify: `packages/hub/src/index.ts` (export the error, if sibling tier errors are exported there — check)

**Interfaces:**
- Produces: `TierWriteRefusedError` (name it consistently with siblings — read `TierNotGrantedError` at errors.ts:703 and `TierAccessDeniedError` and match their shape: code constant, `readonly tier`, `readonly collection`, `this.name`).
- Produces: `export async function assertTierWritable(adapter: NoydbStore, vault: string, name: string, id: string, tiersEnabled: boolean): Promise<void>` in tier-visibility.ts — no-op when `!tiersEnabled`; otherwise peek the live envelope and throw `TierWriteRefusedError(name, tier)` when `(env._tier ?? 0) > 0`. Envelope inspection only, no decryption. Reuse/extend `liveRecordIsElevated` rather than duplicating the peek (a second `adapter.get` per write would be wasteful — consider a shared internal that returns the tier).

- [ ] **Step 1: Write the failing test**

Create `packages/hub/__tests__/tier-write-ring.test.ts`. Copy the `memoryStore()` fixture verbatim from `__tests__/hierarchical-tiers.test.ts`. Start with the unit-level error contract:

```ts
/**
 * #715/#716 — the write ring. A tier-0 put()/delete() targeting an elevated
 * record is refused uniformly (spec: docs/superpowers/specs/2026-07-16-write-ring-refusal-design.md).
 * Holders are refused too: put()/delete() are the tier-0 APIs; putAtTier/
 * elevate/demote are the sanctioned tier-aware paths.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, TierWriteRefusedError } from '../src/index.js'
import { withTiers } from '../src/with-audit/tiers/index.js'
// … memoryStore() copied from hierarchical-tiers.test.ts …

describe('#715 TierWriteRefusedError', () => {
  it('names the collection, the tier, and the remedy', () => {
    const e = new TierWriteRefusedError('docs', 2)
    expect(e).toBeInstanceOf(Error)
    expect(e.name).toBe('TierWriteRefusedError')
    expect(e.collection).toBe('docs')
    expect(e.tier).toBe(2)
    expect(e.message).toMatch(/putAtTier/)   // actionable remedy named
  })
})
```

- [ ] **Step 2: RED** — `pnpm vitest run __tests__/tier-write-ring.test.ts` → FAIL (no such export).

- [ ] **Step 3: Implement** the error class in errors.ts (match sibling shape/JSDoc style; document WHY it is distinct from `TierNotGrantedError` — that one means "no DEK for tier N", whereas this refuses holders too) and `assertTierWritable` in tier-visibility.ts. Export the error wherever `TierNotGrantedError` is exported (grep `TierNotGrantedError` in `src/index.ts` / the public barrel + check `packages/hub/noy-surface.json` if a surface-golden test exists — if the public surface is golden-tested, update it per that test's convention).

- [ ] **Step 4: GREEN + regression** — the new file; `node scripts/check-architecture.mjs`; typecheck + lint. collection.ts untouched this task.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/kernel/errors.ts packages/hub/src/kernel/tier-visibility.ts packages/hub/src/index.ts packages/hub/__tests__/tier-write-ring.test.ts
git commit -m "feat(hub): TierWriteRefusedError + assertTierWritable — the write-ring refusal primitive (#715)"
```

---

### Task 2: wire the refusal into both choke points

**Files:**
- Modify: `packages/hub/src/kernel/collection.ts` (`_putInternal`, `_doDelete`; ~+3 lines → shrink-joins required)
- Modify: `packages/hub/__tests__/tier-write-ring.test.ts` (append)

**Interfaces:**
- Consumes: `assertTierWritable`, `TierWriteRefusedError` (Task 1), `this.tiers` (collection.ts:502), `this.adapter`/`this.vault`/`this.name`.

- [ ] **Step 1: Write the failing tests**

Append. Cover BOTH modes × BOTH ops, the holder case, the non-tiered no-cost case, and #716's bypass:

```ts
describe('#715/#716 write ring: tier-0 put/delete over an elevated record are refused', () => {
  async function open(opts: { lazy?: boolean; crdt?: boolean } = {}) {
    const store = memoryStore()
    const db = await createNoydb({ store, secret: 'pw-715', user: 'owner', tiersStrategy: withTiers() })
    const vault = await db.openVault('v1')
    const docs = vault.collection<Doc>('docs', {
      tiers: [0, 1], perRecordKeys: true,
      ...(opts.lazy ? { prefetch: false, cache: { maxRecords: 100 } } : {}),
      ...(opts.crdt ? { crdt: 'lww-map' as const } : {}),
    })
    return { store, docs }
  }

  for (const mode of ['eager', 'lazy'] as const) {
    it(`${mode}: put() over an elevated id is refused (no demotion, no history snapshot)`, async () => {
      const { store, docs } = await open({ lazy: mode === 'lazy' })
      await docs.put('d1', { id: 'd1', title: 'secret', body: 'x' })
      await docs.elevate('d1', 1)
      // Pre-fix: eager/lazy SILENTLY DEMOTED (_tier 1 → undefined); lazy also
      // wrote a history snapshot of the elevated plaintext.
      await expect(docs.put('d1', { id: 'd1', title: 'clobber', body: 'y' })).rejects.toBeInstanceOf(TierWriteRefusedError)
      expect((await store.get('v1', 'docs', 'd1'))!._tier).toBe(1)   // tier intact — the core #715 pin
    })

    it(`${mode}: delete() over an elevated id is refused — no marker, history stays hidden (#716)`, async () => {
      const { store, docs } = await open({ lazy: mode === 'lazy' })
      await docs.put('d1', { id: 'd1', title: 'secret', body: 'x' })
      await docs.elevate('d1', 1)
      await expect(docs.delete('d1')).rejects.toBeInstanceOf(TierWriteRefusedError)
      expect((await store.get('v1', 'docs', 'd1'))!._tier).toBe(1)   // no marker overwrote it
    })
  }

  it('CRDT: put() over an elevated id is refused with the SAME error (was TamperedError/InvalidKeyError)', async () => {
    const { docs } = await open({ crdt: true })
    await docs.put('c1', { id: 'c1', title: 'secret', body: 'x' })
    await docs.elevate('c1', 1)
    await expect(docs.put('c1', { id: 'c1', title: 'clobber', body: 'y' })).rejects.toBeInstanceOf(TierWriteRefusedError)
  })

  it('the elevating owner (who HOLDS the tier DEK) is refused too — put() is the tier-0 API', async () => {
    const { docs } = await open()
    await docs.put('d1', { id: 'd1', title: 'secret', body: 'x' })
    await docs.elevate('d1', 1)   // this session holds docs#1
    await expect(docs.put('d1', { id: 'd1', title: 'x2', body: 'y' })).rejects.toBeInstanceOf(TierWriteRefusedError)
    await docs.putAtTier('d1', { id: 'd1', title: 'sanctioned', body: 'y' }, 1)  // sanctioned path still works
    expect(((await docs.getAtTier('d1')) as Doc | null)?.title).toBe('sanctioned')
  })

  it('tier-0 records and non-tiered collections are unaffected (no extra cost, no refusal)', async () => {
    const { docs } = await open()
    await docs.put('d0', { id: 'd0', title: 'plain', body: 'x' })
    await docs.put('d0', { id: 'd0', title: 'updated', body: 'y' })   // tier-0 overwrite fine
    expect((await docs.get('d0'))?.title).toBe('updated')
    await docs.delete('d0')
    expect(await docs.get('d0')).toBeNull()
  })

  it('#716: after the refusal, an elevated record’s history stays hidden (delete cannot erase the signal)', async () => {
    // Needs withHistory — check the real import/option name (grep __tests__/*histor*).
    // put v1, put v2, elevate, attempt delete (refused), assert history() === [].
  })
})
```

Write the last test fully (the `withHistory` fixture pattern is in `__tests__/tier0-read-paths.test.ts`'s `#712` block — reuse it). Adapt mechanics to real APIs; never weaken an assert. If a RED doesn't reproduce as documented, STOP → BLOCKED with output.

- [ ] **Step 2: RED** — `pnpm vitest run __tests__/tier-write-ring.test.ts` → the refusal tests fail: eager/lazy put resolves and demotes (`_tier` undefined); CRDT put rejects with `TamperedError`/`InvalidKeyError` (wrong type); delete succeeds and writes a marker; #716's history re-decrypts.

- [ ] **Step 3: Implement — two call sites, net-zero via shrink-joins**

In `_putInternal` (`:1727`) and `_doDelete` (`:2667`), immediately AFTER the `hasWritePermission`/`ReadOnlyError` check and BEFORE the gate-bus dispatch and any prior read:
```ts
    // #715/#716: put()/delete() are the tier-0 APIs — an elevated record is
    // writable only through putAtTier/elevate/demote. Refusing here (before the
    // gate bus and every prior read) is what makes the write path's ungated
    // decodes unreachable, and what stops a delete marker from erasing `_tier`.
    if (this.tiers !== null) await assertTierWritable(this.adapter, this.vault, this.name, id, true)
```
(Or pass `this.tiers !== null` as the flag and drop the outer `if` — pick the shape that costs the fewest lines; the helper already no-ops when disabled.) Add the import. For `_doDelete`, gate on the PUBLIC path only: `if (!internal && this.tiers !== null) …` — see Step 5's investigation.

collection.ts must end at **exactly 4548** (`git show 6dd823e3:packages/hub/src/kernel/collection.ts | wc -l`). Fund the additions with mechanical, semantics-preserving shrink-joins (single-use const inlined into its sole next-line use is the pattern used twice already in this campaign — see git log for `count()` and the tx-revert loop). Document each join in your report.

- [ ] **Step 4: GREEN + regression**

`pnpm vitest run __tests__/tier-write-ring.test.ts __tests__/hierarchical-tiers.test.ts __tests__/tier0-read-paths.test.ts __tests__/per-record-cek.test.ts` → PASS. Then the FULL hub suite (`pnpm --filter @noy-db/hub test` from root) — this arc changes public write behavior, so **expect pre-existing tests to break**: any test that put()s or delete()s over an elevated record now throws. For each such failure, decide carefully: is it pinning the OLD (buggy) demote/throw behavior, or a legitimate scenario the refusal breaks? Report every changed test with the reasoning — a test that pinned the demotion is faithful to update; a test that reveals the refusal breaks a real workflow is a BLOCKED-worthy finding, not a test to edit. `node scripts/check-architecture.mjs`; typecheck; lint.

- [ ] **Step 5: Investigate + report (do NOT fix)**

- `_doDelete(id, internal: true)` — can an internal delete (derivation/MV cleanup) reach an elevated record? If yes, it can still write a marker and erase `_tier`. Report evidence.
- `forget()` / `_writeTombstone` (`:2863`) — does it route around `_doDelete`? Reviewer says it's safe (destroys the CEK). Report whether it should refuse for integrity symmetry.

- [ ] **Step 6: Commit**

```bash
git add packages/hub/src/kernel/collection.ts packages/hub/__tests__/tier-write-ring.test.ts
git commit -m "fix(hub): tier-0 put()/delete() refuse elevated records — no silent demotion, no signal-erasing marker (#715, #716)"
```

---

### Final: full suite + whole-branch review + changeset + PR

- [ ] `pnpm --filter @noy-db/hub test` + typecheck + lint + `pnpm check:architecture` — green.
- [ ] Whole-branch review (fable — this changes public write semantics and is the premise the whole read campaign rests on; ask it to hunt for any surviving path that can demote or marker-erase `_tier`, and to sanity-check the accepted write-side oracle).
- [ ] Local changeset: `@noy-db/hub` **minor** (new public error + intended behavior change) — state plainly that `put()`/`delete()` now throw on elevated records and name `putAtTier`/`elevate`/`demote` as the remedy.
- [ ] PR → main: `Closes #715`, `Closes #716`.
