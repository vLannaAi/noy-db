# Role-Gate the Sync Primary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Never pull from a `backup`/`archive` sync target — apply the role→direction policy the fan-out already uses to the *primary* engine too (#616).

**Architecture:** A small, single-file change in `packages/hub/src/kernel/noydb.ts`: `Noydb.sync()` calls `primary.push()` (push-only) instead of `primary.sync()` when the primary's role isn't `sync-peer`, and `Noydb.pull()` returns an empty `PullResult` no-op for a non-`sync-peer` primary. Election is unchanged; the gate is direction-only.

**Tech Stack:** TypeScript, `@noy-db/hub` (tsup + vitest), turbo monorepo. Run tests from repo root with `pnpm vitest run <path>`.

## Global Constraints

- **`surface: internal`** — no public type/API change; do not touch `to-*` stores or `@noy-db/hub/adapter`.
- The gate lives at the **orchestration layer** (`Noydb.sync`/`pull`), NOT inside `SyncEngine` — an explicit `engine.pull()` must still pull. `SyncEngine.role` is a public `readonly` field read directly by the orchestrator.
- **Election unchanged** — the primary stays elected as `targets.find(t => t.role === 'sync-peer') ?? targets[0]`; only its *direction* is gated.
- **No new event** (YAGNI) — consistent with `sync()`'s existing silent push-only degradation for secondaries.
- **Never add Claude attribution** to commits (family rule). **Grep the diff for the pilot-client name before committing.**

---

### Task 1: Role-gate the primary in `Noydb.sync()` / `Noydb.pull()`

**Files:**
- Modify: `packages/hub/src/kernel/noydb.ts` (`emptyPullResult` factory; `sync()` primary call; `pull()` no-op; `pull()` JSDoc)
- Modify: `docs/subsystems/periods.md` (one clause noting push-only is engine-enforced)
- Modify: `scripts/check-architecture.mjs` (bump `noydb.ts` ceiling only if tripped)
- Test: `packages/hub/__tests__/sync-role-gate.test.ts` (new)

**Interfaces:**
- Consumes: `SyncEngine.role` (public `readonly role: SyncTargetRole`), `SyncEngine.push`/`pull`/`sync`, `PullResult` (`{ pulled: number; conflicts: Conflict[]; errors: Error[]; erasures? }`), `PushResult`.
- Produces: no new exported surface — a module-private `emptyPullResult()` factory and the two gated methods.

- [ ] **Step 1: Write the failing tests**

Create `packages/hub/__tests__/sync-role-gate.test.ts`. The `inlineMemory()` helper is copied verbatim from `packages/hub/__tests__/sync-conflict-policy.test.ts` (a plaintext memory store). Plaintext envelopes are seeded directly onto a store the same way that file's `seedRemoteConflict` does.

