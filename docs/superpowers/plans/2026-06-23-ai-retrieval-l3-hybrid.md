# AI-retrieval L3 — Hybrid Retrieval + fuseRetrieval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `retrieve(q, { mode: 'hybrid', within? })` — fuse the lexical (L1) and semantic (L2) result lists by Reciprocal Rank Fusion and optionally intersect with a structured `Query<T>` — plus ship the fusion step as a standalone, kernel-exported `fuseRetrieval` primitive that klum-db's Lobby reuses across vaults.

**Architecture:** A pure RRF reducer in `src/search/fuse.ts` consumes the ranked `RetrieveHit[]` that both existing paths already return. `collection.retrieve()` refactors its mode dispatch into `retrieveLexical`/`retrieveSemantic`/`retrieveHybrid` private helpers, then applies a `within` post-filter uniformly. The `within` id-set is recovered through a new internal `Query<T>._idArray()` terminal that reference-identity-maps matching records to ids via an id-paired `QuerySource.snapshotEntries()`. Zero new store artifacts — L3 is pure in-trusted-tier computation over L1/L2 outputs.

**Tech Stack:** TypeScript (ESM, `exactOptionalPropertyTypes` ON), vitest, hub-portable (no Node-only imports). Spec: `docs/superpowers/specs/2026-06-23-ai-retrieval-l3-hybrid-design.md`.

## Global Constraints

- **Zero added store leakage:** L3 adds NO new store keys/blobs/queries. It computes over L1's in-memory index, L2's in-memory vectors, and the eager cache. A wrapped-store test must show a hybrid `retrieve()` (with `within`) writes nothing new.
- **Tree-shakeable:** all new logic lives in `src/search/` (+ a thin `Query` terminal + thin `collection.ts` call-sites). Lexical-only bundles must be unaffected.
- **`exactOptionalPropertyTypes` is ON:** never assign `undefined` to an optional property; build objects with conditional spread (`...(x !== undefined ? { x } : {})`). Run `npx tsc --noEmit` in every task.
- **Kernel ceilings:** `scripts/check-architecture.mjs` caps `collection.ts` (5255, file at 5252) and `vault.ts` (4610). Keep logic out of these files; if thin call-sites push `collection.ts` over budget, raise the budget at `scripts/check-architecture.mjs:496` to the new line count + small headroom (the established minimal-raise pattern). Run `node scripts/check-architecture.mjs` in every code task.
- **Public-export rule (L2 lesson):** every new public symbol (`fuseRetrieval`, `FuseOptions`, `mode:'hybrid'`, `within`) MUST be re-exported from `packages/hub/src/index.ts`; `fuseRetrieval` + `FuseOptions` + `RetrieveHit`/`RetrieveOptions` also from `packages/hub/src/kernel/index.ts`. Verify by importing through `@noy-db/hub` (the package entry), NOT `../src` — only the package-entry/showcase path catches a missing barrel re-export.
- **RRF default `k = 60`.** The fused `score` is the RRF score (NOT BM25, NOT cosine) — document it as such.
- **Eager-mode only** for `within` and `hybrid` (matches `query()` and the semantic path); lazy mode throws the existing eager-mode error.
- **No Claude/AI attribution** in commits, PRs, or docs.
- All commands run from `packages/hub` unless noted; the repo root is two levels up (`../..`).

## File Structure

- **Create** `packages/hub/src/search/fuse.ts` — `fuseRetrieval(lists, opts?)` RRF reducer + `FuseOptions`.
- **Modify** `packages/hub/src/search/index.ts` — re-export `fuseRetrieval` + `FuseOptions`.
- **Modify** `packages/hub/src/index.ts` — re-export `fuseRetrieval` + `FuseOptions` from the package entry.
- **Modify** `packages/hub/src/kernel/index.ts` — re-export `fuseRetrieval` (runtime) + `FuseOptions`/`RetrieveHit`/`RetrieveOptions` (types) for the klum federation contract.
- **Modify** `packages/hub/src/query/builder.ts` — `QuerySource.snapshotEntries?()` + `Query<T>._idArray()`.
- **Modify** `packages/hub/src/search/retrieve-types.ts` — `mode` adds `'hybrid'`; `RetrieveOptions` becomes generic `RetrieveOptions<T = unknown>` with `within?: Query<T>`.
- **Modify** `packages/hub/src/collection.ts` — refactor `retrieve()` mode dispatch into `retrieveLexical`/`retrieveHybrid`/`applyWithin`; add `snapshotEntries` to the `query()` source.
- **Modify** `features.yaml`, **create** `docs/subsystems/` hybrid section, **create** `showcases/src/125-hybrid-retrieve.showcase.test.ts`.
- **Create** tests: `packages/hub/__tests__/fuse.test.ts`, `query-idarray.test.ts`, `retrieve-hybrid.test.ts`, `retrieve-within.test.ts`.

---

### Task 1: `fuseRetrieval` RRF reducer + exports

**Files:**
- Create: `packages/hub/src/search/fuse.ts`
- Modify: `packages/hub/src/search/index.ts` (barrel)
- Modify: `packages/hub/src/index.ts` (package entry)
- Modify: `packages/hub/src/kernel/index.ts` (federation contract)
- Test: `packages/hub/__tests__/fuse.test.ts`

