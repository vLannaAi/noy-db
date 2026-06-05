# Dim 11 v3 — Cross-Join Query Primitive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `.crossJoin(target, { as })` to `Query<T>` so consumers can express cartesian-product relations between two vault collections, composing with existing `.where()`, `.wherePredicate()`, `.groupBy()`, and `.aggregate()` terminals.

**Architecture:** `CrossJoinClause` joins the `Clause` union in `predicate.ts`. The query builder appends it to `plan.clauses`. A new `executeClausePipeline` function (in `builder.ts`) walks clauses in declaration order, batching filter clauses and expanding on cross-join clauses; `executePlanWithSource` and `toArray()` delegate to it when cross-join clauses are present. Cost ceiling (`CrossJoinTooLargeError`) is enforced before allocation. `QueryDependencyAnalyzer` and `summarizeQueryPlan` are extended symmetrically with the existing FK-join logic.

**Tech Stack:** TypeScript strict, vitest, pnpm workspace, `packages/hub/` only (no other packages change). Test commands: `pnpm --filter @noy-db/hub test -- --run query-cross-join` for unit tests, `pnpm --filter @noy-db/hub test` for full suite.

**Spec:** `docs/superpowers/specs/2026-05-20-dim11-cross-join-v1-design.md`

---

## File map

| File | Action | What changes |
|---|---|---|
| `packages/hub/src/query/predicate.ts` | Modify | Add `CrossJoinClause` to `Clause` union; add `case 'crossJoin'` to `evaluateClause` |
| `packages/hub/src/errors.ts` | Modify | Add `CrossJoinTooLargeError`, `CrossJoinSourceUnknownError` |
| `packages/hub/src/query/builder.ts` | Modify | Add `crossJoin()`, `executeClausePipeline`, `applyCrossJoin`, update `executePlanWithSource`, `toArray()`, `count()`, `aggregate()`, `groupBy()`, `live()`, `serializeClause`, `executePlan` guard |
| `packages/hub/src/query/index.ts` | Modify | Export `CrossJoinClause`, `CrossJoinTooLargeError`, `CrossJoinSourceUnknownError`, `DEFAULT_CROSS_JOIN_MAX_ROWS` |
| `packages/hub/src/index.ts` | Modify | Export `CrossJoinTooLargeError`, `CrossJoinSourceUnknownError` |
| `packages/hub/src/materialized-views/dependency-analyzer.ts` | Modify | Extend `analyzeDependencies` + `summarizeQueryPlan` for cross-join clauses |
| `packages/hub/__tests__/query-cross-join.test.ts` | Create | Unit tests (mock JoinContext — no Vault) |
| `showcases/src/92-with-cross-join.showcase.test.ts` | Create | Integration showcase — DERIV-SSO-001 end-to-end |
| `docs/subsystems/cross-join.md` | Create | Subsystem doc |
| `features.yaml` | Modify | Add `cross-join` feature entry |

---

## Task 1: `CrossJoinClause` type + `evaluateClause` guard + `serializeClause`

**Files:**
- Modify: `packages/hub/src/query/predicate.ts`
- Modify: `packages/hub/src/query/builder.ts` (serializeClause only)
- Create: `packages/hub/__tests__/query-cross-join.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/hub/__tests__/query-cross-join.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { evaluateClause, type Clause } from '../src/query/predicate.js'

describe('CrossJoinClause > evaluateClause throws on crossJoin type', () => {
  it('throws if a crossJoin clause is passed to evaluateClause', () => {
    const clause = {
      type: 'crossJoin',
      target: 'workers',
      as: 'worker',
      on: undefined,
      onPredicateName: undefined,
      maxRows: undefined,
    } as unknown as Clause
    expect(() => evaluateClause({}, clause)).toThrow('crossJoin clause cannot be evaluated as a per-record predicate')
  })
})
```

- [ ] **Step 2: Run test — expect FAIL**

```bash
pnpm --filter @noy-db/hub test -- --run query-cross-join
```

Expected: FAIL — `evaluateClause` falls through without handling `'crossJoin'`, TypeScript or runtime error.

- [ ] **Step 3: Add `CrossJoinClause` to `predicate.ts`**

In `packages/hub/src/query/predicate.ts`, after the `GroupClause` interface (around line 76), add:

```typescript
/**
 * Cartesian-product expansion clause. Appended to `QueryPlan.clauses`
 * by `Query.crossJoin()`. Processed in declaration order by
 * `executeClausePipeline` — NOT by `evaluateClause` (which is a
 * per-record predicate and throws on this type).
 */
export interface CrossJoinClause {
  readonly type: 'crossJoin'
  /** Target collection name to cross-join against. */
  readonly target: string
  /** Alias under which the right-side record is exposed on each result row. */
  readonly as: string
  /**
   * Lateral filter callback. `undefined` → full cartesian product.
   * Two call shapes:
   *   - Subset:    `(left) => TTarget[]`            — returns the right rows for this left row
   *   - Predicate: `(left) => (right) => boolean`   — executor materializes then filters
   */
  readonly on?: (left: unknown) => unknown[] | ((right: unknown) => boolean)
  /** When `on:` was supplied as `{ predicate: name }`, the name is stored here for queryHash. */
  readonly onPredicateName?: string
  /** Per-clause row ceiling override. `undefined` → `DEFAULT_CROSS_JOIN_MAX_ROWS`. */
  readonly maxRows?: number
}
```

Change the `Clause` type union (line 77) from:

```typescript
export type Clause = FieldClause | FilterClause | WherePredicateClause | GroupClause
```

to:

```typescript
export type Clause = FieldClause | FilterClause | WherePredicateClause | GroupClause | CrossJoinClause
```

In `evaluateClause`, add a `case 'crossJoin'` before the `case 'group'` block:

```typescript
    case 'crossJoin':
      throw new Error(
        `evaluateClause: crossJoin clause cannot be evaluated as a per-record predicate. ` +
          `Cross-join expansion happens in executeClausePipeline, not in evaluateClause. ` +
          `This is a library bug — please report it.`,
      )
```

- [ ] **Step 4: Add `crossJoin` case to `serializeClause` in `builder.ts`**

In `packages/hub/src/query/builder.ts`, find `function serializeClause` (around line 933). After the `if (clause.type === 'group')` block and before the final `return clause`, add:

```typescript
  if (clause.type === 'crossJoin') {
    return {
      type: 'crossJoin',
      target: clause.target,
      as: clause.as,
      on: clause.on ? '[function]' : undefined,
      onPredicateName: clause.onPredicateName,
      maxRows: clause.maxRows,
    }
  }
```

- [ ] **Step 5: Run test — expect PASS**

```bash
pnpm --filter @noy-db/hub test -- --run query-cross-join
```

Expected: PASS (1 test passing).

- [ ] **Step 6: Typecheck**

```bash
pnpm --filter @noy-db/hub typecheck
```

Expected: 0 errors.

- [ ] **Step 7: Commit**

```bash
git add packages/hub/src/query/predicate.ts packages/hub/src/query/builder.ts packages/hub/__tests__/query-cross-join.test.ts
git commit -m "feat(hub): CrossJoinClause type + evaluateClause guard + serializeClause"
```

---

## Task 2: `CrossJoinTooLargeError` + `CrossJoinSourceUnknownError`

**Files:**
- Modify: `packages/hub/src/errors.ts`
- Modify: `packages/hub/src/query/index.ts`
- Modify: `packages/hub/src/index.ts`

- [ ] **Step 1: Write the failing tests** — add to `query-cross-join.test.ts`:

```typescript
import { CrossJoinTooLargeError, CrossJoinSourceUnknownError } from '../src/errors.js'

describe('CrossJoinTooLargeError', () => {
  it('is a NoydbError with correct name and fields', () => {
    const e = new CrossJoinTooLargeError({ target: 'workers', expected: 60_000, limit: 50_000 })
    expect(e).toBeInstanceOf(Error)
    expect(e.name).toBe('CrossJoinTooLargeError')
    expect(e.target).toBe('workers')
    expect(e.expected).toBe(60_000)
    expect(e.limit).toBe(50_000)
    expect(e.message).toContain('workers')
    expect(e.message).toContain('50000')
  })
})

describe('CrossJoinSourceUnknownError', () => {
  it('is a NoydbError with correct name and fields', () => {
    const e = new CrossJoinSourceUnknownError('workers', 'periods')
    expect(e.name).toBe('CrossJoinSourceUnknownError')
    expect(e.target).toBe('workers')
    expect(e.leftCollection).toBe('periods')
    expect(e.message).toContain('workers')
    expect(e.message).toContain('periods')
  })
})
```

