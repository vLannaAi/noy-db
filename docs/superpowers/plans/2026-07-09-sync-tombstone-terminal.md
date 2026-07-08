# Sync Tombstone-Terminal Rule Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make crypto-shred tombstones terminal in sync (#590: pull/push can never resurrect a forgotten record; the shred propagates and re-asserts in both directions) and route every sync-applied local write through Collection cache invalidation (#598).

**Architecture:** A shape-only tombstone predicate (`isTombstoneShape`) lets the `SyncEngine` recognize erasures without per-collection context. Terminal-rule checks run before any version comparison or conflict resolver in `pull()`, `push()`, and `pushFiltered()`. `_writeTombstone` gains an `onDirty` call so shreds ride the normal push channel. A `setCacheInvalidator` hook (same injection pattern as `setPairExpander`) is wired from `Noydb.openVault` to `Vault._invalidateSyncApplied`.

**Tech Stack:** TypeScript ESM, vitest, pnpm. All work in `packages/hub`. Spec: `docs/superpowers/specs/2026-07-08-sync-tombstone-terminal-design.md`.

## Global Constraints

- **No Claude attribution** in any commit message, PR, or changelog (family-wide hard rule).
- **Hub stays portable** — no Node built-ins in `packages/hub/src/**`; `crypto.subtle` only (no crypto needed here anyway).
- **Frozen seams untouched**: do NOT export any new name from `src/legacy/kernel.ts`, `src/with-cargo/index.ts`, or `src/legacy/adapter.ts`. New types go in `src/kernel/types.ts` + the main entry `src/index.ts` only.
- **TDD**: every behavior change lands with its failing test first.
- All commands below run from the **repo root** (`/Users/vicio/lanna-db/noy-db`) unless noted.
- Match existing file style: `push()`/`pushFiltered()` are intentionally parallel near-duplicates — mirror changes into both, do not refactor them together.
- Branch: `fix/590-sync-tombstone-terminal` (already created; spec committed).

## Shared test harness (used by Tasks 1, 3, 4, 5, 6)

All new tests live in ONE new file: `packages/hub/__tests__/sync-tombstone-terminal.test.ts`. Task 1 creates it with this header + helpers; later tasks append `describe` blocks to it.

```ts
import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot, ErasureEnforcement } from '../src/kernel/types.js'
import { ConflictError } from '../src/kernel/errors.js'
import { createNoydb } from '../src/kernel/noydb.js'
import { withSync } from '../src/with-party/sync/index.js'
import { withForgetCascade } from '../src/with-audit/forget/index.js'
import { isTombstoneShape } from '../src/kernel/enclave/record-keys/tombstone.js'

/** In-memory store (mirrors the harness in sync.test.ts). */
function inlineMemory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function gc(c: string, col: string) {
    let comp = store.get(c); if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col); if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
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

/** A crypto-shred tombstone as `buildTombstone` mints it. */
function tombstoneEnv(v: number, ts = new Date().toISOString()): EncryptedEnvelope {
  return { _noydb: 1, _v: v, _ts: ts, _iv: '', _data: '' }
}

interface Note { body: string; subjectId?: string }
const V = 'V1'
```

Run file: `pnpm vitest run packages/hub/__tests__/sync-tombstone-terminal.test.ts`

---

### Task 1: `isTombstoneShape` predicate

**Files:**
- Modify: `packages/hub/src/kernel/enclave/record-keys/tombstone.ts`
- Create (Test): `packages/hub/__tests__/sync-tombstone-terminal.test.ts` (harness above + this describe)

**Interfaces:**
- Produces: `isTombstoneShape(envelope: EncryptedEnvelope): boolean` exported from `src/kernel/enclave/record-keys/tombstone.js` — Tasks 3/4 import it into `sync.ts`.

- [ ] **Step 1: Write the failing test** — create the test file with the shared harness, then append:

```ts
describe('isTombstoneShape', () => {
  it('recognises the buildTombstone shape and nothing else', () => {
    expect(isTombstoneShape(tombstoneEnv(3))).toBe(true)
    // live encrypted envelope: non-empty _data
    expect(isTombstoneShape({ _noydb: 1, _v: 1, _ts: 'x', _iv: 'abc', _data: 'ciphertext' })).toBe(false)
    // unencrypted record envelope: non-empty JSON _data, empty _iv
    expect(isTombstoneShape({ _noydb: 1, _v: 1, _ts: 'x', _iv: '', _data: '{"a":1}' })).toBe(false)
    // _sync meta shape: empty _iv, non-empty _data
    expect(isTombstoneShape({ _noydb: 1, _v: 1, _ts: 'x', _iv: '', _data: '{"dirty":[]}' })).toBe(false)
    // empty _data but a wrapped CEK present → not a shred
    expect(isTombstoneShape({ _noydb: 1, _v: 1, _ts: 'x', _iv: '', _data: '', _cek: 'wrapped' })).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/hub/__tests__/sync-tombstone-terminal.test.ts`
Expected: FAIL — `isTombstoneShape` is not exported.

- [ ] **Step 3: Implement** — in `tombstone.ts`, add below `isTombstone` and make `isTombstone` delegate:

```ts
/**
 * Shape-only tombstone recognition for layers that have no per-collection
 * context (the sync engine, #590): a tombstone carries an empty `_data` and
 * no wrapped CEK. No live envelope can match — record bodies never serialize
 * to the empty string (the `_sync` meta envelope carries non-empty `_data`,
 * and legacy migration envelopes carry non-empty `_iv`/`_data`).
 */
export function isTombstoneShape(envelope: EncryptedEnvelope): boolean {
  return envelope._data === '' && envelope._cek === undefined
}
```

and change the body of `isTombstone` to:

```ts
export function isTombstone(envelope: EncryptedEnvelope, encrypted: boolean): boolean {
  if (!encrypted) return false
  return isTombstoneShape(envelope)
}
```

- [ ] **Step 4: Run test to verify it passes** — same command, expected: PASS.

- [ ] **Step 5: Regression + commit**

```bash
pnpm vitest run packages/hub/src/kernel packages/hub/__tests__/forget-sealed-erasure.test.ts
git add packages/hub/src/kernel/enclave/record-keys/tombstone.ts packages/hub/__tests__/sync-tombstone-terminal.test.ts
git commit -m "feat(hub): shape-only tombstone predicate for context-free layers (#590)"
```

---

### Task 2: Types — `ErasureEnforcement`, `erasures` on results, `'sync:erasure'` event

**Files:**
- Modify: `packages/hub/src/kernel/types.ts` (Conflict/results block ~1188–1285; `NoydbEventMap` ~1334)
- Modify: `packages/hub/src/index.ts` (type export list, `PullResult` is at ~:101)

**Interfaces:**
- Produces (Tasks 3/4 construct these; consumers read them):

```ts
export interface ErasureEnforcement {
  readonly vault: string
  readonly collection: string
  readonly id: string
  /** The winning tombstone (as stored after enforcement). */
  readonly tombstone: EncryptedEnvelope
  /** The live envelope that lost: a suppressed dirty local edit, or the remote copy destroyed by re-assertion. */
  readonly suppressed: EncryptedEnvelope
  readonly direction: 'pull' | 'push'
}
```