**Interfaces:**
- Consumes: `RetrieveHit<T>` from `packages/hub/src/search/retrieve-types.ts` (`{ id, score, rank, field, snippet, locale?, record? }`; `field` is `'(vector)'` for semantic hits, a real field name for lexical).
- Produces:
  - `export interface FuseOptions { readonly strategy?: 'rrf'; readonly k?: number; readonly limit?: number }`
  - `export function fuseRetrieval<T>(lists: ReadonlyArray<ReadonlyArray<RetrieveHit<T>>>, opts?: FuseOptions): RetrieveHit<T>[]`

- [ ] **Step 1: Write the failing test**

Create `packages/hub/__tests__/fuse.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { fuseRetrieval } from '../src/search/fuse.js'
import type { RetrieveHit } from '../src/search/retrieve-types.js'

const hit = (id: string, rank: number, field = 'text', snippet = 's'): RetrieveHit<unknown> =>
  ({ id, score: 1 / rank, rank, field, snippet })

describe('fuseRetrieval (RRF)', () => {
  it('fuses two lists by reciprocal rank, default k=60', () => {
    const lex = [hit('a', 1), hit('b', 2)]
    const sem = [hit('b', 1, '(vector)', ''), hit('c', 2, '(vector)', '')]
    const out = fuseRetrieval([lex, sem])
    // b is in both: 1/(60+2) + 1/(60+1) = highest; a: 1/61; c: 1/62
    expect(out.map(h => h.id)).toEqual(['b', 'a', 'c'])
    expect(out[0].rank).toBe(1)
    expect(out[1].rank).toBe(2)
    expect(out[2].rank).toBe(3)
    // RRF score, not BM25/cosine
    expect(out[0].score).toBeCloseTo(1 / 62 + 1 / 61, 10)
  })

  it('single list is a rank-restamped passthrough (order preserved)', () => {
    const out = fuseRetrieval([[hit('x', 1), hit('y', 2), hit('z', 3)]])
    expect(out.map(h => h.id)).toEqual(['x', 'y', 'z'])
    expect(out.map(h => h.rank)).toEqual([1, 2, 3])
  })

  it('honors limit', () => {
    const out = fuseRetrieval([[hit('a', 1), hit('b', 2), hit('c', 3)]], { limit: 2 })
    expect(out.map(h => h.id)).toEqual(['a', 'b'])
  })

  it('respects a custom k', () => {
    // with k=0, rank-1 contribution is 1/1=1, dominating
    const out = fuseRetrieval([[hit('a', 2)], [hit('b', 1)]], { k: 0 })
    expect(out[0].id).toBe('b')
  })

  it('breaks ties deterministically by id ascending', () => {
    // a and b each appear once at rank 1 → equal score
    const out = fuseRetrieval([[hit('b', 1)], [hit('a', 1)]])
    expect(out.map(h => h.id)).toEqual(['a', 'b'])
  })

  it('a merged hit keeps the lexical field/snippet over the vector placeholder', () => {
    const lex = [hit('a', 2, 'description', 'invoice for X')]
    const sem = [hit('a', 1, '(vector)', '')]
    const out = fuseRetrieval([lex, sem])
    expect(out[0].field).toBe('description')
    expect(out[0].snippet).toBe('invoice for X')
  })

  it('a merged hit recovers record from whichever list carried it', () => {
    const lex: RetrieveHit<{ n: number }>[] = [{ id: 'a', score: 0.5, rank: 1, field: 'text', snippet: 's' }]
    const sem: RetrieveHit<{ n: number }>[] = [{ id: 'a', score: 0.9, rank: 1, field: '(vector)', snippet: '', record: { n: 7 } }]
    const out = fuseRetrieval([lex, sem])
    expect(out[0].record).toEqual({ n: 7 })
  })

  it('empty input yields empty output', () => {
    expect(fuseRetrieval([])).toEqual([])
    expect(fuseRetrieval([[], []])).toEqual([])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run __tests__/fuse.test.ts`
Expected: FAIL — `Cannot find module '../src/search/fuse.js'`.

- [ ] **Step 3: Implement `fuse.ts`**

Create `packages/hub/src/search/fuse.ts`:

```ts
/**
 * #308 L3 — Reciprocal Rank Fusion. Merges N ranked `RetrieveHit` lists into
 * one, scoring each id by Σ 1/(k + rank) across the lists it appears in. Pure,
 * deterministic, no I/O — which is why it serves BOTH hybrid lexical⊕semantic
 * fusion AND klum-db's cross-vault federation (the lists are per-vault). The
 * fused `score` is the RRF score, NOT BM25 or cosine.
 */
import type { RetrieveHit } from './retrieve-types.js'

export interface FuseOptions {
  /** Only 'rrf' in v1 (default). */
  readonly strategy?: 'rrf'
  /** RRF constant; larger flattens the rank weighting. Default 60. */
  readonly k?: number
  /** Truncate the fused output to this many hits. */
  readonly limit?: number
}

export function fuseRetrieval<T>(
  lists: ReadonlyArray<ReadonlyArray<RetrieveHit<T>>>,
  opts: FuseOptions = {},
): RetrieveHit<T>[] {
  const k = opts.k ?? 60
  const acc = new Map<string, { score: number; hit: RetrieveHit<T> }>()
  for (const list of lists) {
    for (const hit of list) {
      const contribution = 1 / (k + hit.rank)
      const prev = acc.get(hit.id)
      if (prev === undefined) {
        acc.set(hit.id, { score: contribution, hit })
      } else {
        prev.score += contribution
        prev.hit = mergePresentation(prev.hit, hit)
      }
    }
  }
  const merged = [...acc.values()].sort(
    (a, b) => b.score - a.score || (a.hit.id < b.hit.id ? -1 : a.hit.id > b.hit.id ? 1 : 0),
  )
  const limited = opts.limit !== undefined ? merged.slice(0, opts.limit) : merged
  return limited.map((m, i) => ({ ...m.hit, score: m.score, rank: i + 1 }))
}

/**
 * When an id appears in multiple lists, prefer the more informative
 * presentation: a real `field`/`snippet`/`locale` (lexical) over the vector
 * placeholder (`'(vector)'` / `''`). Recover `record` from whichever hit has it.
 */
function mergePresentation<T>(a: RetrieveHit<T>, b: RetrieveHit<T>): RetrieveHit<T> {
  const lexical = a.field !== '(vector)' ? a : b
  const other = lexical === a ? b : a
  return {
    ...lexical,
    ...(lexical.record === undefined && other.record !== undefined ? { record: other.record } : {}),
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run __tests__/fuse.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Wire the exports**

In `packages/hub/src/search/index.ts`, append after the `RetrieveOptions`/`RetrieveHit` export line:

```ts
export { fuseRetrieval, type FuseOptions } from './fuse.js'
```

In `packages/hub/src/index.ts`, add (near the other `./search/...` / lazy-mode-index exports — search for `IndexRequiredError` and add below it):

```ts
// #308 L3 — hybrid-retrieval rank fusion (also the klum federation primitive)
export { fuseRetrieval, type FuseOptions } from './search/fuse.js'
```

In `packages/hub/src/kernel/index.ts`, add `fuseRetrieval` to the runtime-helpers group and the types to the types group:

```ts
// #308 L3 — rank-fusion reducer: an outward orchestrator (@klum-db/lobby)
// fuses per-vault retrieve() result-sets with the SAME primitive hybrid uses.
export { fuseRetrieval } from '../search/fuse.js'
```
and in the types group:
```ts
export type { FuseOptions } from '../search/fuse.js'
export type { RetrieveHit, RetrieveOptions } from '../search/retrieve-types.js'
```

- [ ] **Step 6: Verify exports through the package entry**

Run: `npx tsc --noEmit && npm run build`
Then verify the barrel re-exports resolve (the L2 export-gap guard):

Run: `node -e "import('@noy-db/hub').then(m => { if (typeof m.fuseRetrieval !== 'function') throw new Error('fuseRetrieval missing from package entry'); console.log('entry ok'); }).then(() => import('@noy-db/hub/kernel')).then(m => { if (typeof m.fuseRetrieval !== 'function') throw new Error('fuseRetrieval missing from kernel'); console.log('kernel ok'); })"`
Expected: prints `entry ok` then `kernel ok`.

- [ ] **Step 7: Run eslint + architecture**

Run: `npx eslint src/search/fuse.ts src/index.ts src/kernel/index.ts src/search/index.js 2>/dev/null; npx eslint src && node scripts/check-architecture.mjs`
Expected: no eslint errors; architecture OK (this task touches no kernel-capped file beyond barrels — no bump expected).

- [ ] **Step 8: Commit**

```bash
git add packages/hub/src/search/fuse.ts packages/hub/src/search/index.ts packages/hub/src/index.ts packages/hub/src/kernel/index.ts packages/hub/__tests__/fuse.test.ts
git commit -m "feat(search): #308 L3 — fuseRetrieval RRF reducer + kernel export"
```

---

### Task 2: `Query._idArray()` + id-paired `snapshotEntries`

**Files:**
- Modify: `packages/hub/src/query/builder.ts` (`QuerySource` + `InternalSource` interfaces; new `Query._idArray()` method)
- Modify: `packages/hub/src/collection.ts` (add `snapshotEntries` to the `query()` source object, ~line 3266)
- Test: `packages/hub/__tests__/query-idarray.test.ts`

**Interfaces:**
- Consumes: the module-private `executePlanWithSource(source, plan, joinContext?, locale?)` in `builder.ts` (returns the ORIGINAL snapshot record references, before money-decode/joins). `Query`'s private fields `this.source`, `this.plan`, `this.joinContext`.
- Produces:
  - `QuerySource<T>` gains `snapshotEntries?(): readonly { id: string; record: T }[]`.
  - `Query<T>._idArray(): string[]` — ids of records matching this query's plan, via reference identity against `snapshotEntries()`. Throws if the source has no `snapshotEntries`.

- [ ] **Step 1: Write the failing test**

Create `packages/hub/__tests__/query-idarray.test.ts`. Reuse the `memory()` store + `enc()` stub pattern from `__tests__/embeddings-retrieve.test.ts` (copy the `memory()` helper verbatim from there). Then:

```ts
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/noydb.js'
// ... paste the memory() helper from embeddings-retrieve.test.ts ...