- [ ] **Step 2: Run — expect FAIL** (import not found)

```bash
pnpm --filter @noy-db/hub test -- --run query-cross-join
```

- [ ] **Step 3: Add errors to `errors.ts`**

In `packages/hub/src/errors.ts`, find the `JoinTooLargeError` class (around line 1412). After its closing brace, add:

```typescript
/**
 * Thrown by `.crossJoin()` when the cumulative cartesian product (or lateral
 * filtered count) exceeds the configured ceiling. Check before allocating.
 * Mirrors the pattern of `JoinTooLargeError` and the `.join()` row ceiling.
 *
 * @see CrossJoinClause.maxRows — per-clause override
 * @see DEFAULT_CROSS_JOIN_MAX_ROWS — package default (50_000)
 */
export class CrossJoinTooLargeError extends NoydbError {
  readonly target: string
  readonly expected: number
  readonly limit: number

  constructor(opts: { target: string; expected: number; limit: number }) {
    super(
      'CROSS_JOIN_TOO_LARGE',
      `crossJoin("${opts.target}"): would produce ${opts.expected} rows, ` +
        `exceeding the limit of ${opts.limit}. ` +
        `Narrow the left side with .where() first, or raise the ceiling ` +
        `with crossJoin("${opts.target}", { ..., maxRows: ${opts.expected} }).`,
    )
    this.name = 'CrossJoinTooLargeError'
    this.target = opts.target
    this.expected = opts.expected
    this.limit = opts.limit
  }
}

/**
 * Thrown at cross-join execution time when the target collection is not
 * reachable from the current vault. The left collection is included in the
 * message for context.
 */
export class CrossJoinSourceUnknownError extends NoydbError {
  readonly target: string
  readonly leftCollection: string

  constructor(target: string, leftCollection: string) {
    super(
      'CROSS_JOIN_SOURCE_UNKNOWN',
      `crossJoin("${target}"): collection "${target}" is not known in the vault ` +
        `(cross-joining from "${leftCollection}"). ` +
        `Make sure "${target}" is open in the same vault before executing this query.`,
    )
    this.name = 'CrossJoinSourceUnknownError'
    this.target = target
    this.leftCollection = leftCollection
  }
}
```

Also update the error hierarchy comment at the top of `errors.ts`. Find the line:
```
 *       ├─ Query errors
 *       │    ├─ JoinTooLargeError      — join row ceiling exceeded
```
And change it to:
```
 *       ├─ Query errors
 *       │    ├─ JoinTooLargeError           — join row ceiling exceeded
 *       │    ├─ CrossJoinTooLargeError      — cross-join row ceiling exceeded
 *       │    ├─ CrossJoinSourceUnknownError — target collection not in vault
```

- [ ] **Step 4: Export from `query/index.ts`**

In `packages/hub/src/query/index.ts`, find the block at the bottom that exports query errors:
```typescript
export {
  GroupCardinalityError,
  IndexRequiredError,
  IndexWriteFailureError,
  JoinTooLargeError,
  DanglingReferenceError,
} from '../errors.js'
```
Add `CrossJoinTooLargeError` and `CrossJoinSourceUnknownError`:
```typescript
export {
  GroupCardinalityError,
  IndexRequiredError,
  IndexWriteFailureError,
  JoinTooLargeError,
  DanglingReferenceError,
  CrossJoinTooLargeError,
  CrossJoinSourceUnknownError,
} from '../errors.js'
```

Also export the type and constant (will exist after Task 3):
```typescript
export type { CrossJoinClause } from './predicate.js'
```

- [ ] **Step 5: Export from `src/index.ts`**

In `packages/hub/src/index.ts`, find the line that exports `JoinTooLargeError` (around line 241). Add the two new errors to the same export block:
```typescript
  JoinTooLargeError,
  CrossJoinTooLargeError,
  CrossJoinSourceUnknownError,
```

- [ ] **Step 6: Run — expect PASS**

```bash
pnpm --filter @noy-db/hub test -- --run query-cross-join
```

Expected: PASS (3 tests).

- [ ] **Step 7: Typecheck + commit**

```bash
pnpm --filter @noy-db/hub typecheck
git add packages/hub/src/errors.ts packages/hub/src/query/index.ts packages/hub/src/index.ts packages/hub/__tests__/query-cross-join.test.ts
git commit -m "feat(hub): CrossJoinTooLargeError + CrossJoinSourceUnknownError"
```

---

## Task 3: `Query.crossJoin()` terminal

**Files:**
- Modify: `packages/hub/src/query/builder.ts`

- [ ] **Step 1: Write the failing tests** — append to `query-cross-join.test.ts`:

```typescript
import { Query } from '../src/query/index.js'
import type { QuerySource, JoinContext, JoinableSource } from '../src/query/index.js'

function staticSource<T>(records: T[]): QuerySource<T> {
  return { snapshot: () => records }
}

function mockJoinContext(
  leftCollection: string,
  sources: Record<string, unknown[]>,
): JoinContext {
  return {
    leftCollection,
    resolveRef: () => null,
    resolveSource: (name: string): JoinableSource | null => {
      const snap = sources[name]
      return snap !== undefined ? { snapshot: () => snap } : null
    },
  }
}

const PERIODS = [
  { id: 'p1', start: '2026-01', end: '2026-03' },
  { id: 'p2', start: '2026-04', end: '2026-06' },
]
const WORKERS = [
  { id: 'w1', name: 'Alice' },
  { id: 'w2', name: 'Bob' },
]

describe('Query.crossJoin() > builder', () => {
  it('appends a crossJoin clause to the plan', () => {
    const jc = mockJoinContext('periods', { workers: WORKERS })
    const q = new Query(
      staticSource(PERIODS),
      { clauses: [], orderBy: [], limit: undefined, offset: 0, joins: [] },
      jc,
    ).crossJoin('workers', { as: 'worker' })
    const plan = q._plan()
    expect(plan.clauses).toHaveLength(1)
    expect(plan.clauses[0]).toMatchObject({ type: 'crossJoin', target: 'workers', as: 'worker' })
  })

  it('is immutable — original query is unchanged', () => {
    const jc = mockJoinContext('periods', { workers: WORKERS })
    const base = new Query(
      staticSource(PERIODS),
      { clauses: [], orderBy: [], limit: undefined, offset: 0, joins: [] },
      jc,
    )
    const q2 = base.crossJoin('workers', { as: 'worker' })
    expect(base._plan().clauses).toHaveLength(0)
    expect(q2._plan().clauses).toHaveLength(1)
  })

  it('throws when called on a Query with no joinContext', () => {
    const base = new Query(staticSource(PERIODS))
    expect(() => base.crossJoin('workers', { as: 'worker' })).toThrow('join context')
  })
})
```

