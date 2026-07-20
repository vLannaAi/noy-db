# Period Freeze Implementation Plan (#604, Spec 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `vault.freezePeriod(name)` to the existing `with-audit/periods` subsystem — physically purge the delete markers within a *closed* period's window via the shipped `_purgeDeleteMarkers` seam, recording freeze state in a companion record + a ledger entry, without ever mutating the hash-chained period record.

**Architecture:** A new `VaultPeriods.freezePeriod` (facade) + thin `vault.freezePeriod` delegator, mirroring `closePeriod`. Freeze computes the period's exclusive upper bound (markers are bounded by write-time `_ts`), calls `vault._purgeDeleteMarkers(before)` through a new dep, and writes a companion `_period_freezes/<name>` record (the chained `_periods/<name>` record stays byte-immutable). Freeze fields are merged into returned `PeriodRecord`s on read.

**Tech Stack:** TypeScript ESM, vitest, pnpm. All work in `packages/hub`. Spec: `docs/superpowers/specs/2026-07-09-period-freeze-design.md`.

## Global Constraints

- **No Claude attribution** in any commit message, PR, or changelog (family-wide hard rule).
- **Hub stays portable** — no Node built-ins in `packages/hub/src/**`; `crypto.subtle` only. (`new Date(...)`/`Date.parse` are fine — already used in `writePeriodRecord`.)
- **Frozen seams**: do NOT export new names from `src/legacy/kernel.ts`, `src/with-cargo/index.ts`, `src/legacy/adapter.ts`. New periods types export from the `@noy-db/hub/periods` barrel (`with-audit/periods/index.ts`) only.
- **Chain immutability (the crux):** freeze must NEVER change the stored `_periods/<name>` record's bytes — the inter-period `priorPeriodHash` chain depends on it. Freeze state lives ONLY in `_period_freezes/<name>`; the `frozenAt`/`frozenBy`/`purgedMarkerCount` fields on `PeriodRecord` are **return-only** (merged on read, never persisted into `_periods`).
- **Marker boundary:** freeze purges markers with `_ts < periodExclusiveUpperBound(endDate)` — inclusive of `endDate`, exclusive of anything after. Bare-date `endDate` → next midnight; timestamp `endDate` → +1ms.
- **Opt-in**: everything behind `withPeriods()` / `periodsStrategy` (same as `closePeriod`).
- **Terminal + idempotent:** no `unfreezePeriod`; a second `freezePeriod` on an already-frozen period is a no-op (companion exists → return merged, no re-purge, no second ledger entry).
- **kernel-surface metric** is `readFileSync(file).split('\n').length`. `vault.ts` sits at its ceiling `3997` (`scripts/check-architecture.mjs:894`) with zero slack — bump with a dated note. Adding `vault.freezePeriod` also trips the kernel-api-surface golden (a new Vault method) — update its baseline additively.
- TDD; commands from repo root `/Users/vicio/lanna-db/noy-db`. Branch `feat/604-period-freeze` (created; spec at `ce14492b`).

## Anchors (verified)

- `PeriodRecord`, `ClosePeriodOptions`, `PERIODS_COLLECTION`, `loadPeriods`, `chainAnchor`, `appendPeriodLedgerEntry` in `packages/hub/src/with-audit/periods/periods.ts`.
- `VaultPeriods` class + `VaultPeriodsDeps` + `writePeriodRecord`/`decryptPeriodRecord`/`loadPeriodsCache`/`getPeriod`/`listPeriods` in `.../periods/vault-facade.ts` (`closePeriod` at ~:60, `writePeriodRecord` at ~:192, `getPeriod` at ~:156).
- Barrel `.../periods/index.ts`.
- `vault.closePeriod` delegator at `kernel/vault.ts:3382`; `vault._purgeDeleteMarkers(before, collections?)` at `kernel/vault.ts:1342`; `new VaultPeriods({ strategy: opts.periodsStrategy ?? NO_PERIODS, … })` construction near `kernel/vault.ts:589`.

## Shared test harness

New behavioral tests live in `packages/hub/__tests__/period-freeze.test.ts` (Task 3 creates it). Helper for an encrypted vault with periods + sync (markers require sync):

