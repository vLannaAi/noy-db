# crossShardJoin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `crossShardJoin` (co-partitioned, per-shard intra-vault join + union) and `broadcastJoin` (single shared dimension table, central enrichment) to `ShardedQuery`, closing one of the remaining #271 federation primitives.

**Architecture:** Co-partitioned join threads a `JoinLeg` into the *existing, unchanged* intra-vault `.join()` inside each shard's fan-out closure (same vault, same DEK). Broadcast join is a separate central map-attach applied post-merge, bypassing the join planner. All code lives in `federation/` (a lazy chunk under no kernel-surface ceiling). `join.ts` is not touched.

**Tech Stack:** TypeScript ESM, vitest, pnpm workspace (`@noy-db/hub`). Spec: `docs/superpowers/specs/2026-06-09-cross-shard-join-design.md`.

**Run tests from the hub package:** `cd packages/hub && pnpm vitest run __tests__/federation-cross-shard-join.test.ts`. Lint: `pnpm lint`. Architecture: `node scripts/check-architecture.mjs` (run from repo root). **All three must pass before the branch is done — the previous cycle went red in CI because lint/architecture were skipped locally.**

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/hub/src/errors.ts` | Add `CrossShardJoinError` (code `CROSS_SHARD_JOIN`). |
| `packages/hub/src/federation/cross-shard-join.ts` | **New.** Leg types (`CoPartitionedLeg`, `BroadcastLeg`), public option types (`CrossShardJoinOptions`, `BroadcastJoinOptions`), `BroadcastSource` interface, `applyBroadcastLegs()` central executor + local `coerceKey` + warn-dedup. |
| `packages/hub/src/federation/vault-group.ts` | `ShardedQuery` gains `coPartitionedLegs` / `broadcastLegs` constructor params + fields, `crossShardJoin()` / `broadcastJoin()` builders; `fanoutRecords` threads co-partitioned legs (with right-side hydration); `toArray` applies broadcast legs; `live` / `aggregate` / `groupBy` guards. Update the 2 existing `new ShardedQuery(...)` call sites. |
| `packages/hub/src/federation/index.ts` | Re-export the public option types. |
| `packages/hub/__tests__/federation-cross-shard-join.test.ts` | **New.** Behavior + failure-mode coverage. |
| `features.yaml` | Update the `vault-group-federation` invariant line about crossShardJoin. |

---

## Task 1: `CrossShardJoinError`

**Files:**
- Modify: `packages/hub/src/errors.ts`
- Test: `packages/hub/__tests__/federation-cross-shard-join.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `packages/hub/__tests__/federation-cross-shard-join.test.ts` with:

```ts
import { describe, it, expect } from 'vitest'
import { CrossShardJoinError, NoydbError } from '../src/errors.js'

describe('CrossShardJoinError', () => {
  it('is a NoydbError with the CROSS_SHARD_JOIN code', () => {
    const e = new CrossShardJoinError('nope')
    expect(e).toBeInstanceOf(NoydbError)
    expect(e.code).toBe('CROSS_SHARD_JOIN')
    expect(e.message).toBe('nope')
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd packages/hub && pnpm vitest run __tests__/federation-cross-shard-join.test.ts`
Expected: FAIL — `CrossShardJoinError` is not exported from `errors.js`.

- [ ] **Step 3: Implement the error**

In `packages/hub/src/errors.ts`, after an existing federation error (e.g. near `UnknownShardError` / `ShardProvisioningError`), add:

```ts
/**
 * Thrown by `ShardedQuery.crossShardJoin` / `broadcastJoin` for
 * deterministic, query-shaping errors: an undeclared join ref (which
 * would fail identically on every shard), or calling a deferred
 * reactive/aggregate surface on a query that already carries join legs.
 */
export class CrossShardJoinError extends NoydbError {
  constructor(message: string) {
    super('CROSS_SHARD_JOIN', message)
    this.name = 'CrossShardJoinError'
  }
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `cd packages/hub && pnpm vitest run __tests__/federation-cross-shard-join.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/errors.ts packages/hub/__tests__/federation-cross-shard-join.test.ts
git commit -m "feat(hub): CrossShardJoinError"
```

---

## Task 2: Broadcast leg types + `applyBroadcastLegs` central executor

This is pure (no VaultGroup), so it's tested in isolation with plain rows and a fake source.

**Files:**
- Create: `packages/hub/src/federation/cross-shard-join.ts`
- Test: `packages/hub/__tests__/federation-cross-shard-join.test.ts`

- [ ] **Step 1: Write the failing test**

Append to the test file:

```ts
import { applyBroadcastLegs, type BroadcastLeg, type BroadcastSource } from '../src/federation/cross-shard-join.js'