- [ ] **Step 2: Run — expect FAIL** (method doesn't exist yet)

```bash
pnpm --filter @noy-db/hub test -- --run query-cross-join
```

- [ ] **Step 3: Add `crossJoin()` to `Query<T>` in `builder.ts`**

In `packages/hub/src/query/builder.ts`, import `CrossJoinClause` at the top:
```typescript
import type { Clause, FieldClause, FilterClause, GroupClause, Operator, WherePredicateClause, CrossJoinClause } from './predicate.js'
```

Add the constant near the top (after the `EMPTY_PLAN` declaration):
```typescript
/** Default row ceiling for cross-join expansion. Matches JoinTooLargeError's ceiling. */
export const DEFAULT_CROSS_JOIN_MAX_ROWS = 50_000
```

Add the `crossJoin()` method to `Query<T>` after the `join()` method (around line 425):

```typescript
  /**
   * Cartesian-product cross-join against `target` collection. Each result row
   * carries the original `T` fields plus `result[as]` populated from every
   * right-side row (or the filtered subset when `on:` is supplied).
   *
   * **Order matters:** `.where().crossJoin()` filters BEFORE expanding (cheaper);
   * `.crossJoin().where('alias.field', ...)` filters AFTER (required when the
   * where clause references the aliased fields).
   *
   * **Cost ceiling:** `CrossJoinTooLargeError` fires before allocation when
   * `leftRows × rightRows` (or the cumulative lateral count) exceeds the limit.
   * Default: 50,000 rows. Override per-clause with `{ maxRows: N }`.
   *
   * **`on:` shapes:**
   *   - `on: (left) => TTarget[]`              — subset form (most efficient)
   *   - `on: (left) => (right) => boolean`     — predicate form
   *   - `on: { predicate: 'name' }`            — MV-safe, hash-tracked form
   *     (requires the Query to have been augmented via `_withPredicates`)
   *
   * Requires a JoinContext (constructed via `collection.query()`).
   */
  crossJoin<TTarget = unknown, As extends string = string>(
    target: string,
    opts: {
      as: As
      on?:
        | ((left: T) => unknown[] | ((right: TTarget) => boolean))
        | { readonly predicate: string }
      maxRows?: number
    },
  ): Query<T & { [K in As]: TTarget }> {
    if (!this.joinContext) {
      throw new Error(
        `Query.crossJoin("${target}"): requires a join context. ` +
          `Use collection.query() to construct a cross-join-capable Query instead of ` +
          `the Query constructor directly.`,
      )
    }

    let onFn: CrossJoinClause['on']
    let onPredicateName: string | undefined

    if (opts.on !== undefined) {
      if (typeof opts.on === 'function') {
        onFn = opts.on as CrossJoinClause['on']
        if (this.predicates) {
          console.warn(
            `Query.crossJoin("${target}", { on: callback }): inline on: callback inside a ` +
              `withMaterializedView query() disables queryHash drift detection for this cross-join. ` +
              `Use on: { predicate: '<name>' } to enable it.`,
          )
        }
      } else {
        const predName = (opts.on as { predicate: string }).predicate
        if (!this.predicates) {
          throw new Error(
            `Query.crossJoin("${target}", { on: { predicate: "${predName}" } }): ` +
              `the { predicate } form requires a predicates map. ` +
              `Use this form inside a withMaterializedView query() callback that declares ` +
              `predicates: { ${predName}: { hash, fn } }.`,
          )
        }
        const decl = this.predicates.get(predName)
        if (!decl) {
          throw new Error(
            `Query.crossJoin("${target}"): predicate "${predName}" not registered. ` +
              `Available: ${[...this.predicates.keys()].join(', ') || '(none)'}.`,
          )
        }
        const as = opts.as
        const predicateFn = decl.fn
        onFn = (_left: unknown): ((right: unknown) => boolean) =>
          (right: unknown) =>
            predicateFn({ ...(_left as Record<string, unknown>), [as]: right })
        onPredicateName = predName
      }
    }

    const clause: CrossJoinClause = {
      type: 'crossJoin',
      target,
      as: opts.as,
      on: onFn,
      onPredicateName,
      maxRows: opts.maxRows,
    }

    return new Query<T & { [K in As]: TTarget }>(
      this.source as unknown as QuerySource<T & { [K in As]: TTarget }>,
      { ...this.plan, clauses: [...this.plan.clauses, clause] },
      this.joinContext,
      this.aggregateStrategy,
      this.predicates,
    )
  }
```

- [ ] **Step 4: Run — expect PASS**

```bash
pnpm --filter @noy-db/hub test -- --run query-cross-join
```

Expected: PASS (6 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm --filter @noy-db/hub typecheck
git add packages/hub/src/query/builder.ts packages/hub/__tests__/query-cross-join.test.ts
git commit -m "feat(hub): Query.crossJoin() terminal — appends CrossJoinClause to plan"
```

---

## Task 4: `executeClausePipeline` + `applyCrossJoin` + `toArray()` wiring

**Files:**
- Modify: `packages/hub/src/query/builder.ts`

- [ ] **Step 1: Write the failing tests** — append to `query-cross-join.test.ts`:

```typescript
describe('Query.crossJoin() > full cartesian execution', () => {
  it('produces leftRows × rightRows pairs', () => {
    const jc = mockJoinContext('periods', { workers: WORKERS })
    const result = new Query(
      staticSource(PERIODS),
      { clauses: [], orderBy: [], limit: undefined, offset: 0, joins: [] },
      jc,
    )
      .crossJoin<(typeof WORKERS)[0], 'worker'>('workers', { as: 'worker' })
      .toArray()
    expect(result).toHaveLength(4) // 2 periods × 2 workers
    expect(result[0]).toMatchObject({ id: 'p1', start: '2026-01', worker: { id: 'w1', name: 'Alice' } })
    expect(result[1]).toMatchObject({ id: 'p1', worker: { id: 'w2', name: 'Bob' } })
    expect(result[2]).toMatchObject({ id: 'p2', worker: { id: 'w1', name: 'Alice' } })
    expect(result[3]).toMatchObject({ id: 'p2', worker: { id: 'w2', name: 'Bob' } })
  })

  it('where() before crossJoin filters the left side first', () => {
    const jc = mockJoinContext('periods', { workers: WORKERS })
    const result = new Query(
      staticSource(PERIODS),
      { clauses: [], orderBy: [], limit: undefined, offset: 0, joins: [] },
      jc,
    )
      .where('id', '==', 'p1')
      .crossJoin<(typeof WORKERS)[0], 'worker'>('workers', { as: 'worker' })
      .toArray()
    expect(result).toHaveLength(2) // 1 period × 2 workers
    expect(result.every((r: any) => r.id === 'p1')).toBe(true)
  })

  it('where() after crossJoin filters on the alias', () => {
    const jc = mockJoinContext('periods', { workers: WORKERS })
    const result = new Query(
      staticSource(PERIODS),
      { clauses: [], orderBy: [], limit: undefined, offset: 0, joins: [] },
      jc,
    )
      .crossJoin<(typeof WORKERS)[0], 'worker'>('workers', { as: 'worker' })
      .where('worker.name', '==', 'Alice')
      .toArray()
    expect(result).toHaveLength(2) // 2 periods × Alice only
    expect(result.every((r: any) => r.worker.name === 'Alice')).toBe(true)
  })

  it('throws CrossJoinSourceUnknownError when target collection is not in join context', () => {
    const jc = mockJoinContext('periods', {}) // no workers source
    const q = new Query(
      staticSource(PERIODS),
      { clauses: [], orderBy: [], limit: undefined, offset: 0, joins: [] },
      jc,
    ).crossJoin('workers', { as: 'worker' })
    expect(() => q.toArray()).toThrow('CrossJoinSourceUnknownError')
  })

  it('executePlan() throws when plan contains crossJoin clauses', () => {
    const { executePlan } = require('../src/query/index.js')
    const plan = {
      clauses: [{ type: 'crossJoin', target: 'workers', as: 'worker' }],
      orderBy: [],
      limit: undefined,
      offset: 0,
      joins: [],
    }
    expect(() => executePlan([], plan)).toThrow('executePlan')
  })
})
```

- [ ] **Step 2: Run — expect FAIL**

```bash
pnpm --filter @noy-db/hub test -- --run query-cross-join
```

- [ ] **Step 3: Add `executeClausePipeline` + `applyCrossJoin` to `builder.ts`**

In `packages/hub/src/query/builder.ts`, add these two functions after the `filterRecords` function (around line 882). Also import `CrossJoinTooLargeError` and `CrossJoinSourceUnknownError`:

```typescript
import { CrossJoinTooLargeError, CrossJoinSourceUnknownError } from '../errors.js'
```

Add after `filterRecords`:

```typescript
/**
 * Walk the clause list in declaration order, batching filter clauses and
 * expanding on crossJoin clauses. Falls back to `candidateRecords + filterRecords`
 * (index fast-path) when no crossJoin clauses are present.
 *
 * Precondition: `joinContext` must be non-null when any `CrossJoinClause` is in `clauses`.
 */
function executeClausePipeline(
  source: InternalSource,
  clauses: readonly Clause[],
  joinContext: JoinContext,
): unknown[] {
  let rel: unknown[] = [...source.snapshot()]
  let filterBatch: Clause[] = []

  for (const clause of clauses) {
    if (clause.type === 'crossJoin') {
      // Flush accumulated filter clauses before expanding
      if (filterBatch.length > 0) {
        rel = filterRecords(rel, filterBatch)
        filterBatch = []
      }
      const rightSource = joinContext.resolveSource(clause.target)
      if (!rightSource) {
        throw new CrossJoinSourceUnknownError(clause.target, joinContext.leftCollection)
      }
      rel = applyCrossJoin(rel, clause, rightSource)
    } else {
      filterBatch.push(clause)
    }
  }

  // Flush remaining filter clauses
  if (filterBatch.length > 0) {
    rel = filterRecords(rel, filterBatch)
  }

  return rel
}

/**
 * Expand `leftRel` by cross-joining with `rightSource`. Enforces the cost ceiling
 * BEFORE allocating the expanded relation (full cartesian) or cumulatively
 * (lateral form). Throws `CrossJoinTooLargeError` on breach.
 */
function applyCrossJoin(
  leftRel: unknown[],
  clause: CrossJoinClause,
  rightSource: JoinableSource,
): unknown[] {
  const rightRows = rightSource.snapshot()
  const maxRows = clause.maxRows ?? DEFAULT_CROSS_JOIN_MAX_ROWS
  const { as } = clause

  if (!clause.on) {
    // Full cartesian — pre-check ceiling before any allocation
    const product = leftRel.length * rightRows.length
    if (product > maxRows) {
      throw new CrossJoinTooLargeError({ target: clause.target, expected: product, limit: maxRows })
    }
    const expanded: unknown[] = []
    for (const left of leftRel) {
      const leftObj = left as Record<string, unknown>
      for (const right of rightRows) {
        expanded.push({ ...leftObj, [as]: right })
      }
    }
    return expanded
  }

  // Lateral — ceiling is cumulative (post-filter count per left row)
  const expanded: unknown[] = []
  let cumulative = 0
  for (const left of leftRel) {
    const callbackResult = clause.on(left)
    let filteredRight: readonly unknown[]
    if (Array.isArray(callbackResult)) {
      filteredRight = callbackResult as unknown[]
    } else {
      // Predicate form: (left) => (right) => boolean
      filteredRight = (rightRows as unknown[]).filter(
        callbackResult as (r: unknown) => boolean,
      )
    }
    cumulative += filteredRight.length
    if (cumulative > maxRows) {
      throw new CrossJoinTooLargeError({
        target: clause.target,
        expected: cumulative,
        limit: maxRows,
      })
    }
    const leftObj = left as Record<string, unknown>
    for (const right of filteredRight) {
      expanded.push({ ...leftObj, [as]: right })
    }
  }
  return expanded
}
```

Also import `JoinContext` and `JoinableSource` from join.ts at the top of builder.ts (if not already imported — check the existing imports):
```typescript
import type { JoinContext, JoinLeg, JoinStrategy, JoinableSource } from './join.js'
```

- [ ] **Step 4: Update `executePlanWithSource` to accept optional `joinContext`**

Find the `executePlanWithSource` function (around line 753). Change its signature and body:

```typescript
function executePlanWithSource(
  source: InternalSource,
  plan: QueryPlan,
  joinContext?: JoinContext,
): unknown[] {
  const hasCrossJoins = plan.clauses.some(c => c.type === 'crossJoin')

  let result: unknown[]
  if (hasCrossJoins) {
    if (!joinContext) {
      throw new Error(
        `Query.toArray(): plan contains crossJoin clauses but no JoinContext is attached. ` +
          `Use collection.query() instead of new Query() for cross-join support.`,
      )
    }
    result = executeClausePipeline(source, plan.clauses, joinContext)
  } else {
    const { candidates, remainingClauses } = candidateRecords(source, plan.clauses)
    result =
      remainingClauses.length === 0 ? [...candidates] : filterRecords(candidates, remainingClauses)
  }

  if (plan.orderBy.length > 0) {
    result = sortRecords(result, plan.orderBy)
  }
  if (plan.offset > 0) {
    result = result.slice(plan.offset)
  }
  if (plan.limit !== undefined) {
    result = result.slice(0, plan.limit)
  }
  return result
}
```

- [ ] **Step 5: Update `toArray()` to pass `joinContext` to `executePlanWithSource`**

Find `toArray()` (around line 433). Change:
```typescript
  toArray(): T[] {
    const base = executePlanWithSource(this.source, this.plan)
```
to:
```typescript
  toArray(): T[] {
    const base = executePlanWithSource(this.source, this.plan, this.joinContext)
```

- [ ] **Step 6: Update `executePlan` (exported pure function) to throw on cross-join clauses**

Find `export function executePlan` (around line 854). Change to:

```typescript
export function executePlan(records: readonly unknown[], plan: QueryPlan): unknown[] {
  if (plan.clauses.some(c => c.type === 'crossJoin')) {
    throw new Error(
      `executePlan(): does not support crossJoin clauses. ` +
        `executePlan is a stateless pure function — it cannot resolve cross-join right-side ` +
        `collections. Use Query.toArray() (via collection.query()) instead.`,
    )
  }
  let result = filterRecords(records, plan.clauses)
  if (plan.orderBy.length > 0) {
    result = sortRecords(result, plan.orderBy)
  }
  if (plan.offset > 0) {
    result = result.slice(plan.offset)
  }
  if (plan.limit !== undefined) {
    result = result.slice(0, plan.limit)
  }
  return result
}
```

- [ ] **Step 7: Run — expect PASS**

```bash
pnpm --filter @noy-db/hub test -- --run query-cross-join
```

Expected: PASS (11 tests).

- [ ] **Step 8: Full suite — verify no regressions**

```bash
pnpm --filter @noy-db/hub test
```

Expected: all existing tests still pass.

- [ ] **Step 9: Typecheck + commit**

```bash
pnpm --filter @noy-db/hub typecheck
git add packages/hub/src/query/builder.ts packages/hub/__tests__/query-cross-join.test.ts
git commit -m "feat(hub): executeClausePipeline + applyCrossJoin — full cartesian execution wired into toArray()"
```

---

## Task 5: Cost ceiling enforcement tests

The cost ceiling was already implemented in `applyCrossJoin` (Task 4). This task adds explicit ceiling tests.

**Files:**
- Modify: `packages/hub/__tests__/query-cross-join.test.ts`

- [ ] **Step 1: Add ceiling tests**

Append to `query-cross-join.test.ts`:

```typescript
describe('Query.crossJoin() > cost ceiling', () => {
  it('throws CrossJoinTooLargeError when product exceeds default limit', () => {
    // 251 × 200 = 50,200 > 50,000
    const leftRecords = Array.from({ length: 251 }, (_, i) => ({ id: `l${i}` }))
    const rightRecords = Array.from({ length: 200 }, (_, i) => ({ id: `r${i}` }))
    const jc = mockJoinContext('left', { right: rightRecords })
    const q = new Query(
      staticSource(leftRecords),
      { clauses: [], orderBy: [], limit: undefined, offset: 0, joins: [] },
      jc,
    ).crossJoin('right', { as: 'r' })
    expect(() => q.toArray()).toThrow(CrossJoinTooLargeError)
  })

  it('throws before allocating (expected > limit in error)', () => {
    const left = Array.from({ length: 300 }, (_, i) => ({ id: `l${i}` }))
    const right = Array.from({ length: 200 }, (_, i) => ({ id: `r${i}` }))
    const jc = mockJoinContext('left', { right })
    const q = new Query(
      staticSource(left),
      { clauses: [], orderBy: [], limit: undefined, offset: 0, joins: [] },
      jc,
    ).crossJoin('right', { as: 'r' })
    let err: CrossJoinTooLargeError | undefined
    try { q.toArray() } catch (e) { err = e as CrossJoinTooLargeError }
    expect(err?.expected).toBe(60_000)
    expect(err?.limit).toBe(50_000)
  })

  it('per-clause maxRows override raises the ceiling', () => {
    const left = Array.from({ length: 300 }, (_, i) => ({ id: `l${i}` }))
    const right = Array.from({ length: 200 }, (_, i) => ({ id: `r${i}` }))
    const jc = mockJoinContext('left', { right })
    const result = new Query(
      staticSource(left),
      { clauses: [], orderBy: [], limit: undefined, offset: 0, joins: [] },
      jc,
    )
      .crossJoin('right', { as: 'r', maxRows: 100_000 })
      .toArray()
    expect(result).toHaveLength(60_000)
  })
})
```

- [ ] **Step 2: Run — expect PASS**

```bash
pnpm --filter @noy-db/hub test -- --run query-cross-join
```

- [ ] **Step 3: Commit**

```bash
git add packages/hub/__tests__/query-cross-join.test.ts
git commit -m "test(hub): CrossJoinTooLargeError ceiling enforcement tests"
```

---

## Task 6: Lateral `on:` callback support

The lateral form was already implemented in `applyCrossJoin` (Task 4). This task adds tests for both shapes.

**Files:**
- Modify: `packages/hub/__tests__/query-cross-join.test.ts`

- [ ] **Step 1: Add lateral tests**

Append to `query-cross-join.test.ts`:

```typescript
const PERIODS_LATERAL = [
  { id: 'p1', start: '2026-01', end: '2026-03' },
  { id: 'p2', start: '2026-04', end: '2026-06' },
]
const WORKERS_LATERAL = [
  { id: 'w1', name: 'Alice', since: '2026-01', until: null as null | string },
  { id: 'w2', name: 'Bob',   since: '2026-03', until: '2026-05' },
  { id: 'w3', name: 'Carol', since: '2026-05', until: null as null | string },
]

describe('Query.crossJoin() > lateral on: subset form', () => {
  it('on: (left) => TTarget[] supplies the exact right rows for each left row', () => {
    const jc = mockJoinContext('periods', { workers: WORKERS_LATERAL })
    // Alice is active in both periods; Bob only in p2; Carol only in p2 end
    const result = new Query(
      staticSource(PERIODS_LATERAL),
      { clauses: [], orderBy: [], limit: undefined, offset: 0, joins: [] },
      jc,
    )
      .crossJoin<(typeof WORKERS_LATERAL)[0], 'worker'>('workers', {
        as: 'worker',
        on: (period: any) =>
          (WORKERS_LATERAL as typeof WORKERS_LATERAL).filter(
            (w) => w.since <= period.start && (w.until === null || w.until >= period.end),
          ),
      })
      .toArray()
    // p1 start='2026-01' end='2026-03': Alice (since 01, until null) ✓; Bob (since 03, but until null until 05 >= end 03) — Bob since '2026-03' == p1.start ✓, until '2026-05' >= '2026-03' ✓; Carol since '2026-05' > p1.start ✗
    // p2 start='2026-04' end='2026-06': Alice ✓; Bob since 03 <= 04 ✓, until 05 < end 06 ✗; Carol since 05 > 04 ✗
    // So: p1 → Alice, Bob (2 rows); p2 → Alice (1 row)
    expect(result).toHaveLength(3)
    expect(result.map((r: any) => `${r.id}:${r.worker.name}`).sort()).toEqual(
      ['p1:Alice', 'p1:Bob', 'p2:Alice'],
    )
  })
})

describe('Query.crossJoin() > lateral on: predicate form', () => {
  it('on: (left) => (right) => boolean filters each right row against the left row', () => {
    const jc = mockJoinContext('periods', { workers: WORKERS_LATERAL })
    const result = new Query(
      staticSource(PERIODS_LATERAL),
      { clauses: [], orderBy: [], limit: undefined, offset: 0, joins: [] },
      jc,
    )
      .crossJoin<(typeof WORKERS_LATERAL)[0], 'worker'>('workers', {
        as: 'worker',
        on: (period: any) => (worker: any) =>
          worker.since <= period.start && (worker.until === null || worker.until >= period.end),
      })
      .toArray()
    expect(result).toHaveLength(3)
    expect(result.map((r: any) => `${r.id}:${r.worker.name}`).sort()).toEqual(
      ['p1:Alice', 'p1:Bob', 'p2:Alice'],
    )
  })

  it('lateral ceiling is cumulative (post-filter count across left rows)', () => {
    // 2 left rows × max 26 right rows each = 52 > 50 limit → throws
    const left = [{ id: 'a' }, { id: 'b' }]
    const right = Array.from({ length: 26 }, (_, i) => ({ id: `r${i}` }))
    const jc = mockJoinContext('left', { right })
    const q = new Query(
      staticSource(left),
      { clauses: [], orderBy: [], limit: undefined, offset: 0, joins: [] },
      jc,
    ).crossJoin('right', { as: 'r', maxRows: 50, on: () => right })
    expect(() => q.toArray()).toThrow(CrossJoinTooLargeError)
  })
})
```

- [ ] **Step 2: Run — expect PASS**

```bash
pnpm --filter @noy-db/hub test -- --run query-cross-join
```

- [ ] **Step 3: Commit**

```bash
git add packages/hub/__tests__/query-cross-join.test.ts
git commit -m "test(hub): lateral on: callback — subset and predicate-fn shapes"
```

---

## Task 7: `count()`, `aggregate()`, `groupBy()` support

**Files:**
- Modify: `packages/hub/src/query/builder.ts`

- [ ] **Step 1: Write failing tests** — append to `query-cross-join.test.ts`:

```typescript
import { count, sum } from '../src/query/index.js'

describe('Query.crossJoin() > count()', () => {
  it('count() returns expanded relation size', () => {
    const jc = mockJoinContext('periods', { workers: WORKERS })
    const q = new Query(
      staticSource(PERIODS),
      { clauses: [], orderBy: [], limit: undefined, offset: 0, joins: [] },
      jc,
    ).crossJoin('workers', { as: 'worker' })
    expect(q.count()).toBe(4) // 2 × 2
  })
})

describe('Query.crossJoin() > groupBy().aggregate()', () => {
  it('groupBy on a left-side field after cross-join groups the expanded relation', () => {
    const jc = mockJoinContext('periods', { workers: WORKERS })
    const result = new Query(
      staticSource(PERIODS),
      { clauses: [], orderBy: [], limit: undefined, offset: 0, joins: [] },
      jc,
    )
      .crossJoin('workers', { as: 'worker' })
      .groupBy('id')
      .aggregate({ workerCount: count() })
      .run()
    // 2 period buckets, each with 2 workers
    expect(result).toHaveLength(2)
    expect(result.map((r: any) => r.workerCount)).toEqual([2, 2])
  })

  it('groupBy on alias field groups by right-side key', () => {
    const jc = mockJoinContext('periods', { workers: WORKERS })
    const result = new Query(
      staticSource(PERIODS),
      { clauses: [], orderBy: [], limit: undefined, offset: 0, joins: [] },
      jc,
    )
      .crossJoin<(typeof WORKERS)[0], 'worker'>('workers', { as: 'worker' })
      .groupBy('worker.name')
      .aggregate({ periodCount: count() })
      .run()
    // 2 worker buckets, each with 2 periods
    expect(result).toHaveLength(2)
    expect(result.map((r: any) => r.periodCount)).toEqual([2, 2])
  })
})
```

- [ ] **Step 2: Run — expect FAIL** (`count()` doesn't handle cross-join clauses)

```bash
pnpm --filter @noy-db/hub test -- --run query-cross-join
```

- [ ] **Step 3: Update `count()` in `builder.ts`**

Find `count()` (around line 464). Change to:

```typescript
  count(): number {
    if (this.plan.clauses.some(c => c.type === 'crossJoin')) {
      if (!this.joinContext) {
        throw new Error(
          `Query.count(): plan contains crossJoin clauses but no JoinContext is attached.`,
        )
      }
      return executeClausePipeline(this.source, this.plan.clauses, this.joinContext).length
    }
    const { candidates, remainingClauses } = candidateRecords(this.source, this.plan.clauses)
    if (remainingClauses.length === 0) return candidates.length
    return filterRecords(candidates, remainingClauses).length
  }
```

- [ ] **Step 4: Update `aggregate()` in `builder.ts`**

Find `aggregate()` (around line 513). The method builds an `executeRecords` closure. Add cross-join awareness:

Find this block inside `aggregate()`:
```typescript
    const source = this.source
    const clauses = this.plan.clauses
    const executeRecords = (): readonly unknown[] => {
      const { candidates, remainingClauses } = candidateRecords(source, clauses)
      return remainingClauses.length === 0
        ? candidates
        : filterRecords(candidates, remainingClauses)
    }
```

Replace with:
```typescript
    const source = this.source
    const clauses = this.plan.clauses
    const joinCtx = this.joinContext
    const hasCrossJoins = clauses.some(c => c.type === 'crossJoin')
    const executeRecords = (): readonly unknown[] => {
      if (hasCrossJoins) {
        if (!joinCtx) throw new Error('Query.aggregate(): crossJoin requires a join context')
        return executeClausePipeline(source, clauses, joinCtx)
      }
      const { candidates, remainingClauses } = candidateRecords(source, clauses)
      return remainingClauses.length === 0
        ? candidates
        : filterRecords(candidates, remainingClauses)
    }
```

- [ ] **Step 5: Update `groupBy()` in `builder.ts`**

Find `groupBy()` (around line 588). The method also builds an `executeRecords` closure. Apply the same change. Find this block inside `groupBy()`:
```typescript
    const source = this.source
    const clauses = this.plan.clauses
    const executeRecords = (): readonly unknown[] => {
      const { candidates, remainingClauses } = candidateRecords(source, clauses)
      return remainingClauses.length === 0
        ? candidates
        : filterRecords(candidates, remainingClauses)
    }
```

Replace with:
```typescript
    const source = this.source
    const clauses = this.plan.clauses
    const joinCtx = this.joinContext
    const hasCrossJoins = clauses.some(c => c.type === 'crossJoin')
    const executeRecords = (): readonly unknown[] => {
      if (hasCrossJoins) {
        if (!joinCtx) throw new Error('Query.groupBy(): crossJoin requires a join context')
        return executeClausePipeline(source, clauses, joinCtx)
      }
      const { candidates, remainingClauses } = candidateRecords(source, clauses)
      return remainingClauses.length === 0
        ? candidates
        : filterRecords(candidates, remainingClauses)
    }
```

- [ ] **Step 6: Run — expect PASS**

```bash
pnpm --filter @noy-db/hub test -- --run query-cross-join
```

- [ ] **Step 7: Full suite regression check**

```bash
pnpm --filter @noy-db/hub test
```

- [ ] **Step 8: Typecheck + commit**

```bash
pnpm --filter @noy-db/hub typecheck
git add packages/hub/src/query/builder.ts packages/hub/__tests__/query-cross-join.test.ts
git commit -m "feat(hub): count() + aggregate() + groupBy() handle crossJoin clauses"
```

---

## Task 8: `Query.live()` right-side subscriptions for cross-joins

**Files:**
- Modify: `packages/hub/src/query/builder.ts`

- [ ] **Step 1: Write the failing test** — append to `query-cross-join.test.ts`:

```typescript
import { vi } from 'vitest'

describe('Query.crossJoin() > live() subscriptions', () => {
  it('live() subscribes to right-side collection changes', () => {
    let rightCallback: (() => void) | undefined
    const rightSourceWithSub = {
      snapshot: () => WORKERS as unknown[],
      subscribe: (cb: () => void) => {
        rightCallback = cb
        return () => { rightCallback = undefined }
      },
    }
    const jc: JoinContext = {
      leftCollection: 'periods',
      resolveRef: () => null,
      resolveSource: (name: string) => name === 'workers' ? rightSourceWithSub : null,
    }
    const leftSource = {
      snapshot: () => PERIODS as unknown[],
      subscribe: (cb: () => void) => { return () => {} },
    }
    const q = new Query(leftSource as any, { clauses: [], orderBy: [], limit: undefined, offset: 0, joins: [] }, jc)
      .crossJoin('workers', { as: 'worker' })

    let notifications = 0
    const live = q.live()
    live.subscribe(() => { notifications++ })

    // Trigger right-side change
    rightCallback?.()
    expect(notifications).toBeGreaterThan(0)
    live.stop()
  })
})
```

- [ ] **Step 2: Run — expect FAIL**

```bash
pnpm --filter @noy-db/hub test -- --run query-cross-join
```

- [ ] **Step 3: Update `live()` in `builder.ts`**

Find the `live()` method (around line 702). It currently subscribes to right-side sources for FK joins. Add a parallel block for cross-join clauses.

Find this block inside `live()`:
```typescript
    // Right-side change streams — only for joined queries. Dedup
    // by target name so a chain joining the same target twice
    // doesn't double-subscribe and double-fire on every right-side
    // mutation.
    if (this.plan.joins.length > 0 && this.joinContext) {
      const subscribed = new Set<string>()
      for (const leg of this.plan.joins) {
        if (subscribed.has(leg.target)) continue
        subscribed.add(leg.target)
        const rightSource = this.joinContext.resolveSource(leg.target)
        if (rightSource?.subscribe) {
          const rightSubscribe = rightSource.subscribe.bind(rightSource)
          upstreams.push({
            subscribe: (cb: () => void) => rightSubscribe(cb),
          })
        }
      }
    }
```

After this block, add:
```typescript
    // Cross-join right-side change streams — symmetric with FK joins above.
    if (this.joinContext) {
      const subscribedCross = new Set<string>()
      for (const clause of this.plan.clauses) {
        if (clause.type !== 'crossJoin') continue
        if (subscribedCross.has(clause.target)) continue
        subscribedCross.add(clause.target)
        const rightSource = this.joinContext.resolveSource(clause.target)
        if (rightSource?.subscribe) {
          const rightSubscribe = rightSource.subscribe.bind(rightSource)
          upstreams.push({
            subscribe: (cb: () => void) => rightSubscribe(cb),
          })
        }
      }
    }
```

- [ ] **Step 4: Run — expect PASS**

```bash
pnpm --filter @noy-db/hub test -- --run query-cross-join
```

- [ ] **Step 5: Full suite + typecheck + commit**

```bash
pnpm --filter @noy-db/hub test
pnpm --filter @noy-db/hub typecheck
git add packages/hub/src/query/builder.ts packages/hub/__tests__/query-cross-join.test.ts
git commit -m "feat(hub): Query.live() subscribes to cross-join right-side change streams"
```

---

## Task 9: `QueryDependencyAnalyzer` + `summarizeQueryPlan` extensions

**Files:**
- Modify: `packages/hub/src/materialized-views/dependency-analyzer.ts`

- [ ] **Step 1: Write the failing tests** — append to `query-cross-join.test.ts`:

```typescript
import { analyzeDependencies, summarizeQueryPlan } from '../src/materialized-views/index.js'

describe('analyzeDependencies > cross-join targets as dependency sources', () => {
  it('includes cross-join target collection in dependency set', () => {
    const jc = mockJoinContext('periods', { workers: WORKERS })
    const q = new Query(
      staticSource(PERIODS),
      { clauses: [], orderBy: [], limit: undefined, offset: 0, joins: [] },
      jc,
    ).crossJoin('workers', { as: 'worker' })
    const deps = analyzeDependencies(q)
    expect(deps.has('periods')).toBe(true)
    expect(deps.has('workers')).toBe(true)
  })

  it('deduplicates multiple cross-joins to the same target', () => {
    const jc = mockJoinContext('periods', { workers: WORKERS })
    const q = new Query(
      staticSource(PERIODS),
      { clauses: [], orderBy: [], limit: undefined, offset: 0, joins: [] },
      jc,
    )
      .crossJoin('workers', { as: 'w1' })
      .crossJoin('workers', { as: 'w2' })
    const deps = analyzeDependencies(q)
    expect(deps.size).toBe(2) // periods + workers (deduped)
  })
})

describe('summarizeQueryPlan > cross-join in queryHash', () => {
  it('folds cross-join target and alias into the summary', () => {
    const jc = mockJoinContext('periods', { workers: WORKERS })
    const q1 = new Query(
      staticSource(PERIODS),
      { clauses: [], orderBy: [], limit: undefined, offset: 0, joins: [] },
      jc,
    ).crossJoin('workers', { as: 'worker' })
    const q2 = new Query(
      staticSource(PERIODS),
      { clauses: [], orderBy: [], limit: undefined, offset: 0, joins: [] },
      jc,
    ).crossJoin('other', { as: 'worker' }) // different target
    expect(summarizeQueryPlan(q1)).not.toBe(summarizeQueryPlan(q2))
  })

  it('folds onPredicateName into the summary when present', () => {
    // Two plans: one with named predicate, one without — should differ
    const predicates = new Map([['isActive', { hash: 'isActive-v1', fn: () => true }]])
    const jc = mockJoinContext('periods', { workers: WORKERS })
    const base = new Query(
      staticSource(PERIODS),
      { clauses: [], orderBy: [], limit: undefined, offset: 0, joins: [] },
      jc,
    )._withPredicates(predicates)
    const qNamed = base.crossJoin('workers', { as: 'w', on: { predicate: 'isActive' } })
    const qNoOn = new Query(
      staticSource(PERIODS),
      { clauses: [], orderBy: [], limit: undefined, offset: 0, joins: [] },
      jc,
    ).crossJoin('workers', { as: 'w' })
    expect(summarizeQueryPlan(qNamed)).not.toBe(summarizeQueryPlan(qNoOn))
  })
})
```

- [ ] **Step 2: Run — expect FAIL** (cross-join targets missing from deps; not in summary)

```bash
pnpm --filter @noy-db/hub test -- --run query-cross-join
```

- [ ] **Step 3: Update `analyzeDependencies` in `dependency-analyzer.ts`**

In `packages/hub/src/materialized-views/dependency-analyzer.ts`, inside `analyzeDependencies`, after the FK-join `for` loop:

```typescript
  // FK join targets contribute additional sources.
  for (const leg of plan.joins) {
    deps.add(leg.target)
  }
```

Add:

```typescript
  // Cross-join targets are also dependency sources — writes to either side
  // must trigger MV refresh. Symmetric with FK-join target handling above.
  for (const clause of plan.clauses) {
    if (clause.type === 'crossJoin') {
      deps.add(clause.target)
    }
  }
```

- [ ] **Step 4: Update `summarizeQueryPlan` in `dependency-analyzer.ts`**

Find `summarizeQueryPlan` (around line 75). Change:

```typescript
export function summarizeQueryPlan(query: Query<any>): string {
  const plan = query._plan()
  const ctx = query._joinContext()
  return JSON.stringify({
    root: ctx?.leftCollection ?? null,
    clauses: plan.clauses,
    orderBy: plan.orderBy,
    limit: plan.limit ?? null,
    offset: plan.offset,
    joins: plan.joins.map(j => ({ field: j.field, as: j.as, target: j.target, mode: j.mode })),
  })
}
```

to:

```typescript
export function summarizeQueryPlan(query: Query<any>): string {
  const plan = query._plan()
  const ctx = query._joinContext()
  return JSON.stringify({
    root: ctx?.leftCollection ?? null,
    clauses: plan.clauses.map(c => {
      if (c.type === 'crossJoin') {
        return {
          type: 'crossJoin',
          target: c.target,
          as: c.as,
          // Inline on: callback: use sentinel — drift detection disabled for this MV
          onPredicateName: c.onPredicateName ?? (c.on ? '[inline]' : null),
          maxRows: c.maxRows ?? null,
        }
      }
      return c
    }),
    orderBy: plan.orderBy,
    limit: plan.limit ?? null,
    offset: plan.offset,
    joins: plan.joins.map(j => ({ field: j.field, as: j.as, target: j.target, mode: j.mode })),
  })
}
```

Note: when `c.on` is set but `onPredicateName` is absent (inline callback), `summarizeQueryPlan` includes `'[inline]'` as a sentinel. This means changing FROM an inline callback TO a named predicate (or vice versa) WILL change the hash and force refresh. Two different inline callbacks produce the SAME `'[inline]'` sentinel — that's the documented limitation (the `console.warn` in the builder).

- [ ] **Step 5: Run — expect PASS**

```bash
pnpm --filter @noy-db/hub test -- --run query-cross-join
```

- [ ] **Step 6: Full suite + typecheck + commit**

```bash
pnpm --filter @noy-db/hub test
pnpm --filter @noy-db/hub typecheck
git add packages/hub/src/materialized-views/dependency-analyzer.ts packages/hub/__tests__/query-cross-join.test.ts
git commit -m "feat(hub): analyzeDependencies + summarizeQueryPlan extended for cross-join"
```

---

## Task 10: Showcase 92 — DERIV-SSO-001 end-to-end

**Files:**
- Create: `showcases/src/92-with-cross-join.showcase.test.ts`

- [ ] **Step 1: Write the showcase**

Create `showcases/src/92-with-cross-join.showcase.test.ts`:

```typescript
/**
 * Showcase 92 — Cross-join query primitive
 *
 * What you'll learn
 * ─────────────────
 * `.crossJoin(target, { as })` produces a cartesian product between two
 * collections in the same vault. Combined with `.wherePredicate()` /
 * lateral `on:`, `.groupBy()`, and `.aggregate()`, it closes the
 * DERIV-SSO-001 pattern: "for every period, how many workers were active?"
 *
 * Why it matters
 * ──────────────
 * Cross-join is the foundation of period × entity analytics. Without it,
 * a multi-period payroll or coverage report requires N separate queries
 * (one per period) and manual stitching. Cross-join expresses it as a
 * single declarative query that the hub executes after decryption —
 * zero-knowledge to the backend.
 *
 * Spec mapping
 * ────────────
 * features.yaml → features → cross-join
 */

import { describe, it, expect } from 'vitest'
import { createNoydb, count } from '@noy-db/hub'
import { memory } from '@noy-db/to-memory'

interface Period {
  id: string
  label: string
  start: string // 'YYYY-MM'
  end: string   // 'YYYY-MM'
}

interface Worker {
  id: string
  name: string
  since: string  // 'YYYY-MM' — first active month
  until: string | null  // 'YYYY-MM' or null (still active)
}

describe('Showcase 92 — Cross-join', () => {
  it('DERIV-SSO-001: for each period, counts active workers via lateral on:', async () => {
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'cross-join-showcase-2026',
    })
    const vault = await db.openVault('payroll')
    const periods = vault.collection<Period>('periods')
    const workers = vault.collection<Worker>('workers')

    await periods.put('q1', { id: 'q1', label: 'Q1 2026', start: '2026-01', end: '2026-03' })
    await periods.put('q2', { id: 'q2', label: 'Q2 2026', start: '2026-04', end: '2026-06' })
    await periods.put('q3', { id: 'q3', label: 'Q3 2026', start: '2026-07', end: '2026-09' })

    // Alice: active the whole year
    await workers.put('alice', { id: 'alice', name: 'Alice', since: '2026-01', until: null })
    // Bob: joined mid-Q1, left at end of Q2
    await workers.put('bob',   { id: 'bob',   name: 'Bob',   since: '2026-02', until: '2026-06' })
    // Carol: started Q3 only
    await workers.put('carol', { id: 'carol', name: 'Carol', since: '2026-07', until: null })

    // Worker is "active in period" if: worker.since <= period.start AND
    // (worker.until === null OR worker.until >= period.end)
    const result = await periods.query()
      .crossJoin<Worker, 'worker'>('workers', {
        as: 'worker',
        on: (period) => (worker) =>
          worker.since <= period.start &&
          (worker.until === null || worker.until >= period.end),
      })
      .groupBy('id')
      .aggregate({ workerCount: count() })
      .run()

    // Sort by id for determinism
    result.sort((a: any, b: any) => a.id.localeCompare(b.id))

    // Q1: Alice (since 01 <= 01, until null) ✓; Bob (since 02 > 01) ✗ → 1
    // Q2: Alice ✓; Bob (since 02 <= 04, until 06 >= 06) ✓ → 2
    // Q3: Alice ✓; Bob (until 06 < 09) ✗; Carol (since 07 <= 07, until null) ✓ → 2
    expect(result).toHaveLength(3)
    const byId = Object.fromEntries((result as any[]).map((r: any) => [r.id, r.workerCount]))
    expect(byId['q1']).toBe(1)
    expect(byId['q2']).toBe(2)
    expect(byId['q3']).toBe(2)
  })

  it('full cartesian: every period × every worker (no lateral filter)', async () => {
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'cross-join-full-cartesian-2026',
    })
    const vault = await db.openVault('demo')
    const periods = vault.collection<Period>('periods')
    const workers = vault.collection<Worker>('workers')

    await periods.put('p1', { id: 'p1', label: 'Jan', start: '2026-01', end: '2026-01' })
    await periods.put('p2', { id: 'p2', label: 'Feb', start: '2026-02', end: '2026-02' })
    await workers.put('w1', { id: 'w1', name: 'Alice', since: '2026-01', until: null })
    await workers.put('w2', { id: 'w2', name: 'Bob',   since: '2026-01', until: null })

    const rows = await periods.query()
      .crossJoin<Worker, 'worker'>('workers', { as: 'worker' })
      .toArray()

    expect(rows).toHaveLength(4) // 2 × 2
    expect(rows.every((r: any) => r.worker !== undefined)).toBe(true)
  })

  it('where() before crossJoin filters left side (cheaper than post-filter)', async () => {
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'cross-join-pre-filter-2026',
    })
    const vault = await db.openVault('demo')
    const periods = vault.collection<Period>('periods')
    const workers = vault.collection<Worker>('workers')

    await periods.put('p1', { id: 'p1', label: 'Q1', start: '2026-01', end: '2026-03' })
    await periods.put('p2', { id: 'p2', label: 'Q2', start: '2026-04', end: '2026-06' })
    await workers.put('w1', { id: 'w1', name: 'Alice', since: '2026-01', until: null })
    await workers.put('w2', { id: 'w2', name: 'Bob',   since: '2026-01', until: null })

    const rows = await periods.query()
      .where('id', '==', 'p1')
      .crossJoin<Worker, 'worker'>('workers', { as: 'worker' })
      .toArray()

    expect(rows).toHaveLength(2) // 1 period × 2 workers
    expect(rows.every((r: any) => r.id === 'p1')).toBe(true)
  })

  it('CrossJoinTooLargeError fires when product exceeds ceiling', async () => {
    const { CrossJoinTooLargeError } = await import('@noy-db/hub')
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'cross-join-ceiling-2026',
    })
    const vault = await db.openVault('demo')
    const periods = vault.collection<Period>('periods')
    const workers = vault.collection<Worker>('workers')

    // 260 × 200 = 52,000 > 50,000 default ceiling
    for (let i = 0; i < 260; i++) {
      await periods.put(`p${i}`, { id: `p${i}`, label: `P${i}`, start: '2026-01', end: '2026-01' })
    }
    for (let i = 0; i < 200; i++) {
      await workers.put(`w${i}`, { id: `w${i}`, name: `W${i}`, since: '2026-01', until: null })
    }

    const q = periods.query().crossJoin('workers', { as: 'worker' })
    expect(() => q.toArray()).toThrow(CrossJoinTooLargeError)
  })
})
```

- [ ] **Step 2: Run the showcase**

```bash
pnpm --filter showcases test -- --run 92-with-cross-join
```

Expected: PASS (4 tests).

- [ ] **Step 3: Full suite regression check**

```bash
pnpm --filter @noy-db/hub test && pnpm --filter showcases test
```

- [ ] **Step 4: Commit**

```bash
git add showcases/src/92-with-cross-join.showcase.test.ts
git commit -m "feat(showcases): showcase 92 — cross-join DERIV-SSO-001 end-to-end"
```

---

## Task 11: `features.yaml` entry + subsystem doc

**Files:**
- Modify: `features.yaml`
- Create: `docs/subsystems/cross-join.md`

- [ ] **Step 1: Add `cross-join` to `features.yaml`**

In `features.yaml`, find the `joins` entry (around line 381):
```yaml
  - id: joins
    name: Intra-vault joins on declared `ref()` fields
    cluster: read-and-query