describe('Query._idArray()', () => {
  it('returns the ids of records matching the plan', async () => {
    const db = await createNoydb({ store: memory(), masterKey: 'k'.repeat(32) })
    const v = await db.vault('v')
    const c = await v.collection<{ status: string; amount: number }>('orders')
    await c.put('o1', { status: 'open', amount: 10 })
    await c.put('o2', { status: 'closed', amount: 20 })
    await c.put('o3', { status: 'open', amount: 30 })
    const q = c.query().where('status', '==', 'open')
    expect(new Set((q as unknown as { _idArray(): string[] })._idArray())).toEqual(new Set(['o1', 'o3']))
  })

  it('recovers ids even when a money field forces decoded copies in toArray', async () => {
    const db = await createNoydb({ store: memory(), masterKey: 'k'.repeat(32) })
    const v = await db.vault('v')
    const c = await v.collection<{ status: string; price: string }>('inv', {
      money: { price: { currency: 'USD' } },
    })
    await c.put('a', { status: 'open', price: '10.00' })
    await c.put('b', { status: 'open', price: '20.00' })
    await c.put('z', { status: 'closed', price: '5.00' })
    const q = c.query().where('status', '==', 'open')
    expect(new Set((q as unknown as { _idArray(): string[] })._idArray())).toEqual(new Set(['a', 'b']))
  })

  it('throws on a source without snapshotEntries', async () => {
    const { Query } = await import('../src/query/builder.js')
    const raw = new Query<{ x: number }>({ snapshot: () => [{ x: 1 }] })
    expect(() => (raw as unknown as { _idArray(): string[] })._idArray()).toThrow(/snapshotEntries/)
  })
})
```

> NOTE to implementer: confirm the `money` collection-option shape against an existing money test (e.g. grep `money:` in `__tests__/`); adjust the `money:` literal in the second test to match the real option shape if it differs. The assertion (ids recovered despite decoded copies) is the contract — keep it.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run __tests__/query-idarray.test.ts`
Expected: FAIL — `_idArray is not a function`.

- [ ] **Step 3: Add `snapshotEntries` to the source interfaces**

In `packages/hub/src/query/builder.ts`, in `interface QuerySource<T>` add after `lookupById?`:

```ts
  /**
   * #308 L3 — id-paired snapshot for `Query._idArray()` (the `retrieve({within})`
   * id projection). Optional: only collection-backed queries supply it.
   */
  snapshotEntries?(): readonly { id: string; record: T }[]
```

and in `interface InternalSource` add the matching erased form:

```ts
  snapshotEntries?(): readonly { id: string; record: unknown }[]
```

- [ ] **Step 4: Add the `_idArray()` method**

In `packages/hub/src/query/builder.ts`, add a method on `class Query<T>` (place it next to the other `@internal` accessors such as `_plan()`):

```ts
  /**
   * @internal — #308 L3. The ids of records matching this query's plan,
   * recovered by reference identity: `executePlanWithSource` returns the
   * ORIGINAL snapshot record references (money-decode and joins are applied
   * later, in `toArray`), so each matched record is found in the id-paired
   * `snapshotEntries()` map. Used by `collection.retrieve({ within })`.
   * Throws if the source is not collection-backed (no `snapshotEntries`).
   */
  _idArray(): string[] {
    const entries = this.source.snapshotEntries?.()
    if (entries === undefined) {
      throw new Error(
        'Query._idArray(): the query source has no snapshotEntries(); ' +
          'retrieve({ within }) requires a collection-backed query (collection.query()).',
      )
    }
    const refToId = new Map<unknown, string>()
    for (const { id, record } of entries) refToId.set(record, id)
    const matched = executePlanWithSource(this.source, this.plan, this.joinContext)
    const ids: string[] = []
    for (const r of matched) {
      const id = refToId.get(r)
      if (id !== undefined) ids.push(id)
    }
    return ids
  }
```

- [ ] **Step 5: Supply `snapshotEntries` from the collection's query source**

In `packages/hub/src/collection.ts`, in the `query()` source object (the `const source: QuerySource<T> = { ... }` near line 3266), add after the `lookupById` line:

```ts
      snapshotEntries: () => [...this.cache.entries()].map(([id, e]) => ({ id, record: e.record })),
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run __tests__/query-idarray.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 7: Typecheck + eslint + architecture**

Run: `npx tsc --noEmit && npx eslint src/query/builder.ts src/collection.ts && node scripts/check-architecture.mjs`
Expected: tsc clean; eslint clean; architecture OK. If `collection.ts` now exceeds 5255, raise the budget at `scripts/check-architecture.mjs:496` to the reported line count + 5 and re-run.

- [ ] **Step 8: Commit**

```bash
git add packages/hub/src/query/builder.ts packages/hub/src/collection.ts packages/hub/__tests__/query-idarray.test.ts scripts/check-architecture.mjs
git commit -m "feat(query): #308 L3 — Query._idArray() id projection via snapshotEntries"
```

---

### Task 3: `mode:'hybrid'` in `retrieve()`

**Files:**
- Modify: `packages/hub/src/search/retrieve-types.ts` (add `'hybrid'` to `mode`)
- Modify: `packages/hub/src/collection.ts` (refactor `retrieve()` dispatch; add `retrieveLexical` + `retrieveHybrid`)
- Test: `packages/hub/__tests__/retrieve-hybrid.test.ts`

**Interfaces:**
- Consumes: `fuseRetrieval` from `./search/fuse.js` (Task 1); the existing `retrieveSemantic(query, opts)` and the existing lexical body of `retrieve()`.
- Produces: `retrieve(q, { mode: 'hybrid', limit? })` → fused `RetrieveHit<T>[]`; throws `Collection "<name>": retrieve({mode:'hybrid'}) requires an embeddings config.` when `this.embeddings` is unset.

- [ ] **Step 1: Write the failing test**

Create `packages/hub/__tests__/retrieve-hybrid.test.ts` (reuse `memory()` + `enc()` from `embeddings-retrieve.test.ts`):

```ts
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/noydb.js'
// ... paste memory() + enc() helpers from embeddings-retrieve.test.ts ...

interface Doc { id: string; text: string }

async function seed() {
  const db = await createNoydb({ store: memory(), masterKey: 'k'.repeat(32) })
  const v = await db.vault('v')
  const c = await v.collection<Doc>('docs', {
    textIndexes: ['text'],
    embeddings: enc(16),
  })
  await c.put('d1', { id: 'd1', text: 'annual financial report revenue' })
  await c.put('d2', { id: 'd2', text: 'quarterly revenue summary' })
  await c.put('d3', { id: 'd3', text: 'office supplies invoice' })
  return c
}

describe("retrieve({ mode: 'hybrid' })", () => {
  it('returns fused ranked hits with 1-based rank', async () => {
    const c = await seed()
    const hits = await c.retrieve('revenue', { mode: 'hybrid' })
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].rank).toBe(1)
    expect(hits.map(h => h.rank)).toEqual(hits.map((_, i) => i + 1))
  })

  it('a doc strong in both lexical and semantic outranks one strong in only one', async () => {
    const c = await seed()
    const hits = await c.retrieve('revenue report', { mode: 'hybrid' })
    // d1 contains both 'revenue' and 'report' (lexical) and is close semantically
    expect(hits[0].id).toBe('d1')
  })

  it('honors limit', async () => {
    const c = await seed()
    const hits = await c.retrieve('revenue', { mode: 'hybrid', limit: 1 })
    expect(hits.length).toBe(1)
  })

  it('throws when the collection has no embeddings', async () => {
    const db = await createNoydb({ store: memory(), masterKey: 'k'.repeat(32) })
    const v = await db.vault('v')
    const c = await v.collection<Doc>('docs', { textIndexes: ['text'] })
    await c.put('d1', { id: 'd1', text: 'revenue' })
    await expect(c.retrieve('revenue', { mode: 'hybrid' })).rejects.toThrow(/hybrid.*embeddings/)
  })
})
```

> NOTE to implementer: confirm the `textIndexes` / `embeddings` collection-option names against `embeddings-retrieve.test.ts` and an L1 retrieve test; use whatever those tests use (the option that enables `retrieve()` lexical + the `embeddings` descriptor).

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run __tests__/retrieve-hybrid.test.ts`
Expected: FAIL — hybrid mode not handled (falls through to lexical or type error on `'hybrid'`).

- [ ] **Step 3: Add `'hybrid'` to the mode union**

In `packages/hub/src/search/retrieve-types.ts`, change:

```ts
  readonly mode?: 'lexical' | 'semantic'
```
to:
```ts
  /** #308 — retrieval strategy; defaults to 'lexical'. 'hybrid' fuses lexical+semantic (L3). */
  readonly mode?: 'lexical' | 'semantic' | 'hybrid'
```

- [ ] **Step 4: Refactor `retrieve()` dispatch + add `retrieveHybrid`**

In `packages/hub/src/collection.ts`: add the import at the top with the other `./search/...` imports:

```ts
import { fuseRetrieval } from './search/index.js'
```

Rename the current `retrieve()` body: keep the method `retrieve()` as a thin dispatcher and move the existing lexical body into a new private `retrieveLexical`. Concretely, change the current method

```ts
  async retrieve(query: string, opts: RetrieveOptions = {}): Promise<RetrieveHit<T>[]> {
    if (opts.mode === 'semantic') return this.retrieveSemantic(query, opts)
    if (!this.searchIndexStore) {
      // ... existing lexical body ...
    }
    // ... existing lexical body returns hits.map(...) ...
  }
```

into:

```ts
  /** #308 — retrieval. mode: 'lexical' (default) | 'semantic' (L2) | 'hybrid' (L3). */
  async retrieve(query: string, opts: RetrieveOptions = {}): Promise<RetrieveHit<T>[]> {
    if (opts.mode === 'semantic') return this.retrieveSemantic(query, opts)
    if (opts.mode === 'hybrid') return this.retrieveHybrid(query, opts)
    return this.retrieveLexical(query, opts)
  }

  /** #308 L1 — client-side lexical retrieval; ranked { id, score, field, snippet, locale? }. */
  private async retrieveLexical(query: string, opts: RetrieveOptions): Promise<RetrieveHit<T>[]> {
    if (!this.searchIndexStore) {
      throw new Error(`Collection "${this.name}": retrieve() requires a textIndexes config.`)
    }
    // ... EXISTING lexical body verbatim (the ensureHydrated/ensureBuilt/index.query/hits.map block) ...
  }

  /** #308 L3 — hybrid: fuse lexical (L1) + semantic (L2) by RRF. Requires embeddings. */
  private async retrieveHybrid(query: string, opts: RetrieveOptions): Promise<RetrieveHit<T>[]> {
    if (!this.embeddings) {
      throw new Error(`Collection "${this.name}": retrieve({mode:'hybrid'}) requires an embeddings config.`)
    }
    const [lex, sem] = await Promise.all([
      this.retrieveLexical(query, opts),
      this.retrieveSemantic(query, opts),
    ])
    return fuseRetrieval([lex, sem], opts.limit !== undefined ? { limit: opts.limit } : {})
  }
```

> The lexical body (the `if (this.lazy)`/`ensureHydrated`/`resolveDictLabelMaps`/`ensureBuilt`/`index.query`/`hits.map(...)` block) moves verbatim into `retrieveLexical` — do not rewrite it. `retrieveLexical` and `retrieveSemantic` ignore `opts.within` (the `within` post-filter lands in Task 4 on the `retrieve()` dispatcher); passing the full `opts` through is harmless. Both sub-retrievals use the same `opts.limit` for their candidate lists, then `fuseRetrieval` re-limits.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run __tests__/retrieve-hybrid.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Typecheck + eslint + architecture + no regressions on L1/L2 retrieve**

Run: `npx tsc --noEmit && npx eslint src/collection.ts src/search/retrieve-types.ts && npx vitest run __tests__/embeddings-retrieve.test.ts __tests__/retrieve.test.ts && node scripts/check-architecture.mjs`
Expected: tsc clean; eslint clean; existing lexical + semantic retrieve tests still PASS; architecture OK — if `collection.ts` exceeds 5255, raise the budget at `scripts/check-architecture.mjs:496` to the reported count + 5.

> NOTE: confirm the L1 lexical test filename (it may be `retrieve.test.ts`, `retrieve-l1.test.ts`, etc.) via `ls __tests__ | grep retrieve` and run whatever exists.

- [ ] **Step 7: Commit**

```bash
git add packages/hub/src/collection.ts packages/hub/src/search/retrieve-types.ts packages/hub/__tests__/retrieve-hybrid.test.ts scripts/check-architecture.mjs
git commit -m "feat(search): #308 L3 — retrieve(mode:'hybrid') fusing lexical+semantic"
```

---

### Task 4: `within: Query<T>` payload filter (`retrieve ∩ where`)

**Files:**
- Modify: `packages/hub/src/search/retrieve-types.ts` (make `RetrieveOptions` generic; add `within?: Query<T>`)
- Modify: `packages/hub/src/collection.ts` (apply `within` in the `retrieve()` dispatcher; update method signatures to `RetrieveOptions<T>`)
- Test: `packages/hub/__tests__/retrieve-within.test.ts`

**Interfaces:**
- Consumes: `Query<T>._idArray()` (Task 2); the `retrieve()` dispatcher (Task 3).
- Produces: `RetrieveOptions<T = unknown>` with `readonly within?: Query<T>`; `retrieve(q, { within })` intersects hits with `within._idArray()` across ALL modes and re-stamps `rank`.

- [ ] **Step 1: Write the failing test**

Create `packages/hub/__tests__/retrieve-within.test.ts` (reuse `memory()` + `enc()`):

```ts
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/noydb.js'
// ... paste memory() + enc() helpers ...

interface Doc { id: string; text: string; status: string }

async function seed() {
  const db = await createNoydb({ store: memory(), masterKey: 'k'.repeat(32) })
  const v = await db.vault('v')
  const c = await v.collection<Doc>('docs', { textIndexes: ['text'], embeddings: enc(16) })
  await c.put('d1', { id: 'd1', text: 'revenue report', status: 'open' })
  await c.put('d2', { id: 'd2', text: 'revenue summary', status: 'closed' })
  await c.put('d3', { id: 'd3', text: 'revenue forecast', status: 'open' })
  return c
}

describe('retrieve({ within })  — retrieve ∩ where', () => {
  it('lexical ∩ where keeps only ids matching the query and re-ranks', async () => {
    const c = await seed()
    const hits = await c.retrieve('revenue', { within: c.query().where('status', '==', 'open') })
    expect(new Set(hits.map(h => h.id))).toEqual(new Set(['d1', 'd3']))
    expect(hits.map(h => h.rank)).toEqual(hits.map((_, i) => i + 1))
  })

  it('hybrid ∩ where filters the fused list', async () => {
    const c = await seed()
    const hits = await c.retrieve('revenue', { mode: 'hybrid', within: c.query().where('status', '==', 'closed') })
    expect(new Set(hits.map(h => h.id))).toEqual(new Set(['d2']))
  })

  it('semantic ∩ where filters the cosine list', async () => {
    const c = await seed()
    const hits = await c.retrieve('revenue', { mode: 'semantic', within: c.query().where('status', '==', 'open') })
    expect(hits.every(h => h.id === 'd1' || h.id === 'd3')).toBe(true)
  })

  it('an empty within result yields no hits', async () => {
    const c = await seed()
    const hits = await c.retrieve('revenue', { within: c.query().where('status', '==', 'void') })
    expect(hits).toEqual([])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run __tests__/retrieve-within.test.ts`