function fakeSource(rows: Record<string, unknown>[]): BroadcastSource & { snapCalls: number } {
  let snapCalls = 0
  return {
    get snapCalls() { return snapCalls },
    snapshot() { snapCalls++; return rows },
  } as BroadcastSource & { snapCalls: number }
}

describe('applyBroadcastLegs', () => {
  it('attaches the matching dimension record by default on:id', async () => {
    const src = fakeSource([{ id: 'usd', symbol: '$' }, { id: 'eur', symbol: '€' }])
    const leg: BroadcastLeg = { field: 'currencyCode', as: 'fx', from: src, on: 'id', mode: 'warn' }
    const out = await applyBroadcastLegs(
      [{ id: 'i1', currencyCode: 'usd' }, { id: 'i2', currencyCode: 'eur' }],
      [leg],
    )
    expect((out[0] as Record<string, unknown>).fx).toEqual({ id: 'usd', symbol: '$' })
    expect((out[1] as Record<string, unknown>).fx).toEqual({ id: 'eur', symbol: '€' })
  })

  it('matches on a custom key', async () => {
    const src = fakeSource([{ code: 'usd', symbol: '$' }])
    const leg: BroadcastLeg = { field: 'currencyCode', as: 'fx', from: src, on: 'code', mode: 'warn' }
    const out = await applyBroadcastLegs([{ id: 'i1', currencyCode: 'usd' }], [leg])
    expect((out[0] as Record<string, unknown>).fx).toEqual({ code: 'usd', symbol: '$' })
  })

  it('attaches null on a miss', async () => {
    const src = fakeSource([{ id: 'usd' }])
    const leg: BroadcastLeg = { field: 'currencyCode', as: 'fx', from: src, on: 'id', mode: 'cascade' }
    const out = await applyBroadcastLegs([{ id: 'i1', currencyCode: 'gbp' }], [leg])
    expect((out[0] as Record<string, unknown>).fx).toBeNull()
  })

  it('loads the source snapshot exactly once regardless of row count', async () => {
    const src = fakeSource([{ id: 'usd' }])
    const leg: BroadcastLeg = { field: 'currencyCode', as: 'fx', from: src, on: 'id', mode: 'cascade' }
    await applyBroadcastLegs(
      Array.from({ length: 50 }, (_, i) => ({ id: `i${i}`, currencyCode: 'usd' })),
      [leg],
    )
    expect(src.snapCalls).toBe(1)
  })

  it('applies multiple legs independently', async () => {
    const fx = fakeSource([{ id: 'usd', symbol: '$' }])
    const adv = fakeSource([{ id: 'a1', name: 'Dana' }])
    const out = await applyBroadcastLegs(
      [{ id: 'i1', currencyCode: 'usd', advisorId: 'a1' }],
      [
        { field: 'currencyCode', as: 'fx', from: fx, on: 'id', mode: 'cascade' },
        { field: 'advisorId', as: 'advisor', from: adv, on: 'id', mode: 'cascade' },
      ],
    )
    expect((out[0] as Record<string, unknown>).fx).toEqual({ id: 'usd', symbol: '$' })
    expect((out[0] as Record<string, unknown>).advisor).toEqual({ id: 'a1', name: 'Dana' })
  })

  it('returns rows unchanged when there are no legs', async () => {
    const rows = [{ id: 'i1' }]
    const out = await applyBroadcastLegs(rows, [])
    expect(out).toEqual(rows)
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd packages/hub && pnpm vitest run __tests__/federation-cross-shard-join.test.ts`
Expected: FAIL — `cross-shard-join.js` does not exist.

- [ ] **Step 3: Implement `cross-shard-join.ts`**

Create `packages/hub/src/federation/cross-shard-join.ts`:

```ts
/**
 * @category capability
 * crossShardJoin — co-partitioned + broadcast dimension join for
 * ShardedQuery. Spec:
 * docs/superpowers/specs/2026-06-09-cross-shard-join-design.md.
 *
 * This module owns the BROADCAST half (central, post-merge map-attach)
 * and the leg type definitions. The CO-PARTITIONED half is threaded
 * into the existing intra-vault `.join()` from vault-group.ts — see
 * ShardedQuery.fanoutRecords. join.ts is deliberately untouched.
 */
import { readPath } from '../query/predicate.js'
import type { JoinStrategy } from '../query/join.js'

/** Public options for `ShardedQuery.crossShardJoin`. */
export interface CrossShardJoinOptions {
  /** Alias key under which the joined same-shard record attaches. */
  readonly as: string
  /** Per-shard row ceiling override (default DEFAULT_JOIN_MAX_ROWS). */
  readonly maxRows?: number
  /** Planner strategy override, passed through to intra-vault `.join()`. */
  readonly strategy?: JoinStrategy
}

/**
 * Minimal structural shape of a broadcast dimension source. A
 * `Collection` satisfies this: `snapshot()` reads its in-memory cache,
 * `list()` hydrates it. `list` is optional so plain test sources work.
 */
export interface BroadcastSource {
  snapshot(): readonly unknown[]
  list?(): Promise<unknown>
}

/** Public options for `ShardedQuery.broadcastJoin`. */
export interface BroadcastJoinOptions {
  /** Alias key under which the dimension record attaches. */
  readonly as: string
  /** The shared dimension collection (an opened handle in another vault). */
  readonly from: BroadcastSource
  /** Right-side key to match `field` against. Default 'id'. */
  readonly on?: string
  /** Miss behavior. 'warn' (default) attaches null + one-shot warning; 'cascade' is silent. */
  readonly mode?: 'warn' | 'cascade'
}

/** Internal co-partitioned leg carried on ShardedQuery. */
export interface CoPartitionedLeg {
  readonly field: string
  readonly as: string
  readonly maxRows: number | undefined
  readonly strategy: JoinStrategy | undefined
}

/** Internal broadcast leg carried on ShardedQuery. */
export interface BroadcastLeg {
  readonly field: string
  readonly as: string
  readonly from: BroadcastSource
  readonly on: string
  readonly mode: 'warn' | 'cascade'
}

/**
 * Coerce an unknown key value into a lookup string. Mirrors join.ts's
 * private `coerceRefKey` (string → string; number/bigint → String;
 * else null) — re-implemented locally to keep join.ts literally
 * untouched.
 */
function coerceKey(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'bigint') return String(value)
  return null
}

/** One-shot warn dedup for broadcast misses, keyed by `field→as`. */
const warnedBroadcastKeys = new Set<string>()
function warnOnceBroadcastMiss(field: string, as: string, key: string): void {
  const dedup = `${field}→${as}:${key}`
  if (warnedBroadcastKeys.has(dedup)) return
  warnedBroadcastKeys.add(dedup)
  console.warn(
    `[noy-db] broadcastJoin: no "${as}" dimension row for ${field}="${key}". ` +
      `Attaching null. Use mode: 'cascade' to silence.`,
  )
}

/** Test-only reset for the broadcast warn dedup set. */
export function resetBroadcastWarnings(): void {
  warnedBroadcastKeys.clear()
}

/**
 * Apply every broadcast leg to a merged row set, centrally. Each leg's
 * source is snapshotted ONCE, indexed by its `on` key, then every row
 * gets `{ [as]: match ?? null }`. Returns fresh top-level objects.
 */
export async function applyBroadcastLegs(
  rows: readonly unknown[],
  legs: readonly BroadcastLeg[],
): Promise<unknown[]> {
  if (legs.length === 0) return [...rows]

  // Build one index per leg (snapshot once).
  const indexes: { leg: BroadcastLeg; map: Map<string, unknown> }[] = []
  for (const leg of legs) {
    if (leg.from.list) await leg.from.list()
    const map = new Map<string, unknown>()
    for (const rec of leg.from.snapshot()) {
      const k = coerceKey(readPath(rec, leg.on))
      if (k !== null && !map.has(k)) map.set(k, rec)
    }
    indexes.push({ leg, map })
  }

  return rows.map((row) => {
    const out = { ...(row as Record<string, unknown>) }
    for (const { leg, map } of indexes) {
      const key = coerceKey(readPath(row, leg.field))
      const match = key === null ? null : map.get(key) ?? null
      if (match === null && leg.mode === 'warn') {
        warnOnceBroadcastMiss(leg.field, leg.as, key ?? '<null>')
      }
      out[leg.as] = match
    }
    return out
  })
}
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `cd packages/hub && pnpm vitest run __tests__/federation-cross-shard-join.test.ts`
Expected: PASS (Task 1 + Task 2 tests; 7 total).

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/federation/cross-shard-join.ts packages/hub/__tests__/federation-cross-shard-join.test.ts
git commit -m "feat(hub): applyBroadcastLegs — central broadcast dimension executor"
```

---

## Task 3: `crossShardJoin()` builder + co-partitioned fan-out

Wire the co-partitioned leg into `ShardedQuery` and thread it through `fanoutRecords`.

**Files:**
- Modify: `packages/hub/src/federation/vault-group.ts`
- Test: `packages/hub/__tests__/federation-cross-shard-join.test.ts`

- [ ] **Step 1: Add the shared harness to the test file**

At the TOP of the test file (after the existing imports), add the in-memory adapter + harness copied from `packages/hub/__tests__/federation-query-aggregate.test.ts`. Add these imports and helpers:

```ts
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/types.js'
import { ConflictError } from '../src/errors.js'
import { createNoydb } from '../src/noydb.js'
import type { Vault } from '../src/vault.js'
import type { VaultRegistryRow } from '../src/federation/index.js'
import { ref } from '../src/refs.js'

function memory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function gc(c: string, col: string) {
    let comp = store.get(c); if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col); if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
    name: 'memory',
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
      if (comp) for (const [n, coll] of comp) {
        if (!n.startsWith('_')) {
          const r: Record<string, EncryptedEnvelope> = {}
          for (const [id, e] of coll) r[id] = e
          s[n] = r
        }
      }
      return s
    },
    async saveAll(c, data) {
      for (const [n, recs] of Object.entries(data)) {
        const coll = gc(c, n)
        for (const [id, e] of Object.entries(recs)) coll.set(id, e)
      }
    },
  }
}

