# Pre.15 — Multi-key groupBy + UNION MV + GuardStrategyHandle variance — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land three issues in pre.15 — variadic `Query<T>.groupBy(...fields)` (#166), UNION MV via `unionSources` (#165), and `GuardStrategyHandle<T>` variance cleanup (#131).

**Architecture:** Three sequential PRs in one release branch. PR 1 introduces a shared `canonicalGroupKey` helper that PR 2 consumes for cross-arm row dedup; PR 3 is an independent type-only refactor that rides along. The `query`-form and `unionSources`-form MV paths remain independent inside the executor (no internal n-arm unification). The MV registry's existing `dependencies: Set<string>` already supports multi-source per-MV bookkeeping — UNION just populates it from `unionSources[].collection` instead of via the AST analyzer.

**Tech Stack:** TypeScript, `@noy-db/hub` (Web Crypto only), Vitest, Turbo, pnpm workspaces, ESM-primary monorepo.

**Spec:** [`docs/superpowers/specs/2026-05-22-dim14-mv-multikey-and-union-design.md`](../specs/2026-05-22-dim14-mv-multikey-and-union-design.md)

**Branch convention:** Work on `feat/dim14-mv-multikey-and-union` off `main`. Each PR squash-merges back. Commits within a PR are small TDD steps; PR title carries the issue number.

---

## Task 0: Branch setup

**Files:**
- None (git only)

- [ ] **Step 1: Confirm clean tree on main**

Run: `git status --short && git fetch origin && git log --oneline origin/main -3`
Expected: working tree clean (or only `docs/assets/overview.svg` untracked-modified per existing status); HEAD at or beyond commit `653bf62` (spec commit).

- [ ] **Step 2: Create branch**

Run: `git checkout -b feat/dim14-mv-multikey-and-union`

- [ ] **Step 3: Verify baseline test suite is green**

Run: `pnpm install && pnpm turbo build && pnpm vitest run packages/hub`
Expected: 1573 tests pass; build clean; no type errors.

---

# PR 1 — #166 Multi-key groupBy

## Task 1: Add `canonicalGroupKey` helper (TDD)

**Files:**
- Create: `packages/hub/src/aggregate/canonical-key.ts`
- Test: `packages/hub/__tests__/aggregate-canonical-key.test.ts`

The helper is a pure function: sorts field names lexicographically, then serialises `name=value|name=value|…` with JSON-stringified values. Used internally for groupBy dedup AND (later) for UNION MV row-key dedup.

- [ ] **Step 1: Write the failing test file**

```ts
// packages/hub/__tests__/aggregate-canonical-key.test.ts
import { describe, it, expect } from 'vitest'
import { canonicalGroupKey } from '../src/aggregate/canonical-key.js'

describe('canonicalGroupKey', () => {
  it('returns a single-field encoding for one key', () => {
    expect(canonicalGroupKey(['period'], { period: '2026-05' }))
      .toBe('period=\"2026-05\"')
  })

  it('sorts field names lexicographically before serialising', () => {
    const a = canonicalGroupKey(['clientId', 'period'], { clientId: 'c1', period: '2026-05' })
    const b = canonicalGroupKey(['period', 'clientId'], { clientId: 'c1', period: '2026-05' })
    expect(a).toBe(b)
    expect(a).toBe('clientId=\"c1\"|period=\"2026-05\"')
  })

  it('JSON-stringifies value types', () => {
    expect(canonicalGroupKey(['n'], { n: 42 })).toBe('n=42')
    expect(canonicalGroupKey(['flag'], { flag: true })).toBe('flag=true')
    expect(canonicalGroupKey(['obj'], { obj: { a: 1 } })).toBe('obj={\"a\":1}')
  })

  it('distinguishes undefined and null', () => {
    expect(canonicalGroupKey(['x'], { x: undefined })).toBe('x=undefined')
    expect(canonicalGroupKey(['x'], { x: null })).toBe('x=null')
  })

  it('reads missing fields as undefined', () => {
    expect(canonicalGroupKey(['absent'], {})).toBe('absent=undefined')
  })

  it('three-key composite is order-invariant in fields argument', () => {
    const row = { clientId: 'c1', period: '2026-05', direction: 'in' }
    const k1 = canonicalGroupKey(['clientId', 'period', 'direction'], row)
    const k2 = canonicalGroupKey(['direction', 'clientId', 'period'], row)
    expect(k1).toBe(k2)
  })
})
```

- [ ] **Step 2: Run test to verify it fails (module not found)**

Run: `pnpm vitest run packages/hub/__tests__/aggregate-canonical-key.test.ts`
Expected: FAIL — `Cannot find module '../src/aggregate/canonical-key.js'`.

- [ ] **Step 3: Write the helper**

```ts
// packages/hub/src/aggregate/canonical-key.ts

/**
 * Canonicalise a group-key tuple to a stable string for dedup hashing.
 *
 * Sorts field names lexicographically before serialising, so that
 * `.groupBy('a', 'b')` and `.groupBy('b', 'a')` produce identical
 * keys for the same logical group. Values are JSON-stringified;
 * `undefined` and `null` are distinguished (matching the Map-key
 * semantics in `groupAndReduce`).
 *
 * NOT part of the public API. Used by:
 *   - `groupAndReduce` for the dedup Map's key
 *   - `materialized-views/query-hash` for UNION MV cross-arm row-key dedup (PR 2)
 *
 * Pure: same input → same output, no side effects, no allocation
 * caching.
 */
export function canonicalGroupKey(
  fields: readonly string[],
  row: Record<string, unknown>,
): string {
  const sorted = [...fields].sort()
  const parts: string[] = []
  for (const name of sorted) {
    const v = row[name]
    const serialised =
      v === undefined ? 'undefined' : JSON.stringify(v)
    parts.push(`${name}=${serialised}`)
  }
  return parts.join('|')
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/hub/__tests__/aggregate-canonical-key.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/aggregate/canonical-key.ts \
        packages/hub/__tests__/aggregate-canonical-key.test.ts
git commit -m "feat(hub): canonicalGroupKey helper for multi-key groupBy (#166)"
```

---

## Task 2: Add failing tests for multi-key `groupBy` on `Query<T>`

**Files:**
- Modify: `packages/hub/__tests__/query-groupby.test.ts`

- [ ] **Step 1: Add multi-key test cases**