Expected: FAIL — `within` not a known option (type error) / not applied.

- [ ] **Step 3: Make `RetrieveOptions` generic + add `within`**

In `packages/hub/src/search/retrieve-types.ts`: add the import at the top:

```ts
import type { Query } from '../query/builder.js'
```

Change `export interface RetrieveOptions {` to `export interface RetrieveOptions<T = unknown> {` and add the field:

```ts
  /** #308 L3 — intersect hits with a structured query (retrieve ∩ where). Eager-mode only. */
  readonly within?: Query<T>
```

- [ ] **Step 4: Apply `within` in the dispatcher + update signatures**

In `packages/hub/src/collection.ts`, update the `retrieve()` dispatcher (Task 3) to apply `within` uniformly, and widen the `opts` types to `RetrieveOptions<T>`:

```ts
  async retrieve(query: string, opts: RetrieveOptions<T> = {}): Promise<RetrieveHit<T>[]> {
    const hits =
      opts.mode === 'semantic' ? await this.retrieveSemantic(query, opts)
      : opts.mode === 'hybrid' ? await this.retrieveHybrid(query, opts)
      : await this.retrieveLexical(query, opts)
    return opts.within ? this.applyWithin(hits, opts.within) : hits
  }

  /** #308 L3 — keep only hits whose id matches the structured query, re-rank 1-based. */
  private applyWithin(hits: RetrieveHit<T>[], within: Query<T>): RetrieveHit<T>[] {
    const ids = new Set(within._idArray())
    return hits.filter(h => ids.has(h.id)).map((h, i) => ({ ...h, rank: i + 1 }))
  }
```

Change the `opts` parameter type on `retrieveLexical`, `retrieveSemantic`, and `retrieveHybrid` from `RetrieveOptions` to `RetrieveOptions<T>`. Add the `Query` type import if not already present (collection.ts already imports from `./query/...`; add `import type { Query } from './query/builder.js'` if missing).

> `applyWithin` runs against the in-memory cache (via `_idArray`) — no store access — so it adds zero leakage and composes with every mode.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run __tests__/retrieve-within.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Full hub suite + typecheck + eslint + architecture**

Run: `npx tsc --noEmit && npx eslint src && npx vitest run && node scripts/check-architecture.mjs`
Expected: tsc clean; eslint clean; FULL suite green (existing count + the new L3 tests); architecture OK (bump `collection.ts` budget at `scripts/check-architecture.mjs:496` if needed).

- [ ] **Step 7: Commit**

```bash
git add packages/hub/src/search/retrieve-types.ts packages/hub/src/collection.ts packages/hub/__tests__/retrieve-within.test.ts scripts/check-architecture.mjs
git commit -m "feat(search): #308 L3 — within: Query payload filter (retrieve ∩ where)"
```

---

### Task 5: features.yaml + subsystem doc + showcase + leakage test