```ts
import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { ConflictError } from '../src/kernel/errors.js'
import { createNoydb } from '../src/kernel/noydb.js'
import { withSync } from '../src/with-party/sync/index.js'

// Plaintext memory store — copied from sync-conflict-policy.test.ts's inlineMemory().
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

interface Note { title: string }
const V = 'V1'

function liveEnv(data: object, v = 1): EncryptedEnvelope {
  return { _noydb: 1, _v: v, _ts: new Date().toISOString(), _iv: '', _data: JSON.stringify(data) }
}

describe('sync role-gate: push-only sinks are never pulled from (#616)', () => {
  it('db.pull() on a backup-only config is a no-op (does not import from the backup)', async () => {
    const local = inlineMemory(), backup = inlineMemory()
    const db = await createNoydb({ store: local, sync: [{ store: backup, role: 'backup' }], user: 'u', syncStrategy: withSync(), encrypt: false })
    await db.openVault(V)
    await backup.put(V, 'notes', 'x', liveEnv({ title: 'from-backup' }))   // record only on the backup
    const result = await db.pull(V)
    expect(result.pulled).toBe(0)
    expect(await local.get(V, 'notes', 'x')).toBeNull()                    // NOT imported
  })

  it('db.sync() on a backup-only config is push-only', async () => {
    const local = inlineMemory(), backup = inlineMemory()
    const db = await createNoydb({ store: local, sync: [{ store: backup, role: 'backup' }], user: 'u', syncStrategy: withSync(), encrypt: false })
    const v = await db.openVault(V)
    await v.collection<Note>('notes').put('mine', { title: 'local' })      // local record
    await backup.put(V, 'notes', 'theirs', liveEnv({ title: 'from-backup' }))
    const result = await db.sync(V)
    expect(result.pull.pulled).toBe(0)                                     // nothing pulled
    expect(await backup.get(V, 'notes', 'mine')).not.toBeNull()           // local pushed to backup
    expect(await local.get(V, 'notes', 'theirs')).toBeNull()              // backup record NOT pulled
  })

  it('resurrection prevented: a locally-deleted record is not pulled back from a backup', async () => {
    const local = inlineMemory(), backup = inlineMemory()
    const db = await createNoydb({ store: local, sync: [{ store: backup, role: 'backup' }], user: 'u', syncStrategy: withSync(), encrypt: false })
    const v = await db.openVault(V)
    await v.collection<Note>('notes').put('a', { title: 'live' })
    await v.collection<Note>('notes').delete('a')                          // locally deleted (marker under withSync)
    await backup.put(V, 'notes', 'a', liveEnv({ title: 'stale-live' }, 5)) // stale live copy on the backup, higher _v
    await db.pull(V)                                                       // no-op — a sink is never pulled
    expect(await v.collection<Note>('notes').get('a')).toBeNull()         // stays deleted, NOT resurrected
  })

  it('regression: a sync-peer primary still pulls (unchanged)', async () => {
    const local = inlineMemory(), remote = inlineMemory()
    const db = await createNoydb({ store: local, sync: remote, user: 'u', syncStrategy: withSync(), encrypt: false })  // bare store ⇒ sync-peer
    await db.openVault(V)
    await remote.put(V, 'notes', 'x', liveEnv({ title: 'from-peer' }))
    const result = await db.pull(V)
    expect(result.pulled).toBe(1)
    expect(await local.get(V, 'notes', 'x')).not.toBeNull()               // imported
  })

  it('regression: sync-peer primary + backup secondary — primary pulls+pushes, backup push-only', async () => {
    const local = inlineMemory(), remote = inlineMemory(), backup = inlineMemory()
    const db = await createNoydb({
      store: local,
      sync: [{ store: remote, role: 'sync-peer' }, { store: backup, role: 'backup' }],
      user: 'u', syncStrategy: withSync(), encrypt: false,
    })
    const v = await db.openVault(V)
    await v.collection<Note>('notes').put('mine', { title: 'local' })     // local record
    await remote.put(V, 'notes', 'peer', liveEnv({ title: 'from-peer' })) // record on the sync-peer
    await backup.put(V, 'notes', 'sink', liveEnv({ title: 'from-backup' }))
    await db.sync(V)
    expect(await local.get(V, 'notes', 'peer')).not.toBeNull()            // pulled from the sync-peer
    expect(await remote.get(V, 'notes', 'mine')).not.toBeNull()           // pushed to the sync-peer
    expect(await backup.get(V, 'notes', 'mine')).not.toBeNull()           // pushed to the backup
    expect(await local.get(V, 'notes', 'sink')).toBeNull()               // backup secondary NOT pulled from
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/hub/__tests__/sync-role-gate.test.ts`
Expected: the three backup-only tests FAIL (the backup is currently pulled from — `result.pulled` is 1 / records get imported / the deleted record resurrects); the two sync-peer regression tests PASS (their primary is a sync-peer, unaffected).

- [ ] **Step 3: Add the `emptyPullResult` factory**

In `packages/hub/src/kernel/noydb.ts`, add a module-level factory (place it near the other module-scope helpers at the top of the file, or just above the `Noydb` class). `PullResult` is already imported (the `pull`/`sync` signatures use it):