```

After the `joins` entry (after its closing lines), add:

```yaml
  - id: cross-join
    name: Cartesian-product cross-join query primitive
    cluster: read-and-query
    spec: docs/superpowers/specs/2026-05-20-dim11-cross-join-v1-design.md
    subsystem_doc: docs/subsystems/cross-join.md
    showcases:
      - id: 92-with-cross-join
        path: showcases/src/92-with-cross-join.showcase.test.ts
    notes:
      - 'Same-vault only; both collections must be open in the same vault'
      - 'Cost ceiling: CrossJoinTooLargeError at 50,000 rows (cumulative for lateral form)'
      - 'Lateral form via on: (left) => TTarget[] | (right) => boolean'
      - 'MV-safe named predicate form: on: { predicate: name } — queryHash-tracked'
      - 'Composition: where/crossJoin/where/groupBy/aggregate all interleave correctly'
    related: [joins, query-basics, aggregate]
```

- [ ] **Step 2: Run CI feature-check script**

```bash
node scripts/check-features.mjs 2>/dev/null || pnpm --filter @noy-db/hub run lint 2>/dev/null || echo "check manually"
```

If the project has a `Spec coverage` CI check script, run it now. Otherwise verify the YAML is valid:

```bash
node -e "const fs=require('fs'); const y=fs.readFileSync('features.yaml','utf8'); console.log('YAML length:', y.length, 'OK')"
```

- [ ] **Step 3: Create `docs/subsystems/cross-join.md`**

```markdown
# cross-join