Append these `describe` blocks to the existing `query-groupby.test.ts` file (don't replace existing single-key tests).

```ts
describe('Query.groupBy — multi-key (#166)', () => {
  // Reuse the same test fixture pattern as the single-key tests in this file —
  // a `collection` of invoice-like records with clientId, period, amount.

  it('emits one row per composite key, with every grouped field stamped on the row', async () => {
    const invoices = await setupInvoiceCollection([
      { id: 'i1', clientId: 'c1', period: '2026-05', amount: 100 },
      { id: 'i2', clientId: 'c1', period: '2026-05', amount: 200 },
      { id: 'i3', clientId: 'c1', period: '2026-06', amount: 300 },
      { id: 'i4', clientId: 'c2', period: '2026-05', amount: 400 },
    ])

    const rows = invoices.query()
      .groupBy('clientId', 'period')
      .aggregate({ total: sum('amount'), n: count() })
      .run()

    // Three composite keys: (c1,2026-05), (c1,2026-06), (c2,2026-05).
    expect(rows).toHaveLength(3)
    const c1May = rows.find(r => r.clientId === 'c1' && r.period === '2026-05')!
    expect(c1May.total).toBe(300)
    expect(c1May.n).toBe(2)
    const c1Jun = rows.find(r => r.clientId === 'c1' && r.period === '2026-06')!
    expect(c1Jun.total).toBe(300)
    expect(c1Jun.n).toBe(1)
    const c2May = rows.find(r => r.clientId === 'c2' && r.period === '2026-05')!
    expect(c2May.total).toBe(400)
    expect(c2May.n).toBe(1)
  })

  it('preserves grouped-field declaration order on result rows', async () => {
    const invoices = await setupInvoiceCollection([
      { id: 'i1', clientId: 'c1', period: '2026-05', amount: 100 },
    ])

    // declared order: period FIRST, clientId SECOND
    const rowsA = invoices.query()
      .groupBy('period', 'clientId')
      .aggregate({ total: sum('amount') })
      .run()

    // Key-order property — the row literal carries fields in iteration order,
    // and our implementation emits in DECLARATION order (not sorted order).
    expect(Object.keys(rowsA[0]!).slice(0, 2)).toEqual(['period', 'clientId'])

    const rowsB = invoices.query()
      .groupBy('clientId', 'period')
      .aggregate({ total: sum('amount') })
      .run()
    expect(Object.keys(rowsB[0]!).slice(0, 2)).toEqual(['clientId', 'period'])
  })

  it('handles three composite keys', async () => {
    const taxDocs = await setupTaxDocCollection([
      { id: 't1', clientId: 'c1', period: '2026-05', direction: 'in',  vat: 100 },
      { id: 't2', clientId: 'c1', period: '2026-05', direction: 'out', vat: 200 },
      { id: 't3', clientId: 'c1', period: '2026-05', direction: 'in',  vat: 50  },
    ])

    const rows = taxDocs.query()
      .groupBy('clientId', 'period', 'direction')
      .aggregate({ total: sum('vat') })
      .run()

    expect(rows).toHaveLength(2)
    const inRow = rows.find(r => r.direction === 'in')!
    expect(inRow.total).toBe(150)
    const outRow = rows.find(r => r.direction === 'out')!
    expect(outRow.total).toBe(200)
  })

  it('cardinality warning message lists all grouped field names', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    resetGroupByWarnings() // imported from groupby.ts test helper

    // Build a collection with > 10_000 distinct (a,b) tuples.
    const records = Array.from({ length: 10_001 }, (_, i) => ({
      id: `r${i}`, a: `${i}`, b: `${i}`, amount: 1,
    }))
    const coll = await setupAnonCollection(records)
    coll.query().groupBy('a', 'b').aggregate({ n: count() }).run()

    expect(warnSpy).toHaveBeenCalledOnce()
    const msg = warnSpy.mock.calls[0]![0] as string
    expect(msg).toContain('[a, b]')
    warnSpy.mockRestore()
  })

  it('throws GroupCardinalityError at 100k distinct tuples', async () => {
    const records = Array.from({ length: 100_001 }, (_, i) => ({
      id: `r${i}`, a: `${i}`, b: `${i}`, amount: 1,
    }))
    const coll = await setupAnonCollection(records)
    expect(() =>
      coll.query().groupBy('a', 'b').aggregate({ n: count() }).run(),
    ).toThrow(GroupCardinalityError)
  })

  it('back-compat: single-arg groupBy still works and returns narrowed field type', async () => {
    const invoices = await setupInvoiceCollection([
      { id: 'i1', clientId: 'c1', period: '2026-05', amount: 100 },
      { id: 'i2', clientId: 'c2', period: '2026-05', amount: 200 },
    ])
    const rows = invoices.query()
      .groupBy('clientId')
      .aggregate({ total: sum('amount') })
      .run()
    expect(rows).toHaveLength(2)
    expect(typeof rows[0]!.clientId).toBe('string')
  })
})
```

Reuse existing `setupInvoiceCollection`/`setupAnonCollection` helpers from the test file. If a tax-doc fixture helper doesn't exist, mirror `setupInvoiceCollection` and add `setupTaxDocCollection` at the top of the test file with the same shape.

- [ ] **Step 2: Run tests to verify they fail (variadic overload missing)**

Run: `pnpm vitest run packages/hub/__tests__/query-groupby.test.ts -t "multi-key"`
Expected: FAIL — type errors on `.groupBy('clientId', 'period')` ("Expected 1 arguments, but got 2") or runtime "field is not a string".

- [ ] **Step 3: Commit failing tests**

```bash
git add packages/hub/__tests__/query-groupby.test.ts
git commit -m "test(hub): multi-key groupBy cases (#166) — failing"
```

---

## Task 3: Implement variadic `groupBy` overload in `Query<T>` and `GroupedQuery`

**Files:**
- Modify: `packages/hub/src/query/builder.ts` (groupBy method around line 588)
- Modify: `packages/hub/src/aggregate/groupby.ts` (GroupedQuery + GroupedAggregation + groupAndReduce)

- [ ] **Step 1: Widen `GroupedQuery` and `GroupedAggregation` to multi-field**

In `packages/hub/src/aggregate/groupby.ts`, change the constructor field on `GroupedQuery<T, F>` from `private readonly field: F` to `private readonly fields: readonly string[]`. Also adapt `GroupedAggregation`:

```ts
// In GroupedQuery — replace the existing class with this:
export class GroupedQuery<T, F extends string> {
  constructor(
    private readonly executeRecords: () => readonly unknown[],
    private readonly fields: readonly string[],   // was: field: F
    private readonly upstreams: readonly AggregationUpstream[],
    private readonly dictLabelResolver?: (
      key: string,
      locale: string,
      fallback?: string | readonly string[],
    ) => Promise<string | undefined>,
  ) {
    void undefined as T | undefined
  }

  aggregate<Spec extends AggregateSpec>(
    spec: Spec,
  ): GroupedAggregation<GroupedRow<F, AggregateResult<Spec>>> {
    return new GroupedAggregation<GroupedRow<F, AggregateResult<Spec>>>(
      this.executeRecords,
      this.fields,
      spec,
      this.upstreams,
      this.dictLabelResolver,
    )
  }
}

// In GroupedAggregation — change the field constructor param:
//   private readonly fields: readonly string[],   // was: field: string,
// And every internal reference to `this.field` must read `this.fields`.
```

`GroupedRow<F, R>` keeps its existing single-field shape `{ [K in F]: unknown } & R` — when `F` is a single-field type the multi-key generic-projection task (next overload) widens it through a new helper type `GroupedRowN<F, R>`.

- [ ] **Step 2: Add `GroupedRowN` helper type**

In `packages/hub/src/aggregate/groupby.ts`, alongside `GroupedRow`:

```ts
/**
 * Multi-key version of GroupedRow. F is a readonly tuple of field
 * literal types; each becomes a property of the row.
 */
export type GroupedRowN<F extends readonly string[], R> =
  { [K in F[number]]: unknown } & R
```

- [ ] **Step 3: Update `groupAndReduce` to use `canonicalGroupKey` and stamp every field**

In `groupAndReduce`, change the signature from `field: string` to `fields: readonly string[]`. Replace the bucketing loop and row emission as follows:

```ts
import { canonicalGroupKey } from './canonical-key.js'

export function groupAndReduce<R>(
  records: readonly unknown[],
  fields: readonly string[],
  spec: AggregateSpec,
): R[] {
  // bucket key: canonicalGroupKey serialisation
  // bucket value: { keyValues: Record<field, unknown>, records: unknown[] }
  // Storing keyValues per bucket lets us reconstruct row output in
  // declaration order without re-reading the source records.
  const buckets = new Map<string, { keyValues: Record<string, unknown>; records: unknown[] }>()

  for (const record of records) {
    const keyValues: Record<string, unknown> = {}
    for (const f of fields) {
      keyValues[f] = readPath(record, f)
    }
    const bucketKey = canonicalGroupKey(fields, keyValues)
    let bucket = buckets.get(bucketKey)
    if (bucket === undefined) {
      if (buckets.size >= GROUPBY_MAX_CARDINALITY) {
        throw new GroupCardinalityError(
          fields.join(','),
          buckets.size + 1,
          GROUPBY_MAX_CARDINALITY,
        )
      }
      bucket = { keyValues, records: [] }
      buckets.set(bucketKey, bucket)
    }
    bucket.records.push(record)
  }

  if (buckets.size >= GROUPBY_WARN_CARDINALITY) {
    warnCardinalityApproaching(fields, buckets.size)
  }

  const reducerKeys = Object.keys(spec)
  const out: R[] = []
  for (const bucket of buckets.values()) {
    const state: Record<string, unknown> = {}
    for (const key of reducerKeys) {
      state[key] = spec[key]!.init()
    }
    for (const record of bucket.records) {
      for (const key of reducerKeys) {
        state[key] = spec[key]!.step(state[key], record)
      }
    }
    // Emit fields in DECLARATION order, then reducer outputs.
    const row: Record<string, unknown> = {}
    for (const f of fields) row[f] = bucket.keyValues[f]
    for (const key of reducerKeys) {
      row[key] = spec[key]!.finalize(state[key])
    }
    out.push(row as unknown as R)
  }
  return out
}
```

- [ ] **Step 4: Adapt `warnCardinalityApproaching` and the warning dedup set to take `fields: readonly string[]`**

In `groupby.ts`:

```ts
const warnedCardinalityFields = new Set<string>()  // keyed on JSON.stringify([...fields].sort())

function warnCardinalityApproaching(fields: readonly string[], observed: number): void {
  const dedupKey = JSON.stringify([...fields].sort())
  if (warnedCardinalityFields.has(dedupKey)) return
  warnedCardinalityFields.add(dedupKey)
  const label = `[${fields.join(', ')}]`
  console.warn(
    `[noy-db] .groupBy(${label}) produced ${observed} distinct groups, ` +
      `${Math.round((observed / GROUPBY_MAX_CARDINALITY) * 100)}% of the ` +
      `${GROUPBY_MAX_CARDINALITY}-group ceiling. Narrow the query with ` +
      `.where() before grouping, or switch to a lower-cardinality field combination.`,
  )
}

export function resetGroupByWarnings(): void {
  warnedCardinalityFields.clear()
}
```

- [ ] **Step 5: Update `GroupedAggregation` internals (`run()`, live mode) to call `groupAndReduce(records, this.fields, this.spec)`**

In `groupby.ts`, every internal call to `groupAndReduce(records, this.field, this.spec)` becomes `groupAndReduce(records, this.fields, this.spec)`. Live mode rebinds the same way.

- [ ] **Step 6: Add variadic overload on `Query<T>.groupBy`**

In `packages/hub/src/query/builder.ts`, REPLACE the single `groupBy` method definition (around line 588) with two declarations: one overload for the single-field case (keeps narrowed return) and an implementation that handles 1..N.

```ts
// Single-field overload — back-compat, narrows F to the literal.
groupBy<F extends string>(field: F): GroupedQuery<T, F>
// Variadic overload — multi-key. F is a tuple of literal types.
groupBy<F extends readonly [string, ...string[]]>(...fields: F): GroupedQueryN<T, F>
// Implementation
groupBy(...fields: readonly string[]): GroupedQuery<T, string> | GroupedQueryN<T, readonly [string, ...string[]]> {
  if (fields.length === 0) {
    throw new Error('groupBy requires at least one field')
  }
  const source = this.source
  const clauses = this.plan.clauses
  const executeRecords = (): readonly unknown[] => {
    const { candidates, remainingClauses } = candidateRecords(source, clauses)
    return remainingClauses.length === 0
      ? candidates
      : filterRecords(candidates, remainingClauses)
  }

  const upstreams: AggregationUpstream[] = []
  if (source.subscribe) {
    const subscribe = source.subscribe.bind(source)
    upstreams.push({ subscribe: (cb: () => void) => subscribe(cb) })
  }

  // Dict label resolver — only meaningful for SINGLE-field groupBy
  // (multi-key dictKey narrowing is out of scope for #166; future work).
  const joinCtx = this.joinContext
  const dictLabelResolver =
    fields.length === 1 && joinCtx?.resolveDictSource
      ? buildDictLabelResolver(joinCtx, fields[0]!) // extract existing inline closure into a helper
      : undefined

  return this.aggregateStrategy.groupByN(executeRecords, fields, upstreams, dictLabelResolver)
}
```

Add a corresponding `groupByN` method on the aggregate strategy (`packages/hub/src/aggregate/strategy.ts` — mirror the existing `groupBy<T, F>` factory but accept `fields: readonly string[]` and construct `GroupedQuery` with `fields` rather than a single `field`). The single-field overload's runtime path now flows through `groupByN(..., [field], ...)`.

The closure that builds `dictLabelResolver` (currently inlined in `builder.ts`) extracts into `buildDictLabelResolver(joinCtx, field)` so the implementation method body stays readable. Mechanical extraction; no logic change.

- [ ] **Step 7: Export `GroupedRowN` and the variadic types from the public surface**

In `packages/hub/src/aggregate/index.ts`, add `GroupedRowN` and `GroupedQuery` re-exports if they aren't already there. The aggregate barrel determines the consumer surface; check existing re-exports and follow the same pattern.

- [ ] **Step 8: Run tests**

Run: `pnpm vitest run packages/hub/__tests__/query-groupby.test.ts`
Expected: ALL groupby tests pass (existing single-key cases stay green; new multi-key cases pass).

- [ ] **Step 9: Run full hub test suite to check for regressions**

Run: `pnpm vitest run packages/hub`
Expected: 1573 + new tests pass.

- [ ] **Step 10: Run typecheck**

Run: `pnpm turbo typecheck --filter=@noy-db/hub`
Expected: 0 errors.

- [ ] **Step 11: Commit**

```bash
git add packages/hub/src/aggregate/canonical-key.ts \
        packages/hub/src/aggregate/groupby.ts \
        packages/hub/src/aggregate/strategy.ts \
        packages/hub/src/aggregate/index.ts \
        packages/hub/src/query/builder.ts \
        packages/hub/__tests__/query-groupby.test.ts \
        packages/hub/__tests__/aggregate-canonical-key.test.ts
git commit -m "feat(hub): variadic Query.groupBy(...fields) — multi-key groupBy (#166)"
```

---

## Task 4: Accept `groupBy: string | string[]` on `withMaterializedView`

**Files:**
- Modify: `packages/hub/src/materialized-views/types.ts`
- Test: `packages/hub/__tests__/materialized-views/multikey.test.ts` (new)

This is plumbing — the MV strategy already declares its query via a `query: (db) => Query<T>` callback, and the callback can already call the variadic `groupBy` after Task 3. But callers that want a *declarative* `groupBy` field on the strategy object (the niwat shape used in #165's spec) need that field on `MaterializedViewStrategy`.

For pre.15 we EXPOSE the field but keep its execution route through `query()`. The UNION MV task (PR 2) is what consumes the declarative `groupBy` field on the strategy object — single-source MVs continue to express groupBy inside `query()`. This task does the type-level wiring only.

- [ ] **Step 1: Add multi-key MV test (failing)**

```ts
// packages/hub/__tests__/materialized-views/multikey.test.ts
import { describe, it, expect } from 'vitest'
import { withMaterializedView, sum, count } from '../../src/index.js'
import { createTestVault } from '../helpers/test-vault.js'  // existing test helper pattern

describe('withMaterializedView — multi-key groupBy inside query() (#166)', () => {
  it('refreshes a per-(clientId, period) MV when source rows are added', async () => {
    const vault = await createTestVault({
      collections: ['compensations', 'pnd1Auto'],
      strategies: [
        withMaterializedView<{ clientId: string; period: string; total: number }>({
          name: 'pnd1Auto',
          query: db =>
            db.collection<{ clientId: string; period: string; taxAmount: number }>('compensations')
              .query()
              .groupBy('clientId', 'period')
              .aggregate({ total: sum('taxAmount') }),
          sources: ['compensations'],
          rowKey: row => `${row.clientId}|${row.period}`,
          refresh: 'eager',
        }),
      ],
    })

    const comps = vault.collection<{ id: string; clientId: string; period: string; taxAmount: number }>('compensations')
    await comps.put({ id: 'a', clientId: 'c1', period: '2026-05', taxAmount: 100 })
    await comps.put({ id: 'b', clientId: 'c1', period: '2026-05', taxAmount: 50 })
    await comps.put({ id: 'c', clientId: 'c2', period: '2026-05', taxAmount: 200 })

    const out = vault.collection<{ clientId: string; period: string; total: number }>('pnd1Auto')
    const rows = await out.query().toArray()
    expect(rows).toHaveLength(2)
    const c1May = rows.find(r => r.clientId === 'c1' && r.period === '2026-05')!
    expect(c1May.total).toBe(150)
  })
})
```

- [ ] **Step 2: Run test to verify it fails (`groupBy` accepts only 1 arg today, but Task 3 already fixed this — so the test may already pass)**

Run: `pnpm vitest run packages/hub/__tests__/materialized-views/multikey.test.ts`
Expected: PASS already after Task 3 if MV machinery works with the multi-key query plan. If FAIL, the failure mode is dependency-analyzer-related (it walks `Query`'s AST — needs to handle multi-key groupBy).

- [ ] **Step 3 (if step 2 failed): Update dependency analyzer to recognise multi-key groupBy plans**

In `packages/hub/src/materialized-views/dependency-analyzer.ts`, the analyzer walks the `Query` plan. If multi-key groupBy added a new plan-node shape, extend the visitor to handle it. The expected fix is small — the groupBy plan-node stores fields as an array now; the analyzer must read `fields` instead of `field`. Look for any reference to `.field` on a groupBy plan node and switch to `.fields`.

- [ ] **Step 4: Re-run MV multi-key test**

Run: `pnpm vitest run packages/hub/__tests__/materialized-views/multikey.test.ts`
Expected: PASS.

- [ ] **Step 5: Run all MV tests**

Run: `pnpm vitest run packages/hub/__tests__/materialized-views`
Expected: All pre.14 MV tests still green, plus the new multikey test.

- [ ] **Step 6: Commit**

```bash
git add packages/hub/src/materialized-views/dependency-analyzer.ts \
        packages/hub/__tests__/materialized-views/multikey.test.ts
git commit -m "feat(hub): materialized views support multi-key groupBy in query() (#166)"
```

---

## Task 5: Multi-key groupBy showcase

**Files:**
- Create: `showcases/src/<next-N>-with-multikey-groupby.showcase.test.ts`

- [ ] **Step 1: Determine showcase number**

Run: `ls showcases/src/*.showcase.test.ts | sort | tail -5`
Use the next free integer (e.g., if last is `70-…`, this is `71-with-multikey-groupby.showcase.test.ts`).

- [ ] **Step 2: Write the showcase**

Follow the existing showcase template (see `10-with-aggregate.showcase.test.ts` for the pattern: top-of-file doc-comment with "What you'll learn / Why it matters / Prerequisites / What to read next" sections, then one `describe` block with assertions).

```ts
/**
 * Showcase 71 — multi-key groupBy
 *
 * What you'll learn
 * ─────────────────
 * Group records by TWO OR MORE fields. The chainable builder accepts
 * a variadic `groupBy(...fields)` call; result rows carry every
 * grouped field plus the reducer outputs.
 *
 * Why it matters
 * ──────────────
 * Real-world aggregations are rarely keyed by a single field. A
 * per-(client, period) roll-up shape — invoices summed by client and
 * month, taxes aggregated by tenant and reporting window — needs a
 * composite key. Multi-key groupBy lets you express that directly,
 * with no synthetic concatenated-key field on the source schema.
 *
 * Prerequisites
 * ─────────────
 * - Showcase 10 (single-key groupBy + aggregate)
 *
 * What to read next
 * ─────────────────
 *   - showcase 72-with-union-mv (UNION across sibling collections)
 *   - docs/subsystems/derivations.md
 */

import { describe, it, expect } from 'vitest'
import { createMemoryVault, sum, count } from '@noy-db/hub'

describe('Showcase 71 — multi-key groupBy', () => {
  it('groups by (clientId, period) and sums amount', async () => {
    const vault = await createMemoryVault()
    const invoices = vault.collection<{
      id: string; clientId: string; period: string; amount: number
    }>('invoices')
    await invoices.put({ id: 'i1', clientId: 'c1', period: '2026-05', amount: 100 })
    await invoices.put({ id: 'i2', clientId: 'c1', period: '2026-05', amount: 200 })
    await invoices.put({ id: 'i3', clientId: 'c1', period: '2026-06', amount: 300 })
    await invoices.put({ id: 'i4', clientId: 'c2', period: '2026-05', amount: 400 })

    const rows = invoices.query()
      .groupBy('clientId', 'period')
      .aggregate({ total: sum('amount'), n: count() })
      .run()

    expect(rows).toHaveLength(3)
    const c1May = rows.find(r => r.clientId === 'c1' && r.period === '2026-05')!
    expect(c1May.total).toBe(300)
    expect(c1May.n).toBe(2)
  })
})
```

Replace `createMemoryVault` with whatever bootstrap the existing showcases use (see showcase 10 for the exact import). The point is one runnable end-to-end test.

- [ ] **Step 3: Run the showcase**

Run: `pnpm vitest run showcases/src/71-with-multikey-groupby.showcase.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add showcases/src/71-with-multikey-groupby.showcase.test.ts
git commit -m "showcase(hub): multi-key groupBy walkthrough (#166)"
```

---

## Task 6: Update `features.yaml` and subsystem docs for multi-key

**Files:**
- Modify: `features.yaml`
- Modify: `docs/subsystems/derivations.md` (or `materialized-views.md` — check which subsystem doc lives at top of the `docs/subsystems/` dir for derived-data)

- [ ] **Step 1: Add a `mv-multikey-groupby` entry to `features.yaml`**

Look at an existing entry near the MV-related rows for the exact schema. Likely shape:

```yaml
- id: mv-multikey-groupby
  package: '@noy-db/hub'
  title: Multi-key groupBy
  summary: Variadic `Query.groupBy(...fields)` and matching `withMaterializedView` query path. One row per composite key, every grouped field stamped on the row.
  since: 0.1.0-pre.15
  status: stable
  showcase: 71-with-multikey-groupby
  subsystem: derived-data
```

Adjust `subsystem`, `status`, and `since` to match the existing taxonomy.

- [ ] **Step 2: Validate features.yaml**

Run: `node scripts/validate-features.mjs`
Expected: 0 errors.

- [ ] **Step 3: Add a "Multi-key groupBy" section to the relevant subsystem doc**

In `docs/subsystems/derivations.md` (or wherever single-key `groupBy` is documented), add a sibling section:

```md
### Multi-key groupBy

`Query<T>.groupBy(...fields)` accepts one or more field names. The
result rows carry every grouped field (in declaration order) plus the
reducer outputs:

```ts
.groupBy('clientId', 'period')
.aggregate({ total: sum('amount') })
// → [ { clientId: 'c1', period: '2026-05', total: 300 }, … ]
```

Inside `withMaterializedView({ query: db => … })`, multi-key groupBy
works the same way. The MV consumer's `rowKey` callback receives the
full row with every grouped field populated — encode the composite key
however you like (`\`${a}|${b}\``, JSON, hash, …); the hub does not
impose a canonical encoding.

Cardinality thresholds (10k warn, 100k throw) apply on the count of
distinct tuples, not on the count of fields. The warning message lists
every grouped field name.
```

- [ ] **Step 4: Commit**

```bash
git add features.yaml docs/subsystems/derivations.md
git commit -m "docs(hub): multi-key groupBy feature entry + subsystem doc (#166)"
```

---

## Task 7: PR 1 — final checks, push, open PR

- [ ] **Step 1: Run full validation**

Run: `pnpm turbo build && pnpm turbo lint --filter=@noy-db/hub && pnpm turbo typecheck && pnpm vitest run packages/hub && node scripts/check-architecture.mjs && node scripts/validate-features.mjs`
Expected: all green.

- [ ] **Step 2: Push branch**

Run: `git push -u origin feat/dim14-mv-multikey-and-union`

- [ ] **Step 3: Open PR for the multi-key half ONLY**

Use a stacked-PR style: this PR is "PR 1" of three on the same branch. Title:

```
feat(hub): variadic Query.groupBy(...fields) — multi-key groupBy (#166)
```

Body should reference the spec, list the changed files, and note that PR 2 (#165 UNION MV) follows on the same branch.

```bash
gh pr create --title "feat(hub): variadic Query.groupBy(...fields) — multi-key groupBy (#166)" --body "$(cat <<'EOF'
## Summary
- Variadic `Query<T>.groupBy(...fields)` with back-compatible single-arg overload
- `canonicalGroupKey` helper (reused by upcoming UNION MV PR)
- MV strategies can use multi-key groupBy inside `query()`
- One showcase + features.yaml entry + subsystem doc section

Closes #166. Part of pre.15 cycle alongside #165 (UNION MV — follow-up PR on same branch) and #131 (variance cleanup — third PR on same branch).

Spec: docs/superpowers/specs/2026-05-22-dim14-mv-multikey-and-union-design.md

## Test plan
- [ ] `pnpm vitest run packages/hub` passes 1573 + new tests
- [ ] `pnpm turbo typecheck` clean
- [ ] `node scripts/validate-features.mjs` clean
- [ ] Showcase 71 runs green
EOF
)"
```

- [ ] **Step 4: Wait for PR 1 review/merge before continuing OR proceed on the same branch**

Two options depending on the cycle's PR cadence:
- **Sequential**: merge PR 1 to `main`, then rebase the branch on the merged `main` and continue PR 2. Cleaner history.
- **Stacked**: continue PR 2 work on the same branch immediately; PR 2 PR target stays as `feat/dim14-mv-multikey-and-union` until PR 1 merges, then re-targets to `main`. Faster iteration.

Document choice in the PR description. Default: **sequential** unless reviewer asks for stacked.

---

# PR 2 — #165 UNION MV (Option 1: `unionSources`)

## Task 8: Add UNION MV types

**Files:**
- Modify: `packages/hub/src/materialized-views/types.ts`

- [ ] **Step 1: Add `UnionSource` interface and extend `MaterializedViewStrategy`**

In `packages/hub/src/materialized-views/types.ts`, after the existing `MaterializedFromMeta`/`MVQueryContext` declarations, add:

```ts
/**
 * One arm of a UNION MV. Reads from `collection`, then maps each
 * source row to the MV's row shape via `map`. Mandatory per-source
 * `map` is the schema-unification boundary — sibling collections
 * can have different schemas, and `map` is where they meet.
 */
export interface UnionSource<TRow extends Record<string, unknown>> {
  /** Source collection name. Must exist in the vault. */
  readonly collection: string
  /**
   * Pure function from a source row to the unified MV row shape.
   * Called once per source row at materialization time.
   *
   * The function MUST return a row matching the strategy's `TRow`
   * type parameter; both UNION arms' map outputs are concatenated
   * before `groupBy` + `aggregate` run.
   */
  readonly map: (sourceRow: Record<string, unknown>) => TRow
}
```

Extend `MaterializedViewStrategy<TRow>`:

```ts
export interface MaterializedViewStrategy<TRow extends Record<string, unknown>> {
  name: string
  /** Required for single-source MVs; mutually exclusive with `unionSources`. */
  query?: (db: MVQueryContext) => Query<TRow>
  /**
   * UNION MV mode — read from multiple sibling collections.
   * Mutually exclusive with `query`. Minimum two arms.
   * Each arm contributes its `collection` to the dependency set and
   * to the source-write hook reverse-index.
   */
  unionSources?: ReadonlyArray<UnionSource<TRow>>
  /**
   * Group-by clause for UNION MVs. Applied to the concatenated stream
   * after every arm's `map` runs. Accepts a single field name or an
   * array of field names (multi-key). Omit for pure UNION-without-aggregate.
   *
   * Ignored when `query` is set — single-source MVs express groupBy
   * inside the query callback.
   */
  groupBy?: string | ReadonlyArray<string>
  /**
   * Aggregate spec for UNION MVs. Runs after `groupBy` partitions
   * the concatenated stream. Ignored when `query` is set.
   */
  aggregate?: AggregateSpec<unknown>

  rowKey: (row: TRow) => string
  sources?: ReadonlyArray<string>
  predicates?: { [name: string]: { hash: string; fn: (row: TRow, ctx?: unknown) => boolean } }
  refresh?: 'eager' | 'lazy'
  strict?: boolean
  onEmpty?: 'tombstone' | 'keep'
  maxRows?: number
  // ... any other existing fields kept verbatim
}
```

`AggregateSpec` is imported from `../aggregate/aggregation.js` (mirror existing imports in the same file).

- [ ] **Step 2: Typecheck the package**

Run: `pnpm turbo typecheck --filter=@noy-db/hub`
Expected: 0 errors (no consumer uses the new fields yet — additive change).

- [ ] **Step 3: Commit**

```bash
git add packages/hub/src/materialized-views/types.ts
git commit -m "feat(hub): UnionSource type + unionSources/groupBy/aggregate fields on MV strategy (#165)"
```

---

## Task 9: Registration-time validation for `unionSources`

**Files:**
- Modify: `packages/hub/src/materialized-views/with-materialized-view.ts`
- Modify: `packages/hub/src/errors.ts` (add `MaterializedViewConfigError` if not already present)

- [ ] **Step 1: Add failing validation test**

```ts
// packages/hub/__tests__/materialized-views/union-validation.test.ts
import { describe, it, expect } from 'vitest'
import { withMaterializedView, MaterializedViewConfigError, sum } from '../../src/index.js'

describe('withMaterializedView UNION validation (#165)', () => {
  it('rejects strategy with both query and unionSources', () => {
    expect(() => withMaterializedView({
      name: 'bad',
      query: () => null as any,
      unionSources: [
        { collection: 'a', map: r => r as any },
        { collection: 'b', map: r => r as any },
      ],
      rowKey: () => 'k',
    })).toThrow(MaterializedViewConfigError)
  })

  it('rejects unionSources with fewer than 2 arms', () => {
    expect(() => withMaterializedView({
      name: 'bad',
      unionSources: [{ collection: 'a', map: r => r as any }],
      rowKey: () => 'k',
    })).toThrow(/at least 2/)
  })

  it('rejects unionSources with duplicate collection names', () => {
    expect(() => withMaterializedView({
      name: 'bad',
      unionSources: [
        { collection: 'a', map: r => r as any },
        { collection: 'a', map: r => r as any },
      ],
      rowKey: () => 'k',
    })).toThrow(/distinct collections/)
  })

  it('accepts a well-formed UNION strategy', () => {
    expect(() => withMaterializedView<{ k: string; n: number }>({
      name: 'good',
      unionSources: [
        { collection: 'a', map: (r: any) => ({ k: r.k, n: r.n }) },
        { collection: 'b', map: (r: any) => ({ k: r.k, n: r.n }) },
      ],
      groupBy: 'k',
      aggregate: { total: sum('n') },
      rowKey: row => row.k,
    })).not.toThrow()
  })
})
```

- [ ] **Step 2: Run test (expected: tests fail because validation not yet wired)**

Run: `pnpm vitest run packages/hub/__tests__/materialized-views/union-validation.test.ts`
Expected: FAIL.

- [ ] **Step 3: Add `MaterializedViewConfigError` if missing**

In `packages/hub/src/errors.ts`, ensure an error class exists (mirror existing MV errors like `MaterializedViewCycleError`):

```ts
export class MaterializedViewConfigError extends Error {
  constructor(message: string) {
    super(`[noy-db] withMaterializedView: ${message}`)
    this.name = 'MaterializedViewConfigError'
  }
}
```

- [ ] **Step 4: Add validation in `withMaterializedView` factory**

In `packages/hub/src/materialized-views/with-materialized-view.ts`, at the top of the factory body (before any handle construction):

```ts
import { MaterializedViewConfigError } from '../errors.js'

export function withMaterializedView<TRow extends Record<string, unknown>>(
  spec: MaterializedViewStrategy<TRow>,
): MaterializedViewHandle<TRow> {
  // --- BEGIN UNION validation ---
  if (spec.query && spec.unionSources) {
    throw new MaterializedViewConfigError(
      'query and unionSources are mutually exclusive — pick one',
    )
  }
  if (spec.unionSources) {
    if (spec.unionSources.length < 2) {
      throw new MaterializedViewConfigError(
        'unionSources requires at least 2 source collections',
      )
    }
    const seen = new Set<string>()
    for (const s of spec.unionSources) {
      if (seen.has(s.collection)) {
        throw new MaterializedViewConfigError(
          `unionSources must reference distinct collections (duplicate: \"${s.collection}\")`,
        )
      }
      seen.add(s.collection)
    }
  }
  if (!spec.query && !spec.unionSources) {
    throw new MaterializedViewConfigError(
      'strategy must declare either query or unionSources',
    )
  }
  // --- END UNION validation ---

  // ... existing factory body (handle construction, etc.) unchanged
}
```

- [ ] **Step 5: Re-run validation tests**

Run: `pnpm vitest run packages/hub/__tests__/materialized-views/union-validation.test.ts`
Expected: PASS (4 cases).

- [ ] **Step 6: Re-export `MaterializedViewConfigError` from the hub barrel**

In `packages/hub/src/index.ts` (or whichever module exports MV errors), ensure `MaterializedViewConfigError` is re-exported alongside `MaterializedViewCycleError`.

- [ ] **Step 7: Commit**

```bash
git add packages/hub/src/errors.ts \
        packages/hub/src/materialized-views/with-materialized-view.ts \
        packages/hub/src/index.ts \
        packages/hub/__tests__/materialized-views/union-validation.test.ts
git commit -m "feat(hub): registration-time validation for unionSources (#165)"
```

---

## Task 10: Dep-analyzer shortcut for `unionSources`

**Files:**
- Modify: `packages/hub/src/materialized-views/registry.ts` (around the analyzer call site, register method body)
- Modify: `packages/hub/src/materialized-views/dependency-analyzer.ts` (if needed)

The registry's `register` method today calls `analyzeDependencies(q)` on the query plan. For UNION MVs, skip the AST walk and read collections directly off `unionSources`.

- [ ] **Step 1: Locate the dependency derivation in `registry.ts`**

Open `packages/hub/src/materialized-views/registry.ts` and find the block (around lines 67–105 per the existing implementation) that derives `dependencies: Set<string>`:

```ts
// Existing code shape (approximate):
const q = spec.query(mvQueryContext)
let dependencies: Set<string>
try {
  dependencies = analyzeDependencies(q)
  if (spec.sources) for (const s of spec.sources) dependencies.add(s)
} catch (err) {
  if (!spec.sources) throw err
  dependencies = new Set(spec.sources)
}
```

- [ ] **Step 2: Branch on `unionSources`**

Add an early branch BEFORE the existing query-form dependency derivation:

```ts
let dependencies: Set<string>
let queryPlanSummary: string

if (spec.unionSources) {
  // UNION form — dependencies are the explicit arms.
  dependencies = new Set(spec.unionSources.map(s => s.collection))
  // No query plan to summarise; queryHash inputs use a synthetic plan.
  queryPlanSummary = summarizeUnionPlan(spec)
} else {
  // existing query-form branch — unchanged
  const q = spec.query!(mvQueryContext)
  try {
    dependencies = analyzeDependencies(q)
    if (spec.sources) for (const s of spec.sources) dependencies.add(s)
  } catch (err) {
    if (!spec.sources) throw err
    dependencies = new Set(spec.sources)
  }
  queryPlanSummary = summarizeQueryPlan(q)
}
```

- [ ] **Step 3: Add `summarizeUnionPlan` helper**

In `packages/hub/src/materialized-views/dependency-analyzer.ts`, alongside `summarizeQueryPlan`:

```ts
import type { MaterializedViewStrategy } from './types.js'

/**
 * Canonical string description of a UNION MV's plan, used as input
 * to `computeQueryHash`. Includes every arm's collection name (sorted
 * for determinism), the groupBy fields (sorted), and the aggregate
 * spec keys (sorted) — enough that any structural change forces a
 * fresh queryHash on next visit.
 *
 * Per-arm `map` callbacks are NOT fingerprinted (they're function
 * identity; consumers must explicitly invalidate via name/version
 * bump if they change map semantics in a non-equivalent way).
 */
export function summarizeUnionPlan<T extends Record<string, unknown>>(
  spec: MaterializedViewStrategy<T>,
): string {
  const arms = [...(spec.unionSources ?? [])]
    .map(s => s.collection)
    .sort()
    .join(',')
  const groupBy = Array.isArray(spec.groupBy)
    ? [...spec.groupBy].sort().join(',')
    : spec.groupBy ?? ''
  const aggKeys = spec.aggregate ? Object.keys(spec.aggregate).sort().join(',') : ''
  return `union(${arms})|groupBy(${groupBy})|aggregate(${aggKeys})`
}
```

- [ ] **Step 4: Adapt `register()` so the `q` variable is only used in the `query` branch**

The existing code probably calls `spec.query(mvQueryContext)` unconditionally — wrap that call inside the `else` branch as shown in Step 2 so UNION strategies don't fail when `spec.query` is undefined.

- [ ] **Step 5: Run all MV tests**

Run: `pnpm vitest run packages/hub/__tests__/materialized-views`
Expected: pre.14 + multikey tests still pass. UNION MV tests still fail (executor not yet wired — next task).

- [ ] **Step 6: Commit**

```bash
git add packages/hub/src/materialized-views/registry.ts \
        packages/hub/src/materialized-views/dependency-analyzer.ts
git commit -m "feat(hub): MV registry recognises unionSources for dep analysis (#165)"
```

---

## Task 11: Executor branch for `unionSources`

**Files:**
- Modify: `packages/hub/src/materialized-views/executor.ts`

The executor's `materializeQueryResult` (around line 47 per the grep above) drives a single `Query` plan. UNION needs a sibling path that reads each arm, maps, concatenates, then runs groupBy + aggregate.

- [ ] **Step 1: Add failing UNION executor test (basic 2-source UNION + groupBy)**

```ts
// packages/hub/__tests__/materialized-views/union.test.ts
import { describe, it, expect } from 'vitest'
import { withMaterializedView, sum } from '../../src/index.js'
import { createTestVault } from '../helpers/test-vault.js'

describe('UNION MV — basic 2-source (#165)', () => {
  it('reads from both arms, maps, groupBy, aggregate', async () => {
    const vault = await createTestVault({
      collections: ['taxReceipts', 'creditNotes', 'monthlyVat'],
      strategies: [
        withMaterializedView<{ period: string; vat: number }>({
          name: 'monthlyVat',
          unionSources: [
            { collection: 'taxReceipts', map: (r: any) => ({ period: r.issuedAt.slice(0, 7), vat:  r.paidServicesVat }) },
            { collection: 'creditNotes', map: (r: any) => ({ period: r.issuedAt.slice(0, 7), vat: -r.paidServicesVat }) },
          ],
          groupBy: 'period',
          aggregate: { vat: sum('vat') },
          rowKey: row => row.period,
          refresh: 'eager',
        }),
      ],
    })

    const receipts = vault.collection<{ id: string; issuedAt: string; paidServicesVat: number }>('taxReceipts')
    const notes = vault.collection<{ id: string; issuedAt: string; paidServicesVat: number }>('creditNotes')

    await receipts.put({ id: 'r1', issuedAt: '2026-05-15', paidServicesVat: 100 })
    await receipts.put({ id: 'r2', issuedAt: '2026-05-20', paidServicesVat: 50 })
    await notes.put({ id: 'n1', issuedAt: '2026-05-25', paidServicesVat: 30 })

    const out = vault.collection<{ period: string; vat: number }>('monthlyVat')
    const rows = await out.query().toArray()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.period).toBe('2026-05')
    expect(rows[0]!.vat).toBe(120) // 100 + 50 - 30
  })

  it('refreshes on writes to either arm independently', async () => {
    const vault = await createTestVault({
      collections: ['a', 'b', 'totals'],
      strategies: [
        withMaterializedView<{ k: string; n: number }>({
          name: 'totals',
          unionSources: [
            { collection: 'a', map: (r: any) => ({ k: r.k, n: r.n }) },
            { collection: 'b', map: (r: any) => ({ k: r.k, n: r.n }) },
          ],
          groupBy: 'k',
          aggregate: { total: sum('n') },
          rowKey: row => row.k,
          refresh: 'eager',
        }),
      ],
    })
    const a = vault.collection<{ id: string; k: string; n: number }>('a')
    const b = vault.collection<{ id: string; k: string; n: number }>('b')

    await a.put({ id: 'a1', k: 'x', n: 1 })
    let rows = await vault.collection<any>('totals').query().toArray()
    expect(rows.find((r: any) => r.k === 'x')!.total).toBe(1)

    await b.put({ id: 'b1', k: 'x', n: 10 })
    rows = await vault.collection<any>('totals').query().toArray()
    expect(rows.find((r: any) => r.k === 'x')!.total).toBe(11)
  })
})
```

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm vitest run packages/hub/__tests__/materialized-views/union.test.ts`
Expected: FAIL — executor still routes through `query` callback which is undefined.

- [ ] **Step 3: Branch executor on strategy form**

In `packages/hub/src/materialized-views/executor.ts`, identify the entry point (likely `materializeQueryResult` or whatever the registry calls when it needs to materialize). Add a sibling `materializeUnionResult`:

```ts
import { groupAndReduce } from '../aggregate/groupby.js'
import { runReducer } from '../aggregate/aggregation.js' // existing helper for non-grouped aggregate
import type { MaterializedViewStrategy, UnionSource } from './types.js'

async function materializeUnionResult<TRow extends Record<string, unknown>>(
  spec: MaterializedViewStrategy<TRow>,
  db: MVQueryContext,
): Promise<TRow[]> {
  const unified: TRow[] = []
  for (const arm of spec.unionSources!) {
    const coll = db.collection<Record<string, unknown>>(arm.collection)
    const sourceRows = await coll.query().toArray()
    for (const r of sourceRows) {
      unified.push(arm.map(r))
    }
  }

  // No groupBy → emit unified rows as-is
  if (!spec.groupBy) return unified

  const groupFields: readonly string[] =
    typeof spec.groupBy === 'string' ? [spec.groupBy] : spec.groupBy

  if (!spec.aggregate) {
    // groupBy without aggregate: dedup by composite key, keep first.
    // Rare consumer pattern but well-defined.
    const seen = new Map<string, TRow>()
    for (const row of unified) {
      const k = canonicalGroupKey(groupFields, row as Record<string, unknown>)
      if (!seen.has(k)) seen.set(k, row)
    }
    return [...seen.values()]
  }

  // groupBy + aggregate: reuse the shared groupAndReduce
  return groupAndReduce<TRow>(unified, groupFields, spec.aggregate)
}
```

Import `canonicalGroupKey` from `../aggregate/canonical-key.js`.

- [ ] **Step 4: Dispatch on strategy form at the executor's entry point**

Locate the function the registry calls to drive materialisation (likely `materializeQueryResult` or a public `runMaterialization`). Add a branch:

```ts
export async function runMaterialization<TRow extends Record<string, unknown>>(
  spec: MaterializedViewStrategy<TRow>,
  db: MVQueryContext,
): Promise<TRow[]> {
  if (spec.unionSources) {
    return materializeUnionResult(spec, db)
  }
  // existing query-form path
  return materializeQueryResult(spec, db)
}
```

If the existing executor entry has a different name, wrap it the same way. The key constraint: every existing call site that drives MV materialization must funnel through the dispatcher.

- [ ] **Step 5: Wire UNION refresh to source-write hooks**

The registry already populates `dependencies` for UNION MVs (Task 10). The source-write hook (`Collection.put`) reads `registry.findMvsForCollection(coll)` (or whatever the existing function name is — `grep` for `dependencies.has` and `mvs.filter`) to find MVs to refresh. UNION MVs are now visible to that lookup because both arm collections are in their `dependencies` set. NO additional plumbing should be needed.

Verify by examining how the source-write hook iterates MVs today. If it walks `registry.iterMVs()` and filters by `reg.dependencies.has(writtenCollection)`, no change needed. If it has a separate single-source fast path, generalise it.

- [ ] **Step 6: Run UNION executor tests**

Run: `pnpm vitest run packages/hub/__tests__/materialized-views/union.test.ts`
Expected: PASS (both basic tests).

- [ ] **Step 7: Run full MV test suite**

Run: `pnpm vitest run packages/hub/__tests__/materialized-views`
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add packages/hub/src/materialized-views/executor.ts \
        packages/hub/__tests__/materialized-views/union.test.ts
git commit -m "feat(hub): UNION MV executor — reads multiple arms, maps, groups, aggregates (#165)"
```

---

## Task 12: UNION + multi-key composition test (the niwat canonical shape)

**Files:**
- Modify: `packages/hub/__tests__/materialized-views/union.test.ts`

- [ ] **Step 1: Add the composite test**

Append to `union.test.ts`:

```ts
describe('UNION MV — combined with multi-key groupBy (#165 + #166)', () => {
  it('niwat canonical monthly-VAT shape: union(taxReceipts, creditNotes) + groupBy(clientId, period)', async () => {
    const vault = await createTestVault({
      collections: ['taxReceipts', 'creditNotes', 'monthlyOutputVat'],
      strategies: [
        withMaterializedView<{ clientId: string; period: string; vat: number }>({
          name: 'monthlyOutputVat',
          unionSources: [
            { collection: 'taxReceipts', map: (r: any) => ({ clientId: r.clientId, period: r.issuedAt.slice(0, 7), vat:  r.paidServicesVat }) },
            { collection: 'creditNotes', map: (r: any) => ({ clientId: r.clientId, period: r.issuedAt.slice(0, 7), vat: -r.paidServicesVat }) },
          ],
          groupBy: ['clientId', 'period'],
          aggregate: { vat: sum('vat') },
          rowKey: row => `${row.clientId}|${row.period}`,
          refresh: 'eager',
        }),
      ],
    })

    const receipts = vault.collection<any>('taxReceipts')
    const notes = vault.collection<any>('creditNotes')

    await receipts.put({ id: 'r1', clientId: 'c1', issuedAt: '2026-05-01', paidServicesVat: 100 })
    await receipts.put({ id: 'r2', clientId: 'c1', issuedAt: '2026-05-15', paidServicesVat: 50 })
    await receipts.put({ id: 'r3', clientId: 'c2', issuedAt: '2026-05-10', paidServicesVat: 70 })
    await notes.put({ id: 'n1', clientId: 'c1', issuedAt: '2026-05-20', paidServicesVat: 20 })

    const out = vault.collection<{ clientId: string; period: string; vat: number }>('monthlyOutputVat')
    const rows = await out.query().toArray()
    expect(rows).toHaveLength(2)
    const c1May = rows.find(r => r.clientId === 'c1' && r.period === '2026-05')!
    expect(c1May.vat).toBe(130) // 100 + 50 - 20
    const c2May = rows.find(r => r.clientId === 'c2' && r.period === '2026-05')!
    expect(c2May.vat).toBe(70)
  })
})
```

- [ ] **Step 2: Run the new test**

Run: `pnpm vitest run packages/hub/__tests__/materialized-views/union.test.ts -t "niwat canonical"`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/hub/__tests__/materialized-views/union.test.ts
git commit -m "test(hub): UNION + multi-key composition (niwat monthly-VAT shape) (#165 + #166)"
```

---

## Task 13: Edge-case UNION tests (3-source, onEmpty, strict, maxRows)

**Files:**
- Modify: `packages/hub/__tests__/materialized-views/union.test.ts`

- [ ] **Step 1: Add edge tests**

```ts
describe('UNION MV — edges', () => {
  it('three-source UNION sums correctly', async () => {
    const vault = await createTestVault({
      collections: ['a', 'b', 'c', 'totals'],
      strategies: [
        withMaterializedView<{ k: string; n: number }>({
          name: 'totals',
          unionSources: [
            { collection: 'a', map: (r: any) => ({ k: r.k, n: r.n }) },
            { collection: 'b', map: (r: any) => ({ k: r.k, n: r.n }) },
            { collection: 'c', map: (r: any) => ({ k: r.k, n: r.n }) },
          ],
          groupBy: 'k',
          aggregate: { total: sum('n') },
          rowKey: row => row.k,
          refresh: 'eager',
        }),
      ],
    })
    await vault.collection<any>('a').put({ id: '1', k: 'x', n: 1 })
    await vault.collection<any>('b').put({ id: '1', k: 'x', n: 2 })
    await vault.collection<any>('c').put({ id: '1', k: 'x', n: 4 })

    const rows = await vault.collection<any>('totals').query().toArray()
    expect(rows[0]!.total).toBe(7)
  })

  it('onEmpty: tombstone removes the MV row when all contributing source rows are deleted', async () => {
    const vault = await createTestVault({
      collections: ['a', 'b', 'totals'],
      strategies: [
        withMaterializedView<{ k: string; n: number }>({
          name: 'totals',
          unionSources: [
            { collection: 'a', map: (r: any) => ({ k: r.k, n: r.n }) },
            { collection: 'b', map: (r: any) => ({ k: r.k, n: r.n }) },
          ],
          groupBy: 'k',
          aggregate: { total: sum('n') },
          rowKey: row => row.k,
          refresh: 'eager',
          onEmpty: 'tombstone',
        }),
      ],
    })
    const a = vault.collection<any>('a')
    const b = vault.collection<any>('b')
    await a.put({ id: '1', k: 'x', n: 1 })
    await b.put({ id: '1', k: 'x', n: 2 })

    let rows = await vault.collection<any>('totals').query().toArray()
    expect(rows).toHaveLength(1)

    await a.delete('1')
    await b.delete('1')
    rows = await vault.collection<any>('totals').query().toArray()
    expect(rows).toHaveLength(0)
  })

  // Add similar tests for strict-mode rollback and maxRows enforcement
  // if the existing single-source MV tests cover those — copy-adapt them.
})
```

- [ ] **Step 2: Run edge tests**

Run: `pnpm vitest run packages/hub/__tests__/materialized-views/union.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/hub/__tests__/materialized-views/union.test.ts
git commit -m "test(hub): UNION MV edges (3-source, onEmpty tombstone) (#165)"
```

---

## Task 14: UNION MV showcase

**Files:**
- Create: `showcases/src/<next-N>-with-union-mv.showcase.test.ts`

- [ ] **Step 1: Write showcase**

Mirror the multi-key showcase pattern, e.g.:

```ts
/**
 * Showcase 72 — UNION MV
 *
 * What you'll learn
 * ─────────────────
 * Read from two sibling collections and aggregate across both in one
 * materialized view, via `unionSources`. Per-source `map` is the
 * schema-unification boundary; `groupBy` + `aggregate` run on the
 * concatenated stream.
 *
 * Why it matters
 * ──────────────
 * Many real-world roll-ups span more than one source collection: a
 * monthly VAT obligation that combines tax receipts and credit notes,
 * a per-tenant audit feed merging multiple log shapes, a unified
 * reporting view over two structurally-similar tables. Without UNION
 * MV, consumers maintain two parallel MVs and sum at read time —
 * defeating the "no imperative transforms outside primitives" rule.
 *
 * Prerequisites
 * ─────────────
 * - Showcase 70 (withMaterializedView basics)
 * - Showcase 71 (multi-key groupBy)
 *
 * What to read next
 * ─────────────────
 *   - docs/subsystems/derivations.md (UNION sources section)
 */
import { describe, it, expect } from 'vitest'
import { createMemoryVault, withMaterializedView, sum } from '@noy-db/hub'

describe('Showcase 72 — UNION MV', () => {
  it('monthly VAT = sum(taxReceipts.vat) - sum(creditNotes.vat)', async () => {
    const vault = await createMemoryVault({
      strategies: [
        withMaterializedView<{ period: string; vat: number }>({
          name: 'monthlyVat',
          unionSources: [
            { collection: 'taxReceipts', map: (r: any) => ({ period: r.issuedAt.slice(0, 7), vat:  r.vatAmount }) },
            { collection: 'creditNotes', map: (r: any) => ({ period: r.issuedAt.slice(0, 7), vat: -r.vatAmount }) },
          ],
          groupBy: 'period',
          aggregate: { vat: sum('vat') },
          rowKey: row => row.period,
          refresh: 'eager',
        }),
      ],
    })

    const receipts = vault.collection<any>('taxReceipts')
    const notes = vault.collection<any>('creditNotes')
    await receipts.put({ id: 'r1', issuedAt: '2026-05-15', vatAmount: 100 })
    await receipts.put({ id: 'r2', issuedAt: '2026-05-20', vatAmount: 50 })
    await notes.put({ id: 'n1', issuedAt: '2026-05-25', vatAmount: 30 })

    const rows = await vault.collection<any>('monthlyVat').query().toArray()
    expect(rows[0]!.vat).toBe(120)
  })
})
```

Adjust `createMemoryVault` / vault bootstrap to match existing showcase conventions.

- [ ] **Step 2: Run showcase**

Run: `pnpm vitest run showcases/src/72-with-union-mv.showcase.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add showcases/src/72-with-union-mv.showcase.test.ts
git commit -m "showcase(hub): UNION MV walkthrough (#165)"
```

---

## Task 15: Docs + features.yaml for UNION MV

**Files:**
- Modify: `features.yaml`
- Modify: `docs/subsystems/derivations.md` (or wherever MV is documented)

- [ ] **Step 1: Add `mv-union-sources` entry to `features.yaml`**

```yaml
- id: mv-union-sources
  package: '@noy-db/hub'
  title: UNION materialized views
  summary: Read from multiple sibling collections in one MV via `unionSources: [{ collection, map }, ...]`. Per-source `map` unifies row shapes; `groupBy` + `aggregate` run on the concatenated stream.
  since: 0.1.0-pre.15
  status: stable
  showcase: 72-with-union-mv
  subsystem: derived-data
```

- [ ] **Step 2: Add "UNION sources" section to subsystem doc**

```md
### UNION sources

A materialized view can read from MULTIPLE sibling collections in one
declaration via `unionSources`:

```ts
withMaterializedView<{ period: string; vat: number }>({
  name: 'monthlyVat',
  unionSources: [
    { collection: 'taxReceipts', map: r => ({ period: r.issuedAt.slice(0, 7), vat:  r.vatAmount }) },
    { collection: 'creditNotes', map: r => ({ period: r.issuedAt.slice(0, 7), vat: -r.vatAmount }) },
  ],
  groupBy: 'period',
  aggregate: { vat: sum('vat') },
  rowKey: row => row.period,
  refresh: 'eager',
})
```

**Mutually exclusive with `query`** — a strategy uses one or the other.
Multi-arm UNION requires at least 2 entries; duplicate collection names
are rejected at registration.

**Per-source `map` is the schema-unification boundary.** The two source
collections may have different schemas; each arm's `map` projects to the
MV's row shape (the strategy's type parameter), and the executor concats
the mapped rows before `groupBy` + `aggregate` run.

**Source-write hooks fire on every arm.** A write to ANY collection in
`unionSources` re-fires the MV refresh path.

**Composes with multi-key groupBy.** UNION arms can roll up to a composite
key — the canonical niwat monthly-VAT MV groups by `['clientId', 'period']`.
```

- [ ] **Step 3: Validate features.yaml**

Run: `node scripts/validate-features.mjs`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add features.yaml docs/subsystems/derivations.md
git commit -m "docs(hub): UNION MV feature entry + subsystem section (#165)"
```

---

## Task 16: PR 2 — final checks, push, open PR

- [ ] **Step 1: Full validation**

Run: `pnpm turbo build && pnpm turbo lint --filter=@noy-db/hub && pnpm turbo typecheck && pnpm vitest run packages/hub && node scripts/check-architecture.mjs && node scripts/validate-features.mjs && pnpm vitest run showcases`
Expected: all green.

- [ ] **Step 2: Push**

Run: `git push`

- [ ] **Step 3: Open PR 2**

```bash
gh pr create --title "feat(hub): UNION MV via unionSources field — withMaterializedView reads multiple sibling collections (#165)" --body "$(cat <<'EOF'
## Summary
- New `unionSources: [{ collection, map }, ...]` field on `withMaterializedView`
- Per-source `map` callback is the schema-unification boundary
- Mutually exclusive with `query`; minimum 2 arms; distinct collection names
- Source-write hook fires on every arm via the existing dependency tracker
- Composes with multi-key `groupBy` (PR 1) — niwat monthly-VAT shape included as test + showcase

Closes #165. Builds on PR 1 (#166 multi-key groupBy) — same branch, same release cycle (pre.15).

Spec: docs/superpowers/specs/2026-05-22-dim14-mv-multikey-and-union-design.md

## Test plan
- [ ] UNION 2-source + 3-source basics pass
- [ ] UNION + multi-key composition (niwat monthly-VAT shape) passes
- [ ] Validation tests reject malformed strategies (both query+union, <2 arms, duplicate collection)
- [ ] onEmpty: tombstone correctly removes rows when all sources delete
- [ ] Showcase 72 runs green
EOF
)"
```

---

# PR 3 — #131 GuardStrategyHandle variance cleanup

## Task 17: Locate the two `any` annotations

**Files:**
- Read: `packages/hub/src/vault.ts:334`
- Read: `packages/hub/src/types.ts:1748`

- [ ] **Step 1: Confirm the two annotations are still at the documented locations**

Run: `grep -n "GuardStrategyHandle<any>" packages/hub/src/vault.ts packages/hub/src/types.ts`
Expected output: two matches near the documented lines.

- [ ] **Step 2: Read each call site for surrounding context**

Read each file at the matching line ±10. Confirm the field is `guardStrategies?: ReadonlyArray<GuardStrategyHandle<any>>` in both, with an `eslint-disable-next-line @typescript-eslint/no-explicit-any` comment above.

---

## Task 18: Define an existential `GuardStrategyHandleAny` type

**Files:**
- Modify: `packages/hub/src/guards/types.ts`

- [ ] **Step 1: Add the existential type**

In `packages/hub/src/guards/types.ts`, AFTER the `GuardStrategyHandle<T>` interface:

```ts
/**
 * Existential erasure of `GuardStrategyHandle<T>` — used as the
 * element type of `ReadonlyArray<>` fields where T differs per entry.
 *
 * TS has no first-class existentials, but a structurally narrow shape
 * that only exposes the discriminant + the (now type-erased) spec is
 * a safe public-API surface:
 *
 * - Callers pass `GuardStrategyHandle<Invoice>` and `GuardStrategyHandle<Disbursement>`
 *   into an array typed as `GuardStrategyHandleAny[]`. Both assign because
 *   their structural shape (discriminant + spec object) widens to this
 *   erased form.
 * - Internals that need T re-narrow via the runtime discriminant + the
 *   registry's per-handle type information.
 *
 * NOT exported from the public consumer barrel — the construction of
 * a handle still goes through `withGuard<T>()` which returns the
 * typed `GuardStrategyHandle<T>`. This shape is only the array-element
 * existential.
 */
