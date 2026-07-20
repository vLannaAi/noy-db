# #691 Tier-Unaware Read Paths — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Elevated (`_tier > 0`) records become invisible on every tier-0 enclave read path (verify doors, det scans, findByDigest), and `elevate`/`demote` evict the record cache + refuse tombstones — closing #691.

**Architecture:** Explicit `(env._tier ?? 0) > 0` gates placed BEFORE any key resolution (never try/catch — the elevating session's warm `cekCache` would otherwise leak past the tier audit). Elevated ≡ missing: identical pad path in verify (C4 preserved), skip-and-continue in scans. Spec: `docs/superpowers/specs/2026-07-15-tier-unaware-reads-design.md`.

**Tech Stack:** TypeScript ESM, vitest, `crypto.subtle` only. Branch `fix/691-tier-unaware-reads`.

## Global Constraints

- NEVER add Claude/Anthropic attribution to commits, PRs, or changelogs.
- NEVER reference the private pilot client by name — grep your diff before each commit.
- Ceilings (exact zero slack; checker metric = `split('\n').length` = `wc -l` + 1): `collection.ts` 4549, `vault.ts` 3959, `noydb.ts` 2396. Task 3 adds ONE line to collection.ts → must remove one line elsewhere in the same file first (shrink-first). Do NOT edit the ceiling values in `scripts/check-architecture.mjs`. vault.ts/noydb.ts untouched.
- TDD: write the failing test, run it RED, implement, run GREEN, commit. Classified verify tests are PBKDF2-heavy — give those `it`s a `60_000` timeout (existing convention) and keep assertion-dense tests over many small ones.
- Run single files from `packages/hub/`: `pnpm vitest run <path>`.
- No new npm deps. No timing assertions (pad discipline is enforced by construction — identical branch as missing).

---

### Task 1: verify.ts tier gates (digest / text / group doors + findByDigest)

**Files:**
- Modify: `packages/hub/src/kernel/enclave/classify/verify.ts`
- Create: `packages/hub/__tests__/tier0-read-paths.test.ts`

**Interfaces:**
- Consumes: `EncryptedEnvelope._tier?: number` (kernel/types.ts), existing `padFalse()`.
- Produces: `__tests__/tier0-read-paths.test.ts` with an exported-by-convention fixture pattern Task 2 will extend (Task 2 appends to the same file).

- [ ] **Step 1: Write the failing tests**

Create `packages/hub/__tests__/tier0-read-paths.test.ts`. Copy the `memoryStore()` fixture **verbatim** from `__tests__/hierarchical-tiers.test.ts` (its top ~56 lines: imports + the in-memory `NoydbStore`). Then:

```ts
/**
 * #691 — tier-0 enclave read paths vs elevated records. An elevated
 * (_tier > 0) record is INVISIBLE through every tier-0 door: verify /
 * verifyGroup pad-false exactly like a missing record, findByDigest drops
 * the hit, det scans skip it — in BOTH the elevating (warm cekCache)
 * session and a cold reopened session. Pre-#691 these paths resolved the
 * record CEK under the collection tier-0 DEK unconditionally: cold
 * sessions threw (InvalidKeyError/TamperedError, an elevation oracle that
 * also aborted det scans), and the warm session leaked tier-1 plaintext
 * through findByDet with no CrossTierAccessEvent.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/index.js'
import { withTiers } from '../src/with-audit/tiers/index.js'
import { withClassified } from '../src/via/classified/active.js'
import { classified } from '../src/via/classified/presets.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/index.js'

// … memoryStore() copied from hierarchical-tiers.test.ts …

interface User extends Record<string, unknown> { name?: string; password?: string; email?: string; a1?: string; a2?: string }

/** One store, reopenable: open() twice = cold second session over the same ciphertext. */
function tieredClassifiedHarness() {
  const store = memoryStore()
  const open = async () => {
    const db = await createNoydb({
      store, user: 'owner', secret: 'pw-691-tier-gate',
      tiersStrategy: withTiers(), classifiedStrategy: withClassified(),
    })
    const vault = await db.openVault('v1')
    const users = vault.collection<User>('users', {
      perRecordKeys: true,
      tiers: [0, 1],
      classifiedFields: {
        password: classified.password(),
        email: classified.email(),           // recoverable → _sealed → text door
        a1: classified.secretAnswer(),
        a2: classified.secretAnswer(),
      },
    })
    return { vault, users }
  }
  return { store, open }
}

describe('#691 verify doors: elevated ≡ missing', () => {
  it('verify (digest + text doors) pads false on an elevated record, warm and cold', async () => {
    const h = tieredClassifiedHarness()
    const { users } = await h.open()
    await users.put('u1', { name: 'n', password: 'correct-horse-battery', email: 'u1@example.com', a1: 'Rex', a2: 'Bangkok' })
    expect(await users.verify('u1', 'password', 'correct-horse-battery')).toMatchObject({ ok: true })
    expect(await users.verify('u1', 'email', 'u1@example.com')).toMatchObject({ ok: true })

    await users.elevate('u1', 1)

    // Warm (elevating) session: verdict-only — MUST NOT throw, MUST NOT verify.
    expect(await users.verify('u1', 'password', 'correct-horse-battery')).toEqual({ ok: false }) // digest door
    expect(await users.verify('u1', 'email', 'u1@example.com')).toEqual({ ok: false })           // text door
    // Same shape as a genuinely missing id — no elevation oracle.
    expect(await users.verify('no-such-id', 'password', 'correct-horse-battery')).toEqual({ ok: false })

    // Cold session (fresh cekCache) — identical verdicts, still no throw.
    const cold = await h.open()
    expect(await cold.users.verify('u1', 'password', 'correct-horse-battery')).toEqual({ ok: false })
    expect(await cold.users.verify('u1', 'email', 'u1@example.com')).toEqual({ ok: false })
  }, 60_000)

  it('verifyGroup pads all members false on an elevated record', async () => {
    const h = tieredClassifiedHarness()
    const { users } = await h.open()
    await users.put('u1', { name: 'n', password: 'pw-grp-secret-1', email: 'g@example.com', a1: 'Rex', a2: 'Bangkok' })
    expect(await users.verifyGroup('u1', { a1: 'Rex', a2: 'Bangkok' }, { min: 2 })).toEqual({ passed: true })
    await users.elevate('u1', 1)
    expect(await users.verifyGroup('u1', { a1: 'Rex', a2: 'Bangkok' }, { min: 2 })).toEqual({ passed: false })
    const cold = await h.open()
    expect(await cold.users.verifyGroup('u1', { a1: 'Rex', a2: 'Bangkok' }, { min: 2 })).toEqual({ passed: false })
  }, 60_000)

  it('findByDigest drops the elevated hit and keeps scanning tier-0 hits', async () => {
    const h = tieredClassifiedHarness()
    const { users } = await h.open()
    await users.put('u0', { name: 'a', password: 'pw-zero-stays-00', email: 'z@example.com', a1: 'x', a2: 'y' })
    await users.put('u1', { name: 'b', password: 'pw-one-moves-111', email: 'o@example.com', a1: 'x', a2: 'y' })
    await users.elevate('u1', 1)

    expect(await users.findByDigest('password', 'pw-one-moves-111')).toEqual([])        // elevated hit dropped, no throw
    expect(await users.findByDigest('password', 'pw-zero-stays-00')).toEqual(['u0'])    // scan NOT aborted

    const cold = await h.open()
    expect(await cold.users.findByDigest('password', 'pw-one-moves-111')).toEqual([])
    expect(await cold.users.findByDigest('password', 'pw-zero-stays-00')).toEqual(['u0'])
  }, 60_000)
})
```

If a group-preset declaration is required for `verifyGroup` (the flat `secretAnswer()` pair may need the `_noydbClassifiedGroup` wrapper — see `__tests__/classified/digest-presets.test.ts:45`), adapt the fixture to the group declaration used by the existing `verifyGroup` happy-path test (`__tests__/classified/verify-public-surface.test.ts`) — behavior asserted stays identical.

- [ ] **Step 2: Run to verify RED**

Run: `pnpm vitest run __tests__/tier0-read-paths.test.ts` (from `packages/hub/`)
Expected: FAIL — post-elevate `verify`/`verifyGroup`/`findByDigest` calls reject (`InvalidKeyError`/`TamperedError`) instead of returning padded verdicts. If any leg unexpectedly passes pre-fix, STOP and report (the bug premise needs re-checking), do not adjust the assert to pass.

- [ ] **Step 3: Implement the gates in verify.ts**

Three edits + one header note in `packages/hub/src/kernel/enclave/classify/verify.ts`:

(a) `verifyDigestField` — replace line 63 (`if (env === null) return padFalse()`):
```ts
  // #691: an elevated envelope (_tier > 0) is non-comparable through every
  // tier-0 door — its key material is tier-DEK-wrapped and must never be
  // resolved here (the elevating session's warm cekCache would otherwise
  // leak past the tier audit). Exactly the missing-record pad path, checked
  // BEFORE the R6 residue probe so tier-0 callers learn nothing.
  if (env === null || (env._tier ?? 0) > 0) return padFalse()
```

(b) `verifyTextField` — extend the unseal precondition (line 109):
```ts
  if (env !== null && (env._tier ?? 0) === 0 && blob !== undefined) { // #691: elevated ≡ missing
```
(`stored` stays `undefined`; the unconditional pad + forced-false tail is untouched — single-code-path C4 preserved.)

(c) `matchGroupFields` — replace `const env = await ctx.getEnvelope(id)` (line 151):
```ts
  const fetched = await ctx.getEnvelope(id)
  // #691: elevated ≡ missing — nulling the view here also skips the R6
  // residue probe (a tier-0 caller must not learn an elevated record's
  // storage form) and forces the cek-undefined pad path for every member.
  const env = fetched === null || (fetched._tier ?? 0) > 0 ? null : fetched
```

(d) Module header — after the sentence ending "…(no inverted exists-vs-absent oracle)." (line 9), add:
```ts
 * Elevated records (_tier > 0, with-audit tier moves) are non-comparable
 * through every door and pad-false exactly like missing records (#691) —
 * the tier-aware read surface is getAtTier, never verify.
```

No change to `findByDigest` in collection.ts — its confirm loop calls `verifyDigestField` (collection.ts ~1211) and inherits gate (a); the `_bidx` scan hit is then silently dropped as `{ok:false}`.

- [ ] **Step 4: Run GREEN + regression**

Run: `pnpm vitest run __tests__/tier0-read-paths.test.ts` → PASS.
Run: `pnpm vitest run __tests__/classified __tests__/hierarchical-tiers.test.ts __tests__/deterministic.test.ts` → PASS (behavior lock).

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/kernel/enclave/classify/verify.ts packages/hub/__tests__/tier0-read-paths.test.ts
git commit -m "fix(hub): verify doors treat elevated records as missing — padded false, never a key-resolution throw (#691)"
```

---

### Task 2: deterministic.ts skip gates (findByDet / queryByDet)

**Files:**
- Modify: `packages/hub/src/kernel/enclave/record-keys/deterministic.ts`
- Modify: `packages/hub/__tests__/tier0-read-paths.test.ts` (append a describe block; reuse `memoryStore`)

**Interfaces:**
- Consumes: Task 1's test file + `memoryStore()` fixture.
- Produces: nothing downstream.

- [ ] **Step 1: Write the failing tests**

Append to `__tests__/tier0-read-paths.test.ts` (det collection needs tiers but NOT classified):

```ts
describe('#691 det scans: elevated records are skipped', () => {
  function tieredDetHarness() {
    const store = memoryStore()
    const open = async () => {
      const db = await createNoydb({ store, user: 'owner', secret: 'pw-691-det', tiersStrategy: withTiers() })
      const vault = await db.openVault('v1')
      const accounts = vault.collection<User>('accounts', {
        tiers: [0, 1],
        deterministicFields: ['email'],
      })
      return { vault, accounts }
    }
    return { store, open }
  }

  it('warm (elevating) session: findByDet must NOT leak the elevated record via the cekCache', async () => {
    const h = tieredDetHarness()
    const { accounts } = await h.open()
    await accounts.put('e1', { name: 'leaky', email: 'x@y.z' })
    await accounts.elevate('e1', 1) // caches the CEK — pre-#691 findByDet then SUCCEEDS here, audit-free
    expect(await accounts.findByDet('email', 'x@y.z')).toBeNull()
  })

  it('cold session: det scans skip the elevated match instead of throwing, and keep tier-0 matches', async () => {
    const h = tieredDetHarness()
    const { accounts } = await h.open()
    await accounts.put('a0', { name: 'a', email: 'shared@y.z' })
    await accounts.put('b0', { name: 'b', email: 'shared@y.z' })
    await accounts.put('e1', { name: 'c', email: 'shared@y.z' })
    await accounts.elevate('e1', 1)

    const cold = await h.open()
    // Pre-#691: the scan throws on e1's tier-wrapped key material, ABORTING
    // the whole query and losing a0/b0.
    const hits = await cold.accounts.queryByDet('email', 'shared@y.z')
    expect(hits.map(r => r.name).sort()).toEqual(['a', 'b'])
    // findByDet on a value only the elevated record carries → null, no throw.
    await cold.accounts.put('solo', { name: 's', email: 'solo@y.z' })
    await cold.accounts.elevate('solo', 1)
    expect(await cold.accounts.findByDet('email', 'solo@y.z')).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify RED**

Run: `pnpm vitest run __tests__/tier0-read-paths.test.ts -t 'det scans'`
Expected: FAIL — warm test returns the record (the leak); cold test rejects with a decrypt error.

- [ ] **Step 3: Implement the skip gates**

In `packages/hub/src/kernel/enclave/record-keys/deterministic.ts`, both scan loops (lines 92 and 112), replace:
```ts
    if (!env || !env._det) continue
```
with:
```ts
    // #691: an elevated record's _det slot is tier-independent (#662 carries
    // it), so it MATCHES — but its key material is tier-wrapped. Skip it
    // explicitly: invisible to tier-0 det scans regardless of cekCache state
    // (a catch-based fix would still leak plaintext, audit-free, in the
    // session that performed the elevate).
    if (!env || !env._det || (env._tier ?? 0) > 0) continue
```
(Full comment on the `findByDet` occurrence; on the `queryByDet` occurrence use the one-liner `// #691: skip elevated — see findByDet above`.)

Also append one sentence to the module doc header (after "…which is the whole point of a deterministic index."):
```ts
 * Elevated records (_tier > 0) are skipped: invisible to tier-0 scans (#691).
```

- [ ] **Step 4: Run GREEN + regression**

Run: `pnpm vitest run __tests__/tier0-read-paths.test.ts __tests__/deterministic.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/kernel/enclave/record-keys/deterministic.ts packages/hub/__tests__/tier0-read-paths.test.ts
git commit -m "fix(hub): det scans skip elevated records — no scan abort, no warm-cache audit bypass (#691)"
```

---

### Task 3: tier moves evict the record cache + refuse tombstones

**Files:**
- Modify: `packages/hub/src/with-audit/tiers/index.ts`
- Modify: `packages/hub/src/kernel/collection.ts` (ONE net-zero line change — see ceiling constraint)
- Modify: `packages/hub/__tests__/hierarchical-tiers.test.ts` (append a describe block)

**Interfaces:**
- Consumes: `TiersContext<T>` (tiers/index.ts:41), `tiersContext()` builder in collection.ts (~4508–4522), `isDeleteMarker`/`isTombstoneShape` from `../../kernel/enclave/index.js` (already the import source for `rewrapBodyToDek`), `buildDeleteMarker` (test only, exported from `src/index.js`? if not, import from `../src/kernel/enclave/index.js`).
- Produces: `TiersContext.evictCache(id: string): void`.

- [ ] **Step 1: Write the failing tests**

Append to `__tests__/hierarchical-tiers.test.ts`:

```ts
describe('#691 fold-ins: tier moves × record cache × tombstones', () => {
  it('elevate evicts the eager record cache — plain get() no longer serves pre-move plaintext', async () => {
    const { vault } = await freshVault()
    const docs = vault.collection<Doc>('docs', { tiers: [0, 1] })
    await docs.put('d1', { id: 'd1', title: 'Loose', body: 'lips' })
    expect((await docs.get('d1'))?.title).toBe('Loose') // cache warm
    await docs.elevate('d1', 1)
    // Pre-#691: the eager cache still holds the decoded record, so the plain
    // tier-0 get() serves an elevated record's plaintext with ZERO key
    // resolution. Post-fix: evicted → eager get() is cache-authoritative → null.
    expect(await docs.get('d1')).toBeNull()
    // The sanctioned surface still reads it fine in the elevating session.
    expect(((await docs.getAtTier('d1')) as Doc | null)?.title).toBe('Loose')
  })

  it('demote also evicts', async () => {
    const { vault } = await freshVault()
    const docs = vault.collection<Doc>('docs', { tiers: [0, 1] })
    await docs.put('d2', { id: 'd2', title: 'Down', body: 'again' })
    await docs.elevate('d2', 1)
    await docs.demote('d2', 0)
    // After demote-to-0 the record is tier-0 again; the pre-elevate cache
    // entry must not have survived the two raw envelope rewrites in between.
    // (Eviction on both moves; a fresh getAtTier round-trips the content.)
    expect(((await docs.getAtTier('d2')) as Doc | null)?.title).toBe('Down')
  })

  it('elevate/demote on a delete-marker throw not-found, not TamperedError', async () => {
    const store = memoryStore()
    const db = await createNoydb({ store, secret: 'pw', user: 'owner', tiersStrategy: withTiers() })
    const vault = await db.openVault('v1')
    const docs = vault.collection<Doc>('docs', { tiers: [0, 1] })
    await docs.put('gone', { id: 'gone', title: 'x', body: 'y' })
    const live = (await store.get('v1', 'docs', 'gone'))!
    await store.put('v1', 'docs', 'gone', buildDeleteMarker(live._v, 'owner'))
    await expect(docs.elevate('gone', 1)).rejects.toThrow(/not found/)
    await expect(docs.demote('gone', 0)).rejects.toThrow(/not found/)
  })
})
```

Check `buildDeleteMarker`'s actual signature in `src/kernel/enclave/record-keys/tombstone.ts` before using it (arity/args may differ — adapt the call, keep the scenario). If `freshVault()` doesn't expose the raw store, use the inline `memoryStore()` pattern as in the third test for all three.

- [ ] **Step 2: Run to verify RED**

Run: `pnpm vitest run __tests__/hierarchical-tiers.test.ts -t '691 fold-ins'`
Expected: FAIL — test 1: `get('d1')` returns the pre-move record; test 3: rejects with `TamperedError`/`OperationError`, not `/not found/`.

- [ ] **Step 3: Implement in tiers/index.ts**

(a) `TiersContext` (after the `cekCache` member):
```ts
  /** Evict the collection's decoded-record cache entry after a tier move rewraps the envelope (#691). */
  evictCache(id: string): void
```

(b) In BOTH `elevate` and `demote`, extend the not-found guard (elevate line ~260, demote equivalent):
```ts
  if (!envelope || isDeleteMarker(envelope) || isTombstoneShape(envelope)) {
    throw new Error(`Record "${id}" not found in collection "${ctx.name}"`)
  }
```
(Deleted ≡ missing — same message, no oracle distinguishing them. `demote` keeps its own existing message shape if it differs — match its current not-found text.) Extend the existing `../../kernel/enclave/index.js` import with `isDeleteMarker, isTombstoneShape`.

(c) In BOTH `elevate` and `demote`, immediately after the `ctx.cekCache?.set(id, body.cek, 1)` line (elevate ~279, demote ~341) — or after the `adapter.put` if ordering reads cleaner — add:
```ts
  ctx.evictCache(id)
```

- [ ] **Step 4: Wire evictCache in collection.ts — NET-ZERO lines**

In `tiersContext()` (collection.ts ~4508–4522) add:
```ts
      evictCache: (id: string) => { this.cache.delete(id); this.lru?.remove(id) },
```
(Mirrors `_writeTombstone`'s eviction minus `cekCache` — the tier move deliberately re-seeds the CEK for `getAtTier`.)

collection.ts is at its exact ceiling (4549). Before adding, remove exactly one line elsewhere in collection.ts: find a two-line statement that joins naturally within the file's style (e.g. a short single-use `const` inlined into its sole use site, or a wrapped argument list that fits one line) near the code you're touching. Verify with `node scripts/check-architecture.mjs` (must pass WITHOUT editing the 4549 value) and `pnpm --filter @noy-db/hub lint`.

- [ ] **Step 5: Run GREEN + regression**

Run: `pnpm vitest run __tests__/hierarchical-tiers.test.ts __tests__/tier0-read-paths.test.ts` → PASS.
Run: `node scripts/check-architecture.mjs` (repo root) → PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/hub/src/with-audit/tiers/index.ts packages/hub/src/kernel/collection.ts packages/hub/__tests__/hierarchical-tiers.test.ts
git commit -m "fix(hub): elevate/demote evict the record cache and refuse tombstones (#691)"
```

---

### Final: full suite + whole-branch review + changeset

- [ ] `pnpm --filter @noy-db/hub test` (full hub suite) + `pnpm typecheck` + `pnpm lint` + `pnpm check:architecture` — all green.
- [ ] Whole-branch review (fable — crypto-sensitive: pad discipline, oracle surface, gate placement).
- [ ] Author local changeset (`.changeset/` is gitignored — local file, ships next release): `@noy-db/hub` **patch** — "verify/det/findByDigest treat elevated records as missing (padded false / skipped) instead of throwing on tier-wrapped key material; elevate/demote evict the record cache and refuse tombstoned ids (#691)".
- [ ] PR `fix/691-tier-unaware-reads` → main with `Closes #691`.