> **Subpath:** *(currently always-core)*
> **Cluster:** A — Read & Query
> **Spec:** `docs/superpowers/specs/2026-05-20-dim11-cross-join-v1-design.md`

## What it does

Cartesian-product cross-join between any two collections in the same vault via `.crossJoin(target, { as })`. Each result row carries the original left fields plus `row[as]` populated from the right side.

The optional `on:` parameter enables a **lateral form** — the right-side rows are filtered per left row:
- **Subset:** `on: (left) => TTarget[]` — return only the right rows that pair with `left`
- **Predicate:** `on: (left) => (right) => boolean` — executor materializes then filters
- **MV-safe:** `on: { predicate: 'name' }` — resolves a named predicate from the MV's `predicates` map; queryHash-tracked for drift detection

Composes in declared order with `.where()`, `.groupBy()`, and `.aggregate()`. Cross-join clauses are interleaved with filter clauses: a `.where()` BEFORE `.crossJoin()` filters the left side first (cheaper); a `.where()` AFTER can reference aliased right-side fields.

## When you need it

- Period × entity analytics (DERIV-SSO-001 pattern): active workers per pay period, coverage per billing cycle
- Multi-dimension reporting: every product × every region → aggregate
- Derived collections whose shape is inherently "every A paired with every B"