```ts
import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { ConflictError } from '../src/kernel/errors.js'
import { createNoydb } from '../src/kernel/noydb.js'
import { withSync } from '../src/with-party/sync/index.js'
import { withPeriods } from '../src/with-audit/periods/index.js'
import { withHistory } from '../src/with-commit/history/index.js'
import { isDeleteMarker } from '../src/kernel/enclave/record-keys/tombstone.js'

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
    async put(c, col, id, env, ev) { const coll = gc(c, col); const ex = coll.get(id); if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v); coll.set(id, env) },
    async delete(c, col, id) { store.get(c)?.get(col)?.delete(id) },
    async list(c, col) { const coll = store.get(c)?.get(col); return coll ? [...coll.keys()] : [] },
    async loadAll(c) { const comp = store.get(c); const s: VaultSnapshot = {}; if (comp) for (const [n, coll] of comp) { if (!n.startsWith('_')) { const r: Record<string, EncryptedEnvelope> = {}; for (const [id, e] of coll) r[id] = e; s[n] = r } } return s },
    async saveAll(c, data) { for (const [n, recs] of Object.entries(data)) { const coll = gc(c, n); for (const [id, e] of Object.entries(recs)) coll.set(id, e) } },
  }
}

interface Row { amount: number; date: string }
const V = 'V1'
async function makeVault() {
  const local = memory(); const remote = memory()
  const db = await createNoydb({
    store: local, sync: remote, user: 'alice', secret: 'hunter2',
    syncStrategy: withSync(), periodsStrategy: withPeriods(), historyStrategy: withHistory(),
  })
  return { local, remote, db, vault: await db.openVault(V) }
}
```

Run: `pnpm vitest run packages/hub/__tests__/period-freeze.test.ts`

---

### Task 1: Types, companion collection, and the boundary helper

**Files:**
- Modify: `packages/hub/src/with-audit/periods/periods.ts`
- Modify: `packages/hub/src/with-audit/periods/index.ts` (barrel)
- Test: `packages/hub/src/with-audit/periods/periods.test.ts` (append; create beside source if absent)

**Interfaces:**
- Produces: `PERIOD_FREEZES_COLLECTION` (`'_period_freezes'`), `interface PeriodFreezeRecord { period; frozenAt; frozenBy; purgedMarkerCount }`, `periodExclusiveUpperBound(endDate: string): string`, and three optional return-only fields on `PeriodRecord` (`frozenAt?`, `frozenBy?`, `purgedMarkerCount?`).

- [ ] **Step 1: Write the failing boundary-helper tests** — append to `periods.test.ts`:

```ts
import { periodExclusiveUpperBound } from './periods.js'

describe('periodExclusiveUpperBound (#604)', () => {
  it('bare-date endDate → next midnight (seals through end-of-day)', () => {
    expect(periodExclusiveUpperBound('2026-03-31')).toBe('2026-04-01T00:00:00.000Z')
  })
  it('timestamp endDate → +1ms (seals through that instant)', () => {
    expect(periodExclusiveUpperBound('2026-03-31T17:00:00.000Z')).toBe('2026-03-31T17:00:00.001Z')
  })
  it('a marker at end-of-endDate-day is inside the window; next-day-start is outside', () => {
    const bound = periodExclusiveUpperBound('2026-03-31')
    expect('2026-03-31T23:59:59.999Z' < bound).toBe(true)   // purged
    expect('2026-04-01T00:00:00.000Z' < bound).toBe(false)  // kept
  })
  it('throws on an unparseable endDate', () => {
    expect(() => periodExclusiveUpperBound('not-a-date')).toThrow()
  })
})
```

- [ ] **Step 2: Run — expect FAIL** (`periodExclusiveUpperBound` not exported).

Run: `pnpm vitest run packages/hub/src/with-audit/periods/periods.test.ts`

- [ ] **Step 3: Implement in `periods.ts`.** Add near `PERIODS_COLLECTION`:

```ts
/** Sibling of {@link PERIODS_COLLECTION} holding freeze companions (#604). */
export const PERIOD_FREEZES_COLLECTION = '_period_freezes'

/**
 * Companion record recording that a closed period was frozen (its delete
 * markers physically purged). Stored in {@link PERIOD_FREEZES_COLLECTION},
 * keyed by period name — kept OFF the hash-chained `_periods/<name>` record so
 * freeze never alters the inter-period chain.
 */
export interface PeriodFreezeRecord {
  readonly period: string
  readonly frozenAt: string
  readonly frozenBy: string
  readonly purgedMarkerCount: number
}

/**
 * Exclusive upper bound for a period's delete-marker purge window (#604).
 * Markers carry no business date (empty body), only write-time `_ts`, so freeze
 * purges markers with `_ts < bound`, `bound` being the instant just after the
 * period's inclusive `endDate`: a date-only `endDate` seals through end-of-day
 * → next midnight; a full-timestamp `endDate` seals through that instant → +1ms.
 */
export function periodExclusiveUpperBound(endDate: string): string {
  const ms = Date.parse(endDate)
  if (Number.isNaN(ms)) throw new ValidationError(`freezePeriod: unparseable period endDate "${endDate}".`)
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(endDate)
  return new Date(ms + (dateOnly ? 86_400_000 : 1)).toISOString()
}
```

(`ValidationError` is already imported in `periods.ts`.)

Add the return-only fields to `interface PeriodRecord` (below `openingCollections?`):

```ts
  /** #604 return-only — merged from the `_period_freezes/<name>` companion on
   *  read; NEVER written into the stored `_periods/<name>` record (would break
   *  the hash chain). Absent = not yet frozen. */
  readonly frozenAt?: string
  readonly frozenBy?: string
  readonly purgedMarkerCount?: number
```

- [ ] **Step 4: Barrel** — in `index.ts`, add to the value export `PERIOD_FREEZES_COLLECTION`, `periodExclusiveUpperBound` (beside `PERIODS_COLLECTION`/`loadPeriods`) and to the type export `PeriodFreezeRecord`.

- [ ] **Step 5: Run — expect PASS.** Same command as Step 2. Then `pnpm --filter @noy-db/hub typecheck` → PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/hub/src/with-audit/periods/periods.ts packages/hub/src/with-audit/periods/index.ts packages/hub/src/with-audit/periods/periods.test.ts
git commit -m "feat(hub): period freeze types + exclusive-upper-bound helper (#604)"
```

---

### Task 2: Wire the purge seam into the periods facade

**Files:**
- Modify: `packages/hub/src/with-audit/periods/vault-facade.ts` (`VaultPeriodsDeps`)
- Modify: `packages/hub/src/kernel/vault.ts` (the `new VaultPeriods({ … })` construction, ~:589)

**Interfaces:**
- Produces: `VaultPeriodsDeps.purgeDeleteMarkers(before: string): Promise<number>`, bound to `vault._purgeDeleteMarkers`.

- [ ] **Step 1: Add the dep** — in `vault-facade.ts`, add to `interface VaultPeriodsDeps` (beside `collection`):

```ts
  /** #604: physically purge delete markers with `_ts < before`. Bound to `vault._purgeDeleteMarkers`. */
  purgeDeleteMarkers(before: string): Promise<number>
```

- [ ] **Step 2: Wire it** — in `kernel/vault.ts`, locate the `new VaultPeriods({ … })` deps object (has `strategy: opts.periodsStrategy ?? NO_PERIODS`, `adapter`, `getDEK`, `collection`, …) and add:

```ts
      purgeDeleteMarkers: (before) => this._purgeDeleteMarkers(before),
