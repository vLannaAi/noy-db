# Compile-Time Sensitive-Field Refusal (P3-T5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `@noy-db/hub` refuse a collection's declared `sensitive` fields at **compile time** in the query/scan/index DSLs (`Query.where`/`.orderBy`, `ScanBuilder.where`, `LazyQuery.where`/`.orderBy`, and the `indexes`/`deterministicFields`/`textIndexes` collection options), turning today's silent runtime-seal into a `tsc` error.

**Architecture:** Type-only change. The runtime already seals `sensitive` fields out of `_data`/`_det`, so `where('ssn', …)` already returns nothing — this plan adds the compile-time gate. We thread the existing `S` (the sensitive-field union, already on `Collection<T, S>`) through the three query builders (`Query<T, S>`, `ScanBuilder<T, S>`, `LazyQuery<T, S>`), and narrow each field-name parameter to a new `QueryField<T, S>` type. The narrowing is **guarded** — `[S] extends [never] ? string : Exclude<keyof T & string, S>` — so collections that declare **no** sensitive fields keep the permissive `field: string` signature unchanged (zero churn for existing consumers); only collections that opt into `sensitive: [...]` get strict field typing.

**Tech Stack:** TypeScript 5.9 (`*.test-d.ts` type-tests enforced by `tsc --noEmit -p tsconfig.typetest.json`, run via `pnpm --filter @noy-db/hub typecheck:types`), tsup (DTS build), pnpm + turbo.