## API

```ts
query.crossJoin<TTarget, As extends string>(
  target: string,
  opts: {
    as: As
    on?: ((left: T) => TTarget[] | ((right: TTarget) => boolean)) | { predicate: string }
    maxRows?: number   // default: 50_000
  }
): Query<T & { [K in As]: TTarget }>
```

## Cost ceiling

`CrossJoinTooLargeError` fires **before** allocation when the product (or cumulative lateral count) exceeds the ceiling. Default: 50,000 rows (matches `JoinTooLargeError`). Override per-clause with `{ maxRows: N }`.

## Example — DERIV-SSO-001

```ts
const result = periods.query()
  .crossJoin<Worker, 'worker'>('workers', {
    as: 'worker',
    on: (period) => (worker) =>
      worker.since <= period.start &&
      (worker.until === null || worker.until >= period.end),
  })
  .groupBy('id')
  .aggregate({ workerCount: count() })
  .run()
// → [{ id: 'q1', workerCount: 3 }, { id: 'q2', workerCount: 2 }, ...]
```

## Behavior in live queries

`.live()` subscribes to BOTH the left source and all cross-join right-side sources. A mutation on either side re-fires the live query.

## Edge cases & limits

- **Row ceiling:** `CrossJoinTooLargeError` at 50,000 rows. Raise with `{ maxRows: N }`.
- **Lateral ceiling:** charged cumulatively — the ceiling applies to the total post-filter count across ALL left rows, not per-left-row.
- **MV inline `on:` callback:** drift detection disabled; warning emitted at build time. Use `on: { predicate: 'name' }` for MV use.
- **`executePlan()` (pure):** throws if called with a plan containing crossJoin clauses — use `Query.toArray()` instead.
- **Same-vault only:** both collections must be in the same vault. Cross-vault correlation goes through `Noydb.queryAcross`.