interface Invoice { id: string; clientId: string; customerId: string; amount: number; status: string; currencyCode?: string }
interface Customer { id: string; name: string }

/** Operator db + a client template that registers customers + invoices(ref customers). */
async function harness() {
  const adapter = memory()
  const db = await createNoydb({ store: adapter, user: 'operator', secret: 'op-pass' })
  db.withVaultTemplate('client-template', {
    version: 1,
    configure(vault: Vault) {
      vault.collection<Customer>('customers')
      vault.collection<Invoice>('invoices', { refs: { customerId: ref('customers') } })
    },
  })
  const stateVault = await db.openVault('state')
  const registry = stateVault.collection<VaultRegistryRow>('vault-registry')
  const firm = await db.openVaultGroup<Invoice>('firm-clients', {
    registry,
    sharding: { keyOf: (r) => r.clientId, vaultTemplate: 'client-template' },
  })
  return { adapter, db, registry, firm }
}
```

- [ ] **Step 2: Write the failing co-partitioned test**

Append:

```ts
describe('crossShardJoin (co-partitioned)', () => {
  it('joins each shard against its same-vault right collection and unions', async () => {
    const { firm } = await harness()
    // Two shards (acme, globex). Each has its own customers + invoices.
    const acme = await firm.shard('acme')
    await acme.collection<Customer>('customers').put('c-acme', { id: 'c-acme', name: 'Acme Co' })
    await firm.collection('invoices').put('i1', { id: 'i1', clientId: 'acme', customerId: 'c-acme', amount: 100, status: 'overdue' })
    const globex = await firm.shard('globex')
    await globex.collection<Customer>('customers').put('c-glx', { id: 'c-glx', name: 'Globex' })
    await firm.collection('invoices').put('i2', { id: 'i2', clientId: 'globex', customerId: 'c-glx', amount: 200, status: 'overdue' })

    const res = await firm.collection('invoices').query()
      .where('status', '==', 'overdue')
      .crossShardJoin('customerId', { as: 'customer' })
      .toArray()

    expect(res.skippedVaults).toEqual([])
    const byId = Object.fromEntries(res.results.map((r) => [(r as Invoice).id, r])) as Record<string, Record<string, unknown>>
    expect((byId['i1'].customer as Customer).name).toBe('Acme Co')
    expect((byId['i2'].customer as Customer).name).toBe('Globex')
  })
})
```

Note: confirm `firm.shard(key)` is the drill-down accessor (it is — `VaultGroup.shard`). If a shard must exist before `firm.shard()`, write the invoice first (auto-creates the shard) then open it to add customers; reorder the puts if needed.

- [ ] **Step 3: Run it to confirm it fails**

Run: `cd packages/hub && pnpm vitest run __tests__/federation-cross-shard-join.test.ts -t 'co-partitioned'`
Expected: FAIL — `crossShardJoin` is not a function on `ShardedQuery`.

- [ ] **Step 4: Implement the co-partitioned leg in `vault-group.ts`**

In `packages/hub/src/federation/vault-group.ts`:

(a) Add imports near the other federation imports:

```ts
import { applyBroadcastLegs } from './cross-shard-join.js'
import type { CoPartitionedLeg, BroadcastLeg, CrossShardJoinOptions, BroadcastJoinOptions } from './cross-shard-join.js'
import { CrossShardJoinError } from '../errors.js'
```

(Add `CrossShardJoinError` to the existing `from '../errors.js'` import line instead of a second import if cleaner.)

(b) Change `ShardedQuery`'s constructor to carry the two leg arrays. Replace the current constructor + the `where()` method:

```ts
export class ShardedQuery<T, R = T> {
  constructor(
    private readonly group: VaultGroup<T>,
    private readonly collectionName: string,
    private readonly clauses: readonly WhereClause[],
    private readonly coPartitionedLegs: readonly CoPartitionedLeg[] = [],
    private readonly broadcastLegs: readonly BroadcastLeg[] = [],
  ) {}