```

- [ ] **Step 3: Verify + commit**

Run: `pnpm --filter @noy-db/hub typecheck` → PASS (a new required dep with no consumer yet still type-checks; the facade compiles).

```bash
git add packages/hub/src/with-audit/periods/vault-facade.ts packages/hub/src/kernel/vault.ts
git commit -m "feat(hub): expose _purgeDeleteMarkers to the periods facade (#604)"
```

---

### Task 3: `VaultPeriods.freezePeriod` + companion read/write + merge

**Files:**
- Modify: `packages/hub/src/with-audit/periods/vault-facade.ts`
- Test: `packages/hub/__tests__/period-freeze.test.ts` (CREATE with the harness + these describes)

**Interfaces:**
- Consumes: `periodExclusiveUpperBound`, `PERIOD_FREEZES_COLLECTION`, `PeriodFreezeRecord` (Task 1); `purgeDeleteMarkers` dep (Task 2); the existing `writePeriodRecord`/`decryptPeriodRecord`/`loadPeriodsCache`/`appendPeriodLedgerEntry`.
- Produces: `VaultPeriods.freezePeriod(name: string): Promise<PeriodRecord>`; `getPeriod`/`listPeriods` return freeze-merged records.

- [ ] **Step 1: Write the failing tests** — create the test file with the harness, then:

```ts
describe('freezePeriod (#604)', () => {
  it('purges in-window delete markers, records the companion + count, leaves the chained record byte-immutable', async () => {
    const { local, db, vault } = await makeVault()
    const t = vault.collection<Row>('txns')
    await t.put('a', { amount: 1, date: '2026-02-01' }); await db.push(V)
    await t.delete('a'); await db.push(V)                          // delete marker, _ts ~ now (2026-07)
    // Force the marker's _ts into the period window for the test:
    const m = local.raw(V, 'txns', 'a')!; expect(isDeleteMarker(m)).toBe(true)
    await local.put(V, 'txns', 'a', { ...m, _ts: '2026-02-15T00:00:00.000Z' })
    await vault.closePeriod({ name: 'FY26-Q1', endDate: '2026-03-31' })
    const before = local.raw(V, '_periods', 'FY26-Q1')!            // snapshot the chained record bytes

    const frozen = await vault.freezePeriod('FY26-Q1')

    expect(frozen.frozenAt).toBeTruthy()
    expect(frozen.frozenBy).toBe('alice')
    expect(frozen.purgedMarkerCount).toBe(1)
    expect(local.raw(V, 'txns', 'a')).toBeUndefined()             // marker physically gone
    expect(local.raw(V, '_period_freezes', 'FY26-Q1')).toBeDefined()
    const after = local.raw(V, '_periods', 'FY26-Q1')!
    expect(after._iv).toBe(before._iv); expect(after._data).toBe(before._data)  // chained record UNCHANGED
    db.close()
  })

  it('leaves out-of-window markers, live records, and forget-tombstones untouched', async () => {
    const { local, db, vault } = await makeVault()
    const t = vault.collection<Row>('txns', { perRecordKeys: true })
    await t.put('live', { amount: 5, date: '2026-02-01' })
    await t.put('late', { amount: 2, date: '2026-02-01' }); await db.push(V)
    await t.delete('late'); await db.push(V)
    const late = local.raw(V, 'txns', 'late')!
    await local.put(V, 'txns', 'late', { ...late, _ts: '2026-05-10T00:00:00.000Z' })  // deleted AFTER Q1 window
    await t.put('shred', { amount: 9, date: '2026-02-01', subjectId: 's1' } as Row & { subjectId: string })
    await db.push(V)
    // (forget requires a forgetStrategy; if not wired here, assert live+late only and note shred separately)
    await vault.closePeriod({ name: 'FY26-Q1', endDate: '2026-03-31' })

    const frozen = await vault.freezePeriod('FY26-Q1')
    expect(frozen.purgedMarkerCount).toBe(0)                      // 'late' marker is out of window
    expect(local.raw(V, 'txns', 'late')).toBeDefined()           // out-of-window marker kept
    expect((await t.get('live'))!.amount).toBe(5)                 // live untouched
    db.close()
  })

  it('requires a closed period: throws on absent or opened', async () => {
    const { db, vault } = await makeVault()
    await expect(vault.freezePeriod('nope')).rejects.toThrow(/no period named/)
    await vault.closePeriod({ name: 'FY26-Q1', endDate: '2026-03-31' })
    await vault.openPeriod({ name: 'FY26-Q2', startDate: '2026-04-01', fromPeriod: 'FY26-Q1', carryForward: async () => ({}) })
    await expect(vault.freezePeriod('FY26-Q2')).rejects.toThrow(/only a closed period/)
    db.close()
  })

  it('is idempotent: a second freeze is a no-op (no re-purge, no second ledger entry)', async () => {
    const { local, db, vault } = await makeVault()
    const t = vault.collection<Row>('txns')
    await t.put('a', { amount: 1, date: '2026-02-01' }); await db.push(V); await t.delete('a'); await db.push(V)
    const m = local.raw(V, 'txns', 'a')!; await local.put(V, 'txns', 'a', { ...m, _ts: '2026-02-15T00:00:00.000Z' })
    await vault.closePeriod({ name: 'FY26-Q1', endDate: '2026-03-31' })
    const first = await vault.freezePeriod('FY26-Q1')
    const companionBefore = local.raw(V, '_period_freezes', 'FY26-Q1')!
    const second = await vault.freezePeriod('FY26-Q1')
    expect(second.frozenAt).toBe(first.frozenAt)                  // same freeze time (no re-write)
    expect(second.purgedMarkerCount).toBe(1)
    expect(local.raw(V, '_period_freezes', 'FY26-Q1')!._data).toBe(companionBefore._data)  // companion unchanged
    db.close()
  })

  it('getPeriod / listPeriods return the merged freeze fields; a frozen period still rejects writes', async () => {
    const { local, db, vault } = await makeVault()
    const t = vault.collection<Row>('txns')
    await t.put('a', { amount: 1, date: '2026-02-01' }); await db.push(V); await t.delete('a'); await db.push(V)
    const m = local.raw(V, 'txns', 'a')!; await local.put(V, 'txns', 'a', { ...m, _ts: '2026-02-15T00:00:00.000Z' })
    await vault.closePeriod({ name: 'FY26-Q1', endDate: '2026-03-31', dateField: 'date' })
    await vault.freezePeriod('FY26-Q1')

    expect((await vault.getPeriod('FY26-Q1'))!.frozenAt).toBeTruthy()
    expect((await vault.listPeriods()).find(p => p.name === 'FY26-Q1')!.purgedMarkerCount).toBe(1)
    await expect(t.put('b', { amount: 2, date: '2026-02-02' })).rejects.toThrow()  // seal intact
    db.close()
  })
})
```

(If the forget-tombstone assertion needs a `forgetStrategy`, either wire `withForgetCascade({ subjects: { txns: 'subjectId' } })` into `makeVault` for that test or drop the shred line and assert only live+late — the load-bearing claim is "out-of-window markers and live records survive.")

- [ ] **Step 2: Run — expect FAIL** (`vault.freezePeriod` not a function).

Run: `pnpm vitest run packages/hub/__tests__/period-freeze.test.ts`

- [ ] **Step 3: Implement in `vault-facade.ts`.**

3a. Import: add `PERIOD_FREEZES_COLLECTION`, `PeriodFreezeRecord`, `periodExclusiveUpperBound` to the existing import from `./periods.js`.

3b. Refactor the record IO to serve both collections (DRY — `writePeriodRecord`/`decryptPeriodRecord` currently hardcode `PERIODS_COLLECTION`). Replace them with generic helpers and update the 2 existing `writePeriodRecord(record)` call sites (in `closePeriod` and `openPeriod`) to `writeReserved(PERIODS_COLLECTION, record.name, record)`:

```ts
private async writeReserved(collection: string, key: string, value: object): Promise<EncryptedEnvelope> {
  const json = JSON.stringify(value)
  let envelope: EncryptedEnvelope
  if (this.deps.encrypted) {
    const dek = await this.deps.getDEK(collection)
    const { iv, data } = await encrypt(json, dek)
    envelope = { _noydb: NOYDB_FORMAT_VERSION, _v: 1, _ts: new Date().toISOString(), _iv: iv, _data: data, _by: this.deps.userId() }
  } else {
    envelope = { _noydb: NOYDB_FORMAT_VERSION, _v: 1, _ts: new Date().toISOString(), _iv: '', _data: json, _by: this.deps.userId() }
  }
  await this.deps.adapter.put(this.deps.vault, collection, key, envelope)
  return envelope
}

