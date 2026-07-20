# Period-Driven Cold Archival Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `vault.archivePeriod(name)` — relocate a closed period's in-window sealed records from the hot store to the configured cold tier, keyed to the period's `_ts` upper bound, driving `routeStore`'s existing migration + read-through.

**Architecture:** A surgical extension, not a new subsystem. `routeStore` already does hot/cold migration (`compact()`) + cold read-through (`get()`); the only gap is that `compact()` keys off a *rolling* `coldAfterDays`. We (1) let `compact()` take an explicit `{ before }` cutoff and expose a `coldArchival` capability, (2) add a `Vault._archiveClosedPeriod(before)` seam parallel to the shipped `_purgeDeleteMarkers`, and (3) add a `VaultPeriods.archivePeriod` facade that mirrors the shipped `freezePeriod` exactly — `_period_archives/<name>` companion record, one ledger entry attributed to that companion, idempotent, chain-immutable, return-only merged fields.

**Tech Stack:** TypeScript, `@noy-db/hub` (tsup + vitest), turbo monorepo. Run tests from repo root with `pnpm vitest run <path>`.

## Global Constraints

- **`surface: api`** — rides the existing `NoydbStore` seam; no `@noy-db/hub/adapter` change. Do not touch `to-*` stores.
- **Stores never see plaintext.** Archival bounds by envelope `_ts` (plaintext, envelope-level), NEVER by `record[dateField]` (encrypted). This is why the boundary is `_ts`, matching freeze.
- **Never mutate the chained `_periods/<name>` record.** Freeze/archive state lives in companion records so the inter-period hash chain (`priorPeriodHash`) is never disturbed. Assert byte-immutability in tests.
- **The freeze precedent is the template.** `archivePeriod` mirrors `freezePeriod` (`with-audit/periods/vault-facade.ts:165`) method-for-method: gate → idempotency companion read → seam call → companion write → `appendPeriodLedgerEntry(..., name, <COMPANION_COLLECTION>)` → return merged. The trailing `collection` param on `appendPeriodLedgerEntry` MUST be the companion collection, or the ledger misattributes the put to `_periods` and `verifyBackupIntegrity()` false-fails (the exact CRITICAL #604's whole-branch review caught).
- **Never add Claude attribution** to commits/PRs/CHANGELOGs (family rule). **Grep the diff for the pilot-client name before any commit.**
- Reserved-collection names are `_`-prefixed; `routeStore.isCold` already excludes them via `isInternal()`. Summaries (`_periods` / `_period_freezes` / `_period_archives`) MUST stay hot.

---

### Task 1: `coldArchival` store capability

**Files:**
- Modify: `packages/hub/src/kernel/types.ts` (add optional field to `StoreCapabilities`)
- Modify: `packages/hub/src/with-store/route-store.ts` (set `capabilities` on the returned store)
- Test: `packages/hub/__tests__/route-store.test.ts`

**Interfaces:**
- Consumes: `RouteStoreOptions.age` (existing), `NoydbStore.capabilities` (existing optional).
- Produces: `StoreCapabilities.coldArchival?: boolean`; a `routeStore(...)` return whose `.capabilities.coldArchival === true` iff an `age.cold` route is configured. Task 3's Vault seam reads this.

- [ ] **Step 1: Write the failing test**

Add to `packages/hub/__tests__/route-store.test.ts` (reuse the file's existing in-memory store helper; if it has a local `memStore()`/`memory()` factory, use it — otherwise a minimal `NoydbStore` with Maps):

```ts
describe('coldArchival capability (#613)', () => {
  it('advertises coldArchival when an age.cold route is configured', () => {
    const s = routeStore({ default: memStore(), age: { cold: memStore(), coldAfterDays: 30 } })
    expect(s.capabilities?.coldArchival).toBe(true)
  })
  it('does NOT advertise coldArchival without a cold route', () => {
    const s = routeStore({ default: memStore() })
    expect(s.capabilities?.coldArchival).not.toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/hub/__tests__/route-store.test.ts -t "coldArchival capability"`
Expected: FAIL — `s.capabilities` is `undefined` (routeStore sets no capabilities today).

- [ ] **Step 3: Add the capability field**

In `packages/hub/src/kernel/types.ts`, inside `interface StoreCapabilities`, add after `maxBlobBytes?`:

```ts
  /**
   * true — the store is a tiered router (`routeStore`) with a cold route,
   * so `compact(vault, { before })` can relocate records hot → cold and
   * reads fall through to cold. `vault.archivePeriod()` requires this.
   */
  coldArchival?: boolean
```

- [ ] **Step 4: Set `capabilities` on the routed store**

In `packages/hub/src/with-store/route-store.ts`, just before `const store: RoutedNoydbStore = {` (the `// ── Store methods ──` block, ~line 496), add:

```ts
  // #613: advertise cold-archival when a cold route exists. Spread the
  // primary's capabilities so CAS/auth/etc. still surface; layer the flag.
  const capabilities: StoreCapabilities | undefined = opts.age?.cold
    ? ({ ...primary.capabilities, coldArchival: true } as StoreCapabilities)
    : primary.capabilities
```

Then add `capabilities,` as the second property of the returned `store` object (right after `name: buildName(),`). Add `StoreCapabilities` to the existing `import type { ... } from '../kernel/types.js'` block if not already imported.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run packages/hub/__tests__/route-store.test.ts -t "coldArchival capability"`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/hub/src/kernel/types.ts packages/hub/src/with-store/route-store.ts packages/hub/__tests__/route-store.test.ts
git commit -m "feat(hub): routeStore advertises a coldArchival capability (#613)"
```

---

### Task 2: `compact(vault, { before })` — explicit period cutoff + optional `coldAfterDays`

**Files:**
- Modify: `packages/hub/src/with-store/route-store.ts` (`AgeRoute.coldAfterDays` optional, `isCold` gains `before`, `compact` gains `opts`, interface decl)
- Test: `packages/hub/__tests__/route-store.test.ts`

**Interfaces:**
- Consumes: `isCold`, `compact` (existing internals).
- Produces: `RoutedNoydbStore.compact(vault: string, opts?: { before?: string }): Promise<number>` — with `opts.before`, migrates records with `_ts < before`; skips `_`-prefixed collections; requires `age.cold`. `AgeRoute.coldAfterDays` becomes optional (`age: { cold }` alone = period-driven only, no rolling compact). Task 3's Vault seam calls `compact(vault, { before })`.

- [ ] **Step 1: Write the failing tests**

Add to `packages/hub/__tests__/route-store.test.ts`:

```ts
describe('compact({ before }) — explicit cutoff (#613)', () => {
  const env = (ts: string): EncryptedEnvelope => ({
    _noydb: 1, _v: 1, _ts: ts, _iv: '', _data: 'x',
  })

  it('migrates only records with _ts < before, leaving newer ones hot', async () => {
    const hot = memStore(), cold = memStore()
    const s = routeStore({ default: hot, age: { cold } })   // no coldAfterDays
    await hot.put('V', 'txns', 'old', env('2026-01-01T00:00:00.000Z'))
    await hot.put('V', 'txns', 'new', env('2026-09-01T00:00:00.000Z'))

    const migrated = await s.compact('V', { before: '2026-04-01T00:00:00.000Z' })

    expect(migrated).toBe(1)
    expect(await hot.get('V', 'txns', 'old')).toBeNull()          // moved out of hot
    expect(await cold.get('V', 'txns', 'old')).not.toBeNull()     // now in cold
    expect(await hot.get('V', 'txns', 'new')).not.toBeNull()      // untouched
    expect(await s.get('V', 'txns', 'old')).not.toBeNull()        // read-through still finds it
  })

  it('never migrates _-prefixed reserved collections', async () => {
    const hot = memStore(), cold = memStore()
    const s = routeStore({ default: hot, age: { cold } })
    await hot.put('V', '_periods', 'FY26', env('2020-01-01T00:00:00.000Z'))

    const migrated = await s.compact('V', { before: '2026-01-01T00:00:00.000Z' })

    expect(migrated).toBe(0)
    expect(await hot.get('V', '_periods', 'FY26')).not.toBeNull()  // summary stays hot
  })

  it('rolling compact() migrates nothing when coldAfterDays is omitted', async () => {
    const hot = memStore(), cold = memStore()
    const s = routeStore({ default: hot, age: { cold } })
    await hot.put('V', 'txns', 'old', env('2000-01-01T00:00:00.000Z'))

    expect(await s.compact('V')).toBe(0)                           // no rolling cutoff configured
    expect(await hot.get('V', 'txns', 'old')).not.toBeNull()
  })
})
```

(If `EncryptedEnvelope` isn't already imported in the test file, add `import type { EncryptedEnvelope } from '../src/kernel/types.js'`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/hub/__tests__/route-store.test.ts -t "compact"`
Expected: FAIL — `compact` ignores the second arg / `coldAfterDays` is required by the type (TS error) / rolling path throws on `undefined * ...`.

- [ ] **Step 3: Make `coldAfterDays` optional**

In `packages/hub/src/with-store/route-store.ts`, `interface AgeRoute`, change:

```ts
  /** Days after last modification before a record is cold-eligible. */
  readonly coldAfterDays: number
```
to:
```ts
  /**
   * Days after last modification before a record is cold-eligible for the
   * ROLLING `compact(vault)` migrator. Omit for period-driven archival only
   * (`compact(vault, { before })`), where the cutoff is supplied per call.
   */
  readonly coldAfterDays?: number
```

- [ ] **Step 4: Teach `isCold` an explicit cutoff**

Replace the `isCold` function body (`packages/hub/src/with-store/route-store.ts:485`) with:

```ts
  function isCold(collection: string, envelope: EncryptedEnvelope, before?: string): boolean {
    if (!opts.age) return false
    if (isInternal(collection)) return false
    if (opts.age.collections && opts.age.collections.length > 0) {
      if (!opts.age.collections.includes(collection)) return false
    }
    // explicit period cutoff wins; else the rolling age cutoff; else nothing is cold
    const cutoffIso =
      before ??
      (opts.age.coldAfterDays != null
        ? new Date(Date.now() - opts.age.coldAfterDays * 24 * 60 * 60 * 1000).toISOString()
        : undefined)
    if (cutoffIso === undefined) return false
    return envelope._ts < cutoffIso
  }
```

(Note: comparison is now ISO-string `<` for the explicit path — `_ts` is an ISO `toISOString()` string, so lexicographic order matches chronological order; the rolling path uses the same ISO comparison for consistency.)

- [ ] **Step 5: Teach `compact` the `before` option + update the interface**

Update the interface declaration (`packages/hub/src/with-store/route-store.ts:234`):

```ts
  /**
   * Migrate records to the cold store. Only applies when `age.cold` is
   * configured. With `{ before }`, migrates records whose `_ts < before`
   * (period-driven archival); without, uses the rolling `coldAfterDays`.
   * Returns the number of records migrated.
   */
  compact(vault: string, opts?: { before?: string }): Promise<number>
```

Update the implementation (`async compact(vault) {` ~line 594):

```ts
    async compact(vault, compactOpts) {
      if (!opts.age) return 0
      let migrated = 0
      const collections = opts.age.collections?.length
        ? opts.age.collections
        : await primary.list(vault, '').catch(() => [] as string[])

      for (const collection of collections) {
        const ids = await primary.list(vault, collection).catch(() => [] as string[])
        for (const id of ids) {
          const envelope = await primary.get(vault, collection, id)
          if (!envelope) continue
          if (isCold(collection, envelope, compactOpts?.before)) {
            await opts.age.cold.put(vault, collection, id, envelope)
            await primary.delete(vault, collection, id)
            migrated++
          }
        }
      }
      return migrated
    },
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm vitest run packages/hub/__tests__/route-store.test.ts`
Expected: PASS (all route-store tests, including the 3 new ones + the Task 1 pair). If pre-existing `compact` tests exist that pass `coldAfterDays`, they must still pass — the rolling path is unchanged.

- [ ] **Step 7: Commit**

```bash
git add packages/hub/src/with-store/route-store.ts packages/hub/__tests__/route-store.test.ts
git commit -m "feat(hub): routeStore.compact({ before }) — explicit period cutoff, optional coldAfterDays (#613)"
```

---

### Task 3: `VaultPeriods.archivePeriod` facade + types (unit-tested)

**Files:**
- Modify: `packages/hub/src/with-audit/periods/periods.ts` (add `PERIOD_ARCHIVES_COLLECTION`, `PeriodArchiveRecord`, `PeriodRecord` archived fields)
- Modify: `packages/hub/src/with-audit/periods/index.ts` (export the new const + type)
- Modify: `packages/hub/src/with-audit/periods/vault-facade.ts` (`VaultPeriodsDeps.archiveRecords`, `archivePeriod`, `mergeArchive`, merge archive in `getPeriod`/`listPeriods`)
- Test: `packages/hub/__tests__/period-archive-facade.test.ts` (new)

**Interfaces:**
- Consumes: `periodExclusiveUpperBound(endDate)` (exported from `periods.ts`), `appendPeriodLedgerEntry` (via `this.deps.strategy`), `writeReserved`/`readReserved`/`loadPeriodsCache`/`mergeFreeze` (existing private methods on `VaultPeriods`).
- Produces:
  - `PERIOD_ARCHIVES_COLLECTION = '_period_archives'`
  - `interface PeriodArchiveRecord { period: string; archivedAt: string; archivedBy: string; archivedRecordCount: number }`
  - `PeriodRecord` gains `archivedAt?`, `archivedBy?`, `archivedRecordCount?` (return-only)
  - `VaultPeriodsDeps.archiveRecords(before: string): Promise<number>`
  - `VaultPeriods.archivePeriod(name: string): Promise<PeriodRecord>`
  - Task 4 wires `archiveRecords` and adds the `vault.archivePeriod` delegator.

- [ ] **Step 1: Write the failing facade test**

Create `packages/hub/__tests__/period-archive-facade.test.ts`. This unit-tests the facade directly with a plaintext fake store + a stub `archiveRecords`, so it needs no routeStore. Model the deps on `kernel/vault.ts`'s `new VaultPeriods({...})` wiring, using `encrypted: false` (so `writeReserved`/`readReserved` skip crypto).

```ts
import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { VaultPeriods } from '../src/with-audit/periods/vault-facade.js'
import { withPeriods } from '../src/with-audit/periods/index.js'
import { PERIOD_ARCHIVES_COLLECTION } from '../src/with-audit/periods/periods.js'

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

function makeFacade() {
  const adapter = memory()
  let archiveArg: string | undefined
  const deps = {
    strategy: withPeriods(),
    adapter,
    vault: 'V',
    encrypted: false,
    userId: () => 'alice',
    getDEK: async () => { throw new Error('no crypto in plaintext test') },
    getLedgerOrNull: () => null,          // history off → appendPeriodLedgerEntry no-ops
    collection: () => { throw new Error('unused') },
    purgeDeleteMarkers: async () => 0,
    archiveRecords: async (before: string) => { archiveArg = before; return 2 },
  }
  const periods = new VaultPeriods(deps as any)
  return { periods, adapter, archiveArg: () => archiveArg }
}

describe('VaultPeriods.archivePeriod (#613)', () => {
  it('archives a closed period: calls archiveRecords with the _ts upper bound, writes the companion, returns merged fields', async () => {
    const { periods, adapter, archiveArg } = makeFacade()
    await periods.closePeriod({ name: 'FY26-Q1', endDate: '2026-03-31' })

    const archived = await periods.archivePeriod('FY26-Q1')

    expect(archiveArg()).toBe('2026-04-01T00:00:00.000Z')          // periodExclusiveUpperBound('2026-03-31')
    expect(archived.archivedRecordCount).toBe(2)
    expect(archived.archivedBy).toBe('alice')
    expect(typeof archived.archivedAt).toBe('string')
    expect(adapter.raw('V', PERIOD_ARCHIVES_COLLECTION, 'FY26-Q1')).toBeDefined()  // companion written
  })

  it('throws on an absent or opened period', async () => {
    const { periods } = makeFacade()
    await expect(periods.archivePeriod('nope')).rejects.toThrow(/no period named|not found/i)
    await periods.closePeriod({ name: 'FY26-Q1', endDate: '2026-03-31' })
    await periods.openPeriod({ name: 'FY26-Q2', startDate: '2026-04-01', fromPeriod: 'FY26-Q1', carryForward: async () => ({}) })
    await expect(periods.archivePeriod('FY26-Q2')).rejects.toThrow(/only a closed period|closed/i)
  })

  it('is idempotent: second archive is a no-op (companion unchanged, archiveRecords not called again)', async () => {
    const { periods, adapter } = makeFacade()
    await periods.closePeriod({ name: 'FY26-Q1', endDate: '2026-03-31' })
    const first = await periods.archivePeriod('FY26-Q1')
    const companionBefore = adapter.raw('V', PERIOD_ARCHIVES_COLLECTION, 'FY26-Q1')!._data
    const second = await periods.archivePeriod('FY26-Q1')
    expect(second.archivedAt).toBe(first.archivedAt)
    expect(adapter.raw('V', PERIOD_ARCHIVES_COLLECTION, 'FY26-Q1')!._data).toBe(companionBefore)
  })

  it('leaves the chained _periods record byte-identical (never mutated by archive)', async () => {
    const { periods, adapter } = makeFacade()
    await periods.closePeriod({ name: 'FY26-Q1', endDate: '2026-03-31' })
    const before = adapter.raw('V', '_periods', 'FY26-Q1')!._data
    await periods.archivePeriod('FY26-Q1')
    expect(adapter.raw('V', '_periods', 'FY26-Q1')!._data).toBe(before)
  })

  it('getPeriod merges the archive fields', async () => {
    const { periods } = makeFacade()
    await periods.closePeriod({ name: 'FY26-Q1', endDate: '2026-03-31' })
    await periods.archivePeriod('FY26-Q1')
    const got = await periods.getPeriod('FY26-Q1')
    expect(got?.archivedRecordCount).toBe(2)
    expect(got?.archivedBy).toBe('alice')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/hub/__tests__/period-archive-facade.test.ts`
Expected: FAIL — `PERIOD_ARCHIVES_COLLECTION` not exported / `archivePeriod` not a function.

- [ ] **Step 3: Add the const, record type, and PeriodRecord fields**

In `packages/hub/src/with-audit/periods/periods.ts`, after `PERIOD_FREEZES_COLLECTION` (line 104):

```ts
/** Sibling of {@link PERIODS_COLLECTION} holding archive companions (#613). */
export const PERIOD_ARCHIVES_COLLECTION = '_period_archives'
```

After the `PeriodFreezeRecord` interface (after line 117), add:

```ts
/**
 * Companion record noting that a closed period was cold-archived (its
 * in-window records physically relocated hot → cold). Stored in
 * {@link PERIOD_ARCHIVES_COLLECTION}, keyed by period name — kept OFF the
 * hash-chained `_periods/<name>` record so archive never alters the chain.
 */
export interface PeriodArchiveRecord {
  readonly period: string
  readonly archivedAt: string
  readonly archivedBy: string
  readonly archivedRecordCount: number
}
```

In `interface PeriodRecord`, after the `purgedMarkerCount?` field (line 192):

```ts
  /** #613 return-only — merged from the `_period_archives/<name>` companion on
   *  read; NEVER written into the stored `_periods/<name>` record. Absent = not
   *  yet archived. */
  readonly archivedAt?: string
  readonly archivedBy?: string
  readonly archivedRecordCount?: number
```

- [ ] **Step 4: Export from the barrel**

In `packages/hub/src/with-audit/periods/index.ts`, add `PERIOD_ARCHIVES_COLLECTION,` to the value export block (beside `PERIOD_FREEZES_COLLECTION,`) and `PeriodArchiveRecord,` to the `export type { ... }` block (beside `PeriodFreezeRecord,`).

- [ ] **Step 5: Add the dep, the method, and the merges**

In `packages/hub/src/with-audit/periods/vault-facade.ts`:

Add the import of the new symbols — extend the existing import from `./periods.js` to include `PERIOD_ARCHIVES_COLLECTION` and `type PeriodArchiveRecord`.

Add to `interface VaultPeriodsDeps` (after the `purgeDeleteMarkers` field, line 48):

```ts
  /** #613: relocate a closed period's in-window records hot → cold. Bound to `vault._archiveClosedPeriod`. */
  archiveRecords(before: string): Promise<number>
```

Add the method (place it right after `freezePeriod`'s closing brace, ~line 203, before `mergeFreeze`):

```ts
  /**
   * Archive a closed period (#613): physically relocates its in-window
   * records (those with `_ts < periodExclusiveUpperBound(endDate)`) from the
   * hot store to the configured cold tier via `archiveRecords`, and records
   * the fact in a companion `_period_archives/<name>` record. NEVER mutates
   * the hash-chained `_periods/<name>` record. Non-destructive (reads fall
   * through to cold) and idempotent: a second call is a no-op returning the
   * same merged record.
   */
  async archivePeriod(name: string): Promise<PeriodRecord> {
    const existing = await this.loadPeriodsCache()
    const period = existing.find((p) => p.name === name)
    if (!period) throw new ValidationError(`archivePeriod: no period named "${name}".`)
    if (period.kind !== 'closed') {
      throw new ValidationError(
        `archivePeriod: period "${name}" is "${period.kind}"; only a closed period can be archived.`,
      )
    }
    const prior = await this.readReserved<PeriodArchiveRecord>(PERIOD_ARCHIVES_COLLECTION, name)
    if (prior) return this.mergeArchive(period, prior) // idempotent no-op

    const before = periodExclusiveUpperBound(period.endDate)
    const archivedRecordCount = await this.deps.archiveRecords(before)
    const archive: PeriodArchiveRecord = {
      period: name,
      archivedAt: new Date().toISOString(),
      archivedBy: this.deps.userId(),
      archivedRecordCount,
    }
    const envelope = await this.writeReserved(PERIOD_ARCHIVES_COLLECTION, name, archive)
    await this.deps.strategy.appendPeriodLedgerEntry(
      this.deps.getLedgerOrNull(),
      this.deps.userId(),
      envelope,
      name,
      PERIOD_ARCHIVES_COLLECTION,
    )
    return this.mergeArchive(period, archive)
  }

  /** Merge archive companion fields into a fresh `PeriodRecord` copy — never mutates `periodCache`. */
  private mergeArchive(period: PeriodRecord, archive: PeriodArchiveRecord): PeriodRecord {
    return {
      ...period,
      archivedAt: archive.archivedAt,
      archivedBy: archive.archivedBy,
      archivedRecordCount: archive.archivedRecordCount,
    }
  }
```

Ensure `periodExclusiveUpperBound` is imported in `vault-facade.ts` (it already is — used by `freezePeriod`).

Now teach `getPeriod` and `listPeriods` to also merge the archive companion. Replace `getPeriod` (line ~231):

```ts
  /** Look up a single period by name, merged with its freeze + archive companions if any. Returns `null` if not found. */
  async getPeriod(name: string): Promise<PeriodRecord | null> {
    const all = await this.loadPeriodsCache()
    const period = all.find((p) => p.name === name)
    if (!period) return null
    const freeze = await this.readReserved<PeriodFreezeRecord>(PERIOD_FREEZES_COLLECTION, name)
    const archive = await this.readReserved<PeriodArchiveRecord>(PERIOD_ARCHIVES_COLLECTION, name)
    let merged = freeze ? this.mergeFreeze(period, freeze) : period
    if (archive) merged = this.mergeArchive(merged, archive)
    return merged
  }
```

Replace `listPeriods` (line ~216) to also load + merge archives:

```ts
  /** Return every closed / opened period in `closedAt` order, merged with any freeze + archive companions. */
  async listPeriods(): Promise<readonly PeriodRecord[]> {
    const all = await this.loadPeriodsCache()
    const freezeIds = await this.deps.adapter.list(this.deps.vault, PERIOD_FREEZES_COLLECTION)
    const freezes = new Map<string, PeriodFreezeRecord>()
    for (const id of freezeIds) {
      const f = await this.readReserved<PeriodFreezeRecord>(PERIOD_FREEZES_COLLECTION, id)
      if (f) freezes.set(f.period, f)
    }
    const archiveIds = await this.deps.adapter.list(this.deps.vault, PERIOD_ARCHIVES_COLLECTION)
    const archives = new Map<string, PeriodArchiveRecord>()
    for (const id of archiveIds) {
      const a = await this.readReserved<PeriodArchiveRecord>(PERIOD_ARCHIVES_COLLECTION, id)
      if (a) archives.set(a.period, a)
    }
    return all.map((p) => {
      const f = freezes.get(p.name)
      let merged = f ? this.mergeFreeze(p, f) : p
      const a = archives.get(p.name)
      if (a) merged = this.mergeArchive(merged, a)
      return merged
    })
  }
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm vitest run packages/hub/__tests__/period-archive-facade.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 7: Typecheck**

Run: `pnpm --filter @noy-db/hub typecheck`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add packages/hub/src/with-audit/periods/ packages/hub/__tests__/period-archive-facade.test.ts
git commit -m "feat(hub): VaultPeriods.archivePeriod — companion record, idempotent, chain-immutable (#613)"
```

---

### Task 4: Vault seam + delegator + wiring (end-to-end)

**Files:**
- Modify: `packages/hub/src/kernel/vault.ts` (`_archiveClosedPeriod` seam, `archivePeriod` delegator, `archiveRecords` dep wiring)
- Modify: `packages/hub/__tests__/kernel-api.golden.json` (add `archivePeriod` to the `Vault` list)
- Modify: `scripts/check-architecture.mjs` (bump the `vault.ts` kernel-surface ceiling)
- Test: `packages/hub/__tests__/period-archive.test.ts` (new, mirrors `period-freeze.test.ts`)

**Interfaces:**
- Consumes: `RoutedNoydbStore.compact(vault, { before })` + `capabilities.coldArchival` (Tasks 1–2); `VaultPeriods.archivePeriod` + `VaultPeriodsDeps.archiveRecords` (Task 3); the shipped `_purgeDeleteMarkers` wiring as the template.
- Produces: `vault.archivePeriod(name): Promise<PeriodRecord>` (public); `Vault._archiveClosedPeriod(before): Promise<number>` (`@internal`).

- [ ] **Step 1: Write the failing e2e test**

Create `packages/hub/__tests__/period-archive.test.ts`. Harness mirrors `period-freeze.test.ts` but the vault's store is a `routeStore({ default: hot, age: { cold } })` using white-box `memory()` stores exposing `.raw()`:

```ts
import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { createNoydb } from '../src/kernel/noydb.js'
import { withPeriods } from '../src/with-audit/periods/index.js'
import { withHistory } from '../src/with-commit/history/index.js'
import { routeStore } from '../src/with-store/index.js'   // verify this path against route-store.test.ts's import; use whatever it uses

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

async function makeVault() {
  const hot = memory(), cold = memory()
  const db = await createNoydb({
    store: routeStore({ default: hot, age: { cold } }),
    user: 'alice',
    periodsStrategy: withPeriods(),
    historyStrategy: withHistory(),
    secret: 'hunter2',
  })
  const vault = await db.openVault(V)
  return { hot, cold, db, vault }
}

describe('archivePeriod (#613)', () => {
  it('relocates in-window records hot → cold; reads still resolve; count recorded', async () => {
    const { hot, cold, db, vault } = await makeVault()
    const t = vault.collection<Row>('txns')
    await t.put('a', { amount: 1, date: '2026-02-01' })
    // force the record's _ts into the period window (white-box, like period-freeze.test.ts)
    const raw = hot.raw(V, 'txns', 'a')!; await hot.put(V, 'txns', 'a', { ...raw, _ts: '2026-02-15T00:00:00.000Z' })

    await vault.closePeriod({ name: 'FY26-Q1', endDate: '2026-03-31' })
    const archived = await vault.archivePeriod('FY26-Q1')

    expect(archived.archivedRecordCount).toBe(1)
    expect(hot.raw(V, 'txns', 'a')).toBeUndefined()               // gone from hot
    expect(cold.raw(V, 'txns', 'a')).toBeDefined()                // now in cold
    expect((await t.get('a'))?.amount).toBe(1)                    // read-through still resolves
    db.close()
  })

  it('leaves out-of-window records hot and summaries hot', async () => {
    const { hot, db, vault } = await makeVault()
    const t = vault.collection<Row>('txns')
    await t.put('late', { amount: 9, date: '2026-02-01' })         // _ts = now (2026+, after endDate)
    await vault.closePeriod({ name: 'FY26-Q1', endDate: '2026-03-31' })
    await vault.archivePeriod('FY26-Q1')
    expect(hot.raw(V, 'txns', 'late')).toBeDefined()               // late _ts stays hot
    expect(hot.raw(V, '_periods', 'FY26-Q1')).toBeDefined()        // summary stays hot
    db.close()
  })

  it('throws when the store is not a cold-capable routeStore', async () => {
    const db = await createNoydb({ store: memory(), user: 'alice', periodsStrategy: withPeriods(), secret: 'hunter2' })
    const vault = await db.openVault(V)
    await vault.closePeriod({ name: 'FY26-Q1', endDate: '2026-03-31' })
    await expect(vault.archivePeriod('FY26-Q1')).rejects.toThrow(/cold archival requires a routeStore/i)
    db.close()
  })

  it('composes with freeze and keeps verifyBackupIntegrity ok (ledger attributed to _period_archives)', async () => {
    const { db, vault } = await makeVault()
    const t = vault.collection<Row>('txns')
    await t.put('a', { amount: 1, date: '2026-02-01' }); await t.delete('a')
    await vault.closePeriod({ name: 'FY26-Q1', endDate: '2026-03-31' })
    await vault.freezePeriod('FY26-Q1')      // purge markers
    await vault.archivePeriod('FY26-Q1')     // relocate records
    const report = await vault.verifyBackupIntegrity()
    expect(report.ok).toBe(true)             // ledger entry attributed to _period_archives, not _periods
    db.close()
  })

  it('is idempotent (second archive: no re-migration, count stable)', async () => {
    const { db, vault } = await makeVault()
    const t = vault.collection<Row>('txns')
    await t.put('a', { amount: 1, date: '2026-02-01' })
    await vault.closePeriod({ name: 'FY26-Q1', endDate: '2026-03-31' })
    const first = await vault.archivePeriod('FY26-Q1')
    const second = await vault.archivePeriod('FY26-Q1')
    expect(second.archivedAt).toBe(first.archivedAt)
    expect(second.archivedRecordCount).toBe(first.archivedRecordCount)
    db.close()
  })

  it('preserves the write-seal: an archived period still rejects writes (#613 spec §6)', async () => {
    const { db, vault } = await makeVault()
    const t = vault.collection<Row>('txns')
    await vault.closePeriod({ name: 'FY26-Q1', endDate: '2026-03-31', dateField: 'date' })
    await vault.archivePeriod('FY26-Q1')
    await expect(t.put('b', { amount: 2, date: '2026-02-02' })).rejects.toThrow()  // seal intact
    db.close()
  })
})
```

Note: verify `vault.verifyBackupIntegrity()` is the correct method name in this repo before relying on it — grep `packages/hub/src/kernel/vault.ts` for `verifyBackupIntegrity`; use the exact name `period-freeze.test.ts` uses (it has the same assertion). If the freeze test uses a different call, mirror that.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/hub/__tests__/period-archive.test.ts`
Expected: FAIL — `vault.archivePeriod is not a function`.

- [ ] **Step 3: Add the `_archiveClosedPeriod` seam**

In `packages/hub/src/kernel/vault.ts`, add after `_purgeDeleteMarkers` (after line 1356):

```ts
  /**
   * @internal #613. Relocate this closed period's in-window records (those
   * with `_ts < before`) from the hot store to the configured cold tier,
   * via the routeStore's `compact({ before })`. Returns the count moved.
   * Requires a `routeStore` with a cold route (the `coldArchival`
   * capability); throws a clear error otherwise. Non-destructive — reads
   * fall through to cold, so this does NOT re-open the #589 window.
   */
  async _archiveClosedPeriod(before: string): Promise<number> {
    const store = this.adapter as Partial<import('../with-store/route-store.js').RoutedNoydbStore>
    if (store.capabilities?.coldArchival !== true || typeof store.compact !== 'function') {
      throw new ValidationError('archivePeriod: cold archival requires a routeStore with a cold route.')
    }
    return store.compact(this.name, { before })
  }
```

(If `ValidationError` isn't already imported in `vault.ts`, add it — grep confirms it is used elsewhere; reuse the existing import.)

- [ ] **Step 4: Wire the `archiveRecords` dep**

In the `new VaultPeriods({ ... })` block (`packages/hub/src/kernel/vault.ts:588`), add after the `purgeDeleteMarkers` line:

```ts
      archiveRecords: (before) => this._archiveClosedPeriod(before),
```

- [ ] **Step 5: Add the public delegator**

Add after the `freezePeriod` delegator (`packages/hub/src/kernel/vault.ts:3428`):

```ts
  /**
   * Archive a closed period (#613): relocates its in-window records from the
   * hot store to the configured cold tier (via the routeStore's cold route),
   * recording a `_period_archives` companion + ledger entry, never mutating
   * the chained `_periods` record. Non-destructive (reads fall through to
   * cold) and idempotent. Requires a routeStore with a cold route.
   */
  async archivePeriod(name: string): Promise<PeriodRecord> {
    return this.periods.archivePeriod(name)
  }
```

- [ ] **Step 6: Update the kernel-api golden**

In `packages/hub/__tests__/kernel-api.golden.json`, in the `Vault` array, insert `"archivePeriod",` in sorted position (the array is alphabetical; it goes before `"closePeriod"` — near the top of the Vault entry). Run the golden test to confirm placement:

Run: `pnpm vitest run packages/hub/__tests__/kernel-api-surface-golden.test.ts`
Expected: PASS. If it fails with a diff, adjust the JSON to exactly match the reported public method set (the test compares `Object.getOwnPropertyNames` of the prototype).

- [ ] **Step 7: Run the e2e test + build**

Run: `pnpm vitest run packages/hub/__tests__/period-archive.test.ts`
Expected: PASS (7 tests). Debug any read-through/relocation mismatch against the Task-1/2 routeStore behavior.

- [ ] **Step 8: Bump the kernel-surface ceiling if tripped**

Run: `pnpm check:architecture`
Expected: either OK, or a `vault.ts` kernel-surface failure reporting the new line count. If it fails, edit `scripts/check-architecture.mjs:902` (`'packages/hub/src/kernel/vault.ts': 4010`) up to the exact reported count, and add a one-line ratchet comment above it in the existing style, e.g.:

```js
  // Bumped 4010→<N> (2026-07-10, #613 period archive): `_archiveClosedPeriod` seam + `archivePeriod` delegator (pure additive, mirrors freezePeriod).
```

Re-run `pnpm check:architecture` → `✓ Architecture invariants OK`.

- [ ] **Step 9: Typecheck + lint**

Run: `pnpm --filter @noy-db/hub typecheck && pnpm --filter @noy-db/hub lint`
Expected: clean.

- [ ] **Step 10: Commit**

```bash
git add packages/hub/src/kernel/vault.ts packages/hub/__tests__/kernel-api.golden.json packages/hub/__tests__/period-archive.test.ts scripts/check-architecture.mjs
git commit -m "feat(hub): vault.archivePeriod — cold-archival seam + delegator, end-to-end (#613)"
```

---

### Task 5: Documentation

**Files:**
- Modify: `packages/hub/src/with-audit/periods/periods.ts` (module doc — add an "## Archive" section)
- Modify: `docs/subsystems/periods.md` (operator-facing docs for `archivePeriod`)

**Interfaces:** none (docs only). Consumes the shipped `archivePeriod` behavior.

- [ ] **Step 1: Add the "Archive" section to the module doc**

In `packages/hub/src/with-audit/periods/periods.ts`, after the "## Freeze" section (after the local-only caveat paragraph, before "## Not covered"), add:

```
 * ## Archive
 *
 * ```
 * vault.archivePeriod('FY2026-Q1')
 *   └─► relocates the closed period's in-window records (those with
 *       `_ts < periodExclusiveUpperBound(endDate)`) from the hot store to
 *       the configured cold tier (routeStore's `cold` route), then records:
 *         ├─ PeriodArchiveRecord written to _period_archives/<name>
 *         └─ a ledger entry attributed to _period_archives
 * ```
 *
 * Archival is NON-DESTRUCTIVE: routeStore reads fall through to the cold
 * tier on a hot miss, so an archived record still reads normally. It is
 * therefore gated only on `closed` (not `frozen`) — it does not re-open the
 * #589 resurrection window and needs no convergence safe-point. Freeze
 * (purge markers) and archive (relocate records) are independent and compose
 * in either order. Like freeze, archival keeps the chained `_periods/<name>`
 * record byte-immutable (state lives in the companion) and is idempotent.
 *
 * Bounds by write-time `_ts`, NOT business date: the store tier sees only
 * encrypted envelopes. A record with an in-period business date but a later
 * `_ts` (late-booked) archives at the NEXT period's archive — the same rule
 * freeze uses for late-booked delete markers. Requires a `routeStore` with a
 * cold route (`age: { cold }`); throws otherwise.
 *
 * Read cost: with `withLazy()` (per-id reads) archived records are truly
 * cold — fetched from cold only on access. In the default hydrated mode,
 * `loadAll` merges the cold store, so archived records still load into RAM
 * on vault open (hot-tier STORAGE is reclaimed; RAM is not). Summaries
 * (`_`-prefixed) always stay hot.
```

- [ ] **Step 2: Update the operator-facing subsystem doc**

Read `docs/subsystems/periods.md`. Find the section documenting `freezePeriod` (added in #604) and add a parallel `### archivePeriod(name)` subsection immediately after it, covering: what it does (relocate a closed period's in-window records to the cold tier), the `routeStore` + cold-route requirement, `_ts` boundary + late-booked rule, non-destructive/idempotent/closed-gated, `withLazy()` for true memory-cold, and that it's separate from `freezePeriod` (compose in either order). Match the file's existing heading level and prose style; keep it to ~15 lines.

- [ ] **Step 3: Run the doc-growth check**

Run: `pnpm check:architecture`
Expected: OK — but if the added `periods.ts` module-doc lines trip any periods-file ceiling, bump it in `scripts/check-architecture.mjs` with a ratchet comment noting it's pure doc growth (no behavior change), same as #604's doc bump did.

- [ ] **Step 4: Commit**

```bash
git add packages/hub/src/with-audit/periods/periods.ts docs/subsystems/periods.md
git commit -m "docs(hub): document the period archive phase (#613)"
```

---

## Final steps (after all tasks — handled by the execution skill)

- Run the full hub suite: `pnpm --filter @noy-db/hub test` (or `pnpm vitest run packages/hub`) — expect green.
- Run `pnpm check:architecture` and `pnpm --filter @noy-db/hub typecheck && lint` — all clean.
- Author a changeset: `pnpm changeset` → `@noy-db/hub: minor` (new public `vault.archivePeriod`), one-line summary referencing #613. (`.changeset/` is gitignored/local — ships next release with the stacked #589/#590/#604 changesets.)
- The whole-branch review is the net for cross-task issues — in particular re-verify the ledger-attribution (`_period_archives`, not `_periods`) and the `verifyBackupIntegrity`-post-archive assertion, since that's the class of bug #604's review caught for freeze.
- PR against `main`, base branch `feat/613-cold-archival`; do NOT merge (human gate).