  where(field: string, op: WhereClause['op'], value: unknown): ShardedQuery<T, R> {
    return new ShardedQuery<T, R>(
      this.group, this.collectionName,
      [...this.clauses, { field, op, value }],
      this.coPartitionedLegs, this.broadcastLegs,
    )
  }

  /** Co-partitioned join: each shard joins its own same-vault right collection (resolved via ref()), then union. */
  crossShardJoin(field: string, opts: CrossShardJoinOptions): ShardedQuery<T, R> {
    const leg: CoPartitionedLeg = { field, as: opts.as, maxRows: opts.maxRows, strategy: opts.strategy }
    return new ShardedQuery<T, R>(
      this.group, this.collectionName, this.clauses,
      [...this.coPartitionedLegs, leg], this.broadcastLegs,
    )
  }
```

(c) In `fanoutRecords`, replace the per-shard closure body so it hydrates each join target and threads the legs. Current closure ends with `return q.toArray()`; replace the closure with:

```ts
      async (vault) => {
        this.group.template.configure(vault)
        const coll = vault.collection<R>(this.collectionName)
        await coll.list() // hydrate the left side
        // Hydrate each co-partitioned join target — resolveSource reads
        // the in-memory cache, so an unopened right collection would join
        // to an empty snapshot (every row → null).
        for (const leg of this.coPartitionedLegs) {
          const desc = vault.resolveRef(this.collectionName, leg.field)
          if (desc) await vault.collection(desc.target).list()
        }
        let q = coll.query()
        for (const c of this.clauses) q = q.where(c.field, c.op, c.value)
        for (const leg of this.coPartitionedLegs) {
          q = q.join(leg.field, {
            as: leg.as,
            ...(leg.maxRows !== undefined ? { maxRows: leg.maxRows } : {}),
            ...(leg.strategy ? { strategy: leg.strategy } : {}),
          })
        }
        return q.toArray() as R[]
      },
```

- [ ] **Step 5: Run the test to confirm it passes**

Run: `cd packages/hub && pnpm vitest run __tests__/federation-cross-shard-join.test.ts -t 'co-partitioned'`
Expected: PASS. If `firm.shard('acme')` throws "unknown shard" before the invoice write, reorder so the invoice (auto-create) lands first, then `firm.shard('acme')` to add the customer, then re-query.

- [ ] **Step 6: Run the full file + typecheck**

Run: `cd packages/hub && pnpm vitest run __tests__/federation-cross-shard-join.test.ts && pnpm tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add packages/hub/src/federation/vault-group.ts packages/hub/__tests__/federation-cross-shard-join.test.ts
git commit -m "feat(hub): crossShardJoin — co-partitioned per-shard join + union"
```

---

## Task 4: `broadcastJoin()` builder + `toArray` applies broadcast legs

**Files:**
- Modify: `packages/hub/src/federation/vault-group.ts`
- Test: `packages/hub/__tests__/federation-cross-shard-join.test.ts`

- [ ] **Step 1: Write the failing test**

Append:

```ts
import { resetBroadcastWarnings } from '../src/federation/cross-shard-join.js'

describe('broadcastJoin (dimension)', () => {
  it('enriches every merged row from a single shared dimension collection', async () => {
    resetBroadcastWarnings()
    const { db, firm } = await harness()
    // Shared dimension vault, separate from any shard.
    const dims = await db.openVault('dimensions')
    const currencies = dims.collection<{ id: string; symbol: string }>('currencies')
    await currencies.put('usd', { id: 'usd', symbol: '$' })
    await currencies.put('eur', { id: 'eur', symbol: '€' })

    await firm.collection('invoices').put('i1', { id: 'i1', clientId: 'acme', customerId: 'c1', amount: 100, status: 'paid', currencyCode: 'usd' })
    await firm.collection('invoices').put('i2', { id: 'i2', clientId: 'globex', customerId: 'c2', amount: 200, status: 'paid', currencyCode: 'eur' })

    const res = await firm.collection('invoices').query()
      .broadcastJoin('currencyCode', { as: 'fx', from: currencies })
      .toArray()

    const byId = Object.fromEntries(res.results.map((r) => [(r as Invoice).id, r])) as Record<string, Record<string, unknown>>
    expect((byId['i1'].fx as { symbol: string }).symbol).toBe('$')
    expect((byId['i2'].fx as { symbol: string }).symbol).toBe('€')
  })

  it('combines a co-partitioned join and a broadcast join', async () => {
    resetBroadcastWarnings()
    const { db, firm } = await harness()
    const dims = await db.openVault('dimensions')
    const currencies = dims.collection<{ id: string; symbol: string }>('currencies')
    await currencies.put('usd', { id: 'usd', symbol: '$' })

    await firm.collection('invoices').put('i1', { id: 'i1', clientId: 'acme', customerId: 'c-acme', amount: 100, status: 'overdue', currencyCode: 'usd' })
    const acme = await firm.shard('acme')
    await acme.collection<Customer>('customers').put('c-acme', { id: 'c-acme', name: 'Acme Co' })

    const res = await firm.collection('invoices').query()
      .crossShardJoin('customerId', { as: 'customer' })
      .broadcastJoin('currencyCode', { as: 'fx', from: currencies })
      .toArray()

    const row = res.results[0] as Record<string, unknown>
    expect((row.customer as Customer).name).toBe('Acme Co')
    expect((row.fx as { symbol: string }).symbol).toBe('$')
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd packages/hub && pnpm vitest run __tests__/federation-cross-shard-join.test.ts -t 'broadcastJoin'`
Expected: FAIL — `broadcastJoin` is not a function.

- [ ] **Step 3: Implement `broadcastJoin()` + `toArray` change in `vault-group.ts`**

Add the builder method to `ShardedQuery` (after `crossShardJoin`):

```ts
  /** Broadcast dimension join: enrich every merged row from a single shared collection. */
  broadcastJoin(field: string, opts: BroadcastJoinOptions): ShardedQuery<T, R> {
    const leg: BroadcastLeg = {
      field,
      as: opts.as,
      from: opts.from,
      on: opts.on ?? 'id',
      mode: opts.mode ?? 'warn',
    }
    return new ShardedQuery<T, R>(
      this.group, this.collectionName, this.clauses,
      this.coPartitionedLegs, [...this.broadcastLegs, leg],
    )
  }
```

Change `toArray` to apply broadcast legs after the fan-out merge:

```ts
  async toArray(options: FanoutQueryOptions = {}): Promise<FanoutResult<R>> {
    const { records, skippedVaults } = await this.fanoutRecords(options)
    const results = (await applyBroadcastLegs(records, this.broadcastLegs)) as R[]
    return { results, skippedVaults }
  }
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `cd packages/hub && pnpm vitest run __tests__/federation-cross-shard-join.test.ts`
Expected: PASS (all tests so far).

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/federation/vault-group.ts packages/hub/__tests__/federation-cross-shard-join.test.ts
git commit -m "feat(hub): broadcastJoin — central dimension enrichment on ShardedQuery"
```

---

## Task 5: Failure semantics

Undeclared ref → single `CrossShardJoinError`; dangling ref → per-shard `RefMode` (strict skips the shard, warn attaches null); broadcast miss → null + one-shot warn.

**Files:**
- Modify: `packages/hub/src/federation/vault-group.ts`
- Test: `packages/hub/__tests__/federation-cross-shard-join.test.ts`

- [ ] **Step 1: Write the failing tests**

Append:

```ts
describe('crossShardJoin failure semantics', () => {
  it('throws a single CrossShardJoinError when the join field has no ref()', async () => {
    const { firm } = await harness()
    await firm.collection('invoices').put('i1', { id: 'i1', clientId: 'acme', customerId: 'c1', amount: 1, status: 'open' })
    await expect(
      firm.collection('invoices').query().crossShardJoin('amount', { as: 'x' }).toArray(),
    ).rejects.toBeInstanceOf(CrossShardJoinError)
  })

  it('attaches null for a dangling ref in warn mode (per-shard RefMode)', async () => {
    // warn-mode template: ref('customers', 'warn')
    const adapter = memory()
    const db = await createNoydb({ store: adapter, user: 'operator', secret: 'op-pass' })
    db.withVaultTemplate('warn-template', {
      version: 1,
      configure(vault: Vault) {
        vault.collection<Customer>('customers')
        vault.collection<Invoice>('invoices', { refs: { customerId: ref('customers', 'warn') } })
      },
    })
    const sv = await db.openVault('state')
    const registry = sv.collection<VaultRegistryRow>('vault-registry')
    const firm = await db.openVaultGroup<Invoice>('warn-firm', {
      registry,
      sharding: { keyOf: (r) => r.clientId, vaultTemplate: 'warn-template' },
    })
    await firm.collection('invoices').put('i1', { id: 'i1', clientId: 'acme', customerId: 'ghost', amount: 1, status: 'open' })

    const res = await firm.collection('invoices').query()
      .crossShardJoin('customerId', { as: 'customer' })
      .toArray()
    expect(res.results).toHaveLength(1)
    expect((res.results[0] as Record<string, unknown>).customer).toBeNull()
  })
})

describe('broadcastJoin miss', () => {
  it('attaches null on a miss without throwing', async () => {
    resetBroadcastWarnings()
    const { db, firm } = await harness()
    const dims = await db.openVault('dimensions')
    const currencies = dims.collection<{ id: string }>('currencies')
    await currencies.put('usd', { id: 'usd' })
    await firm.collection('invoices').put('i1', { id: 'i1', clientId: 'acme', customerId: 'c1', amount: 1, status: 'paid', currencyCode: 'gbp' })

    const res = await firm.collection('invoices').query()
      .broadcastJoin('currencyCode', { as: 'fx', from: currencies, mode: 'cascade' })
      .toArray()
    expect((res.results[0] as Record<string, unknown>).fx).toBeNull()
  })
})
```

- [ ] **Step 2: Run them to confirm they fail**

Run: `cd packages/hub && pnpm vitest run __tests__/federation-cross-shard-join.test.ts -t 'failure semantics'`
Expected: FAIL on the undeclared-ref test — without the guard, the per-shard `.join()` throws a generic `Error` swallowed into `skippedVaults`, so `.toArray()` resolves instead of rejecting. (The warn-mode and broadcast-miss tests may already pass — that's fine; they lock the behavior.)

- [ ] **Step 3: Implement the undeclared-ref pre-check**

In `fanoutRecords` (or a small private helper called at the top of `fanoutRecords`), before the `queryAcross` fan-out, validate each co-partitioned leg against the template once. The template's ref registry isn't directly inspectable without a vault, so resolve against the FIRST eligible shard's vault and treat a missing ref as a deterministic error:

Add, right after `const { eligible, skipped } = await this.group.resolveEligible(options)` and before the `queryAcross` call:

```ts
    // Deterministic pre-check: an undeclared join ref fails identically
    // on every shard, so surface it as ONE CrossShardJoinError rather
    // than N identical skips. Validate against the first eligible shard.
    if (this.coPartitionedLegs.length > 0 && eligible.length > 0) {
      // resolveEligible returns VaultRegistryRow[]; each row carries
      // `partitionKey` directly (see vault-group.ts:195). Open the first
      // eligible shard as the probe.
      const probe = await this.group.openShard(eligible[0].partitionKey)
      this.group.template.configure(probe)
      for (const leg of this.coPartitionedLegs) {
        if (!probe.resolveRef(this.collectionName, leg.field)) {
          throw new CrossShardJoinError(
            `crossShardJoin("${leg.field}"): no ref() declared for "${leg.field}" on ` +
              `collection "${this.collectionName}" in template "${this.group.sharding.vaultTemplate}". ` +
              `Add refs: { ${leg.field}: ref('<target>') } to the template's collection options.`,
          )
        }
      }
    }
```

`VaultRegistryRow.partitionKey` and `VaultGroup.openShard(partitionKey)` are both confirmed to exist. `this.group.sharding.vaultTemplate` is the template name (used only in the error string). No `SHARD_SEPARATOR` split needed.

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `cd packages/hub && pnpm vitest run __tests__/federation-cross-shard-join.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/federation/vault-group.ts packages/hub/__tests__/federation-cross-shard-join.test.ts
git commit -m "feat(hub): crossShardJoin failure semantics — undeclared-ref pre-check"
```

---

## Task 6: Deferred-surface guards (`live` / `aggregate` / `groupBy` throw with legs)

**Files:**
- Modify: `packages/hub/src/federation/vault-group.ts`
- Test: `packages/hub/__tests__/federation-cross-shard-join.test.ts`

- [ ] **Step 1: Write the failing tests**

Append:

```ts
describe('deferred surfaces throw when join legs are present', () => {
  it('live() throws CrossShardJoinError with a co-partitioned leg', async () => {
    const { firm } = await harness()
    expect(() =>
      firm.collection('invoices').query().crossShardJoin('customerId', { as: 'c' }).live(),
    ).toThrow(CrossShardJoinError)
  })

  it('aggregate() throws CrossShardJoinError with a broadcast leg', async () => {
    const { db, firm } = await harness()
    const dims = await db.openVault('dimensions')
    const cur = dims.collection<{ id: string }>('currencies')
    expect(() =>
      firm.collection('invoices').query().broadcastJoin('currencyCode', { as: 'fx', from: cur }).aggregate({ total: 'count' } as never),
    ).toThrow(CrossShardJoinError)
  })

  it('groupBy() throws CrossShardJoinError with a join leg', async () => {
    const { firm } = await harness()
    expect(() =>
      firm.collection('invoices').query().crossShardJoin('customerId', { as: 'c' }).groupBy('status'),
    ).toThrow(CrossShardJoinError)
  })
})
```

- [ ] **Step 2: Run them to confirm they fail**

Run: `cd packages/hub && pnpm vitest run __tests__/federation-cross-shard-join.test.ts -t 'deferred surfaces'`
Expected: FAIL — these methods currently ignore the legs.

- [ ] **Step 3: Add the guards**

Add a private helper to `ShardedQuery` and call it at the top of `live`, `aggregate`, and `groupBy`:

```ts
  /** @internal — joined queries don't support reactive/aggregate surfaces in v1. */
  private assertNoJoinLegs(surface: string): void {
    if (this.coPartitionedLegs.length || this.broadcastLegs.length) {
      throw new CrossShardJoinError(
        `${surface}() is not supported on a ShardedQuery with crossShardJoin/broadcastJoin ` +
          `legs in v1. Use toArray() for joined cross-shard queries.`,
      )
    }
  }
```

Then, as the FIRST line inside each method:
- `live(options = {}) { this.assertNoJoinLegs('live'); /* ...existing... */ }`
- `aggregate(spec) { this.assertNoJoinLegs('aggregate'); /* ...existing... */ }`
- `groupBy(field) { this.assertNoJoinLegs('groupBy'); /* ...existing... */ }`

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `cd packages/hub && pnpm vitest run __tests__/federation-cross-shard-join.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/federation/vault-group.ts packages/hub/__tests__/federation-cross-shard-join.test.ts
git commit -m "feat(hub): guard live/aggregate/groupBy against join legs in v1"
```

---

## Task 7: Exports, features.yaml, and full verification

**Files:**
- Modify: `packages/hub/src/federation/index.ts`
- Modify: `features.yaml`

- [ ] **Step 1: Re-export the public option types**

In `packages/hub/src/federation/index.ts`, add to the existing `export type { ... } from './types.js'` block a NEW export line for the cross-shard-join module:

```ts
export { resetBroadcastWarnings } from './cross-shard-join.js'
export type {
  CrossShardJoinOptions,
  BroadcastJoinOptions,
  BroadcastSource,
} from './cross-shard-join.js'
```

- [ ] **Step 2: Verify the types are reachable from the package entry**

Run: `cd packages/hub && pnpm tsc --noEmit`
Expected: PASS, no errors.

- [ ] **Step 3: Update the features.yaml invariant**

In `features.yaml`, under the `vault-group-federation` feature's `invariants:` list, replace:

```yaml
      - 'join.ts partitionScope seam is untouched (crossShardJoin deferred)'
```

with:

```yaml
      - 'crossShardJoin is co-partitioned fan-out + central broadcast enrichment; join.ts and its partitionScope seam stay untouched'
```

- [ ] **Step 4: Validate features.yaml**

Run (from repo root): `pnpm validate:features` (alias for `node scripts/validate-features.mjs`).
Expected: PASS — no dangling-ref / schema failure. This is the same job CI's "Spec coverage" runs.

- [ ] **Step 5: Run the FULL gate — tests + lint + architecture**

Run from repo root:

```bash
cd packages/hub && pnpm vitest run __tests__/federation-cross-shard-join.test.ts && pnpm vitest run __tests__/federation-vault-group.test.ts __tests__/federation-query-aggregate.test.ts && cd ../.. && pnpm lint && node scripts/check-architecture.mjs
```

Expected: ALL pass. The architecture check must report OK (federation code is under no ceiling, but run it anyway — the previous cycle went red because lint/architecture were skipped). Fix any lint error (no inline `import()` type annotations; no unused imports) before committing.

- [ ] **Step 6: Commit**

```bash
git add packages/hub/src/federation/index.ts features.yaml
git commit -m "feat(hub): export crossShardJoin option types + features.yaml invariant"
```

- [ ] **Step 7: Finish the branch**

Use **superpowers:finishing-a-development-branch** to verify the full hub test suite, then push and open a PR titled `feat(hub): crossShardJoin — co-partitioned + broadcast dimension join (#271)`. The PR body should note: closes one milestone-16 primitive; `join.ts` untouched; `.live()`/`.aggregate()` deferred for joined queries. Do NOT add Claude attribution. Do NOT publish a release.

---

## Self-Review Notes (for the implementer)

- **Type widening:** `toArray` keeps returning `FanoutResult<R>` for simplicity (the `as`-keyed fields are present at runtime; consumers cast per-leg, exactly as the intra-vault `.join()` test does with `as JoinedRow`). Do not over-engineer the generic widening — the spec accepts the cast pattern.
- **`firm.shard(key)` vs auto-create:** writing through `firm.collection('invoices').put(...)` auto-creates the shard; `firm.shard(key)` opens an existing one. In tests that need to seed the right-side collection, write one invoice first (auto-create) OR call `firm.createShard(key)` before `firm.shard(key)`. Verify against `VaultGroup`'s actual method names (`shard` / `openShard` / `createShard`) before finalizing.
- **The Task 5 probe line** (recovering a partition key from a vault id) is the one spot needing verification against `resolveEligible`'s real return shape — check whether eligible rows carry the partition key directly before splitting on `SHARD_SEPARATOR`.