private async readReserved<T>(collection: string, key: string): Promise<T | null> {
  const env = await this.deps.adapter.get(this.deps.vault, collection, key)
  if (!env) return null
  const json = this.deps.encrypted ? await openEnvelopeJson(env, await this.deps.getDEK(collection)) : env._data
  return JSON.parse(json) as T
}
```

Keep `decryptPeriodRecord` (used by `loadPeriodsCache`/`assertTsWritable` decrypt callbacks) as-is, or have it delegate to a shared decrypt of `env` — minimal change: leave `decryptPeriodRecord` untouched and only replace `writePeriodRecord`. (If `writePeriodRecord` is only called by close/open, converting it to `writeReserved` and updating both call sites is the clean DRY move; if that widens the diff more than you like, add `writeReserved`/`readReserved` alongside and leave `writePeriodRecord` for close/open. Either is fine — the tests are the contract.)

3c. Add `freezePeriod` + the merge helper:

```ts
async freezePeriod(name: string): Promise<PeriodRecord> {
  const existing = await this.loadPeriodsCache()
  const period = existing.find((p) => p.name === name)
  if (!period) throw new ValidationError(`freezePeriod: no period named "${name}".`)
  if (period.kind !== 'closed') {
    throw new ValidationError(`freezePeriod: period "${name}" is "${period.kind}"; only a closed period can be frozen.`)
  }
  const prior = await this.readReserved<PeriodFreezeRecord>(PERIOD_FREEZES_COLLECTION, name)
  if (prior) return this.mergeFreeze(period, prior)             // idempotent no-op

  const before = periodExclusiveUpperBound(period.endDate)
  const purgedMarkerCount = await this.deps.purgeDeleteMarkers(before)
  const freeze: PeriodFreezeRecord = { period: name, frozenAt: new Date().toISOString(), frozenBy: this.deps.userId(), purgedMarkerCount }
  const envelope = await this.writeReserved(PERIOD_FREEZES_COLLECTION, name, freeze)
  await this.deps.strategy.appendPeriodLedgerEntry(this.deps.getLedgerOrNull(), this.deps.userId(), envelope, name)
  return this.mergeFreeze(period, freeze)
}