## Deferred (out of scope for v3)

`.leftJoin` / outer joins, anti-join, cross-join over MV virtual collections, cost-based query planner, index-aware hash-join downgrade, streaming MV cross-join.

## See also

- [SUBSYSTEMS.md](../../SUBSYSTEMS.md)
- [joins.md](./joins.md) — FK joins (intra-vault, declared `ref()`)
- Showcase 92 — DERIV-SSO-001 end-to-end
```

- [ ] **Step 4: Export `DEFAULT_CROSS_JOIN_MAX_ROWS` from `query/index.ts`**

In `packages/hub/src/query/index.ts`, add to the exports from `builder.js`:

```typescript
export { Query, executePlan, DEFAULT_CROSS_JOIN_MAX_ROWS } from './builder.js'
```

- [ ] **Step 5: Full suite, typecheck, build**

```bash
pnpm --filter @noy-db/hub test
pnpm --filter @noy-db/hub typecheck
pnpm --filter @noy-db/hub build
```

All expected: clean.

- [ ] **Step 6: Commit**

```bash
git add features.yaml docs/subsystems/cross-join.md packages/hub/src/query/index.ts
git commit -m "docs: cross-join subsystem doc + features.yaml entry"
```

---

## Final validation

- [ ] **Run the full hub test suite one last time**

```bash
pnpm --filter @noy-db/hub test
```

Expected: all existing tests pass + new `query-cross-join` tests pass.

- [ ] **Run showcases**

```bash
pnpm --filter showcases test
```

- [ ] **Typecheck all packages**

```bash
pnpm typecheck
```

- [ ] **Open PR on GitHub** (optional — done in the parent session)