```ts
/** #616: a fresh empty pull result for push-only (backup/archive) targets that are never pulled from. */
const emptyPullResult = (): PullResult => ({ pulled: 0, conflicts: [], errors: [] })
```

- [ ] **Step 4: No-op `Noydb.pull()` for a non-`sync-peer` primary**

Replace `Noydb.pull()` (currently at `noydb.ts:~1285`):

```ts
  /**
   * Pull remote changes to local for a vault. A `backup`/`archive` primary is a
   * push-only sink and is never pulled from (#616) — returns an empty result.
   */
  async pull(vault: string, options?: PullOptions): Promise<PullResult> {
    const engine = this.getSyncEngine(vault)
    if (engine.role !== 'sync-peer') return emptyPullResult()
    return engine.pull(options)
  }
```

- [ ] **Step 5: Role-gate the primary in `Noydb.sync()`**

In `Noydb.sync()` (`noydb.ts:~1294`), replace the unconditional primary call:

```ts
    const primary = this.getSyncEngine(vault)
    const result = await primary.sync(options)
```
with:
```ts
    const primary = this.getSyncEngine(vault)
    const result: { pull: PullResult; push: PushResult } =
      primary.role === 'sync-peer'
        ? await primary.sync(options)
        : { pull: emptyPullResult(), push: await primary.push(options?.push) }
```
Leave the secondary fan-out loop below unchanged.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm vitest run packages/hub/__tests__/sync-role-gate.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 7: Confirm no sync/party regression**

Run: `pnpm vitest run packages/hub/__tests__/sync-conflict-policy.test.ts packages/hub/__tests__/sync-tombstone-terminal.test.ts packages/hub/__tests__/delete-tombstone-convergence.test.ts packages/hub/__tests__/period-target-purge.test.ts`
Expected: PASS — these use a `sync-peer` primary (bare store) or seed backups white-box, so none regress. If any fails, a real config pulled from a backup-as-primary; investigate before continuing.

- [ ] **Step 8: Tighten the docs**

In `docs/subsystems/periods.md`, in the `### purgePeriodTargets(name)` section, adjust the sentence describing why push-only targets are safe so it credits enforcement — e.g. append to the `sync-peer`-skip rationale: "(backup/archive targets are push-only by engine enforcement — never pulled from — see #616)." Keep it to the one clause; do not rewrite the section.

(No change needed to `Noydb.sync()`'s existing JSDoc — it already states "backup/archive targets do push-only"; this task makes the code match it.)

- [ ] **Step 9: Typecheck, ceilings, lint**

Run: `pnpm --filter @noy-db/hub typecheck` — expected clean.
Run: `pnpm check:architecture` — if it fails on a `noydb.ts` kernel-surface line count, bump that entry in `scripts/check-architecture.mjs` UP to the exact reported count with a one-line ratchet comment (`// Bumped N→M (2026-07-10, #616): role-gate the sync primary (emptyPullResult + push-only branch).`). Do not lower any other ceiling. Re-run → `✓ Architecture invariants OK`.
Run: `pnpm --filter @noy-db/hub lint` — expected clean.

- [ ] **Step 10: Commit**

```bash
git add packages/hub/src/kernel/noydb.ts packages/hub/__tests__/sync-role-gate.test.ts docs/subsystems/periods.md scripts/check-architecture.mjs
git commit -m "fix(hub): never pull from a backup/archive sync primary (#616)"
```

---

## Final steps (after the task — handled by the execution skill)

- Full hub suite: `pnpm --filter @noy-db/hub test` — expect green.
- `pnpm check:architecture` + `pnpm --filter @noy-db/hub typecheck && lint` — all clean.
- Author a changeset: `pnpm changeset` → `@noy-db/hub: patch` (internal sync-orchestration fix, no public surface change), one-line summary referencing #616. (`.changeset/` is gitignored/local — ships next release with the other stacked changesets.)
- The whole-branch review re-verifies: the `sync-peer` primary path is untouched; the backup-only path is push-only for both `sync()` and `pull()`; the resurrection test genuinely fails without the fix.
- PR against `main` from `feat/616-role-gate-pull`; do NOT merge (human gate).