private mergeFreeze(period: PeriodRecord, freeze: PeriodFreezeRecord): PeriodRecord {
  return { ...period, frozenAt: freeze.frozenAt, frozenBy: freeze.frozenBy, purgedMarkerCount: freeze.purgedMarkerCount }
}
```

3d. Merge on read. Change `getPeriod` to merge its companion, and `listPeriods` to merge all companions (read the freeze collection once):

```ts
async getPeriod(name: string): Promise<PeriodRecord | null> {
  const all = await this.loadPeriodsCache()
  const period = all.find((p) => p.name === name)
  if (!period) return null
  const freeze = await this.readReserved<PeriodFreezeRecord>(PERIOD_FREEZES_COLLECTION, name)
  return freeze ? this.mergeFreeze(period, freeze) : period
}
```

For `listPeriods()` (find its current body), after loading the periods, load the freeze companions once and merge:

```ts
async listPeriods(): Promise<readonly PeriodRecord[]> {
  const all = await this.loadPeriodsCache()
  const freezeIds = await this.deps.adapter.list(this.deps.vault, PERIOD_FREEZES_COLLECTION)
  const freezes = new Map<string, PeriodFreezeRecord>()
  for (const id of freezeIds) {
    const f = await this.readReserved<PeriodFreezeRecord>(PERIOD_FREEZES_COLLECTION, id)
    if (f) freezes.set(f.period, f)
  }
  return all.map((p) => { const f = freezes.get(p.name); return f ? this.mergeFreeze(p, f) : p })
}
```

**IMPORTANT:** do NOT merge freeze fields into `this.periodCache` — the cache feeds the write-guard and must stay = the stored chained records. `mergeFreeze` returns fresh copies only.

- [ ] **Step 4: Run — expect PASS** (all freeze tests). Same command as Step 2.

- [ ] **Step 5: Regression + commit**

```bash
pnpm vitest run packages/hub/__tests__/periods.test.ts packages/hub/__tests__/accounting-periods.test.ts 2>/dev/null || pnpm vitest run -t "period"
git add packages/hub/src/with-audit/periods/vault-facade.ts packages/hub/__tests__/period-freeze.test.ts
git commit -m "feat(hub): VaultPeriods.freezePeriod — companion-record purge, idempotent, chain-immutable (#604)"
```

(Find the existing periods test file name with `ls packages/hub/__tests__ | grep -i period` and run it as the regression — close/open/list/get must still pass, especially the chain.)

---

### Task 4: `vault.freezePeriod` delegator + guards

**Files:**
- Modify: `packages/hub/src/kernel/vault.ts` (delegator beside `closePeriod` at ~:3382)
- Modify: `scripts/check-architecture.mjs` (vault.ts kernel-surface ceiling ~:894)
- Modify: the kernel-api-surface golden baseline (Vault method list)

**Interfaces:**
- Consumes: `VaultPeriods.freezePeriod` (Task 3).
- Produces: `vault.freezePeriod(name: string): Promise<PeriodRecord>`.

- [ ] **Step 1: Add the delegator** — in `vault.ts`, beside `closePeriod`/`openPeriod`/`listPeriods`:

```ts
  /**
   * Freeze a CLOSED period (#604): physically purge the delete markers whose
   * write-time `_ts` falls within the period (≤ `endDate`) via the shipped
   * purge seam, recording a `_period_freezes/<name>` companion + a ledger
   * entry. The closed period is the operator-asserted convergence safe-point
   * #589's markers need; purging re-opens the resurrection window for any peer
   * offline since before the cutoff, so this is deliberate and terminal.
   * Idempotent; requires the periods strategy.
   */
  async freezePeriod(name: string): Promise<PeriodRecord> {
    return this.periods.freezePeriod(name)
  }