- [ ] **Step 1: Add the type** — in `kernel/types.ts`, insert the `ErasureEnforcement` interface (exact code above, with a doc comment referencing #590) directly after the `Conflict` interface.

- [ ] **Step 2: Extend the results** — append to both `PushResult` and `PullResult`:

```ts
  /** #590: tombstone enforcements applied during this run (never resolver-visible). */
  readonly erasures?: ErasureEnforcement[]
```

- [ ] **Step 3: Extend the event map** — in `NoydbEventMap` next to `'sync:pull'`:

```ts
  'sync:erasure': ErasureEnforcement
```

- [ ] **Step 4: Export from the main entry** — in `src/index.ts`, add `ErasureEnforcement,` to the type list containing `PullResult` (~:101). Do NOT touch `src/legacy/kernel.ts`, `src/with-cargo/index.ts`, or `src/legacy/adapter.ts`.

- [ ] **Step 5: Verify + commit**

Run: `pnpm --filter @noy-db/hub typecheck` — expected: PASS.
Run: `pnpm vitest run packages/hub/__tests__/cargo-surface-golden.test.ts packages/hub/__tests__/kernel-surface-golden.test.ts` — expected: PASS (surfaces unchanged). If a golden test fails, you exported into a seam — undo Step 4's location, do not update the golden files.

```bash
git add packages/hub/src/kernel/types.ts packages/hub/src/index.ts
git commit -m "feat(hub): ErasureEnforcement type, erasures on sync results, sync:erasure event (#590)"
```

---

### Task 3: Pull terminal rule + engine-side invalidator plumbing

**Files:**
- Modify: `packages/hub/src/with-party/team/sync.ts` (`pull()` ~:265–343; new private members)
- Test: `packages/hub/__tests__/sync-tombstone-terminal.test.ts` (append describe)

**Interfaces:**
- Consumes: `isTombstoneShape` (Task 1), `ErasureEnforcement` (Task 2).
- Produces (used by Task 4 in push paths, wired by Task 6):
  - `setCacheInvalidator(fn: (collection: string, id: string) => Promise<void>): void` (public)
  - `private applyRemote(collection: string, id: string, envelope: EncryptedEnvelope): Promise<void>`
  - `private reportErasure(collection: string, id: string, tombstone: EncryptedEnvelope, suppressed: EncryptedEnvelope, direction: 'pull' | 'push'): ErasureEnforcement`
  - `private reassertTombstone(collection: string, id: string, tombstone: EncryptedEnvelope, suppressedRemote: EncryptedEnvelope): Promise<ErasureEnforcement>`

- [ ] **Step 1: Write the failing tests** — append to the test file:

```ts
describe('pull tombstone-terminal rule (#590)', () => {
  async function setup(conflict?: 'local-wins') {
    const local = inlineMemory(); const remote = inlineMemory()
    const db = await createNoydb({
      store: local, sync: remote, user: 'u', syncStrategy: withSync(), encrypt: false,
      ...(conflict ? { conflict } : {}),
    })
    const vault = await db.openVault(V)
    const notes = vault.collection<Note>('notes')
    return { local, remote, db, notes }
  }

  it('a remote tombstone beats a newer dirty local edit — enforced, dirty dropped, reported, resolver bypassed', async () => {
    const { local, remote, db, notes } = await setup('local-wins')
    await notes.put('n1', { body: 'v1' })
    await db.push(V)                                      // both sides at _v=1
    await notes.put('n1', { body: 'offline edit' })       // dirty, _v=2
    await remote.put(V, 'notes', 'n1', tombstoneEnv(1))   // another device shredded it

    const events: ErasureEnforcement[] = []
    db.on('sync:erasure', e => events.push(e))
    const pull = await db.pull(V)

    expect((await local.get(V, 'notes', 'n1'))!._data).toBe('')  // enforced despite local-wins + higher local _v
    expect(pull.erasures).toHaveLength(1)
    expect(pull.erasures![0]!.direction).toBe('pull')
    expect(pull.erasures![0]!.suppressed._v).toBe(2)
    expect(pull.conflicts).toHaveLength(0)                       // never a resolvable conflict
    expect(events).toHaveLength(1)

    const push = await db.push(V)
    expect(push.pushed).toBe(0)                                  // suppressed edit is not pushed
    db.close()
  })

  it('a remote tombstone over a non-dirty stale copy applies silently (no erasure report)', async () => {
    const { local, remote, db, notes } = await setup()
    await notes.put('n1', { body: 'v1' })
    await db.push(V)                                      // clean
    await remote.put(V, 'notes', 'n1', tombstoneEnv(1))
    const pull = await db.pull(V)
    expect((await local.get(V, 'notes', 'n1'))!._data).toBe('')
    expect(pull.erasures ?? []).toHaveLength(0)
    db.close()
  })

  it('a local tombstone is never overwritten by a higher-_v live remote — re-asserted outward with a bumped _v', async () => {
    const { local, remote, db, notes } = await setup()
    await notes.put('n1', { body: 'v1' })
    await db.push(V)
    const live = (await remote.get(V, 'notes', 'n1'))!
    await local.put(V, 'notes', 'n1', tombstoneEnv(1))    // local shred residue
    await remote.put(V, 'notes', 'n1', { ...live, _v: 3 }) // offline peer's later edit

    const pull = await db.pull(V)

    expect((await local.get(V, 'notes', 'n1'))!._data).toBe('')
    const remoteEnv = (await remote.get(V, 'notes', 'n1'))!
    expect(remoteEnv._data).toBe('')                       // remote re-tombstoned
    expect(remoteEnv._v).toBe(3)                           // bumped to the suppressed _v
    expect((await local.get(V, 'notes', 'n1'))!._v).toBe(3)
    expect(pull.erasures).toHaveLength(1)
    expect(pull.erasures![0]!.suppressed._v).toBe(3)
    db.close()
  })

  it('re-assert at equal _v: remote live copy is tombstoned without a bump', async () => {
    const { local, remote, db, notes } = await setup()
    await notes.put('n1', { body: 'v1' })
    await db.push(V)
    await local.put(V, 'notes', 'n1', tombstoneEnv(1))
    const pull = await db.pull(V)
    const remoteEnv = (await remote.get(V, 'notes', 'n1'))!
    expect(remoteEnv._data).toBe('')
    expect(remoteEnv._v).toBe(1)
    expect(pull.erasures).toHaveLength(1)
    db.close()
  })

  it('both sides tombstoned: higher _v wins, nothing reported', async () => {
    const { local, remote, db } = await setup()
    await local.put(V, 'notes', 'n1', tombstoneEnv(1))
    await remote.put(V, 'notes', 'n1', tombstoneEnv(4))
    const pull = await db.pull(V)
    expect((await local.get(V, 'notes', 'n1'))!._v).toBe(4)
    expect(pull.erasures ?? []).toHaveLength(0)
    db.close()
  })

  it('modifiedSince never skips an arriving tombstone (but still skips old live envelopes)', async () => {
    const { local, remote, db, notes } = await setup()
    await notes.put('n1', { body: 'v1' })
    await notes.put('n2', { body: 'v1' })
    await db.push(V)
    await remote.put(V, 'notes', 'n1', tombstoneEnv(2, '2000-01-01T00:00:00.000Z'))
    const oldLive = (await remote.get(V, 'notes', 'n2'))!
    await remote.put(V, 'notes', 'n2', { ...oldLive, _v: 2, _ts: '2000-01-01T00:00:00.000Z' })

    await db.pull(V, { modifiedSince: '2020-01-01T00:00:00.000Z' })

    expect((await local.get(V, 'notes', 'n1'))!._data).toBe('')  // tombstone exempt from the filter
    expect((await local.get(V, 'notes', 'n2'))!._v).toBe(1)      // old live envelope still filtered
    db.close()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/hub/__tests__/sync-tombstone-terminal.test.ts`
Expected: the new describe FAILS (tombstones overwritten / no `erasures` field); Task 1's describe still passes.

- [ ] **Step 3: Implement in `sync.ts`**

3a. Import: add `isTombstoneShape` to the imports from a new line: `import { isTombstoneShape } from '../../kernel/enclave/record-keys/tombstone.js'`, and add `ErasureEnforcement` to the type import list from `'../../kernel/types.js'`.

3b. New members on `SyncEngine` (below `pairExpander`):

```ts
  /** #598: refreshes Collection in-memory views after a sync-applied local write. Wired by the vault at open. */
  private cacheInvalidator?: (collection: string, id: string) => Promise<void>

  /** Wire the Collection-cache invalidation hook (#598). Same injection pattern as `setPairExpander`. */
  setCacheInvalidator(fn: (collection: string, id: string) => Promise<void>): void {
    this.cacheInvalidator = fn
  }
```

3c. Private helpers (place near `handleConflict`):

```ts
  /** Apply an envelope to the local store and refresh in-memory views (#598). */
  private async applyRemote(collection: string, id: string, envelope: EncryptedEnvelope): Promise<void> {
    await this.local.put(this.vault, collection, id, envelope)
    await this.cacheInvalidator?.(collection, id)
  }

  /** Record + emit a tombstone enforcement (#590). */
  private reportErasure(
    collection: string, id: string,
    tombstone: EncryptedEnvelope, suppressed: EncryptedEnvelope,
    direction: 'pull' | 'push',
  ): ErasureEnforcement {
    const enforcement: ErasureEnforcement = { vault: this.vault, collection, id, tombstone, suppressed, direction }
    this.emitter.emit('sync:erasure', enforcement)
    return enforcement
  }

  /**
   * Re-assert a local tombstone over a live remote envelope (#590): the shred
   * wins in both directions, regardless of `_v`. Bumps the tombstone to the
   * suppressed envelope's `_v` when higher so per-key version counters stay
   * monotonic on every store; `_by` (the shredding actor) is preserved.
   */
  private async reassertTombstone(
    collection: string, id: string,
    tombstone: EncryptedEnvelope, suppressedRemote: EncryptedEnvelope,
  ): Promise<ErasureEnforcement> {
    let winner = tombstone
    if (suppressedRemote._v > tombstone._v) {
      winner = { ...tombstone, _v: suppressedRemote._v, _ts: new Date().toISOString() }
      await this.applyRemote(collection, id, winner)
    }
    await this.remote.put(this.vault, collection, id, winner)
    return this.reportErasure(collection, id, winner, suppressedRemote, 'pull')
  }
```

3d. Rework `pull()`'s per-record body. Add `const erasures: ErasureEnforcement[] = []` next to `conflicts`. Change the `modifiedSince` filter to:

```ts
          // Partial sync: modifiedSince filter — arriving tombstones are exempt (#590):
          // an erasure must never be skipped by partial sync.
          if (options?.modifiedSince && remoteEnvelope._ts <= options.modifiedSince && !isTombstoneShape(remoteEnvelope)) {
            continue
          }
```

Replace the body of the inner `try` (currently `const localEnvelope = …` through the `// Same version or local is newer` comment) with:

```ts
            const localEnvelope = await this.local.get(this.vault, collName, id)
            const remoteIsTombstone = isTombstoneShape(remoteEnvelope)

            if (!localEnvelope) {
              // New record from remote (tombstones included — durable erasure evidence)
              await this.applyRemote(collName, id, remoteEnvelope)
              pulled++
            } else if (isTombstoneShape(localEnvelope)) {
              if (remoteIsTombstone) {
                // Both shredded — keep the higher version counter
                if (remoteEnvelope._v > localEnvelope._v) await this.applyRemote(collName, id, remoteEnvelope)
              } else {
                // Terminal rule (#590): a tombstone is never overwritten by a live
                // envelope, regardless of _v. Re-assert the shred outward instead.
                erasures.push(await this.reassertTombstone(collName, id, localEnvelope, remoteEnvelope))
              }
            } else if (remoteIsTombstone) {
              // Terminal rule (#590): an arriving tombstone wins over any local live
              // envelope — even a newer, dirty one. Resolvers are never consulted.
              const wasDirty = this.dirty.some(d => d.collection === collName && d.id === id)
              await this.applyRemote(collName, id, remoteEnvelope)
              this.dirty = this.dirty.filter(d => !(d.collection === collName && d.id === id))
              pulled++
              if (wasDirty) erasures.push(this.reportErasure(collName, id, remoteEnvelope, localEnvelope, 'pull'))
            } else if (remoteEnvelope._v > localEnvelope._v) {
              // Remote is newer — check if we have a dirty entry for this
              const isDirty = this.dirty.some(d => d.collection === collName && d.id === id)
              if (isDirty) {
                // Both changed — conflict
                const { handled, conflict } = await this.handleConflict(
                  collName,
                  id,
                  localEnvelope,
                  remoteEnvelope,
                  'pull',
                )
                conflicts.push(conflict)
                if (handled === 'remote') {
                  await this.applyRemote(collName, id, conflict.remote)
                  this.dirty = this.dirty.filter(d => !(d.collection === collName && d.id === id))
                  pulled++
                } else if (handled === 'merged' && conflict.local !== localEnvelope) {
                  const merged = conflict.local
                  await this.applyRemote(collName, id, merged)
                  this.dirty = this.dirty.filter(d => !(d.collection === collName && d.id === id))
                  pulled++
                }
                // 'local' or 'deferred': push handles it
              } else {
                // Remote is newer, no local changes — update
                await this.applyRemote(collName, id, remoteEnvelope)
                pulled++
              }
            }
            // Same version or local is newer — skip (push will handle)
```

Change the result construction to `const result: PullResult = { pulled, conflicts, errors, erasures }`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/hub/__tests__/sync-tombstone-terminal.test.ts`
Expected: PASS (all describes so far).

- [ ] **Step 5: Regression + commit**

```bash
pnpm vitest run packages/hub/__tests__/sync.test.ts packages/hub/__tests__/sync-conflict-policy.test.ts packages/hub/__tests__/sync-partial.test.ts packages/hub/__tests__/sync-transaction.test.ts packages/hub/__tests__/satellites-sync-pair.test.ts packages/hub/__tests__/sync-credentials.test.ts
git add packages/hub/src/with-party/team/sync.ts packages/hub/__tests__/sync-tombstone-terminal.test.ts
git commit -m "fix(hub): pull() treats crypto-shred tombstones as terminal and re-asserts them (#590)"
```

Expected: all regression suites PASS.

---

### Task 4: Push side — unconditional tombstone push + conflict-path enforcement

**Files:**
- Modify: `packages/hub/src/with-party/team/sync.ts` (`push()` ~:170–262 and `pushFiltered()` ~:357–438 — mirror the same changes into BOTH; they are intentionally parallel)
- Test: `packages/hub/__tests__/sync-tombstone-terminal.test.ts` (append describe)

**Interfaces:**
- Consumes: `isTombstoneShape`, `applyRemote`, `reportErasure` (Task 3), `ErasureEnforcement` (Task 2).

- [ ] **Step 1: Write the failing tests** — append:

```ts
describe('push tombstone-terminal rule (#590)', () => {
  async function setup(conflict?: 'local-wins') {
    const local = inlineMemory(); const remote = inlineMemory()
    const db = await createNoydb({
      store: local, sync: remote, user: 'u', syncStrategy: withSync(), encrypt: false,
      ...(conflict ? { conflict } : {}),
    })
    const vault = await db.openVault(V)
    const notes = vault.collection<Note>('notes')
    return { local, remote, db, notes }
  }

  it('a dirty entry whose local envelope is a tombstone pushes unconditionally (no CAS)', async () => {
    const { local, remote, db, notes } = await setup()
    await notes.put('n1', { body: 'v1' })                  // dirty at _v=1
    // remote meanwhile holds a much newer live copy — CAS would refuse
    const liveRemote: EncryptedEnvelope = { _noydb: 1, _v: 9, _ts: new Date().toISOString(), _iv: '', _data: '{"body":"other"}' }
    await remote.put(V, 'notes', 'n1', liveRemote)
    await local.put(V, 'notes', 'n1', tombstoneEnv(1))     // shredded before the push ran

    const push = await db.push(V)

    expect(push.pushed).toBe(1)
    expect((await remote.get(V, 'notes', 'n1'))!._data).toBe('')  // erasure won without CAS
    const again = await db.push(V)
    expect(again.pushed).toBe(0)                                   // entry completed
    db.close()
  })

  it('push ConflictError against a remote tombstone: enforced locally, reported, resolver bypassed', async () => {
    const { local, remote, db, notes } = await setup('local-wins')
    await notes.put('n1', { body: 'v1' })
    await db.push(V)                                       // both at _v=1
    await notes.put('n1', { body: 'offline edit' })        // dirty, _v=2 (CAS expects remote _v=1)
    await remote.put(V, 'notes', 'n1', tombstoneEnv(5))    // shredded elsewhere at _v=5 → CAS mismatch

    const events: ErasureEnforcement[] = []
    db.on('sync:erasure', e => events.push(e))
    const push = await db.push(V)

    expect((await local.get(V, 'notes', 'n1'))!._data).toBe('')   // enforced despite local-wins
    expect(push.erasures).toHaveLength(1)
    expect(push.erasures![0]!.direction).toBe('push')
    expect(push.erasures![0]!.suppressed._v).toBe(2)
    expect(push.conflicts).toHaveLength(0)
    expect(events).toHaveLength(1)
    expect((await db.push(V)).pushed).toBe(0)                     // entry completed, edit never re-pushed
    db.close()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/hub/__tests__/sync-tombstone-terminal.test.ts`
Expected: new describe FAILS (first: `push.pushed` is 0 with the entry stuck on ConflictError; second: local-wins resurrects the remote).

- [ ] **Step 3: Implement in `push()`** — two insertions:

3a. After `const envelope = await this.local.get(…)` / the `if (!envelope)` block, before the inner `try { await this.remote.put(…, entry.version - 1) }`:

```ts
          if (isTombstoneShape(envelope)) {
            // #590: a tombstone push is an erasure assertion — unconditional,
            // no CAS, no conflict resolution. Erasure always wins.
            await this.remote.put(this.vault, entry.collection, entry.id, envelope)
            completed.push(i)
            pushed++
            continue
          }
```

3b. In the `ConflictError` branch, inside `if (remoteEnvelope) {`, wrap the existing `handleConflict` block:

```ts
              if (remoteEnvelope) {
                if (isTombstoneShape(remoteEnvelope)) {
                  // #590: remote already shredded this record — enforce locally,
                  // never resolve. Resolvers must not overrule an erasure.
                  await this.applyRemote(entry.collection, entry.id, remoteEnvelope)
                  erasures.push(this.reportErasure(entry.collection, entry.id, remoteEnvelope, envelope, 'push'))
                  completed.push(i)
                } else {
                  const { handled, conflict } = await this.handleConflict(
                    // … existing block unchanged, except: replace the two
                    // `await this.local.put(this.vault, entry.collection, entry.id, X)`
                    // applies (handled === 'remote' and handled === 'merged') with
                    // `await this.applyRemote(entry.collection, entry.id, X)`
                  )
                }
              }
```

3c. Add `const erasures: ErasureEnforcement[] = []` beside `conflicts` and include `erasures` in the `PushResult` construction.

- [ ] **Step 4: Mirror the exact same three changes into `pushFiltered()`** (it has the identical structure).

- [ ] **Step 5: Run tests to verify they pass** — same command, expected: PASS.

- [ ] **Step 6: Regression + commit**

```bash
pnpm vitest run packages/hub/__tests__/sync.test.ts packages/hub/__tests__/sync-conflict-policy.test.ts packages/hub/__tests__/sync-partial.test.ts packages/hub/__tests__/sync-transaction.test.ts packages/hub/__tests__/satellites-sync-pair.test.ts
git add packages/hub/src/with-party/team/sync.ts packages/hub/__tests__/sync-tombstone-terminal.test.ts
git commit -m "fix(hub): push() asserts tombstones unconditionally and never resolves against them (#590)"
```

---

### Task 5: Forget propagation — `_writeTombstone` enters the dirty log + end-to-end vectors

**Files:**
- Modify: `packages/hub/src/kernel/collection.ts` (`_writeTombstone`, ~:2957–2970 — one added line)
- Test: `packages/hub/__tests__/sync-tombstone-terminal.test.ts` (append describe)

**Interfaces:**
- Consumes: `this.onDirty` (existing `OnDirtyCallback` field on Collection), Tasks 3/4 sync behavior.

- [ ] **Step 1: Write the failing tests** — append (encrypted, REAL `vault.forget()`):

```ts
describe('end-to-end: forget() + sync (#590 exit criteria)', () => {
  async function setup() {
    const local = inlineMemory(); const remote = inlineMemory()
    const db = await createNoydb({
      store: local, sync: remote, user: 'alice', secret: 'hunter2', syncStrategy: withSync(),
      forgetStrategy: withForgetCascade({ subjects: { notes: 'subjectId' } }),
    })
    const vault = await db.openVault(V)
    const notes = vault.collection<Note>('notes', { perRecordKeys: true })
    return { local, remote, db, vault, notes }
  }

  it('the shred rides the push channel: forget → push tombstones the remote', async () => {
    const { remote, db, vault, notes } = await setup()
    await notes.put('n1', { subjectId: 's1', body: 'secret' })
    await db.push(V)
    await vault.forget('s1')
    await db.push(V)
    const remoteEnv = (await remote.get(V, 'notes', 'n1'))!
    expect(remoteEnv._data).toBe('')
    expect(remoteEnv._cek).toBeUndefined()
    db.close()
  })

  it('exit criteria, order pull-then-push: offline higher-_v edit cannot resurrect; tombstoned everywhere, edit reported', async () => {
    const { local, remote, db, vault, notes } = await setup()
    await notes.put('n1', { subjectId: 's1', body: 'secret' })
    await db.push(V)
    const preShred = (await remote.get(V, 'notes', 'n1'))!   // what offline peer B still holds
    await vault.forget('s1')                                  // ledger-attested shred on A
    await remote.put(V, 'notes', 'n1', { ...preShred, _v: preShred._v + 1 })  // B pushed its edit

    const pull = await db.pull(V)
    await db.push(V)

    expect(await notes.get('n1')).toBeNull()                                  // still erased on A
    expect((await local.get(V, 'notes', 'n1'))!._data).toBe('')
    const remoteEnv = (await remote.get(V, 'notes', 'n1'))!
    expect(remoteEnv._data).toBe('')                                          // remote re-tombstoned
    expect(remoteEnv._cek).toBeUndefined()
    expect(remoteEnv._v).toBe(preShred._v + 1)                                // monotonic counter kept
    expect(pull.erasures).toHaveLength(1)                                     // B's edit reported, not applied
    db.close()
  })

  it('exit criteria, order push-then-pull: same convergence', async () => {
    const { local, remote, db, vault, notes } = await setup()
    await notes.put('n1', { subjectId: 's1', body: 'secret' })
    await db.push(V)
    const preShred = (await remote.get(V, 'notes', 'n1'))!
    await vault.forget('s1')
    await remote.put(V, 'notes', 'n1', { ...preShred, _v: preShred._v + 1 })

    await db.push(V)     // unconditional tombstone assertion overwrites B's copy
    await db.pull(V)

    expect(await notes.get('n1')).toBeNull()
    expect((await local.get(V, 'notes', 'n1'))!._data).toBe('')
    expect((await remote.get(V, 'notes', 'n1'))!._data).toBe('')
    db.close()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/hub/__tests__/sync-tombstone-terminal.test.ts`
Expected: first test FAILS (remote keeps the live envelope — the tombstone never entered the dirty log). The order tests may partially pass off Task 3/4 behavior; the push-propagation test must fail.

- [ ] **Step 3: Implement** — in `_writeTombstone` (`kernel/collection.ts`), after the cache-eviction lines (`this.cekCache?.remove(id)`), before `return`:

```ts
    // #590: the shred must ride the sync push channel like any other write —
    // without this the remote keeps the pre-shred envelope (wrapped CEK
    // intact) until a pull re-assertion happens to run.
    await this.onDirty?.(this.name, id, 'put', live._v)
```

- [ ] **Step 4: Run tests to verify they pass** — same command, expected: PASS (whole file).

- [ ] **Step 5: Regression (forget + satellites + kernel ceiling) + commit**

```bash
pnpm vitest run packages/hub/__tests__/forget-sealed-erasure.test.ts packages/hub/__tests__/satellites-forget.test.ts packages/hub/__tests__/embeddings-forget.test.ts
pnpm check:architecture
git add packages/hub/src/kernel/collection.ts packages/hub/__tests__/sync-tombstone-terminal.test.ts
git commit -m "fix(hub): forget() tombstones enter the sync dirty log — the shred propagates on push (#590)"
```

Expected: forget suites PASS; `check:architecture` PASS (the kernel-surface line ratchet has headroom for one line — if it trips, STOP and surface it, do not raise the ceiling).

---

### Task 6: #598 — wire the cache invalidator end to end

**Files:**
- Modify: `packages/hub/src/kernel/vault.ts` (add `_invalidateSyncApplied` near the other `@internal` helpers; `collectionCache` is at :331)
- Modify: `packages/hub/src/kernel/noydb.ts` (`openVault`, immediately after the `const comp = new Vault({ … })` construction that starts at ~:598)
- Test: `packages/hub/__tests__/sync-tombstone-terminal.test.ts` (append describe)

**Interfaces:**
- Consumes: `SyncEngine.setCacheInvalidator` (Task 3), `Collection._invalidateCekCacheEntry` / `_invalidateCacheEntry` (existing), `Noydb._forEachSyncEngine(vault, fn)` (existing, noydb.ts:1485).
- Produces: `Vault._invalidateSyncApplied(collection: string, id: string): Promise<void>` (@internal).

- [ ] **Step 1: Write the failing tests** — append:

```ts
describe('sync-applied writes refresh the Collection cache (#598)', () => {
  it('a pull-applied newer envelope is visible through collection.get without a re-open', async () => {
    const local = inlineMemory(); const remote = inlineMemory()
    const db = await createNoydb({ store: local, sync: remote, user: 'u', syncStrategy: withSync(), encrypt: false })
    const vault = await db.openVault(V)
    const notes = vault.collection<Note>('notes')
    await notes.put('n1', { body: 'v1' })
    await db.push(V)
    expect((await notes.get('n1'))!.body).toBe('v1')          // cache warm

    const env = (await remote.get(V, 'notes', 'n1'))!
    const newer = { ...env, _v: 2, _data: JSON.stringify({ ...JSON.parse(env._data), body: 'v2-from-remote' }) }
    await remote.put(V, 'notes', 'n1', newer)
    await db.pull(V)

    expect((await notes.get('n1'))!.body).toBe('v2-from-remote')  // stale cache would still say v1
    db.close()
  })

  it('an enforced tombstone is immediately unreadable through collection.get (no decrypted residue in memory)', async () => {
    const local = inlineMemory(); const remote = inlineMemory()
    const db = await createNoydb({ store: local, sync: remote, user: 'alice', secret: 'hunter2', syncStrategy: withSync() })
    const vault = await db.openVault(V)
    const notes = vault.collection<Note>('notes', { perRecordKeys: true })
    await notes.put('n1', { subjectId: 's1', body: 'secret' })
    await db.push(V)
    expect((await notes.get('n1'))!.body).toBe('secret')      // cache warm with decrypted record

    await remote.put(V, 'notes', 'n1', tombstoneEnv(1))       // shredded on another device
    await db.pull(V)

    expect(await notes.get('n1')).toBeNull()                  // enforced AND evicted
    db.close()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/hub/__tests__/sync-tombstone-terminal.test.ts`
Expected: both new tests FAIL on the stale-cache assertion (`v1` / `'secret'` still served).

- [ ] **Step 3: Implement `Vault._invalidateSyncApplied`** — in `vault.ts`:

```ts
  /**
   * @internal Sync-applied envelope invalidation (#598): refresh every
   * in-memory view of a record the sync engine rewrote underneath us.
   * No-op for collections not instantiated this session — they hydrate
   * from the store on first use and need no eviction.
   */
  async _invalidateSyncApplied(collection: string, id: string): Promise<void> {
    const coll = this.collectionCache.get(collection)
    if (!coll) return
    coll._invalidateCekCacheEntry(id)
    await coll._invalidateCacheEntry(id)
  }
```

- [ ] **Step 4: Wire it in `Noydb.openVault`** — in `noydb.ts`, directly after the `const comp = new Vault({ … })` statement's closing `})`:

```ts
    // #598: sync-applied writes (pull applies, conflict winners, tombstone
    // enforcement) must refresh Collection in-memory views.
    this._forEachSyncEngine(name, engine => {
      engine.setCacheInvalidator((collection, id) => comp._invalidateSyncApplied(collection, id))
    })
```

- [ ] **Step 5: Run tests to verify they pass** — same command, expected: PASS (entire file).

- [ ] **Step 6: Regression + commit**

```bash
pnpm --filter @noy-db/hub test
git add packages/hub/src/kernel/vault.ts packages/hub/src/kernel/noydb.ts
git commit -m "fix(hub): sync-applied envelopes invalidate Collection caches (#598)"
```

Expected: full hub suite PASS.

---

### Task 7: Verification sweep + changeset

**Files:**
- Create: `.changeset/sync-tombstone-terminal.md`

- [ ] **Step 1: Full verification** (memory: CI runs ESLint — lint locally, not just typecheck)

```bash
pnpm --filter @noy-db/hub test
pnpm --filter @noy-db/hub typecheck
pnpm --filter @noy-db/hub lint
pnpm check:architecture
pnpm vitest run packages/hub/__tests__/cargo-surface-golden.test.ts packages/hub/__tests__/kernel-surface-golden.test.ts
```

Expected: all PASS. Golden surfaces must be UNCHANGED (no update to any `.golden.json`).

- [ ] **Step 2: Changeset**

```markdown
---
'@noy-db/hub': patch
---

Security (#590): sync now treats crypto-shred tombstones as terminal. `pull()` never overwrites a `forget()` tombstone with a live envelope regardless of `_v` and re-asserts the shred outward; `push()` asserts tombstones unconditionally and never conflict-resolves against one (resolvers are bypassed — an erasure cannot be overruled); `forget()` tombstones now enter the sync dirty log so the shred propagates on push. Suppressed edits are reported via `PushResult.erasures` / `PullResult.erasures` and the new `sync:erasure` event (new `ErasureEnforcement` type). Also fixes #598: every sync-applied local write now refreshes the Collection in-memory caches, so same-session readers see sync results (and never a decrypted residue of a shredded record).
```

- [ ] **Step 3: Commit**

```bash
git add .changeset/sync-tombstone-terminal.md
git commit -m "chore: changeset for sync tombstone-terminal rule (#590, #598)"
```

---

### Task 8: PR + issue hygiene

- [ ] **Step 1: Push and open the PR** (no Claude attribution anywhere)

```bash
git push -u origin fix/590-sync-tombstone-terminal
gh pr create --repo vLannaAi/noy-db --title "fix(hub): sync tombstone-terminal rule — forget() survives sync (#590) + sync-applied cache invalidation (#598)" --body "$(cat <<'EOF'
Closes #590. Closes #598.

Implements docs/superpowers/specs/2026-07-08-sync-tombstone-terminal-design.md (milestone: Sync convergence & tombstones).

- `pull()` treats a crypto-shred tombstone as terminal for its record id: never overwritten by a live envelope regardless of `_v`; re-asserted outward (remote re-tombstoned, `_v` bumped to keep counters monotonic).
- `push()` asserts local tombstones unconditionally (no CAS) and never conflict-resolves against a remote tombstone — per-collection resolvers and the db-level strategy are bypassed for erasures.
- `_writeTombstone` enters the sync dirty log, so the shred propagates on the normal push channel.
- Suppressed edits are reported (`erasures` on push/pull results + `sync:erasure` event, new `ErasureEnforcement` type) — never silently applied.
- #598: all sync-applied local writes route through Collection cache invalidation (new `SyncEngine.setCacheInvalidator`, wired vault-side), so enforced tombstones leave no decrypted in-memory residue.
- Seam impact: none — no `/kernel`, `/cargo`, or `/adapter` surface change (golden tests untouched). Resolves the milestone's `port?` to plain `api`.

Known, documented window: a push-only client that edited offline can transiently resurrect the remote copy; the first sync by any tombstone-holder re-tombstones it. A dumb ciphertext store cannot enforce this server-side.

Exit-criteria conformance vector (forget on A + concurrent higher-`_v` edit on offline B + bidirectional sync in both orders → tombstoned everywhere, edit reported) is in `packages/hub/__tests__/sync-tombstone-terminal.test.ts`.
EOF
)"
```

- [ ] **Step 2: Grep the diff for the pilot-client name** (family hard rule) before requesting review:

Run: `git diff main...HEAD | grep -i "<pilot-client-name>"` — expected: no matches (the operator knows the name; any match blocks the PR).

- [ ] **Step 3: Issue hygiene** — after the PR is open:

```bash
gh issue edit 590 --repo vLannaAi/noy-db --remove-label "surface: port?"
gh issue edit 598 --repo vLannaAi/noy-db --add-label "surface: internal"
```

(#590 stays `surface: api` — the tombstone-terminal semantics + `erasures`/event are api-surface; the envelope shape did not change so `port?` is resolved-out. Milestone title `[api·port?]` gets its `?` resolved only when #589's design also lands — leave the milestone title alone for now.)