**Files:**
- Modify: `features.yaml` (extend the hybrid/fusion capability + spec ref)
- Modify/Create: `docs/subsystems/search.md` (or the embeddings doc) — hybrid section
- Create: `showcases/src/125-hybrid-retrieve.showcase.test.ts`
- Test (leakage): add a case to `packages/hub/__tests__/retrieve-within.test.ts` or a new `retrieve-hybrid-leakage.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–4 through the package entry `@noy-db/hub`.

- [ ] **Step 1: Leakage test (write first, must fail if a store write sneaks in)**

Add to a new `packages/hub/__tests__/retrieve-hybrid-leakage.test.ts` a wrapped-store test: wrap `memory()` so every `put(c,col,id,...)` records `${col}/${id}` into a `Set`; seed docs + embeddings (this WILL write `_vec/<id>` at put time — that is L2, expected); snapshot the write-set AFTER seeding; then run `retrieve('revenue', { mode:'hybrid', within: c.query().where('status','==','open') })`; assert the write-set is UNCHANGED by the retrieve call (L3 writes nothing).

```ts
it('hybrid retrieve with within writes no new store keys', async () => {
  const writes = new Set<string>()
  const base = memory()
  const wrapped: NoydbStore = { ...base, async put(c, col, id, env, ev) { writes.add(`${col}/${id}`); return base.put(c, col, id, env, ev) } }
  const db = await createNoydb({ store: wrapped, masterKey: 'k'.repeat(32) })
  const v = await db.vault('v')
  const c = await v.collection<Doc>('docs', { textIndexes: ['text'], embeddings: enc(16) })
  await c.put('d1', { id: 'd1', text: 'revenue report', status: 'open' })
  await c.put('d2', { id: 'd2', text: 'revenue summary', status: 'closed' })
  const before = new Set(writes)
  await c.retrieve('revenue', { mode: 'hybrid', within: c.query().where('status', '==', 'open') })
  expect(new Set(writes)).toEqual(before)
})
```

> NOTE: `NoydbStore` is imported as a type from `../src/types.js` (see embeddings-retrieve.test.ts). Adjust the `put` wrapper signature to match the real `NoydbStore.put` arity.

Run: `npx vitest run __tests__/retrieve-hybrid-leakage.test.ts` → expect PASS (it should already pass given the design; if it FAILS, a store write leaked into the retrieve path — STOP and investigate before touching docs).

- [ ] **Step 2: features.yaml**

Find the `search-index` and/or `vector-search` feature node (`grep -n "vector-search\|search-index" features.yaml`). Extend the relevant node's capabilities/invariants with the hybrid mode + the `fuseRetrieval` federation primitive, and add the L3 spec ref `docs/superpowers/specs/2026-06-23-ai-retrieval-l3-hybrid-design.md`. Correct any invariant that asserts retrieval is single-mode. Then:

Run (repo root): `node scripts/validate-features.mjs`
Expected: OK (no dangling refs).

- [ ] **Step 3: Subsystem doc**

In `docs/subsystems/search.md` (or `embeddings.md` — whichever holds the retrieve docs; grep for `mode:'semantic'`), add a "Hybrid retrieval (L3)" section documenting: `mode:'hybrid'` (fuses lexical+semantic, requires embeddings, throws otherwise); RRF with `k=60` and that the fused `score` is an RRF score (not BM25/cosine); `within: Query<T>` (`retrieve ∩ where`, eager-mode only, reuses the structured query engine via `_idArray`); the `@noy-db/hub/kernel` `fuseRetrieval` export and the federation seam (klum fans out per-vault `retrieve()`, qualifies ids, calls `fuseRetrieval`); and the L3 line of the L0–L4 epic map.

- [ ] **Step 4: Showcase**

Create `showcases/src/125-hybrid-retrieve.showcase.test.ts` mirroring `124-semantic-retrieve.showcase.test.ts`'s structure (same deterministic stub encoder, imports from `@noy-db/hub`). Demonstrate: (a) a mixed query where `mode:'hybrid'` surfaces a doc that lexical-only and semantic-only each rank lower; (b) a `within`-filtered hybrid retrieve. Include the `* Spec mapping` header block pointing at `features.yaml -> features -> vector-search` (or the chosen node).

Run (repo root): `cd showcases && npm run typecheck && npx vitest run src/125-hybrid-retrieve.showcase.test.ts`
Expected: typecheck clean (this exercises the package-entry exports — the L2 export-gap guard); showcase PASS.

- [ ] **Step 5: Full gate**

Run (repo root):
```bash
cd packages/hub && npx tsc --noEmit && npx eslint src && npx vitest run && cd ../.. && node scripts/check-architecture.mjs && node scripts/validate-features.mjs && cd showcases && npm run typecheck
```
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add features.yaml docs/subsystems showcases/src/125-hybrid-retrieve.showcase.test.ts packages/hub/__tests__/retrieve-hybrid-leakage.test.ts
git commit -m "docs(search): #308 L3 — hybrid/fuseRetrieval features.yaml + subsystem doc + showcase 125 + leakage test"
```

---

## Self-Review

**Spec coverage:**
- `fuseRetrieval` RRF reducer + arity-generic + kernel export → Task 1. ✅
- `mode:'hybrid'` (run lexical+semantic, fuse) → Task 3. ✅
- Hybrid requires embeddings (throw) → Task 3 (test + guard). ✅
- `within: Query<T>` (`retrieve ∩ where`, all modes, re-rank) → Task 4; id mechanism (`_idArray` + `snapshotEntries`, reference identity, money-field correctness, throw on raw source) → Task 2. ✅
- Export `fuseRetrieval`/`FuseOptions` from entry + kernel; `RetrieveHit`/`RetrieveOptions` from kernel → Task 1. ✅
- features.yaml + subsystem doc + showcase → Task 5. ✅
- Zero added store leakage → Task 5 wrapped-store test. ✅
- Merged-hit field policy (lexical over `'(vector)'`; recover record) → Task 1 tests + `mergePresentation`. ✅
- RRF score documented as RRF (not BM25/cosine) → Task 1 test + Task 5 doc. ✅
- Tree-shaking / kernel ceilings → Global Constraints + per-task `check-architecture`. ✅

**Placeholder scan:** No "TBD"/"handle edge cases"/"similar to Task N". Each code step shows the code. The two implementer NOTEs ask for confirmation of EXISTING option names (`money`, `textIndexes`, `embeddings`, test filenames) against the repo — these are verification asks, not unfilled blanks; the contract (the assertion) is fully specified.

**Type consistency:** `fuseRetrieval<T>(lists, opts?)`/`FuseOptions` identical across Task 1 def and Task 3 use. `Query<T>._idArray(): string[]` identical across Task 2 def and Task 4 use. `RetrieveOptions<T = unknown>` (generic added in Task 4) is back-compatible — Task 3 uses `RetrieveOptions` before the generic exists, and Task 4 widens all three private helpers + the dispatcher to `RetrieveOptions<T>` in the same task, so no signature is left half-migrated. `snapshotEntries?()` shape matches between `QuerySource<T>` (Task 2 def) and the collection source literal (Task 2 use) and `_idArray`'s consumption.