```

- [ ] **Step 2: Bump the kernel-surface ceiling** — measure and set:

Run: `awk 'END{print NR+1}' packages/hub/src/kernel/vault.ts` → set `scripts/check-architecture.mjs` line ~894 `'packages/hub/src/kernel/vault.ts'` to that value, with an appended dated note: `// Bumped 3997→<N> (2026-07-09, +<delta>: #604 vault.freezePeriod delegator).`

- [ ] **Step 3: Update the kernel-api-surface golden** — adding a Vault method trips it. Run the surface goldens to see which fails:

Run: `pnpm vitest run -t "surface" packages/hub/__tests__/` (or locate the kernel-api-surface golden test: `ls packages/hub/__tests__ | grep -i surface`). The failing golden lists `freezePeriod` as a new Vault member. Update its baseline `.golden.json` (or the inline expected list) per the test's documented mechanism — **add `freezePeriod` in sorted position; remove/rename nothing.** Re-run → PASS.

- [ ] **Step 4: Verify + commit**

```bash
pnpm --filter @noy-db/hub typecheck
pnpm check:architecture
pnpm vitest run packages/hub/__tests__/period-freeze.test.ts
git add packages/hub/src/kernel/vault.ts scripts/check-architecture.mjs packages/hub/__tests__/*surface*.golden.json packages/hub/__tests__/*surface*.test.ts
git commit -m "feat(hub): vault.freezePeriod delegator + surface guards (#604)"
```

---

### Task 5: Module docs + verification sweep + changeset

**Files:**
- Modify: `packages/hub/src/with-audit/periods/periods.ts` (module docstring — add the freeze phase to the "Closure model" / "Not covered" sections)
- Create: `.changeset/period-freeze.md` (LOCAL — `.changeset/` is gitignored; do NOT `git add` it)

- [ ] **Step 1: Doc the freeze phase** — in the `periods.ts` module docstring, add a short "Freeze" subsection after the closure/opening models: `vault.freezePeriod(name)` physically purges a closed period's delete markers (via the #589 seam), recording a `_period_freezes/<name>` companion + ledger entry; the chained `_periods/<name>` record is never mutated; terminal + idempotent. Move the note that it does NOT purge forget-tombstones/history here. (The `noy-db-docs` subsystem page is a separate cross-repo doc-sync follow-up — note it in the PR, don't edit it here.)