export interface GuardStrategyHandleAny {
  readonly __noydb_strategy: 'guard'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly spec: GuardStrategy<any>
}
```

The single internal `any` here is acceptable per the issue's framing — it's behind a private existential boundary, not on a public API field. (If the reviewer pushes back even here, the alternative is `GuardStrategy<Record<string, unknown>>` — confirm assignment from `GuardStrategy<Invoice>` typechecks before swapping.)

- [ ] **Step 2: Re-export from the guards barrel if appropriate**

In `packages/hub/src/guards/index.ts`, decide whether to export `GuardStrategyHandleAny`. Prefer KEEPING IT INTERNAL to discourage consumers from constructing it directly. If `vault.ts` or `types.ts` need to import it, use a relative path from the guards subdirectory.

- [ ] **Step 3: Commit**

```bash
git add packages/hub/src/guards/types.ts packages/hub/src/guards/index.ts
git commit -m "feat(hub): GuardStrategyHandleAny existential — array-element type for guard strategies (#131)"
```

---

## Task 19: Replace the two `any` annotations

**Files:**
- Modify: `packages/hub/src/vault.ts` (line 334 area)
- Modify: `packages/hub/src/types.ts` (line 1748 area)

- [ ] **Step 1: Replace in `types.ts`**

Find the line:

```ts
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  guardStrategies?: ReadonlyArray<GuardStrategyHandle<any>>
```

Replace with:

```ts
  guardStrategies?: ReadonlyArray<GuardStrategyHandleAny>
