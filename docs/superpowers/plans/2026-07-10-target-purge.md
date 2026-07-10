# Single-Vault Target-Purge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `vault.purgePeriodTargets(name)` — sweep delete markers off the vault's push-only sync targets (`backup`/`archive` roles) for a closed + frozen period.

**Architecture:** Generalize the shipped `Vault._purgeDeleteMarkers` sweep into a store-parameterized `_purgeMarkersOn(store, before)`, add a `_purgePeriodTargets` seam that iterates the vault's push-only targets (via a `getPurgeableTargets()` accessor noydb wires in), and add a `VaultPeriods.purgePeriodTargets` facade that mirrors the shipped `freezePeriod`/`archivePeriod` — companion record, ledger entry, idempotent, chain-immutable — gated on the period being frozen first.

**Tech Stack:** TypeScript, `@noy-db/hub` (tsup + vitest), turbo monorepo. Run tests from repo root with `pnpm vitest run <path>`.

## Global Constraints

- **`surface: api`** — rides the existing `NoydbStore` seam (`loadAll`/`delete` on target stores); no `@noy-db/hub/adapter` change; do not touch `to-*` stores.
- **Role filter is load-bearing:** sweep ONLY `role === 'backup' || role === 'archive'`. `sync-peer` targets MUST be skipped (purging their markers re-opens the #589 resurrection window).
- **Frozen-first gate:** `purgePeriodTargets` requires the period be `kind: 'closed'` AND already frozen (`_period_freezes/<name>` companion present).
- **No push-only targets → write NO companion** and return the period unchanged (re-runnable). A persisted empty companion would make a later run (after a backup target is added) hit the idempotent no-op and silently never sweep it — the #613-I1 black hole. The companion is written only when at least one push-only target exists (even if it swept 0 markers).
- **Never mutate the chained `_periods/<name>` record.** Target-purge state lives in the `_period_target_purges/<name>` companion.
- **Ledger attribution:** `appendPeriodLedgerEntry(..., name, PERIOD_TARGET_PURGES_COLLECTION)` — the trailing collection param MUST be the companion collection, or `verifyBackupIntegrity()` false-fails (the #604-arc regression class).
- **Never add Claude attribution** to commits (family rule). **Grep the diff for the pilot-client name before any commit.**

---

### Task 1: `VaultPeriods.purgePeriodTargets` facade + types

**Files:**
- Modify: `packages/hub/src/with-audit/periods/periods.ts` (add const + two types + `PeriodRecord` fields)
- Modify: `packages/hub/src/with-audit/periods/index.ts` (export the new const + types)
- Modify: `packages/hub/src/with-audit/periods/vault-facade.ts` (`VaultPeriodsDeps.purgeTargets`, `purgePeriodTargets`, `mergeTargetPurge`, 3-way merge in `getPeriod`/`listPeriods`)
- Test: `packages/hub/__tests__/period-target-purge-facade.test.ts` (new)

**Interfaces:**
- Consumes: `periodExclusiveUpperBound`, `PERIOD_FREEZES_COLLECTION`, `PeriodFreezeRecord` (existing, from `periods.ts`); `writeReserved`/`readReserved`/`loadPeriodsCache`/`mergeFreeze`/`mergeArchive` (existing private `VaultPeriods` methods).
- Produces:
  - `PERIOD_TARGET_PURGES_COLLECTION = '_period_target_purges'`
  - `interface TargetPurgeCount { label?: string; role: 'backup' | 'archive'; purgedCount: number }`
  - `interface PeriodTargetPurgeRecord { period: string; purgedAt: string; purgedBy: string; targets: readonly TargetPurgeCount[] }`
  - `PeriodRecord` gains return-only `targetsPurgedAt?`, `targetsPurgedBy?`, `targetsPurged?: readonly TargetPurgeCount[]`
  - `VaultPeriodsDeps.purgeTargets(before: string): Promise<readonly TargetPurgeCount[]>`
  - `VaultPeriods.purgePeriodTargets(name: string): Promise<PeriodRecord>`
  - Task 2 wires `purgeTargets` and adds the `vault.purgePeriodTargets` delegator.

- [ ] **Step 1: Write the failing facade test**

Create `packages/hub/__tests__/period-target-purge-facade.test.ts`. It unit-tests the facade with a plaintext fake store + a stub `purgeTargets`, mirroring the existing `period-archive-facade.test.ts` harness (copy its `memory()` helper and deps shape; `encrypted: false`).

```ts
import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { VaultPeriods } from '../src/with-audit/periods/vault-facade.js'
import { withPeriods } from '../src/with-audit/periods/index.js'
import { PERIOD_TARGET_PURGES_COLLECTION } from '../src/with-audit/periods/periods.js'

function memory(): NoydbStore & { raw(c: string, col: string, id: string): EncryptedEnvelope | undefined } {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const gc = (c: string, col: string) => {
    let a = store.get(c); if (!a) { a = new Map(); store.set(c, a) }
    let b = a.get(col); if (!b) { b = new Map(); a.set(col, b) }
    return b
  }
  return {
    raw: (c, col, id) => store.get(c)?.get(col)?.get(id),
    async get(c, col, id) { return store.get(c)?.get(col)?.get(id) ?? null },
    async put(c, col, id, env) { gc(c, col).set(id, env) },
    async delete(c, col, id) { store.get(c)?.get(col)?.delete(id) },
    async list(c, col) { const m = store.get(c)?.get(col); return m ? [...m.keys()] : [] },
    async loadAll() { return {} as VaultSnapshot },
    async saveAll() {},
  }
}

function makeFacade(purgeTargetsImpl: (before: string) => Promise<readonly { label?: string; role: 'backup' | 'archive'; purgedCount: number }[]>) {
  const adapter = memory()
  let purgeCalls = 0
  const deps = {
    strategy: withPeriods(),
    adapter,
    vault: 'V',
    encrypted: false,
    userId: () => 'alice',
    getDEK: async () => { throw new Error('no crypto in plaintext test') },
    getLedgerOrNull: () => null,
    collection: () => { throw new Error('unused') },
    purgeDeleteMarkers: async () => 0,
    archiveRecords: async () => 0,
    purgeTargets: async (before: string) => { purgeCalls++; return purgeTargetsImpl(before) },
  }
  const periods = new VaultPeriods(deps as any)
  return { periods, adapter, purgeCalls: () => purgeCalls }
}

async function closeAndFreeze(periods: any, name = 'FY26-Q1', endDate = '2026-03-31') {
  await periods.closePeriod({ name, endDate })
  await periods.freezePeriod(name)
}

describe('VaultPeriods.purgePeriodTargets (#615)', () => {
  it('sweeps push-only targets on a frozen period, writes the companion, returns merged fields', async () => {
    const { periods, adapter } = makeFacade(async () => [{ label: 'bkp', role: 'backup', purgedCount: 3 }])
    await closeAndFreeze(periods)
    const out = await periods.purgePeriodTargets('FY26-Q1')
    expect(out.targetsPurged).toEqual([{ label: 'bkp', role: 'backup', purgedCount: 3 }])
    expect(out.targetsPurgedBy).toBe('alice')
    expect(typeof out.targetsPurgedAt).toBe('string')
    expect(adapter.raw('V', PERIOD_TARGET_PURGES_COLLECTION, 'FY26-Q1')).toBeDefined()
  })

  it('throws when the period is not frozen first', async () => {
    const { periods } = makeFacade(async () => [{ role: 'backup', purgedCount: 0 }])
    await periods.closePeriod({ name: 'FY26-Q1', endDate: '2026-03-31' })   // closed but NOT frozen
    await expect(periods.purgePeriodTargets('FY26-Q1')).rejects.toThrow(/must be frozen first|frozen/i)
  })

  it('throws on an absent or opened period', async () => {
    const { periods } = makeFacade(async () => [])
    await expect(periods.purgePeriodTargets('nope')).rejects.toThrow(/no period named|not found/i)
    await closeAndFreeze(periods)
    await periods.openPeriod({ name: 'FY26-Q2', startDate: '2026-04-01', fromPeriod: 'FY26-Q1', carryForward: async () => ({}) })
    await expect(periods.purgePeriodTargets('FY26-Q2')).rejects.toThrow(/only a closed period|closed/i)
  })

  it('no push-only targets → writes NO companion and is re-runnable (no black hole)', async () => {
    let targets: readonly { label?: string; role: 'backup' | 'archive'; purgedCount: number }[] = []
    const { periods, adapter } = makeFacade(async () => targets)
    await closeAndFreeze(periods)
    const first = await periods.purgePeriodTargets('FY26-Q1')
    expect(first.targetsPurged).toBeUndefined()
    expect(adapter.raw('V', PERIOD_TARGET_PURGES_COLLECTION, 'FY26-Q1')).toBeUndefined()  // NO companion
    // a target appears later → a subsequent call DOES sweep + record it
    targets = [{ label: 'bkp', role: 'backup', purgedCount: 1 }]
    const second = await periods.purgePeriodTargets('FY26-Q1')
    expect(second.targetsPurged).toEqual([{ label: 'bkp', role: 'backup', purgedCount: 1 }])
    expect(adapter.raw('V', PERIOD_TARGET_PURGES_COLLECTION, 'FY26-Q1')).toBeDefined()
  })

  it('is idempotent once a companion exists: second call does not re-sweep', async () => {
    const { periods, purgeCalls } = makeFacade(async () => [{ role: 'backup', purgedCount: 2 }])
    await closeAndFreeze(periods)
    const first = await periods.purgePeriodTargets('FY26-Q1')
    const second = await periods.purgePeriodTargets('FY26-Q1')
    expect(second.targetsPurgedAt).toBe(first.targetsPurgedAt)
    expect(purgeCalls()).toBe(1)   // purgeTargets called exactly once
  })

  it('leaves the chained _periods record byte-identical', async () => {
    const { periods, adapter } = makeFacade(async () => [{ role: 'backup', purgedCount: 1 }])
    await closeAndFreeze(periods)
    const before = adapter.raw('V', '_periods', 'FY26-Q1')!._data
    await periods.purgePeriodTargets('FY26-Q1')
    expect(adapter.raw('V', '_periods', 'FY26-Q1')!._data).toBe(before)
  })

  it('getPeriod merges the target-purge fields alongside freeze', async () => {
    const { periods } = makeFacade(async () => [{ label: 'bkp', role: 'backup', purgedCount: 1 }])
    await closeAndFreeze(periods)
    await periods.purgePeriodTargets('FY26-Q1')
    const got = await periods.getPeriod('FY26-Q1')
    expect(got?.targetsPurged?.[0]?.purgedCount).toBe(1)
    expect(got?.frozenAt).toBeDefined()   // freeze merge still works
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/hub/__tests__/period-target-purge-facade.test.ts`
Expected: FAIL — `PERIOD_TARGET_PURGES_COLLECTION` not exported / `purgePeriodTargets` not a function.

- [ ] **Step 3: Add the const, types, and PeriodRecord fields**

In `packages/hub/src/with-audit/periods/periods.ts`, after `PERIOD_ARCHIVES_COLLECTION` (line ~138):

```ts
/** Sibling of {@link PERIODS_COLLECTION} holding target-purge companions (#615). */
export const PERIOD_TARGET_PURGES_COLLECTION = '_period_target_purges'
```

After the `PeriodArchiveRecord` interface (after line ~166), add:

```ts
/** Per-target count of delete markers purged off one push-only sync target (#615). */
export interface TargetPurgeCount {
  readonly label?: string
  readonly role: 'backup' | 'archive'
  readonly purgedCount: number
}

/**
 * Companion record noting that a closed+frozen period's delete markers were
 * swept off the vault's push-only sync targets (#615). Stored in
 * {@link PERIOD_TARGET_PURGES_COLLECTION}, keyed by period name — kept OFF the
 * hash-chained `_periods/<name>` record so target-purge never alters the chain.
 */
export interface PeriodTargetPurgeRecord {
  readonly period: string
  readonly purgedAt: string
  readonly purgedBy: string
  readonly targets: readonly TargetPurgeCount[]
}
```

In `interface PeriodRecord`, after the `archivedRecordCount?` field (line ~245):

```ts
  /** #615 return-only — merged from the `_period_target_purges/<name>` companion
   *  on read; NEVER written into the stored `_periods/<name>` record. Absent =
   *  target-purge not yet run (or the vault has no push-only targets). */
  readonly targetsPurgedAt?: string
  readonly targetsPurgedBy?: string
  readonly targetsPurged?: readonly TargetPurgeCount[]
```

- [ ] **Step 4: Export from the barrel**

In `packages/hub/src/with-audit/periods/index.ts`, add `PERIOD_TARGET_PURGES_COLLECTION,` to the value-export block (beside `PERIOD_ARCHIVES_COLLECTION,`) and `PeriodTargetPurgeRecord,` + `TargetPurgeCount,` to the `export type { ... }` block (beside `PeriodArchiveRecord,`).

- [ ] **Step 5: Add the dep, the method, and the 3-way merges**

In `packages/hub/src/with-audit/periods/vault-facade.ts`:

Extend the import from `./periods.js` to include `PERIOD_TARGET_PURGES_COLLECTION`, `type PeriodTargetPurgeRecord`, and `type TargetPurgeCount`.

Add to `interface VaultPeriodsDeps` (after the `archiveRecords` field, line ~52):

```ts
  /** #615: sweep delete markers off the vault's push-only sync targets. Bound to `vault._purgePeriodTargets`. */
  purgeTargets(before: string): Promise<readonly TargetPurgeCount[]>
```

Add the method (place it right after `archivePeriod`'s closing brace, before `mergeArchive`, line ~247):

```ts
  /**
   * Target-purge a closed period (#615): sweeps delete markers off the vault's
   * PUSH-ONLY sync targets (`backup`/`archive`) via `purgeTargets`, recording a
   * companion `_period_target_purges/<name>` record. `sync-peer` targets are
   * skipped (resurrection risk). NEVER mutates the chained `_periods/<name>`
   * record. Requires the period be frozen first (closed → frozen → target-purged).
   * Idempotent once run; with no push-only targets it writes no companion and
   * is re-runnable.
   */
  async purgePeriodTargets(name: string): Promise<PeriodRecord> {
    const existing = await this.loadPeriodsCache()
    const period = existing.find((p) => p.name === name)
    if (!period) throw new ValidationError(`purgePeriodTargets: no period named "${name}".`)
    if (period.kind !== 'closed') {
      throw new ValidationError(
        `purgePeriodTargets: period "${name}" is "${period.kind}"; only a closed period can be target-purged.`,
      )
    }
    const frozen = await this.readReserved<PeriodFreezeRecord>(PERIOD_FREEZES_COLLECTION, name)
    if (!frozen) {
      throw new ValidationError(
        `purgePeriodTargets: period "${name}" must be frozen first (closed → frozen → target-purged).`,
      )
    }
    const prior = await this.readReserved<PeriodTargetPurgeRecord>(PERIOD_TARGET_PURGES_COLLECTION, name)
    if (prior) return this.mergeTargetPurge(period, prior) // idempotent no-op

    const before = periodExclusiveUpperBound(period.endDate)
    const targets = await this.deps.purgeTargets(before)
    if (targets.length === 0) return period // no push-only targets → no companion, re-runnable

    const record: PeriodTargetPurgeRecord = {
      period: name,
      purgedAt: new Date().toISOString(),
      purgedBy: this.deps.userId(),
      targets,
    }
    const envelope = await this.writeReserved(PERIOD_TARGET_PURGES_COLLECTION, name, record)
    await this.deps.strategy.appendPeriodLedgerEntry(
      this.deps.getLedgerOrNull(),
      this.deps.userId(),
      envelope,
      name,
      PERIOD_TARGET_PURGES_COLLECTION,
    )
    return this.mergeTargetPurge(period, record)
  }

  /** Merge target-purge companion fields into a fresh `PeriodRecord` copy — never mutates `periodCache`. */
  private mergeTargetPurge(period: PeriodRecord, record: PeriodTargetPurgeRecord): PeriodRecord {
    return {
      ...period,
      targetsPurgedAt: record.purgedAt,
      targetsPurgedBy: record.purgedBy,
      targetsPurged: record.targets,
    }
  }
```

Now teach `listPeriods` and `getPeriod` to also merge the target-purge companion. In `listPeriods`, after the archives map is built (after line ~283), add a target-purge map and apply it:

```ts
    const targetPurgeIds = await this.deps.adapter.list(this.deps.vault, PERIOD_TARGET_PURGES_COLLECTION)
    const targetPurges = new Map<string, PeriodTargetPurgeRecord>()
    for (const id of targetPurgeIds) {
      const tp = await this.readReserved<PeriodTargetPurgeRecord>(PERIOD_TARGET_PURGES_COLLECTION, id)
      if (tp) targetPurges.set(tp.period, tp)
    }
```
and in its `all.map(...)` body, after the archive merge line (`if (a) merged = this.mergeArchive(merged, a)`):
```ts
      const tp = targetPurges.get(p.name)
      if (tp) merged = this.mergeTargetPurge(merged, tp)
```

In `getPeriod`, after the archive read + merge (after line ~301), add:
```ts
    const targetPurge = await this.readReserved<PeriodTargetPurgeRecord>(PERIOD_TARGET_PURGES_COLLECTION, name)
    if (targetPurge) merged = this.mergeTargetPurge(merged, targetPurge)
```
(ensure `merged` remains a `let` and the final `return merged` still stands.)

- [ ] **Step 6: Run the facade test to verify it passes**

Run: `pnpm vitest run packages/hub/__tests__/period-target-purge-facade.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 7: Confirm no periods regression**

Run: `pnpm vitest run packages/hub/__tests__/period-archive-facade.test.ts packages/hub/__tests__/period-freeze.test.ts packages/hub/__tests__/periods.test.ts`
Expected: PASS (freeze/archive merging untouched).

- [ ] **Step 8: Commit** (typecheck will report one expected error at `vault.ts` — the unwired `purgeTargets` dep — which Task 2 fixes; note it in the commit body)

```bash
git add packages/hub/src/with-audit/periods/ packages/hub/__tests__/period-target-purge-facade.test.ts
git commit -m "feat(hub): VaultPeriods.purgePeriodTargets — companion, frozen-gated, idempotent (#615)

Facade + types only; the purgeTargets dep is wired into vault.ts in the next task
(whole-tree typecheck is red at vault.ts's VaultPeriods literal until then)."
```

---

### Task 2: Vault sweep seam + noydb accessor + delegator (end-to-end)

**Files:**
- Modify: `packages/hub/src/kernel/vault.ts` (`_purgeMarkersOn` extraction, `_purgePeriodTargets` seam, `getPurgeableTargets` opt+field+default, `purgeTargets` dep wiring, `purgePeriodTargets` delegator)
- Modify: `packages/hub/src/kernel/noydb.ts` (pass `getPurgeableTargets` at the sync-configured Vault site)
- Modify: `packages/hub/__tests__/kernel-api.golden.json` (add `"purgePeriodTargets"` to the `Vault` array)
- Modify: `scripts/check-architecture.mjs` (bump `vault.ts` and, if tripped, `noydb.ts` kernel-surface ceilings)
- Test: `packages/hub/__tests__/period-target-purge.test.ts` (new, e2e with a real backup-role target)

**Interfaces:**
- Consumes: `VaultPeriods.purgePeriodTargets` + `VaultPeriodsDeps.purgeTargets` (Task 1); the shipped `_purgeDeleteMarkers` (to refactor) + `isDeleteMarker` (already imported in `vault.ts`).
- Produces: `vault.purgePeriodTargets(name): Promise<PeriodRecord>` (public); `Vault._purgePeriodTargets(before)` + `Vault._purgeMarkersOn(store, before, collections?)` (`@internal`); a `getPurgeableTargets` Vault option.

- [ ] **Step 1: Write the failing e2e test**

Create `packages/hub/__tests__/period-target-purge.test.ts`. It builds an encrypted vault with a real `backup`-role target, seeds a real (encrypted) delete marker onto the backup store white-box, then target-purges. Harness mirrors `period-archive.test.ts`'s `memory()` (with `.raw()` + `ConflictError` on version mismatch).

```ts
import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { createNoydb } from '../src/kernel/noydb.js'
import { withPeriods } from '../src/with-audit/periods/index.js'
import { withHistory } from '../src/with-commit/history/index.js'
import { withSync } from '../src/with-party/sync/index.js'
import { isDeleteMarker } from '../src/kernel/enclave/index.js'

function memory(): NoydbStore & { raw(c: string, col: string, id: string): EncryptedEnvelope | undefined } {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const gc = (c: string, col: string) => {
    let a = store.get(c); if (!a) { a = new Map(); store.set(c, a) }
    let b = a.get(col); if (!b) { b = new Map(); a.set(col, b) }
    return b
  }
  return {
    raw: (c, col, id) => store.get(c)?.get(col)?.get(id),
    async get(c, col, id) { return store.get(c)?.get(col)?.get(id) ?? null },
    async put(c, col, id, env, ev) { const m = gc(c, col); const ex = m.get(id); if (ev !== undefined && ex && ex._v !== ev) throw Object.assign(new Error('conflict'), { name: 'ConflictError' }); m.set(id, env) },
    async delete(c, col, id) { store.get(c)?.get(col)?.delete(id) },
    async list(c, col) { const m = store.get(c)?.get(col); return m ? [...m.keys()] : [] },
    async loadAll(c) { const comp = store.get(c); const s: VaultSnapshot = {}; if (comp) for (const [n, coll] of comp) { if (!n.startsWith('_')) { const r: Record<string, EncryptedEnvelope> = {}; for (const [id, e] of coll) r[id] = e; s[n] = r } } return s },
    async saveAll(c, data) { for (const [n, recs] of Object.entries(data)) { const m = gc(c, n); for (const [id, e] of Object.entries(recs)) m.set(id, e) } },
  }
}

interface Row { amount: number; date: string }
const V = 'V1'

// Build a vault with the given sync targets; returns the stores for white-box assertions.
async function makeVault(targets: { store: NoydbStore; role: 'backup' | 'archive' | 'sync-peer'; label?: string }[]) {
  const local = memory()
  const db = await createNoydb({
    store: local,
    ...(targets.length > 0 ? { sync: targets } : {}),   // omit sync when empty (withSync still enables _del markers)
    user: 'alice',
    syncStrategy: withSync(),
    periodsStrategy: withPeriods(),
    historyStrategy: withHistory(),
    secret: 'hunter2',
  })
  const vault = await db.openVault(V)
  return { local, db, vault }
}

// Produce a real encrypted delete marker for (col,id) by deleting locally, then return it.
async function realMarker(vault: any, local: ReturnType<typeof memory>, col: string, id: string): Promise<EncryptedEnvelope> {
  const t = vault.collection<Row>(col)
  await t.put(id, { amount: 1, date: '2026-02-01' })
  await t.delete(id)                 // under withSync, delete writes a _del marker (not a physical delete)
  const m = local.raw(V, col, id)!
  expect(isDeleteMarker(m)).toBe(true)
  return m
}

describe('purgePeriodTargets (#615)', () => {
  it('sweeps in-window markers off a backup target; local unaffected; count recorded', async () => {
    const backup = memory()
    const { local, db, vault } = await makeVault([{ store: backup, role: 'backup', label: 'bkp' }])
    const marker = await realMarker(vault, local, 'txns', 'a')
    // seed the same real marker onto the backup with an in-window _ts (white-box, mimics a pushed marker)
    await backup.put(V, 'txns', 'a', { ...marker, _ts: '2026-02-15T00:00:00.000Z' })

    await vault.closePeriod({ name: 'FY26-Q1', endDate: '2026-03-31' })
    await vault.freezePeriod('FY26-Q1')
    const out = await vault.purgePeriodTargets('FY26-Q1')

    expect(out.targetsPurged).toEqual([{ label: 'bkp', role: 'backup', purgedCount: 1 }])
    expect(backup.raw(V, 'txns', 'a')).toBeUndefined()          // marker swept off backup
    db.close()
  })

  it('skips sync-peer targets (their markers survive)', async () => {
    const backup = memory(), peer = memory()
    const { local, db, vault } = await makeVault([
      { store: backup, role: 'backup', label: 'bkp' },
      { store: peer, role: 'sync-peer', label: 'peer' },
    ])
    const marker = await realMarker(vault, local, 'txns', 'a')
    await backup.put(V, 'txns', 'a', { ...marker, _ts: '2026-02-15T00:00:00.000Z' })
    await peer.put(V, 'txns', 'a', { ...marker, _ts: '2026-02-15T00:00:00.000Z' })

    await vault.closePeriod({ name: 'FY26-Q1', endDate: '2026-03-31' })
    await vault.freezePeriod('FY26-Q1')
    const out = await vault.purgePeriodTargets('FY26-Q1')

    expect(out.targetsPurged?.map(t => t.label)).toEqual(['bkp'])   // only the backup swept
    expect(backup.raw(V, 'txns', 'a')).toBeUndefined()
    expect(peer.raw(V, 'txns', 'a')).toBeDefined()                  // sync-peer marker SURVIVES
    db.close()
  })

  it('leaves out-of-window markers on the backup', async () => {
    const backup = memory()
    const { local, db, vault } = await makeVault([{ store: backup, role: 'backup', label: 'bkp' }])
    const marker = await realMarker(vault, local, 'txns', 'late')
    await backup.put(V, 'txns', 'late', { ...marker, _ts: '2026-09-01T00:00:00.000Z' })  // after endDate

    await vault.closePeriod({ name: 'FY26-Q1', endDate: '2026-03-31' })
    await vault.freezePeriod('FY26-Q1')
    await vault.purgePeriodTargets('FY26-Q1')
    expect(backup.raw(V, 'txns', 'late')).toBeDefined()
    db.close()
  })

  it('requires the period be frozen first', async () => {
    const backup = memory()
    const { db, vault } = await makeVault([{ store: backup, role: 'backup' }])
    await vault.closePeriod({ name: 'FY26-Q1', endDate: '2026-03-31' })   // not frozen
    await expect(vault.purgePeriodTargets('FY26-Q1')).rejects.toThrow(/frozen first|frozen/i)
    db.close()
  })

  it('no push-only targets → no companion; verifyBackupIntegrity ok', async () => {
    const { db, vault } = await makeVault([])   // no targets at all
    await vault.closePeriod({ name: 'FY26-Q1', endDate: '2026-03-31' })
    await vault.freezePeriod('FY26-Q1')
    const out = await vault.purgePeriodTargets('FY26-Q1')
    expect(out.targetsPurged).toBeUndefined()
    expect((await vault.verifyBackupIntegrity()).ok).toBe(true)
    db.close()
  })

  it('records the sweep to _period_target_purges (verifyBackupIntegrity stays ok)', async () => {
    const backup = memory()
    const { local, db, vault } = await makeVault([{ store: backup, role: 'backup', label: 'bkp' }])
    const marker = await realMarker(vault, local, 'txns', 'a')
    await backup.put(V, 'txns', 'a', { ...marker, _ts: '2026-02-15T00:00:00.000Z' })
    await vault.closePeriod({ name: 'FY26-Q1', endDate: '2026-03-31' })
    await vault.freezePeriod('FY26-Q1')
    await vault.purgePeriodTargets('FY26-Q1')
    expect((await vault.verifyBackupIntegrity()).ok).toBe(true)   // ledger attributed to _period_target_purges
    db.close()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/hub/__tests__/period-target-purge.test.ts`
Expected: FAIL — `vault.purgePeriodTargets is not a function`.

- [ ] **Step 3: Extract `_purgeMarkersOn` and re-point `_purgeDeleteMarkers`**

In `packages/hub/src/kernel/vault.ts`, replace the body of `_purgeDeleteMarkers` (line ~1344) so it delegates to a new store-parameterized helper:

```ts
  async _purgeDeleteMarkers(before: string, collections?: string[]): Promise<number> {
    return this._purgeMarkersOn(this.adapter, before, collections)
  }

  /**
   * @internal #615. Sweep delete markers with `_ts < before` off ANY store
   * (local adapter or a push-only sync target). Returns the count removed.
   */
  private async _purgeMarkersOn(store: NoydbStore, before: string, collections?: string[]): Promise<number> {
    const snapshot = await store.loadAll(this.name)
    let removed = 0
    for (const [coll, records] of Object.entries(snapshot)) {
      if (collections && !collections.includes(coll)) continue
      for (const [id, env] of Object.entries(records)) {
        if (isDeleteMarker(env) && env._ts < before) {
          await store.delete(this.name, coll, id)
          removed++
        }
      }
    }
    return removed
  }
```

- [ ] **Step 4: Add the `getPurgeableTargets` option, field, default, and the `_purgePeriodTargets` seam**

In `vault.ts`, in the Vault options interface (near the `syncAdapter?` field, line ~522), add:

```ts
    /** #615 — push-only sync targets (backup/archive) this vault may target-purge. Default: none. */
    getPurgeableTargets?: () => readonly { store: NoydbStore; role: 'backup' | 'archive'; label?: string }[]
```

Add a private field + default assignment (near `this.syncAdapter = opts.syncAdapter`, line ~573):

```ts
  private readonly getPurgeableTargets: () => readonly { store: NoydbStore; role: 'backup' | 'archive'; label?: string }[]
```
```ts
    this.getPurgeableTargets = opts.getPurgeableTargets ?? (() => [])
```

Add the seam (place after `_archiveClosedPeriod`, after line ~1382):

```ts
  /**
   * @internal #615. Sweep delete markers with `_ts < before` off each of the
   * vault's push-only sync targets, returning a per-target count. Skips
   * `sync-peer` targets by construction (getPurgeableTargets yields only
   * backup/archive). Never touches the local adapter.
   */
  async _purgePeriodTargets(before: string): Promise<readonly { label?: string; role: 'backup' | 'archive'; purgedCount: number }[]> {
    const out: { label?: string; role: 'backup' | 'archive'; purgedCount: number }[] = []
    for (const t of this.getPurgeableTargets()) {
      const purgedCount = await this._purgeMarkersOn(t.store, before)
      out.push({ ...(t.label !== undefined ? { label: t.label } : {}), role: t.role, purgedCount })
    }
    return out
  }
```

- [ ] **Step 5: Wire the `purgeTargets` dep + the delegator**

In the `new VaultPeriods({ ... })` block (line ~597, after `archiveRecords`), add:

```ts
      purgeTargets: (before) => this._purgePeriodTargets(before),
```

Add the public delegator after the `archivePeriod` delegator (after line ~3460):

```ts
  /**
   * Target-purge a closed+frozen period (#615): sweeps delete markers off the
   * vault's push-only sync targets (`backup`/`archive`), recording a
   * `_period_target_purges` companion + ledger entry, never mutating the chained
   * `_periods` record. `sync-peer` targets are skipped. Requires the period be
   * frozen first. Idempotent; a vault with no push-only targets writes no
   * companion and is re-runnable.
   */
  async purgePeriodTargets(name: string): Promise<PeriodRecord> {
    return this.periods.purgePeriodTargets(name)
  }
```

- [ ] **Step 6: Wire the accessor in noydb.ts (sync-configured site only)**

In `packages/hub/src/kernel/noydb.ts`, at the Vault construction with `targets` in scope (the `syncAdapter: targets.length > 0 ? targets[0]!.store : undefined,` line, ~620), add directly below it:

```ts
      getPurgeableTargets: () =>
        targets
          .filter((t) => t.role === 'backup' || t.role === 'archive')
          .map((t) => ({ store: t.store, role: t.role as 'backup' | 'archive', ...(t.label !== undefined ? { label: t.label } : {}) })),
```
The other two `new Vault({...})` sites (the encrypt-false and reopen fallbacks, ~703 / ~747) have no sync targets; leave them unchanged — the Vault option defaults to `() => []`.

- [ ] **Step 7: Update the kernel-api golden**

In `packages/hub/__tests__/kernel-api.golden.json`, in the `Vault` array, insert `"purgePeriodTargets",` in sorted position (between `"pull"` and `"push"`). Run:

Run: `pnpm vitest run packages/hub/__tests__/kernel-api-surface-golden.test.ts`
Expected: PASS. If it fails with a diff, adjust the JSON to exactly match the reported public method set.

- [ ] **Step 8: Run the e2e test + periods regression**

Run: `pnpm vitest run packages/hub/__tests__/period-target-purge.test.ts packages/hub/__tests__/period-freeze.test.ts packages/hub/__tests__/period-archive.test.ts`
Expected: PASS (6 e2e + freeze + archive all green — the `_purgeMarkersOn` extraction leaves the local freeze path byte-identical).

- [ ] **Step 9: Typecheck, ceilings, lint**

Run: `pnpm --filter @noy-db/hub typecheck` — expected clean (this restores the Task-1 red).
Run: `pnpm check:architecture` — if it fails on a `vault.ts` or `noydb.ts` kernel-surface line-count, edit `scripts/check-architecture.mjs` bumping the tripped file's ceiling UP to the exact reported count, with a one-line ratchet comment in the existing style (e.g. `// Bumped N→M (2026-07-10, #615 target-purge): _purgeMarkersOn + _purgePeriodTargets + delegator.`). Do not lower any other ceiling. Re-run → `✓ Architecture invariants OK`.
Run: `pnpm --filter @noy-db/hub lint` — expected clean.

- [ ] **Step 10: Commit**

```bash
git add packages/hub/src/kernel/vault.ts packages/hub/src/kernel/noydb.ts packages/hub/__tests__/kernel-api.golden.json packages/hub/__tests__/period-target-purge.test.ts scripts/check-architecture.mjs
git commit -m "feat(hub): vault.purgePeriodTargets — sweep push-only sync targets, end-to-end (#615)"
```

---

### Task 3: Documentation

**Files:**
- Modify: `packages/hub/src/with-audit/periods/periods.ts` (module doc — add a "## Target-purge" section)
- Modify: `docs/subsystems/periods.md` (operator-facing `### purgePeriodTargets(name)` subsection)

**Interfaces:** none (docs only). Consumes the shipped `purgePeriodTargets` behavior.

- [ ] **Step 1: Add the "Target-purge" section to the module doc**

In `packages/hub/src/with-audit/periods/periods.ts`, after the "## Archive" section (before "## Not covered"), add (JSDoc block — every line ` * `-prefixed):

```
 * ## Target-purge
 *
 * ```
 * vault.purgePeriodTargets('FY2026-Q1')
 *   └─► sweeps delete markers (`_ts < periodExclusiveUpperBound(endDate)`) off
 *       the vault's PUSH-ONLY sync targets (backup/archive roles), then records:
 *         ├─ PeriodTargetPurgeRecord written to _period_target_purges/<name>
 *         └─ a ledger entry attributed to _period_target_purges
 * ```
 *
 * Extends freeze's local marker purge to the vault's own remote sinks.
 * `sync-peer` (bidirectional) targets are SKIPPED: purging a marker there
 * re-opens the #589 resurrection window for a client offline before the
 * cutoff, an assertion no single vault can verify. Backup/archive targets are
 * push-only — never pulled from into convergence — so sweeping their markers
 * is safe. Requires the period be frozen first (closed → frozen →
 * target-purged) so the local safe-point is already established. Idempotent
 * once run; a vault with no push-only targets writes no companion and is
 * re-runnable (so a target added later is still swept). Single-vault only —
 * fleet-wide purge across sovereign vaults is klum's concern over
 * `@noy-db/hub/cargo`.
```

- [ ] **Step 2: Add the operator-facing subsection**

In `docs/subsystems/periods.md`, add a `### purgePeriodTargets(name)` subsection immediately after the `### archivePeriod(name)` section. Match the file's heading level + prose style; ~12 lines. Cover: sweeps delete markers off the vault's push-only (`backup`/`archive`) sync targets for a closed+frozen period; `sync-peer` skipped (resurrection risk) and why; frozen-first gate; `_ts` boundary; companion + ledger + idempotent; no-push-only-targets writes no companion (re-runnable); single-vault only (fleet → klum).

- [ ] **Step 3: Verify docs don't break gates**

Run: `pnpm --filter @noy-db/hub typecheck` (a malformed block comment breaks it) — expected clean.
Run: `pnpm check:architecture` — expected OK (periods.ts is not line-ceiled; if it unexpectedly trips, report it, don't guess).

- [ ] **Step 4: Commit**

```bash
git add packages/hub/src/with-audit/periods/periods.ts docs/subsystems/periods.md
git commit -m "docs(hub): document the period target-purge phase (#615)"
```

---

## Final steps (after all tasks — handled by the execution skill)

- Full hub suite: `pnpm --filter @noy-db/hub test` — expect green.
- `pnpm check:architecture` + `pnpm --filter @noy-db/hub typecheck && lint` — all clean.
- Author a changeset: `pnpm changeset` → `@noy-db/hub: minor` (new public `vault.purgePeriodTargets`), one-line summary referencing #615. (`.changeset/` is gitignored/local — ships next release with the stacked #589/#590/#604/#613 changesets.)
- The whole-branch review is the net for cross-task issues — re-verify the ledger attribution (`_period_target_purges`, not `_periods`), the `_purgeMarkersOn` extraction leaving the local freeze path identical, and the no-push-only-targets re-runnability (no black hole).
- PR against `main` from `feat/615-target-purge`; do NOT merge (human gate).