- [ ] **Step 2: Full verification** (lint runs in CI — run it locally)

```bash
pnpm --filter @noy-db/hub test
pnpm --filter @noy-db/hub typecheck
pnpm --filter @noy-db/hub lint
pnpm check:architecture
pnpm vitest run packages/hub/__tests__/cargo-surface-golden.test.ts packages/hub/__tests__/kernel-surface-golden.test.ts
```

Expected: all PASS. Cargo/kernel-surface goldens: the kernel-api-surface golden changed additively in Task 4 (`freezePeriod`); the **cargo** golden must stay UNCHANGED (freezePeriod is not a cargo export). If cargo golden fails, you exported into the wrong seam — undo.

- [ ] **Step 3: Changeset** — create `.changeset/period-freeze.md` (do NOT commit; gitignored):

```markdown
---
'@noy-db/hub': minor
---

Period freeze (#604). `vault.freezePeriod(name)` physically reclaims the space held by a closed accounting period's delete markers — it purges the delete markers whose write-time falls within the period (via the operator-asserted safe-point the closed period provides), records a `_period_freezes/<name>` companion + a tamper-evident ledger entry, and leaves the hash-chained period record byte-immutable. Terminal and idempotent; requires `withPeriods()`. Forget-tombstones, history, and live records are untouched. Closes the `_purgeDeleteMarkers` audit-emission deferred from #589.
```

- [ ] **Step 4: Commit the doc change** (changeset excluded)

```bash
git add packages/hub/src/with-audit/periods/periods.ts
git commit -m "docs(hub): document the period freeze phase (#604)"
```

---

### Task 6: PR

- [ ] **Step 1: Push + open the PR**

```bash
git push -u origin feat/604-period-freeze
gh pr create --repo vLannaAi/noy-db --title "feat(hub): period freeze — reclaim a closed period's delete-marker space (#604)" --body "$(cat <<'EOF'
Closes #604 (Spec 2 of the #589 arc). Spec: docs/superpowers/specs/2026-07-09-period-freeze-design.md. Milestone: Retention: purge, GC & archival.

`vault.freezePeriod(name)` adds the "frozen" phase to the existing accounting-periods subsystem: a *closed* period is the operator-asserted convergence safe-point #589's delete markers need, so freezing it physically purges the markers whose write-time `_ts` falls within the period (`_ts ≤ endDate`, via the shipped `_purgeDeleteMarkers` seam).

- **Chain-immutable:** freeze state lives in a companion `_period_freezes/<name>` record; the hash-chained `_periods/<name>` record is never mutated (a rewrite would break the successor's `priorPeriodHash` once `verifyPeriodChain()` ships). `frozenAt`/`frozenBy`/`purgedMarkerCount` are merged into returned `PeriodRecord`s on read.
- **Marker boundary:** markers carry no business date, so they're bounded by write-time `_ts`; a late-booked delete (in-period business date, deleted after `endDate`) is reclaimed by the next period's freeze — conservative and correct.
- **Audit:** freeze appends a tamper-evident ledger entry — this closes the `_purgeDeleteMarkers` ledger/event emission deferred from #589.
- Terminal + idempotent; opt-in via `withPeriods()`; forget-tombstones/history/live records untouched. `surface: api` — no `/adapter` change.

Out of scope (own later specs / dropped): cold-archival tiering, forget-tombstone/history purge, re-open, scheduled/auto-freeze, cross-vault fleet freeze.

Verification: full hub suite + typecheck + lint + check:architecture; kernel-api-surface golden updated additively for `vault.freezePeriod`; cargo/kernel-surface goldens otherwise unchanged. Changeset local (`@noy-db/hub` minor). Follow-up: noy-db-docs periods subsystem page.
EOF
)"
```

- [ ] **Step 2: Grep the diff for the pilot-client name** (family hard rule):

Run: `git diff main...HEAD | grep -i "<pilot-client-name>"` — expected: no matches.
