# Delete-Tombstone Convergence Implementation Plan (#589, Spec 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make ordinary `collection.delete()` converge on pull by writing a version-ordered `_del` marker envelope (instead of a physical delete) when sync is active, so offline peers can no longer resurrect deleted records — while a legitimate re-create at a higher version still resurrects the id.

**Architecture:** A new optional `_del?: true` field on `EncryptedEnvelope` + an `isDeleteMarker` predicate, distinct from the forget crypto-shred tombstone (`isTombstoneShape`, which becomes `_del`-guarded). Under sync, `_doDelete` writes a marker at `existing._v + 1` and tracks it as a `put` on the dirty log (retiring the bare `remote.delete` push for synced deletes); the marker rides the ordinary CAS put/pull path. Re-create version continuity, the same-`_v` delete-vs-edit tie rule, read-path filtering, an adapter-conformance round-trip vector, and a minimal `_purgeDeleteMarkers` seam (for #604) complete it. Reuses the #590 tombstone dispatch and #598 cache-invalidation machinery.

**Tech Stack:** TypeScript ESM, vitest, pnpm. Work in `packages/hub` + `test-harnesses/adapter-conformance`. Spec: `docs/superpowers/specs/2026-07-09-delete-tombstone-convergence-design.md`.

## Global Constraints

- **No Claude attribution** in any commit message, PR, or changelog (family-wide hard rule).
- **Hub stays portable** — no Node built-ins in `packages/hub/src/**`; `crypto.subtle` only.
- **Frozen seams**: do NOT export new names from `src/legacy/kernel.ts`, `src/with-cargo/index.ts`, or `src/legacy/adapter.ts`. New predicates go on the **enclave barrel** (`src/kernel/enclave/index.ts`) only; the `_del` type field is additive on `EncryptedEnvelope` (published via `/adapter` — additive, non-breaking).
- **Two views stay distinct**: raw stored `_v` for the *writer* (version continuity), filtered-`null` for every *reader*. A delete marker must read as absent everywhere and never reach a decrypt attempt.
- **Distinct from forget**: a `_del` marker is *version-ordered* (higher `_v` re-create wins); a forget tombstone (`isTombstoneShape`) is *terminal* (#590). The predicates must never overlap.
- **Sync-gated**: markers are written only when `this.onDirty` is defined (⟺ the vault has ≥1 sync target). Local-only collections keep physical `adapter.delete()` — zero regression.
- **kernel-surface metric** is `readFileSync(file).split('\n').length` (= `wc -l` + 1 on trailing-newline files). `collection.ts` sits at its ceiling `4664` with zero slack (`scripts/check-architecture.mjs:697`); any added line needs a ceiling bump with a dated justification comment in the established style.
- TDD: failing test first, every task.
- All commands run from repo root `/Users/vicio/lanna-db/noy-db`. Branch `fix/589-delete-tombstones` (already created; spec committed at `0f6fbd94`).

## Shared test harness

New sync/write tests live in ONE file: `packages/hub/__tests__/delete-tombstone-convergence.test.ts`. Task 3 creates it with this header (mirrors the #590 test harness); later tasks append `describe` blocks.

```ts
import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { ConflictError } from '../src/kernel/errors.js'
import { createNoydb } from '../src/kernel/noydb.js'
import { withSync } from '../src/with-party/sync/index.js'
import { isDeleteMarker } from '../src/kernel/enclave/record-keys/tombstone.js'

/** In-memory store exposing raw stored envelopes for white-box assertions. */
function memory(): NoydbStore & { raw(c: string, col: string, id: string): EncryptedEnvelope | undefined } {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function gc(c: string, col: string) {
    let comp = store.get(c); if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col); if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
    raw(c, col, id) { return store.get(c)?.get(col)?.get(id) },
    async get(c, col, id) { return store.get(c)?.get(col)?.get(id) ?? null },
    async put(c, col, id, env, ev) {
      const coll = gc(c, col); const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      coll.set(id, env)
    },
    async delete(c, col, id) { store.get(c)?.get(col)?.delete(id) },
    async list(c, col) { const coll = store.get(c)?.get(col); return coll ? [...coll.keys()] : [] },
    async loadAll(c) {
      const comp = store.get(c); const s: VaultSnapshot = {}
      if (comp) for (const [n, coll] of comp) { if (!n.startsWith('_')) { const r: Record<string, EncryptedEnvelope> = {}; for (const [id, e] of coll) r[id] = e; s[n] = r } }
      return s
    },
    async saveAll(c, data) {
      for (const [n, recs] of Object.entries(data)) { const coll = gc(c, n); for (const [id, e] of Object.entries(recs)) coll.set(id, e) }
    },
  }
}

interface Note { body: string }
const V = 'V1'
```

Run file: `pnpm vitest run packages/hub/__tests__/delete-tombstone-convergence.test.ts`

---

### Task 1: `_del` field, `isDeleteMarker` / `buildDeleteMarker`, barrel + golden

**Files:**
- Modify: `packages/hub/src/kernel/types.ts` (`EncryptedEnvelope`, ends line 233)
- Modify: `packages/hub/src/kernel/enclave/record-keys/tombstone.ts`
- Modify: `packages/hub/src/kernel/enclave/index.ts:105` (barrel)
- Test: `packages/hub/src/kernel/enclave/record-keys/tombstone.test.ts` (append; if absent, create beside the source)
- Test (baseline): `packages/hub/__tests__/enclave-surface-golden.test.ts` (+ its `.golden.json`)

**Interfaces:**
- Produces:
  - `EncryptedEnvelope._del?: true`
  - `isDeleteMarker(env: EncryptedEnvelope): boolean` — `env._del === true`
  - `buildDeleteMarker(version: number, actor: string): EncryptedEnvelope`
  - `isTombstoneShape` now excludes `_del` markers.

- [ ] **Step 1: Write the failing predicate tests** — append to `tombstone.test.ts`:

```ts
import { isDeleteMarker, buildDeleteMarker, isTombstoneShape, isTombstone } from './tombstone.js'

describe('delete marker predicate (#589)', () => {
  it('isDeleteMarker recognises _del:true and nothing else', () => {
    expect(isDeleteMarker({ _noydb: 1, _v: 6, _ts: 'x', _iv: '', _data: '', _del: true })).toBe(true)
    expect(isDeleteMarker({ _noydb: 1, _v: 1, _ts: 'x', _iv: 'iv', _data: 'ct' })).toBe(false)
    expect(isDeleteMarker({ _noydb: 1, _v: 1, _ts: 'x', _iv: '', _data: '' })).toBe(false) // forget tombstone
  })
  it('a delete marker is NOT a forget tombstone (predicates never overlap)', () => {
    const marker = buildDeleteMarker(6, 'alice')
    expect(isDeleteMarker(marker)).toBe(true)
    expect(isTombstoneShape(marker)).toBe(false)             // guarded by _del !== true
    expect(isTombstone(marker, true)).toBe(false)
  })
  it('buildDeleteMarker mints the marker shape at the given version', () => {
    const m = buildDeleteMarker(6, 'alice')
    expect(m).toMatchObject({ _noydb: 1, _v: 6, _iv: '', _data: '', _del: true, _by: 'alice' })
    expect(typeof m._ts).toBe('string')
    expect(m._cek).toBeUndefined()
  })
  it('a forget tombstone is still a tombstone (unchanged)', () => {
    expect(isTombstoneShape({ _noydb: 1, _v: 3, _ts: 'x', _iv: '', _data: '' })).toBe(true)
  })
})
```

- [ ] **Step 2: Run — expect FAIL** (`isDeleteMarker`/`buildDeleteMarker` not exported).

Run: `pnpm vitest run packages/hub/src/kernel/enclave/record-keys/tombstone.test.ts`

- [ ] **Step 3: Add the type field** — in `types.ts`, inside `EncryptedEnvelope`, immediately before the closing brace at line 233:

```ts
  /**
   * #589: this envelope is a delete marker (ordinary `collection.delete()` under
   * sync). Empty `_data`, no `_cek`, but version-ordered — a higher-`_v` re-create
   * resurrects the id. Distinct from a forget crypto-shred tombstone, which is
   * terminal. Reads treat it as absent.
   */
  readonly _del?: true
```

- [ ] **Step 4: Add predicates + guard** — in `tombstone.ts`, add:

```ts
/** #589: is this envelope an ordinary-delete marker (version-ordered, reads as absent)? */
export function isDeleteMarker(envelope: EncryptedEnvelope): boolean {
  return envelope._del === true
}

/**
 * Mint a delete marker from the deleted record's next version + actor (#589).
 * Minted at the NEXT version (`existing._v + 1`) — unlike `buildTombstone`, which
 * keeps the displaced `_v` — so it wins convergence over the pre-delete copy and a
 * re-create can still win over it at a higher version.
 */
export function buildDeleteMarker(version: number, actor: string): EncryptedEnvelope {
  return {
    _noydb: NOYDB_FORMAT_VERSION,
    _v: version,
    _ts: new Date().toISOString(),
    _iv: '',
    _data: '',
    _del: true,
    ...(actor ? { _by: actor } : {}),
  }
}
```

and change `isTombstoneShape` (lines 27-29) to exclude markers:

```ts
export function isTombstoneShape(envelope: EncryptedEnvelope): boolean {
  return envelope._data === '' && envelope._cek === undefined && envelope._del !== true
}
```

- [ ] **Step 5: Barrel export** — in `enclave/index.ts`, line 105, extend:

```ts
export { isTombstone, isTombstoneShape, buildTombstone, isDeleteMarker, buildDeleteMarker } from './record-keys/tombstone.js'
```

- [ ] **Step 6: Run predicate tests — expect PASS.** Same command as Step 2.

- [ ] **Step 7: Update the enclave-surface golden** — run the golden test; it fails RED on the two ADDED exports:

Run: `pnpm vitest run packages/hub/__tests__/enclave-surface-golden.test.ts`
Expected: FAIL listing `isDeleteMarker`, `buildDeleteMarker` as new. Update its `.golden.json` baseline per the test's documented mechanism (add the two names in sorted position; remove/rename nothing). Re-run → PASS.

- [ ] **Step 8: Verify frozen seams + commit**

Run: `pnpm vitest run packages/hub/__tests__/cargo-surface-golden.test.ts packages/hub/__tests__/kernel-surface-golden.test.ts` — expected PASS, unchanged (the `_del` field is additive on `EncryptedEnvelope`, which those goldens list by name only). If either fails, you exported a new NAME into a frozen seam — undo that.
Run: `pnpm --filter @noy-db/hub typecheck` — PASS.

```bash
git add packages/hub/src/kernel/types.ts packages/hub/src/kernel/enclave/record-keys/tombstone.ts packages/hub/src/kernel/enclave/record-keys/tombstone.test.ts packages/hub/src/kernel/enclave/index.ts packages/hub/__tests__/enclave-surface-golden.test.ts packages/hub/__tests__/*.golden.json
git commit -m "feat(hub): _del delete-marker field + isDeleteMarker/buildDeleteMarker predicates (#589)"
```

---

### Task 2: read-path filtering — a delete marker reads as absent

**Files:**
- Modify: `packages/hub/src/kernel/enclave/record-keys/record-codec.ts:451` (the decrypt choke point)
- Modify: `packages/hub/src/kernel/collection.ts` direct `isTombstone` short-circuits: `1477`, `2301`, `2312`, `2684`, `2959`, `3940`, `3954`
- Test: `packages/hub/__tests__/delete-tombstone-convergence.test.ts` is created in Task 3; put this task's tests in a **new** file `packages/hub/__tests__/delete-marker-read-filter.test.ts` (uses the same `memory()` harness — copy the header block from the Shared test harness section, dropping the unused `withSync` import)

**Interfaces:**
- Consumes: `isDeleteMarker` (Task 1).

- [ ] **Step 1: Write the failing test** — create `delete-marker-read-filter.test.ts` with the harness header, then:

```ts
describe('delete marker reads as absent (#589)', () => {
  async function seedMarker(lazy: boolean) {
    const store = memory()
    const db = await createNoydb({ store, user: 'u', encrypt: false })
    const vault = await db.openVault(V)
    const notes = vault.collection<Note>('notes', lazy ? { lazy: true } : {})
    await notes.put('n1', { body: 'live' })
    // Simulate a delete marker landing in the raw store (as sync would deliver):
    const live = store.raw(V, 'notes', 'n1')!
    store['delete'] // no-op ref to keep types happy
    await store.put(V, 'notes', 'n1', { ...live, _v: live._v + 1, _iv: '', _data: '', _del: true })
    return { store, db, vault, notes }
  }

  for (const lazy of [false, true]) {
    it(`get/list/query treat a marker as absent (lazy=${lazy})`, async () => {
      const { db, vault, notes } = await seedMarker(lazy)
      // Fresh handle to bypass any warm cache from the initial put:
      const fresh = (await db.openVault(V)).collection<Note>('notes', lazy ? { lazy: true } : {})
      expect(await fresh.get('n1')).toBeNull()
      expect(await fresh.list()).not.toContainEqual(expect.objectContaining({ id: 'n1' }))
      expect((await fresh.query().all()).find(r => (r as { id?: string }).id === 'n1')).toBeUndefined()
      db.close()
    })
  }
})
```

(If `collection.list()`/`query().all()` return shapes differ, adjust the assertion to "n1 is not present"; the invariant under test is *absence*.)

- [ ] **Step 2: Run — expect FAIL** (marker currently decodes or surfaces as a record, or throws on decrypt).

Run: `pnpm vitest run packages/hub/__tests__/delete-marker-read-filter.test.ts`

- [ ] **Step 3: Fix the decrypt choke point** — `record-codec.ts:451`, change:

```ts
    if (isTombstone(envelope, this.ctx.storeCiphertext)) return null
```
to:
```ts
    if (isTombstone(envelope, this.ctx.storeCiphertext) || isDeleteMarker(envelope)) return null
```
Add `isDeleteMarker` to the existing import from the enclave record-keys module in this file.

- [ ] **Step 4: Fix the direct short-circuits in `collection.ts`** — at each of lines `1477`, `2301`, `2312`, `2684`, `2959`, `3940`, `3954`, the code reads `isTombstone(env, this.storeCiphertext)` to treat a value as absent. Change each to also treat a marker as absent:

```ts
// before: isTombstone(env, this.storeCiphertext)
// after:  (isTombstone(env, this.storeCiphertext) || isDeleteMarker(env))
```

Import `isDeleteMarker` alongside the existing `isTombstone` import in `collection.ts`. (At `2959`, `_writeTombstone`'s idempotency guard: a forget over an already-delete-marked record is a no-op — correct, the marker means "no live body to shred".) Do NOT touch `history.ts:199` or `classify/reveal.ts:24` — those are forget-history / sealed-field paths a delete marker never reaches; note this in the commit body.

- [ ] **Step 5: Run tests — expect PASS.** Same command as Step 2.

- [ ] **Step 6: Regression + commit**

```bash
pnpm vitest run packages/hub/__tests__/forget-sealed-erasure.test.ts packages/hub/__tests__/sync-tombstone-terminal.test.ts
git add packages/hub/src/kernel/enclave/record-keys/record-codec.ts packages/hub/src/kernel/collection.ts packages/hub/__tests__/delete-marker-read-filter.test.ts
git commit -m "fix(hub): delete markers read as absent at every read choke point (#589)"
```

Expected: forget + #590 suites still PASS (the added predicate is orthogonal to tombstones).

---

### Task 3: write path — `delete()` writes a marker under sync

**Files:**
- Modify: `packages/hub/src/kernel/collection.ts` (`_doDelete`, ~2776-2919; physical delete at `2849`; onDirty at `2885`)
- Modify: `scripts/check-architecture.mjs:697` (collection.ts ceiling)
- Test: `packages/hub/__tests__/delete-tombstone-convergence.test.ts` (CREATE with the Shared harness header + this describe)

**Interfaces:**
- Consumes: `buildDeleteMarker`, `isDeleteMarker`, `isTombstone` (Task 1); `this.onDirty` gate.
- Produces: under sync, `delete()` leaves a `_del` marker at `existing._v + 1` and a `'put'` dirty entry at version `existing._v + 1`.

- [ ] **Step 1: Write the failing test** — create the test file with the Shared harness header, then:

```ts
describe('delete() writes a marker under sync (#589)', () => {
  it('synced delete leaves a version-bumped _del marker, not a physical removal', async () => {
    const local = memory(); const remote = memory()
    const db = await createNoydb({ store: local, sync: remote, user: 'alice', syncStrategy: withSync(), encrypt: false })
    const vault = await db.openVault(V)
    const notes = vault.collection<Note>('notes')
    await notes.put('n1', { body: 'v1' })            // live at _v=1
    await notes.delete('n1')

    const raw = local.raw(V, 'notes', 'n1')
    expect(raw).toBeDefined()                         // NOT physically removed
    expect(isDeleteMarker(raw!)).toBe(true)
    expect(raw!._v).toBe(2)                           // existing._v (1) + 1
    expect(await notes.get('n1')).toBeNull()          // reads absent (Task 2)
    db.close()
  })

  it('non-synced delete stays physical (no marker, zero regression)', async () => {
    const store = memory()
    const db = await createNoydb({ store, user: 'u', encrypt: false })   // no sync target
    const vault = await db.openVault(V)
    const notes = vault.collection<Note>('notes')
    await notes.put('n1', { body: 'v1' })
    await notes.delete('n1')
    expect(store.raw(V, 'notes', 'n1')).toBeUndefined()   // physically gone
    db.close()
  })

  it('delete of an already-deleted (marked) record is a no-op', async () => {
    const local = memory(); const remote = memory()
    const db = await createNoydb({ store: local, sync: remote, user: 'u', syncStrategy: withSync(), encrypt: false })
    const notes = (await db.openVault(V)).collection<Note>('notes')
    await notes.put('n1', { body: 'v1' })
    await notes.delete('n1')
    const after1 = local.raw(V, 'notes', 'n1')!
    await notes.delete('n1')                          // second delete
    expect(local.raw(V, 'notes', 'n1')!._v).toBe(after1._v)   // unchanged, no re-marker
    db.close()
  })
})
```

- [ ] **Step 2: Run — expect FAIL** (first test: record physically removed, `raw` undefined).

Run: `pnpm vitest run packages/hub/__tests__/delete-tombstone-convergence.test.ts`

- [ ] **Step 3: Branch `_doDelete`** — in `collection.ts`, replace the physical delete at line `2849` (`await this.adapter.delete(this.vault, this.name, id)`) with a sync-gated branch. Keep the surrounding history-snapshot (2811-2839), ledger append (2855-2864), and cache/index eviction (2866-2883) exactly as they are. The write becomes:

```ts
    if (this.onDirty) {
      // #589: under sync, delete leaves a version-ordered marker so the deletion
      // converges on pull (a bare adapter.delete is invisible to other pullers).
      // No-op if there is no live record to delete (already marked / shredded).
      const live = await this.adapter.get(this.vault, this.name, id)
      if (!live || isTombstone(live, this.storeCiphertext) || isDeleteMarker(live)) return
      await this.adapter.put(this.vault, this.name, id, buildDeleteMarker(live._v + 1, this.keyring.userId))
    } else {
      await this.adapter.delete(this.vault, this.name, id)
    }
```

Then change the `onDirty` fire at line `2885` from:
```ts
    await this.onDirty?.(this.name, id, 'delete', existing?.version ?? 0)
```
to:
```ts
    // #589: under sync the marker rides the push channel as an ordinary CAS put at
    // its own version (existing._v + 1); the dirty version must match the marker so
    // push's expectedVersion = marker._v - 1 = existing._v matches the remote's live copy.
    await this.onDirty?.(this.name, id, 'put', (existing?.version ?? 0) + 1)
```

(The `return` in the sync branch when no live record short-circuits before the ledger/onDirty for the no-op case; verify the early `return` is placed so a genuine no-op skips the marker AND the dirty entry. If `_doDelete`'s structure makes an early return skip needed cleanup, instead guard just the marker write and let the rest no-op naturally — the reviewer will check this.)

- [ ] **Step 4: Bump the kernel-surface ceiling** — `collection.ts` grew by ~8 lines. In `scripts/check-architecture.mjs`, above line 697, add a dated comment and raise the value. Measure first:

Run: `awk 'END{print NR+1}' packages/hub/src/kernel/collection.ts` (the split('\n').length metric). Set the ceiling to that exact number. Add above the entry:
```js
  // Bumped 4664→<N> (2026-07-09, +<delta>: #589 _doDelete writes a delete marker under
  // sync via buildDeleteMarker; converges deletes on pull. Marker helpers live in enclave.
  'packages/hub/src/kernel/collection.ts': <N>,
```

- [ ] **Step 5: Run — expect PASS** (all three tests). Same command as Step 2. Then `pnpm check:architecture` → PASS.

- [ ] **Step 6: Regression + commit**

```bash
pnpm vitest run packages/hub/__tests__/sync.test.ts packages/hub/__tests__/sync-tombstone-terminal.test.ts packages/hub/__tests__/forget-sealed-erasure.test.ts
git add packages/hub/src/kernel/collection.ts scripts/check-architecture.mjs packages/hub/__tests__/delete-tombstone-convergence.test.ts
git commit -m "feat(hub): delete() writes a version-ordered marker under sync instead of a physical removal (#589)"
```

---

### Task 4: re-create version continuity

**Files:**
- Modify: `packages/hub/src/kernel/collection.ts` — the put version-resolution: eager `resolvePriorValues` (1718-1727) / the `existing`+`version` computation (2056-2079), and the lazy branch (2060-2071)
- Modify: `scripts/check-architecture.mjs:697` if lines were added
- Test: append to `packages/hub/__tests__/delete-tombstone-convergence.test.ts`

**Interfaces:**
- Consumes: `isDeleteMarker` (Task 1), the marker write (Task 3).
- Produces: a `put` re-creating a deleted id under sync mints `marker._v + 1`.

- [ ] **Step 1: Write the failing test** — append:

```ts
describe('re-create version continuity (#589)', () => {
  it('a put after a synced delete continues from the marker version (not reset to 1)', async () => {
    const local = memory(); const remote = memory()
    const db = await createNoydb({ store: local, sync: remote, user: 'u', syncStrategy: withSync(), encrypt: false })
    const notes = (await db.openVault(V)).collection<Note>('notes')
    await notes.put('n1', { body: 'v1' })        // _v=1
    await notes.delete('n1')                      // marker _v=2
    await notes.put('n1', { body: 're-created' }) // must be _v=3, NOT _v=1

    const raw = local.raw(V, 'notes', 'n1')!
    expect(isDeleteMarker(raw)).toBe(false)       // live again
    expect(raw._v).toBe(3)                        // marker._v (2) + 1
    expect((await notes.get('n1'))!.body).toBe('re-created')
    db.close()
  })
})
```

- [ ] **Step 2: Run — expect FAIL** (`raw._v` is `1`, the reset-to-1 behavior).

Run: `pnpm vitest run packages/hub/__tests__/delete-tombstone-convergence.test.ts`

- [ ] **Step 3: Add continuity to the put path.** At the point where `version` is computed (line 2077, `const version = existing ? existing.version + 1 : 1`), when `existing` is undefined AND sync is active, read the raw stored envelope and continue off a marker:

```ts
    let version = existing ? existing.version + 1 : 1
    if (!existing && this.onDirty) {
      // #589: a re-create over a delete marker must continue the version so it wins
      // convergence (a reset to 1 would lose to the marker's higher _v). Markers exist
      // only under sync, so this raw read is gated on onDirty. Forget tombstones are NOT
      // continued (they are terminal / erased) — only _del markers.
      const priorRaw = await this.adapter.get(this.vault, this.name, id)
      if (priorRaw && isDeleteMarker(priorRaw)) version = priorRaw._v + 1
    }
```

For the **lazy** branch, the raw get already happens at line 2063 (`previousEnvelope`); extend the existing block so a marker prior sets the version even though it is treated as no-prior-record:

```ts
      if (previousEnvelope) {
        const previousRecord = await this.codec.decryptRecord(previousEnvelope)
        if (previousRecord !== null) {
          existing = { record: previousRecord, version: previousEnvelope._v }
        } else if (isDeleteMarker(previousEnvelope)) {
          // #589: re-create over a marker — no prior record, but continue the version.
          markerPriorVersion = previousEnvelope._v
        }
      }
```
and after the eager/lazy resolution, fold `markerPriorVersion` into `version` (declare `let markerPriorVersion: number | undefined` near `existing`; `if (markerPriorVersion !== undefined && !existing) version = markerPriorVersion + 1`). Keep the two paths from double-reading: if the lazy branch already read `previousEnvelope`, do not issue the eager extra get.

(Implementer: unify so there is exactly ONE raw read on the re-create path. Structure it as: resolve `existing`; if `!existing && this.onDirty`, do a single raw `adapter.get` and set `version = priorRaw._v + 1` when `isDeleteMarker(priorRaw)`. Prefer this single-point form over editing both branches if it reads cleaner — the test is the contract.)

- [ ] **Step 4: Bump ceiling if needed** — re-measure `awk 'END{print NR+1}' packages/hub/src/kernel/collection.ts`; if over the Task-3 ceiling, raise it with an appended dated note (`+<delta>: #589 re-create version continuity`).

- [ ] **Step 5: Run — expect PASS.** Same command as Step 2. Then `pnpm check:architecture` → PASS.

- [ ] **Step 6: Regression + commit**

```bash
pnpm vitest run packages/hub/__tests__/forget-sealed-erasure.test.ts packages/hub/__tests__/sync.test.ts
git add packages/hub/src/kernel/collection.ts scripts/check-architecture.mjs packages/hub/__tests__/delete-tombstone-convergence.test.ts
git commit -m "feat(hub): re-create over a delete marker continues its version so it wins convergence (#589)"
```

Expected: forget suite unchanged (forget tombstones still reset to 1 — they are not `isDeleteMarker`).

---

### Task 5: sync convergence — pull applies markers + the delete-vs-edit tie

**Files:**
- Modify: `packages/hub/src/with-party/team/sync.ts` (`pull()` dispatch ladder, ~320-375)
- Test: append to `packages/hub/__tests__/delete-tombstone-convergence.test.ts`

**Interfaces:**
- Consumes: `isDeleteMarker` (Task 1); the marker write + `'put'` dirty entry (Task 3); the existing `handleConflict`, `applyRemote`, `reportErasure` helpers.
- Produces: deletes converge on pull; same-`_v` delete-vs-edit resolves (resolver-or-delete-wins); forget still outranks delete.

- [ ] **Step 1: Write the failing tests** — append:

```ts
describe('delete convergence on pull (#589)', () => {
  async function twoPeers(conflict?: 'local-wins') {
    const localA = memory(); const localB = memory(); const remote = memory()
    const dbA = await createNoydb({ store: localA, sync: remote, user: 'a', syncStrategy: withSync(), encrypt: false, ...(conflict ? { conflict } : {}) })
    const dbB = await createNoydb({ store: localB, sync: remote, user: 'b', syncStrategy: withSync(), encrypt: false, ...(conflict ? { conflict } : {}) })
    return { localA, localB, remote, dbA, dbB }
  }

  it('the core bug: a delete on A converges to B on pull', async () => {
    const { dbA, dbB } = await twoPeers()
    const a = (await dbA.openVault(V)).collection<Note>('notes')
    await a.put('n1', { body: 'v1' }); await dbA.push(V)
    const b = (await dbB.openVault(V)).collection<Note>('notes')
    await dbB.pull(V); expect((await b.get('n1'))!.body).toBe('v1')   // B has it

    await a.delete('n1'); await dbA.push(V)                            // A deletes → marker _v=2 pushed
    await dbB.pull(V)
    expect(await b.get('n1')).toBeNull()                              // B converges to deleted
    dbA.close(); dbB.close()
  })

  it('re-create at a higher version resurrects on pull', async () => {
    const { dbA, dbB } = await twoPeers()
    const a = (await dbA.openVault(V)).collection<Note>('notes')
    await a.put('n1', { body: 'v1' }); await a.delete('n1'); await a.put('n1', { body: 'reborn' })  // marker _v=2, live _v=3
    await dbA.push(V); await dbB.pull(V)
    const b = (await dbB.openVault(V)).collection<Note>('notes')
    expect((await b.get('n1'))!.body).toBe('reborn')
    dbA.close(); dbB.close()
  })

  it('concurrent same-version delete-vs-edit: delete wins by default (no resolver)', async () => {
    const { dbA, dbB } = await twoPeers()
    const a = (await dbA.openVault(V)).collection<Note>('notes')
    await a.put('n1', { body: 'v1' }); await dbA.push(V)
    const b = (await dbB.openVault(V)).collection<Note>('notes')
    await dbB.pull(V)                                                 // both at _v=1
    await a.delete('n1'); await dbA.push(V)                           // A: marker _v=2 on remote
    await b.put('n1', { body: 'edited' })                            // B: live _v=2 locally (same _v as marker)
    await dbB.pull(V)                                                 // remote marker _v=2 vs local live _v=2 → tie
    expect(await b.get('n1')).toBeNull()                             // delete wins
    dbA.close(); dbB.close()
  })

  it('same-version tie with a per-collection resolver that keeps the edit → record survives', async () => {
    const localA = memory(); const localB = memory(); const remote = memory()
    const dbA = await createNoydb({ store: localA, sync: remote, user: 'a', syncStrategy: withSync(), encrypt: false })
    const dbB = await createNoydb({ store: localB, sync: remote, user: 'b', syncStrategy: withSync(), encrypt: false })
    const a = (await dbA.openVault(V)).collection<Note>('notes')
    // B registers a resolver that always keeps the live edit over the marker:
    const b = (await dbB.openVault(V)).collection<Note>('notes', {
      conflictPolicy: (_id, local, remote) => (isDeleteMarker(local) ? remote : local),
    })
    await a.put('n1', { body: 'v1' }); await dbA.push(V); await dbB.pull(V)   // both _v=1
    await a.delete('n1'); await dbA.push(V)                                    // A: marker _v=2
    await b.put('n1', { body: 'edited' })                                     // B: live _v=2
    await dbB.pull(V)                                                          // tie → resolver keeps edit
    expect((await b.get('n1'))!.body).toBe('edited')
    dbA.close(); dbB.close()
  })

  it('modifiedSince partial pull never skips an arriving delete marker', async () => {
    const { localB, remote, dbA, dbB } = await twoPeers()
    const a = (await dbA.openVault(V)).collection<Note>('notes')
    await a.put('n1', { body: 'v1' }); await dbA.push(V); await dbB.pull(V)
    await a.delete('n1'); await dbA.push(V)
    // Backdate the remote marker's _ts to before the cutoff:
    const m = remote.raw(V, 'notes', 'n1')!
    await remote.put(V, 'notes', 'n1', { ...m, _ts: '2000-01-01T00:00:00.000Z' })
    const b = (await dbB.openVault(V)).collection<Note>('notes')
    await dbB.pull(V, { modifiedSince: '2020-01-01T00:00:00.000Z' })  // old marker must NOT be skipped
    expect(await b.get('n1')).toBeNull()
    dbA.close(); dbB.close()
  })

  it('a delete marker never overrides a forget tombstone (forget outranks delete)', async () => {
    // local forget tombstone vs incoming delete marker → forget stays
    const local = memory(); const remote = memory()
    const db = await createNoydb({ store: local, sync: remote, user: 'u', secret: 'hunter2', syncStrategy: withSync(),
      historyStrategy: (await import('../src/with-commit/history/index.js')).withHistory(),
      forgetStrategy: (await import('../src/with-audit/forget/index.js')).withForgetCascade({ subjects: { notes: 'subjectId' } }) })
    const notes = (await db.openVault(V)).collection<Note & { subjectId?: string }>('notes', { perRecordKeys: true })
    await notes.put('n1', { body: 'secret', subjectId: 's1' }); await db.push(V)
    const preShred = local.raw(V, 'notes', 'n1')!
    await (await db.openVault(V)).forget('s1')                        // local forget tombstone
    await remote.put(V, 'notes', 'n1', { ...preShred, _v: preShred._v + 1, _iv: '', _data: '', _del: true }) // incoming delete marker
    await db.pull(V)
    expect(isDeleteMarker(local.raw(V, 'notes', 'n1')!)).toBe(false)  // still the forget tombstone, not overwritten
    db.close()
  })
})
```

- [ ] **Step 2: Run — expect FAIL** (core-bug test: B still sees the record — the marker at `_v=2` over B's live `_v=1` should apply via the ladder; if it already passes, the *tie* test fails: same-`_v` is skipped).

Run: `pnpm vitest run packages/hub/__tests__/delete-tombstone-convergence.test.ts`

- [ ] **Step 3a: Exempt delete markers from the `modifiedSince` filter.** In `pull()`, the filter at line 316 is `if (options?.modifiedSince && remoteEnvelope._ts <= options.modifiedSince && !isTombstoneShape(remoteEnvelope)) continue`. A marker is no longer `isTombstoneShape`, so an old-`_ts` marker would be skipped — an arriving delete must never be skipped by partial sync. Change to:

```ts
          if (
            options?.modifiedSince &&
            remoteEnvelope._ts <= options.modifiedSince &&
            !isTombstoneShape(remoteEnvelope) &&
            !isDeleteMarker(remoteEnvelope)
          ) {
            continue
          }
```

Add `isDeleteMarker` to the `isTombstoneShape` import in `sync.ts`.

- [ ] **Step 3b: Add the tie branch in `pull()`.** A higher-`_v` marker already converges through the existing `remoteEnvelope._v > localEnvelope._v` branch (line 344, via `applyRemote` → stores the marker → reads absent). The forget branches (327-343) already outrank a delete marker because a marker is no longer `isTombstoneShape` (Task 1). The ONLY gap is the same-`_v` delete-vs-edit tie, which the ladder currently skips ("Same version or local is newer — skip", line 375). **The db-level `ConflictStrategy` defaults to `'version'`, which resolves a tie to *local-wins* — NOT the delete-wins we want — so the tie must consult ONLY the per-collection resolver (`this.conflictResolvers`), not the db-level fallback.** Insert immediately BEFORE the `else if (remoteEnvelope._v > localEnvelope._v)` at line 344:

```ts
            } else if (
              remoteEnvelope._v === localEnvelope._v &&
              isDeleteMarker(remoteEnvelope) !== isDeleteMarker(localEnvelope)
            ) {
              // #589: true concurrent delete-vs-edit at the SAME version. Version order
              // can't break the tie. A per-collection resolver decides if one is set;
              // otherwise DELETE wins (the db-level 'version' default is deliberately NOT
              // consulted — it would resolve a tie to local-wins).
              const resolver = this.conflictResolvers.get(collName)
              if (resolver) {
                const winner = await resolver(id, localEnvelope, remoteEnvelope)
                if (winner === remoteEnvelope || (winner !== localEnvelope && winner !== null)) {
                  await this.applyRemote(collName, id, winner ?? remoteEnvelope)
                  this.dirty = this.dirty.filter(d => !(d.collection === collName && d.id === id))
                  pulled++
                }
                // winner === localEnvelope or null → keep local (its dirty entry, if any, pushes out)
              } else if (isDeleteMarker(remoteEnvelope)) {
                // no resolver → delete wins; the incoming marker is the delete
                await this.applyRemote(collName, id, remoteEnvelope)
                this.dirty = this.dirty.filter(d => !(d.collection === collName && d.id === id))
                pulled++
              }
              // no resolver and LOCAL is the marker → keep local marker; its dirty 'put' pushes it outward
```

Verify `this.conflictResolvers` (a `Map<string, CollectionConflictResolver>`) and the resolver signature `(id, local, remote) => EncryptedEnvelope | null` against the current `sync.ts` (they were confirmed present during the #590 work); adapt the winner-handling to the exact resolver return contract. **The contract the tests pin: no resolver → delete wins; a resolver returning the live envelope → edit survives.**

- [ ] **Step 4: Run — expect PASS** (all 4). Same command as Step 2.

- [ ] **Step 5: Regression + commit**

```bash
pnpm vitest run packages/hub/__tests__/sync.test.ts packages/hub/__tests__/sync-tombstone-terminal.test.ts packages/hub/__tests__/sync-conflict-policy.test.ts packages/hub/__tests__/sync-partial.test.ts
git add packages/hub/src/with-party/team/sync.ts packages/hub/__tests__/delete-tombstone-convergence.test.ts
git commit -m "fix(hub): pull converges delete markers; same-version delete-vs-edit resolves (resolver or delete-wins) (#589)"
```

Expected: #590 terminal-tombstone suite unchanged (forget still outranks); LWW/partial suites pass.

---

### Task 6: adapter-conformance `_del` round-trip vector

**Files:**
- Modify: `test-harnesses/adapter-conformance/src/index.ts` (`runStoreConformanceTests`, edge-cases `describe` ~191-242)
- Test: the harness IS the test; it runs against the in-memory store via existing wiring.

**Interfaces:**
- Consumes: nothing kernel-level (adapter-layer only — the store must treat `_del` as opaque).

- [ ] **Step 1: Add the vector** — inside the `describe('edge cases', ...)` block, beside the existing "empty string values in envelope fields" test:

```ts
      it('round-trips a delete-marker envelope (_del) byte-identically (#589)', async () => {
        const marker = { _noydb: 1 as const, _v: 6, _ts: new Date().toISOString(), _iv: '', _data: '', _del: true as const }
        await adapter.put('comp1', 'coll1', 'id1', marker)
        const result = await adapter.get('comp1', 'coll1', 'id1')
        expect(result).toEqual(marker)          // _del must survive — a store that drops it breaks #589 convergence
      })
```

- [ ] **Step 2: Run the conformance suite — expect PASS** (the in-memory store round-trips whole envelopes).

Run: `pnpm vitest run test-harnesses/adapter-conformance` (or the package's test script — check `test-harnesses/adapter-conformance/package.json`).

- [ ] **Step 3: Commit**

```bash
git add test-harnesses/adapter-conformance/src/index.ts
git commit -m "test(adapter-conformance): every store must round-trip the _del delete-marker field (#589)"
```

(Note for the PR: this vector is what `noy-db-to` structured stores must satisfy — a column-mapped store that drops `_del` fails it. A `noy-db-to` conformance pass is a cross-repo follow-up, not part of this branch.)

---

### Task 7: purge seam `_purgeDeleteMarkers` (for #604)

**Files:**
- Modify: `packages/hub/src/kernel/vault.ts` (add the `@internal` method near other internal helpers)
- Modify: `scripts/check-architecture.mjs` if `vault.ts` crosses its ceiling (`3964`, line 872)
- Test: append to `packages/hub/__tests__/delete-tombstone-convergence.test.ts`

**Interfaces:**
- Consumes: `isDeleteMarker` (Task 1), `adapter.list`/`adapter.get`/`adapter.delete`.
- Produces: `Vault._purgeDeleteMarkers(before: string, collections?: string[]): Promise<number>`.

- [ ] **Step 1: Write the failing test** — append:

```ts
describe('_purgeDeleteMarkers seam (#589 → #604)', () => {
  it('physically removes only delete markers older than the cutoff; leaves live + newer', async () => {
    const local = memory(); const remote = memory()
    const db = await createNoydb({ store: local, sync: remote, user: 'u', syncStrategy: withSync(), encrypt: false })
    const vault = await db.openVault(V)
    const notes = vault.collection<Note>('notes')
    await notes.put('keep', { body: 'live' })                         // live, never purged
    await notes.put('old', { body: 'x' }); await notes.delete('old')  // old marker
    await notes.put('new', { body: 'y' })                             // (deleted below, after cutoff)

    // Backdate the 'old' marker in the raw store to before the cutoff:
    const oldM = local.raw(V, 'notes', 'old')!
    await local.put(V, 'notes', 'old', { ...oldM, _ts: '2000-01-01T00:00:00.000Z' })
    await notes.delete('new')                                          // 'new' marker at now

    const removed = await (vault as unknown as { _purgeDeleteMarkers(b: string, c?: string[]): Promise<number> })
      ._purgeDeleteMarkers('2020-01-01T00:00:00.000Z')

    expect(removed).toBe(1)
    expect(local.raw(V, 'notes', 'old')).toBeUndefined()             // purged
    expect(isDeleteMarker(local.raw(V, 'notes', 'new')!)).toBe(true) // newer marker kept
    expect(local.raw(V, 'notes', 'keep')).toBeDefined()             // live kept
    db.close()
  })
})
```

- [ ] **Step 2: Run — expect FAIL** (`_purgeDeleteMarkers` undefined).

Run: `pnpm vitest run packages/hub/__tests__/delete-tombstone-convergence.test.ts`

- [ ] **Step 3: Implement** — in `vault.ts`, add near the other `@internal` helpers:

```ts
  /**
   * @internal #589 → #604. Physically remove delete markers with `_ts` strictly
   * older than `before` (ISO timestamp), across `collections` (or all data
   * collections). Returns the count removed.
   *
   * SAFETY: purging a marker RE-OPENS the #589 resurrection window for any peer
   * offline since before the cutoff — never-GC is safe precisely because the marker
   * is always present to win convergence. This is an operator-asserted safe-point
   * ONLY; #604's period-close lifecycle is what earns that assertion. Do not call
   * it on live/unsettled data.
   */
  async _purgeDeleteMarkers(before: string, collections?: string[]): Promise<number> {
    const snapshot = await this.adapter.loadAll(this.name)   // one read; already carries every envelope
    let removed = 0
    for (const [coll, records] of Object.entries(snapshot)) {
      if (collections && !collections.includes(coll)) continue
      for (const [id, env] of Object.entries(records)) {
        if (isDeleteMarker(env) && env._ts < before) {
          await this.adapter.delete(this.name, coll, id)
          removed++
        }
      }
    }
    return removed
  }
```

`import { isDeleteMarker } from '../enclave/index.js'` (the barrel). `loadAll` returns a `VaultSnapshot` (`Record<collName, Record<id, envelope>>`) excluding `_`-prefixed system collections and already carrying every envelope, so no per-id `get` is needed.

- [ ] **Step 4: Bump `vault.ts` ceiling if needed** — `awk 'END{print NR+1}' packages/hub/src/kernel/vault.ts`; if over `3964`, raise line 872 with a dated `+<delta>: #589 _purgeDeleteMarkers seam` note.

- [ ] **Step 5: Run — expect PASS.** Same command as Step 2. Then `pnpm check:architecture` → PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/hub/src/kernel/vault.ts scripts/check-architecture.mjs packages/hub/__tests__/delete-tombstone-convergence.test.ts
git commit -m "feat(hub): _purgeDeleteMarkers operator seam for period-close (#589, seam for #604)"
```

---

### Task 8: verification sweep + changeset

**Files:**
- Create: `.changeset/delete-tombstone-convergence.md` (kept LOCAL — `.changeset/` is gitignored; do NOT `git add` it)

- [ ] **Step 1: Full verification** (lint has not run on this branch yet — CI runs it)

```bash
pnpm --filter @noy-db/hub test
pnpm --filter @noy-db/hub typecheck
pnpm --filter @noy-db/hub lint
pnpm check:architecture
pnpm vitest run test-harnesses/adapter-conformance
pnpm vitest run packages/hub/__tests__/cargo-surface-golden.test.ts packages/hub/__tests__/kernel-surface-golden.test.ts
```

Expected: all PASS. Cargo + kernel goldens UNCHANGED (enclave + root-barrel goldens were updated additively in Task 1). If lint fails only in files this branch touched, fix minimally (style only) and fold into the changeset commit; pre-existing failures elsewhere are out of scope — report them.

- [ ] **Step 2: Author the changeset** — create `.changeset/delete-tombstone-convergence.md` (do NOT commit it; it stays local until release):

```markdown
---
'@noy-db/hub': minor
---

Deletes now converge under sync (#589). `collection.delete()` on a synced vault writes a version-ordered `_del` marker instead of a physical removal, so a delete propagates on pull and offline peers can no longer resurrect deleted records; a legitimate re-create at a higher version still resurrects the id (guaranteed non-resurrection remains `forget()`'s job). A concurrent same-version delete-vs-edit resolves via the collection's conflict resolver, or delete-wins by default. Adds an operator purge seam (`Vault._purgeDeleteMarkers`) for the forthcoming period-close feature (#604). Adds an optional `_del` field to `EncryptedEnvelope` on the `@noy-db/hub/adapter` seam (additive) — every `to-*` store must round-trip it (new adapter-conformance vector); `noy-db-to` stores need a conformance pass. Local-only (non-synced) collections keep physical deletes — no change.
```

- [ ] **Step 3: Commit** (changeset excluded by .gitignore; this commit is a no-op unless lint fixes were made — skip if nothing to commit)

```bash
git status --short
# if lint fixes were staged:
git commit -m "chore: lint fixes for delete-tombstone convergence (#589)"
```

---

### Task 9: PR + issue hygiene

- [ ] **Step 1: Push and open the PR** (no Claude attribution)

```bash
git push -u origin fix/589-delete-tombstones
gh pr create --repo vLannaAi/noy-db --title "fix(hub): delete-tombstone convergence — deletes converge on pull (#589)" --body "$(cat <<'EOF'
Closes #589. Implements docs/superpowers/specs/2026-07-09-delete-tombstone-convergence-design.md (Spec 1; milestone: Sync convergence & tombstones).

- Ordinary `delete()` under sync writes a version-ordered `_del` marker (at `existing._v + 1`) instead of a physical removal, so deletes converge on pull. Local-only collections keep physical deletes.
- Version-ordered, not terminal: a re-create at a higher `_v` resurrects the id (continuity implemented — a put over a marker continues from `marker._v + 1`). Guaranteed non-resurrection stays `forget()`'s job.
- Same-version delete-vs-edit tie → conflict resolver if configured, else delete-wins. Forget tombstones still outrank delete markers (terminal > version-ordered).
- Read-path filters `_del` markers to absent at every choke point (decrypt + the direct short-circuits).
- Retires the bare `remote.delete` push for synced deletes (they ride the ordinary CAS put path), which also closes the #590 note about a dirty delete wiping a remote forget-tombstone.
- Adds `Vault._purgeDeleteMarkers(before)` — the operator purge seam #604 (period-close) builds on. Its doc carries the load-bearing invariant: purging re-opens the resurrection window, so it is an operator-asserted safe-point only.

**Seam / surface:** `EncryptedEnvelope` gains an additive optional `_del?` on `@noy-db/hub/adapter`. Every `to-*` store must round-trip it — new adapter-conformance vector added. **A `noy-db-to` conformance pass is required** (a column-mapped store that drops `_del` breaks convergence). This resolves the milestone's `port?` → `port`.

Changeset authored locally (`.changeset/delete-tombstone-convergence.md`, gitignored per release flow).
EOF
)"
```

- [ ] **Step 2: Grep the diff for the pilot-client name** (family hard rule) before requesting review:

Run: `git diff main...HEAD | grep -i "<pilot-client-name>"` — expected: no matches.

- [ ] **Step 3: Issue + milestone hygiene** — after the PR is open:

```bash
gh issue edit 589 --repo vLannaAi/noy-db --remove-label "surface: port?" --add-label "surface: port"
# milestone tag: rename "Sync convergence & tombstones [api·port?]" → "[api·port]"
mnum=$(gh api "repos/vLannaAi/noy-db/milestones?state=open" --jq '.[] | select(.title|startswith("Sync convergence")) | .number')
gh api -X PATCH repos/vLannaAi/noy-db/milestones/$mnum -f title="Sync convergence & tombstones [api·port]"
```

(#604 depends on this shipping the `_purgeDeleteMarkers` seam — leave a comment on #604 noting the seam has landed once the PR merges.)