> **Type-test gate (READ — the plan's verification mechanism):** Type-tests in this repo are **NOT** run by vitest `--typecheck`. They are `*.test-d.ts` files included by `packages/hub/tsconfig.typetest.json` and validated by `pnpm --filter @noy-db/hub typecheck:types` (= `tsc --noEmit -p tsconfig.typetest.json`). Under `tsc`, an **unused `@ts-expect-error` is a hard error (TS2578)** and an `expectTypeOf<…>().toEqualTypeOf<…>()` mismatch is a type error — so the red→green cycle works: a negative test goes RED with `TS2578: Unused '@ts-expect-error' directive` until the refusal is implemented, then GREEN. The full `pnpm --filter @noy-db/hub typecheck` runs BOTH `tsc --noEmit` (src) and the type-test config. Wherever a step below says to run the type-test, use `pnpm --filter @noy-db/hub typecheck:types`.

## Global Constraints

- **Type-only.** No runtime behavior change. Do not touch any `.where()`/`.orderBy()`/`new Query()` runtime body except to change a parameter's TYPE annotation. Runtime sealing already exists; this is purely the compile-time gate.
- **`S` defaults to `never` everywhere.** Every builder generic is `<T, S extends keyof T = never>`. Every existing single-arg reference (`Query<T>`, `ScanBuilder<T>`, `LazyQuery<T>`, `Collection<T>`) MUST keep compiling unchanged — there are ~26 `Query<T>` references in `builder.ts` alone and ~446 consumer call sites that must be untouched.
- **Guarded narrowing.** `QueryField<T, S> = [S] extends [never] ? string : Exclude<keyof T & string, S>`. A collection with no `sensitive` declaration (S = never) gets `string` — byte-identical DX to today. Verify this property with a type-test in every task.
- **No new public method.** The escape hatch for a sensitive collection that genuinely needs a dynamic field string is a documented cast: `where(field as QueryField<T, S>, …)`. Do not add a `whereDynamic`/`whereUnchecked` method.
- **Run `node scripts/check-architecture.mjs` before every commit** (kernel-surface line-count ratchet on `collection.ts`/`vault.ts`/`noydb.ts`; bump a ceiling only with a `// Bumped X→Y (reason)` comment if a genuine core line is added).
- **Final gate runs the FULL monorepo typecheck** (`pnpm typecheck`), not just `@noy-db/hub` — a public return/param type change ripples into showcases and sibling packages (this is exactly how the prior `SealedView` regression escaped a hub-only check).

---

### Task 1: The `QueryField<T, S>` + `IndexFieldName<T, S>` type aliases

**Files:**
- Modify: `packages/hub/src/types.ts` (add the two aliases next to `SealedView`, ~line 233)
- Test: `packages/hub/__tests__/query-field-type.test-d.ts` (create)

**Interfaces:**
- Produces:
  - `export type QueryField<T, S extends keyof T = never> = [S] extends [never] ? string : Exclude<keyof T & string, S>`
  - `export type IndexFieldName<T, S extends keyof T = never> = [S] extends [never] ? string : Exclude<keyof T & string, S>`
  - (Both have the same definition today; they are kept as two names so the query-DSL narrowing and the index-option narrowing can evolve independently — e.g. a future `Q = indexed-only` restriction on `QueryField` without touching index declarations.)

- [ ] **Step 1: Write the failing type-test**

Create `packages/hub/__tests__/query-field-type.test-d.ts`:

```ts
import { describe, it, expectTypeOf } from 'vitest'
import type { QueryField, IndexFieldName } from '../src/types.js'

interface Person { id: string; name: string; ssn: string; age: number }

describe('QueryField<T, S>', () => {
  it('is permissive `string` when no sensitive fields (S = never)', () => {
    // The zero-churn guarantee: collections without `sensitive` keep `field: string`.
    expectTypeOf<QueryField<Person>>().toEqualTypeOf<string>()
    expectTypeOf<QueryField<Person, never>>().toEqualTypeOf<string>()
  })

  it('narrows to non-sensitive field names when S is populated', () => {
    expectTypeOf<QueryField<Person, 'ssn'>>().toEqualTypeOf<'id' | 'name' | 'age'>()
  })

  it('IndexFieldName mirrors QueryField', () => {
    expectTypeOf<IndexFieldName<Person>>().toEqualTypeOf<string>()
    expectTypeOf<IndexFieldName<Person, 'ssn'>>().toEqualTypeOf<'id' | 'name' | 'age'>()
  })
})
```

- [ ] **Step 2: Run the type-test to verify it fails**

Run: `pnpm --filter @noy-db/hub typecheck:types`
Expected: FAIL — `Cannot find name 'QueryField'` / module has no exported member `QueryField`.

- [ ] **Step 3: Add the aliases to `types.ts`**

In `packages/hub/src/types.ts`, immediately after the `SealedView` definition (the block ending around line 233), add:

```ts
/**
 * The type of a field-name argument to the query/scan DSL (`where`, `orderBy`,
 * …) for a collection whose sealed (`sensitive`) fields are `S`.
 *
 * Guarded so the common case is unchanged: with **no** sensitive fields
 * (`S = never`) it is exactly `string` — collections that don't opt into
 * `sensitive` keep today's permissive DSL, zero churn. Once a field is
 * declared `sensitive`, the DSL narrows to the non-sensitive field names, so
 * `where('ssn', …)` becomes a compile error. TypeScript cannot subtract a
 * literal from `string`, so refusing a sensitive name necessarily means
 * narrowing to the known field-name union — this is intentional and only
 * affects collections that opted in.
 */
export type QueryField<T, S extends keyof T = never> = [S] extends [never]
  ? string
  : Exclude<keyof T & string, S>

/**
 * The type of a field-name reference in a collection's index-declaration
 * options (`indexes`, `deterministicFields`, `textIndexes`). Same guarded
 * narrowing as {@link QueryField}: permissive `string` until a field is
 * declared `sensitive`, then the sensitive names are refused (a plaintext
 * secondary index over a sealed field defeats non-residency — previously only
 * a runtime `console.warn`). Kept distinct from `QueryField` so the two DSL
 * surfaces can diverge later without coupling.
 */
export type IndexFieldName<T, S extends keyof T = never> = [S] extends [never]
  ? string
  : Exclude<keyof T & string, S>
```

- [ ] **Step 4: Run the type-test to verify it passes**

Run: `pnpm --filter @noy-db/hub typecheck:types`
Expected: PASS (3 tests).

- [ ] **Step 5: Architecture check + commit**

```bash
node scripts/check-architecture.mjs   # Expected: ✓ Architecture invariants OK
git add packages/hub/src/types.ts packages/hub/__tests__/query-field-type.test-d.ts
git commit -m "feat(hub): QueryField<T,S> / IndexFieldName<T,S> field-name types (guarded, default-permissive)"
```

---

### Task 2: Thread `S` through `Query<T, S>` and narrow `where`/`orderBy`

**Files:**
- Modify: `packages/hub/src/query/builder.ts` (class header line 138; `where` line 280; `orderBy` line 359; `or` line 299; `and` line 321; `filter` line 340; `join` line 450; `crossJoin` line 525; `wherePredicate` line 238; and every internal `new Query<T>(...)` within the class)
- Modify: `packages/hub/src/collection.ts:3616` (`query()` overload return type) and `:3670` (`new Query<T>(...)` construction)
- Test: `packages/hub/__tests__/sealed-query-refusal.test-d.ts` (create — Query portion; ScanBuilder/LazyQuery/index portions are appended in later tasks)

**Interfaces:**
- Consumes: `QueryField<T, S>` from Task 1.
- Produces:
  - `export class Query<T, S extends keyof T = never>` — `S` is phantom (type-only; no constructor param, no runtime field).
  - `where(field: QueryField<T, S>, op: Operator, value: unknown): Query<T, S>`
  - `orderBy(field: QueryField<T, S>, direction?: 'asc' | 'desc', opts?: { by?: 'value' | 'label' }): Query<T, S>`
  - All chaining methods return `Query<T, S>` (or `Query<T & …, S>` for joins), preserving `S` down the chain.
  - `collection.query(): Query<T, S>` (the no-arg overload only; the predicate overload returning `T[]` is unchanged).

- [ ] **Step 1: Write the failing type-test**

Create `packages/hub/__tests__/sealed-query-refusal.test-d.ts`:

```ts
import { describe, it, expectTypeOf } from 'vitest'
import { createNoydb } from '../src/index.js'
import { memoryStore } from '../src/store/memory-store.js'

interface Person { id: string; name: string; ssn: string; age: number }

// A vault opened for type-level assertions only (never awaited at runtime here).
async function typedVault() {
  const db = createNoydb({ store: memoryStore() })
  const vault = await db.openVault('v', { passphrase: 'x'.repeat(12) })
  return vault
}

describe('Query sensitive-field refusal', () => {
  it('refuses where() on a sensitive field, allows non-sensitive', async () => {
    const vault = await typedVault()
    const people = vault.collection<Person>('people', { sensitive: ['ssn'] })
    const q = people.query()
    // @ts-expect-error — 'ssn' is sealed; refused at compile time
    q.where('ssn', '==', 'x')
    q.where('name', '==', 'Ada')        // ok
    q.orderBy('age', 'desc')            // ok
    // @ts-expect-error — orderBy on a sealed field is refused
    q.orderBy('ssn')
  })

  it('keeps where() permissive on a collection with no sensitive fields', async () => {
    const vault = await typedVault()
    const plain = vault.collection<Person>('plain')
    // No `sensitive` → field stays `string`, every existing call still compiles.
    plain.query().where('ssn', '==', 'x').orderBy('whatever-string')
    expectTypeOf(plain.query().where).parameter(0).toEqualTypeOf<string>()
  })
})
```

- [ ] **Step 2: Run the type-test to verify it fails**

Run: `pnpm --filter @noy-db/hub typecheck:types`
Expected: FAIL with `TS2578: Unused '@ts-expect-error' directive` — because `where('ssn', …)` currently compiles (today's `field: string`), so the directive catches nothing. `tsc` flags every unused `@ts-expect-error` as a hard error; that is the RED phase.

- [ ] **Step 3: Add `S` to the `Query` class and narrow the field params**

In `packages/hub/src/query/builder.ts`:

1. Change the class header (line 138):
```ts
export class Query<T, S extends keyof T = never> {
```

2. Add the import at the top of the file (join the existing `from '../types.js'` import if present, else add):
```ts
import type { QueryField } from '../types.js'
```

3. Change `where` (line 280) — only the signature line; the body is unchanged except the `new Query<T>` → `new Query<T, S>`:
```ts
  where(field: QueryField<T, S>, op: Operator, value: unknown): Query<T, S> {
```
…and inside its body change `return new Query<T>(` to `return new Query<T, S>(`.

4. Change `orderBy` (line 359):
```ts
  orderBy(field: QueryField<T, S>, direction: 'asc' | 'desc' = 'asc', opts?: { by?: 'value' | 'label' }): Query<T, S> {
```
…and `new Query<T>(` → `new Query<T, S>(` in its body.

5. For the remaining chaining methods, change the return annotation `Query<T>` → `Query<T, S>` and every internal `new Query<T>(` → `new Query<T, S>(`:
   - `filter(fn: (record: T) => boolean): Query<T, S>` (line 340)
   - `wherePredicate(name: string, ctx?: unknown): Query<T, S>` (line 238)
   - `or(builder: (q: Query<T, S>) => Query<T, S>): Query<T, S>` (line 299) — change BOTH the callback param type and the return.
   - `and(builder: (q: Query<T, S>) => Query<T, S>): Query<T, S>` (line 321) — same.
   - `join<As extends string, R = unknown>(field: QueryField<T, S>, opts: {…}): Query<T & Record<As, R | null>, S>` (line 450) — narrow `field`, carry `S` into the widened record type (`S extends keyof T` still holds because `keyof T ⊆ keyof (T & …)`).
   - `crossJoin<…>(target: string, opts: {…}): Query<T & { [K in As]: TTarget }, S>` (line 525) — `target` is an external collection name, NOT a field of `T`; leave it `string`, only change the return annotation to carry `S`.

   > Note: `groupBy` (line 808) and `aggregate` (line 721) return `GroupedQuery`/`Aggregation`, which do **not** carry `S`. Leave their signatures unchanged — grouping/aggregating by a sensitive field is a separate leak vector, explicitly out of scope for this plan (record it in the progress ledger as a follow-up). `groupBy`'s `field: F extends string` stays `string`.

6. Inside any other method body in the class that does `new Query<T>(`, change it to `new Query<T, S>(` (sweep the file — there are ~13). Since `S` is phantom, `new Query<T, S>(...sameArgs)` type-checks with no runtime change.

In `packages/hub/src/collection.ts`:

7. Change the no-arg `query()` overload (line 3616) from `query(): Query<T>` to:
```ts
  query(): Query<T, S>
```
Leave the `query(predicate): T[]` overload and the implementation signature `query(predicate?: …): Query<T> | T[]` unchanged (the impl signature is not part of the public type). At the construction site (line 3670) change `return new Query<T>(` to `return new Query<T, S>(`.

- [ ] **Step 4: Run the type-test to verify it passes**

Run: `pnpm --filter @noy-db/hub typecheck:types`
Expected: PASS (2 tests).

- [ ] **Step 5: Verify no hub-internal regression (the zero-churn property)**

Run: `pnpm --filter @noy-db/hub typecheck`
Expected: PASS — every existing `Query<T>` reference still resolves (S defaults to never). If anything in hub fails here, it is a real regression, not a consumer issue — fix it before committing.

- [ ] **Step 6: Architecture check + commit**

```bash
node scripts/check-architecture.mjs
git add packages/hub/src/query/builder.ts packages/hub/src/collection.ts packages/hub/__tests__/sealed-query-refusal.test-d.ts
git commit -m "feat(hub): thread S through Query<T,S>; refuse sealed fields in where/orderBy"
```

---

### Task 3: Thread `S` through `ScanBuilder<T, S>` and narrow `where`

**Files:**
- Modify: `packages/hub/src/query/scan-builder.ts` (class header line 99; `where` line 170; `filter` line 193; `join` line 286; every internal `new ScanBuilder<T>(...)`)
- Modify: `packages/hub/src/collection.ts:4026` (`scan()` return type) and its `new ScanBuilder<T>(...)` construction site(s)
- Test: append to `packages/hub/__tests__/sealed-query-refusal.test-d.ts`

**Interfaces:**
- Consumes: `QueryField<T, S>` (Task 1).
- Produces:
  - `export class ScanBuilder<T, S extends keyof T = never> implements AsyncIterable<T>`
  - `where(field: QueryField<T, S>, op: Operator, value: unknown): ScanBuilder<T, S>`
  - `collection.scan(opts?): ScanBuilder<T, S>`

- [ ] **Step 1: Add the failing type-test (append a new `describe`)**

Append to `packages/hub/__tests__/sealed-query-refusal.test-d.ts`:

```ts
describe('ScanBuilder sensitive-field refusal', () => {
  it('refuses scan().where() on a sensitive field', async () => {
    const vault = await typedVault()
    const people = vault.collection<Person>('people', { sensitive: ['ssn'] })
    const s = people.scan()
    // @ts-expect-error — sealed field refused in scan
    s.where('ssn', '==', 'x')
    s.where('age', '>', 18)  // ok
  })

  it('keeps scan().where() permissive without sensitive fields', async () => {
    const vault = await typedVault()
    const plain = vault.collection<Person>('plain')
    plain.scan().where('any-string', '==', 1)  // still `string`
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @noy-db/hub typecheck:types`
Expected: FAIL — the new `@ts-expect-error` is unused (scan `where('ssn')` currently compiles).

- [ ] **Step 3: Add `S` to `ScanBuilder` and narrow `where`**

In `packages/hub/src/query/scan-builder.ts`:
1. Add import: `import type { QueryField } from '../types.js'`
2. Class header (line 99): `export class ScanBuilder<T, S extends keyof T = never> implements AsyncIterable<T> {`
3. `where` (line 170): `where(field: QueryField<T, S>, op: Operator, value: unknown): ScanBuilder<T, S> {` and `new ScanBuilder<T>(` → `new ScanBuilder<T, S>(` in the body.
4. `filter` (line 193): return `ScanBuilder<T, S>`; `new ScanBuilder<T>(` → `new ScanBuilder<T, S>(`.
5. `join` (line 286): `join<As extends string, R = unknown>(field: QueryField<T, S>, opts: { as: As }): ScanBuilder<T & Record<As, R | null>, S>` — narrow `field`, carry `S`; `new ScanBuilder<…>` updated accordingly.
6. Sweep every other `new ScanBuilder<T>(` in the class → `new ScanBuilder<T, S>(`.
7. Leave `aggregate` (line 581) and `[Symbol.asyncIterator]` (line 339) signatures unchanged (no field-name param; iterator yields `T`).

In `packages/hub/src/collection.ts`:
8. `scan(opts: { pageSize?: number } = {}): ScanBuilder<T, S> {` (line 4026), and change its `new ScanBuilder<T>(` construction site(s) to `new ScanBuilder<T, S>(`.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @noy-db/hub typecheck:types`
Expected: PASS (4 tests total now).

- [ ] **Step 5: Hub typecheck + architecture check + commit**

```bash
pnpm --filter @noy-db/hub typecheck     # Expected: PASS
node scripts/check-architecture.mjs
git add packages/hub/src/query/scan-builder.ts packages/hub/src/collection.ts packages/hub/__tests__/sealed-query-refusal.test-d.ts
git commit -m "feat(hub): thread S through ScanBuilder<T,S>; refuse sealed fields in scan().where"
```

---

### Task 4: Thread `S` through `LazyQuery<T, S>` and narrow `where`/`orderBy`

**Files:**
- Modify: `packages/hub/src/indexing/lazy-builder.ts` (class header line 63; `where` line 72; `orderBy` line 80; every internal `new LazyQuery<T>(...)`)
- Modify: `packages/hub/src/collection.ts:4928` (`lazyQuery()` return type) and its `new LazyQuery<T>(...)` site
- Test: append to `packages/hub/__tests__/sealed-query-refusal.test-d.ts`

**Interfaces:**
- Consumes: `QueryField<T, S>` (Task 1).
- Produces:
  - `export class LazyQuery<T, S extends keyof T = never>`
  - `where<V>(field: QueryField<T, S>, op: Operator, value: V): LazyQuery<T, S>`
  - `orderBy(field: QueryField<T, S>, direction?: 'asc' | 'desc'): LazyQuery<T, S>`
  - `collection.lazyQuery(): LazyQuery<T, S>`

- [ ] **Step 1: Add the failing type-test (append)**

Append to `packages/hub/__tests__/sealed-query-refusal.test-d.ts`:

```ts
describe('LazyQuery sensitive-field refusal', () => {
  it('refuses lazyQuery().where()/orderBy() on a sensitive field', async () => {
    const db = createNoydb({ store: memoryStore() })
    const vault = await db.openVault('lz', { passphrase: 'x'.repeat(12) })
    // lazyQuery requires lazy mode (prefetch: false)
    const people = vault.collection<Person>('people', { sensitive: ['ssn'], prefetch: false })
    const lq = people.lazyQuery()
    // @ts-expect-error — sealed field refused in lazy where
    lq.where('ssn', '==', 'x')
    lq.where('name', '==', 'Ada')   // ok
    // @ts-expect-error — sealed field refused in lazy orderBy
    lq.orderBy('ssn')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @noy-db/hub typecheck:types`
Expected: FAIL — new `@ts-expect-error` directives unused.

- [ ] **Step 3: Add `S` to `LazyQuery` and narrow the field params**

In `packages/hub/src/indexing/lazy-builder.ts`:
1. Add import: `import type { QueryField } from '../types.js'` (note: `lazy-builder.ts` is one level under `src/indexing/`, so the path is `'../types.js'`; confirm the relative depth and adjust if the file resolves `types` differently).
2. Class header (line 63): `export class LazyQuery<T, S extends keyof T = never> {`
3. `where` (line 72): `where<V>(field: QueryField<T, S>, op: Operator, value: V): LazyQuery<T, S> {` and `new LazyQuery<T>(` → `new LazyQuery<T, S>(`.
4. `orderBy` (line 80): `orderBy(field: QueryField<T, S>, direction: 'asc' | 'desc' = 'asc'): LazyQuery<T, S> {` and `new LazyQuery<T>(` → `new LazyQuery<T, S>(`.
5. Sweep any remaining `new LazyQuery<T>(` in the class → `new LazyQuery<T, S>(`.

In `packages/hub/src/collection.ts`:
6. `lazyQuery(): LazyQuery<T, S> {` (line 4928) and change its `new LazyQuery<T>(` site to `new LazyQuery<T, S>(`.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @noy-db/hub typecheck:types`
Expected: PASS (5 tests total).

- [ ] **Step 5: Hub typecheck + architecture check + commit**

```bash
pnpm --filter @noy-db/hub typecheck
node scripts/check-architecture.mjs
git add packages/hub/src/indexing/lazy-builder.ts packages/hub/src/collection.ts packages/hub/__tests__/sealed-query-refusal.test-d.ts
git commit -m "feat(hub): thread S through LazyQuery<T,S>; refuse sealed fields in lazy where/orderBy"
```

---

### Task 5: Narrow the `indexes` / `deterministicFields` / `textIndexes` collection options

**Files:**
- Modify: `packages/hub/src/vault.ts` (the `collection<T, const S …>({ … })` option object, ~lines 684–794 — specifically `indexes`, `deterministicFields`, `textIndexes`)
- Modify: `packages/hub/src/types.ts` (add an `IndexDefFor<F>` generic mirroring the runtime `IndexDef` shape)
- Test: append to `packages/hub/__tests__/sealed-query-refusal.test-d.ts`

**Interfaces:**
- Consumes: `IndexFieldName<T, S>` (Task 1), and the runtime `IndexDef` shape from `packages/hub/src/indexing/eager-indexes.ts:34` (`string | { fields: readonly string[]; unique?: boolean } | readonly string[]`).
- Produces:
  - `export type IndexDefFor<F extends string> = F | { readonly fields: readonly F[]; readonly unique?: boolean } | readonly F[]`
  - `vault.collection`'s `indexes?: readonly IndexDefFor<IndexFieldName<T, S[number]>>[]`, `deterministicFields?: readonly IndexFieldName<T, S[number]>[]`, `textIndexes?: readonly IndexFieldName<T, S[number]>[]`.
  - Because `S[number]` is `never` when no `sensitive` option is given, all three stay `IndexDefFor<string>` / `readonly string[]` — unchanged for non-sensitive collections.

- [ ] **Step 1: Add the failing type-test (append)**

Append to `packages/hub/__tests__/sealed-query-refusal.test-d.ts`:

```ts
describe('index-declaration sensitive-field refusal', () => {
  it('refuses indexing / det-encrypting / text-indexing a sensitive field', async () => {
    const vault = await typedVault()
    vault.collection<Person>('a', {
      sensitive: ['ssn'],
      // @ts-expect-error — cannot put a sealed field in a plaintext index
      indexes: ['ssn'],
    })
    vault.collection<Person>('b', {
      sensitive: ['ssn'],
      // @ts-expect-error — cannot put a sealed field in a composite index
      indexes: [{ fields: ['name', 'ssn'] }],
    })
    vault.collection<Person>('c', {
      sensitive: ['ssn'],
      // @ts-expect-error — sealed field cannot be deterministically encrypted here
      deterministicFields: ['ssn'],
    })
    // Non-sensitive fields index fine on the same collection:
    vault.collection<Person>('d', { sensitive: ['ssn'], indexes: ['name', 'age'] })
  })

  it('keeps index options permissive without sensitive fields', async () => {
    const vault = await typedVault()
    vault.collection<Person>('e', { indexes: ['anything', { fields: ['x', 'y'] }] })
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @noy-db/hub typecheck:types`
Expected: FAIL — the four `@ts-expect-error` directives are unused (today the options are `IndexDef[]` / `readonly string[]`, which accept `'ssn'`).

- [ ] **Step 3: Add `IndexDefFor` and narrow the three options**

In `packages/hub/src/types.ts`, after `IndexFieldName` (Task 1), add:

```ts
/**
 * Generic form of the runtime `IndexDef` (see `indexing/eager-indexes.ts`)
 * parameterised by the allowed field-name set `F`. Used to refuse `sensitive`
 * fields in the `indexes` collection option at compile time while leaving the
 * runtime `IndexDef` (string-based) untouched.
 */
export type IndexDefFor<F extends string> =
  | F
  | { readonly fields: readonly F[]; readonly unique?: boolean }
  | readonly F[]
```

In `packages/hub/src/vault.ts`, in the `collection<T, const S …>` option object:
- `indexes?: readonly IndexDefFor<IndexFieldName<T, S[number]>>[]` (was `IndexDef[]`)
- `deterministicFields?: readonly IndexFieldName<T, S[number]>[]` (was `readonly string[]`)
- `textIndexes?: readonly IndexFieldName<T, S[number]>[]` (was `readonly string[]`)

Add `IndexFieldName, IndexDefFor` to the existing `import type { … } from './types.js'` in `vault.ts`. Keep the runtime body that reads `opts.indexes` unchanged (it already handles `string | string[] | { fields }`).

> If a build error appears where `vault.ts` passes `opts.indexes` into a function typed `IndexDef[]`, add a single localized cast at that internal boundary (`opts.indexes as IndexDef[]`) — the narrowing is a compile-time-only restriction on the public option; the internal index machinery still accepts the wider runtime shape.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @noy-db/hub typecheck:types`
Expected: PASS (7 tests total).

- [ ] **Step 5: Hub typecheck + architecture check + commit**

```bash
pnpm --filter @noy-db/hub typecheck
node scripts/check-architecture.mjs
git add packages/hub/src/types.ts packages/hub/src/vault.ts packages/hub/__tests__/sealed-query-refusal.test-d.ts
git commit -m "feat(hub): refuse sealed fields in indexes/deterministicFields/textIndexes options"
```

---

### Task 6: Full-monorepo verification + consumer fixups + runtime regression check

**Files:**
- Modify (only as needed): `packages/in-rest/src/query-params.ts:64,67` and any other consumer the full typecheck flags.
- Modify (only if a real core line was added): `scripts/check-architecture.mjs` (kernel-surface ceiling — with a justification comment).
- Docs: `packages/hub/docs/subsystems/` is NOT in scope; add a short note to the existing sealed/sensitive doc if one exists (see Step 4).

**Interfaces:**
- Consumes: everything from Tasks 1–5.

- [ ] **Step 1: Build hub DTS (needed so sibling packages resolve the new types)**

Run: `NODE_OPTIONS="--max-old-space-size=8192" pnpm --filter @noy-db/hub build`
Expected: `hub build OK` (the DTS worker needs the larger heap locally; CI has it by default).

- [ ] **Step 2: Full monorepo typecheck — surface ALL consumer breakage**

Run: `NODE_OPTIONS="--max-old-space-size=8192" pnpm typecheck`
Expected: initially FAILS in consumers that pass a raw `string` field to a query on a **sensitive** collection (most consumers are non-sensitive and unaffected). The known candidate is `packages/in-rest/src/query-params.ts` (it builds `result.where(field, op, …)` from a raw HTTP `string`). This only breaks if `apply<T>` is ever instantiated with a sensitive `S`; if `Query<T>`’s `S` defaults to `never` there, it stays permissive and does NOT break. Read each error before changing anything.

- [ ] **Step 3: Fix each flagged consumer with the documented escape-hatch cast**

For any consumer that legitimately passes a dynamic field string into a query whose `S` is non-`never`, cast at the call site using the exported type. Example for `in-rest` IF flagged:

```ts
// packages/in-rest/src/query-params.ts
import type { QueryField } from '@noy-db/hub'
// …
result = result.where(field as QueryField<T>, op, value as T[keyof T & string])
```

Do **not** widen the builder types to fix a consumer — the consumer is the right place for the cast (it is the one erasing field-name type information from an HTTP string). If a consumer fix is more than a localized cast, stop and escalate — it means a builder signature is wrong.

- [ ] **Step 4: Document the escape hatch**

If a sealed/sensitive subsystem doc exists (search `packages/hub/docs` and `SUBSYSTEMS.md` for "sealed"/"sensitive"), add a short paragraph: sensitive fields are refused at compile time in `where`/`orderBy`/`scan`/index options; for a genuinely dynamic field name on a sensitive collection, cast via `field as QueryField<T, S>`. If no such doc exists, skip — do not create a new doc file (out of scope).

- [ ] **Step 5: Run the FULL hub test suite — prove zero runtime change**

Run: `pnpm --filter @noy-db/hub test`
Expected: PASS at the same count as before this plan (the change is type-only; any runtime delta is a bug). Also run the type-tests explicitly: `pnpm --filter @noy-db/hub typecheck:types` → all `*.test-d.ts` clean.

- [ ] **Step 6: Final architecture check + commit**

```bash
node scripts/check-architecture.mjs     # Expected: ✓ (bump a ceiling only with a justification comment if a real core line was added)
git add -A
git commit -m "test(hub): full-monorepo typecheck green for sensitive-field refusal; consumer casts"
```

---

## Notes for the executor

- **The whole change is type-only.** If you find yourself altering a `.where()`/`.orderBy()` runtime body beyond `new Query<T>` → `new Query<T, S>`, stop — you are out of scope.
- **The zero-churn property is the most important invariant.** After every task, `pnpm --filter @noy-db/hub typecheck` must stay green. If a hub-internal `Query<T>`/`ScanBuilder<T>` reference breaks, S did not default correctly — fix the default, don't sprinkle casts.
- **`@ts-expect-error` is the test.** A passing type-test means the directive caught a real compile error. If a directive becomes "unused," the refusal regressed.
- **Out of scope (record as ledger follow-ups):** `groupBy`/`aggregate`/`join`-target sensitive refusal; the `Q = indexed-only` query restriction (full P3-T5); narrowing `refs`/`i18nFields`/`moneyFields`/`dictKeyFields` keys; the runtime `console.warn` at `collection.ts:1114` can stay (defense in depth) or be removed once compile-time refusal lands — leave it for now.