```

Update the import at the top of the file to include `GuardStrategyHandleAny`.

- [ ] **Step 2: Replace in `vault.ts`**

Same swap, same comment removal, update import.

- [ ] **Step 3: Run typecheck**

Run: `pnpm turbo typecheck --filter=@noy-db/hub`
Expected: 0 errors. If errors appear, they're in code that previously relied on the `any` widening — narrow those call sites by reading the runtime discriminant before re-typing the spec.

- [ ] **Step 4: Run the guards test suite**

Run: `pnpm vitest run packages/hub/__tests__/guards`
Expected: all pre.14 guards tests pass unchanged (this is a type-only refactor; runtime is identical).

- [ ] **Step 5: Run showcase 79 specifically (the issue calls it out as the back-compat target)**

Run: `pnpm vitest run showcases/src/*guards*` (or grep for showcase 79's filename and run it directly)
Expected: PASS.

- [ ] **Step 6: Confirm no new `any` introduced**

Run: `grep -nE "any\b" packages/hub/src/vault.ts packages/hub/src/types.ts | grep -i guard`
Expected: no matches.

- [ ] **Step 7: Commit**

```bash
git add packages/hub/src/vault.ts packages/hub/src/types.ts
git commit -m "refactor(hub): remove public-API any from guardStrategies via GuardStrategyHandleAny (#131)"
```

---

## Task 20: PR 3 — final checks, push, open PR

- [ ] **Step 1: Full validation**

Run: `pnpm turbo build && pnpm turbo lint && pnpm turbo typecheck && pnpm vitest run packages/hub`
Expected: all green.

- [ ] **Step 2: Push**

Run: `git push`

- [ ] **Step 3: Open PR 3**

```bash
gh pr create --title "refactor(hub): GuardStrategyHandle type-variance cleanup — remove public-API any (#131)" --body "$(cat <<'EOF'
## Summary
- New `GuardStrategyHandleAny` existential type as the array-element type for `guardStrategies` arrays
- Removed two `eslint-disable-next-line @typescript-eslint/no-explicit-any` annotations on public-API fields (`vault.ts:334` and `types.ts:1748`)
- Type-only refactor; no behaviour change

Closes #131. Third PR of the pre.15 cycle (alongside #165 UNION MV and #166 multi-key groupBy).

## Test plan
- [ ] All hub tests pass unchanged
- [ ] Showcase 79 (guards) type-checks and runs unchanged
- [ ] No new `any` introduced (grep clean)
EOF
)"
```

---

# Cycle wrap-up

## Task 21: Final integration check on all three PRs merged

After all three PRs merge to `main`:

- [ ] **Step 1: Sync local main**

Run: `git checkout main && git fetch && git reset --hard origin/main`

- [ ] **Step 2: Verify pre.15 readiness**

Run: `pnpm install && pnpm turbo build && pnpm vitest run && node scripts/check-architecture.mjs && node scripts/validate-features.mjs`
Expected: all green; new tests count = 1573 + (PR1 new) + (PR2 new); 2 new features in `features.yaml`.

- [ ] **Step 3: Update ROADMAP.md with pre.15 entry**

Add a pre.15 milestone entry pointing at the three closed issues and the spec doc. Follow the existing pre.14 entry's shape.

- [ ] **Step 4: Commit roadmap update**

```bash
git checkout -b chore/roadmap-pre.15
# edit ROADMAP.md
git add ROADMAP.md
git commit -m "docs: add pre.15 roadmap entry (multi-key groupBy + UNION MV + guards variance)"
git push -u origin chore/roadmap-pre.15
gh pr create --title "docs: ROADMAP pre.15 entry" --body "Adds pre.15 milestone summary (#165, #166, #131)."
```

- [ ] **Step 5: When that PR merges — coordinate the 0.1.0-pre.15 release**

This step is the user's call, NOT an agent action. The release workflow per the `project_release_workflow` memory is: manual lockstep bump, GitHub Release `published` event triggers `release.yml`, full SHA in `gh release create --target`. Do not initiate without explicit user confirmation (the `feedback_no_publish_without_explicit_confirmation` memory applies).

---

# Self-review notes (from plan author)

**Spec coverage check** — every acceptance bullet from the spec maps to a task:

- §#166 multi-key groupBy acceptance: Task 1 (canonicalGroupKey), Task 2 (failing tests), Task 3 (variadic overload + execution), Task 4 (MV plumbing), Task 5 (showcase), Task 6 (docs)
- §#165 UNION MV acceptance: Task 8 (types), Task 9 (validation), Task 10 (dep analyzer), Task 11 (executor), Task 12 (composition with #166), Task 13 (edges), Task 14 (showcase), Task 15 (docs)
- §#131 GuardStrategyHandle acceptance: Task 17 (locate), Task 18 (existential), Task 19 (swap + verify)
- Cross-cutting (1573+N tests, features.yaml, subsystem doc, ROADMAP): Tasks 6, 15, 21

**Placeholder scan** — no "TBD"/"TODO"/"similar to" in the plan. The "N" in showcase numbering is explicitly resolved at Task 5 step 1 / Task 14 step 1 via `ls`.

**Type consistency check** — `canonicalGroupKey(fields, row)` signature stable across Task 1 (definition), Task 3 (consumed by groupAndReduce), Task 11 (consumed by materializeUnionResult). `UnionSource<TRow>` shape stable across Task 8 (definition), Task 9 (validation), Task 10 (dep analyzer), Task 11 (executor). `GuardStrategyHandleAny` shape stable across Task 18 (definition), Task 19 (use).

**Files-touched matrix (for reviewer convenience):**

| Layer | PR 1 (#166) | PR 2 (#165) | PR 3 (#131) |
|---|---|---|---|
| `packages/hub/src/aggregate/` | canonical-key.ts (new), groupby.ts, strategy.ts, index.ts | — | — |
| `packages/hub/src/query/` | builder.ts | — | — |
| `packages/hub/src/materialized-views/` | dependency-analyzer.ts | types.ts, with-materialized-view.ts, registry.ts, dependency-analyzer.ts, executor.ts | — |
| `packages/hub/src/errors.ts` | — | MaterializedViewConfigError added | — |
| `packages/hub/src/guards/` | — | — | types.ts, index.ts |
| `packages/hub/src/vault.ts` | — | — | line ~334 |
| `packages/hub/src/types.ts` | — | — | line ~1748 |
| `packages/hub/__tests__/` | aggregate-canonical-key.test.ts (new), query-groupby.test.ts, materialized-views/multikey.test.ts (new) | materialized-views/union*.test.ts (new × 2) | — |
| `showcases/src/` | 71-with-multikey-groupby.showcase.test.ts (new) | 72-with-union-mv.showcase.test.ts (new) | — |
| `features.yaml` | mv-multikey-groupby entry | mv-union-sources entry | — |
| `docs/subsystems/derivations.md` | Multi-key section | UNION sources section | — |
