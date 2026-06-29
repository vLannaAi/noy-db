# AI Retrieval L1 — Client-side Lexical Index Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A client-side, session-rebuilt, in-memory inverted index with an i18n-aware tokenizer, exposed as `collection.retrieve(query, opts)` returning ranked `{ id, score, field, snippet, locale? }` — minimal-disclosure retrieval for an AI agent (or a human search box) without a per-query full scan and without ingesting the whole vault into context.

**Architecture:** All engine code lives in the tree-shakeable `packages/hub/src/search/` subsystem behind an `IndexStore` seam (memory impl now; opaque-blob persistence later). The collection build step maps each configured field to uniform locale-tagged text "docs" (`IndexDoc`) — inline for string/i18nText, `table`/`entries()` for dictKey, `listSlots` for blob — and feeds the pure `InvertedIndex`. Pure client-side, in-memory: **zero added store leakage** (the L0 guarantee).

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), vitest (`vitest run` from `packages/hub`), `Intl.Segmenter` (standard, hub-portable), reusing the shipped BM25 from `src/search/scan.ts`.

**Spec:** `docs/superpowers/specs/2026-06-22-ai-retrieval-l1-lexical-index-design.md`

## Global Constraints

- **Hub-portable:** no Node-only imports in `packages/hub/src/**` (architecture check `hub-portable`). `Intl.Segmenter` is standard ECMAScript — allowed.
- **Tree-shakeable:** all new code under `src/search/`, reached only when `retrieve()`/`search()` is called. Non-search bundles pay nothing.
- **Kernel ceiling:** `packages/hub/src/collection.ts` ≤ **4922** lines (`scripts/check-architecture.mjs:493`; currently 4911 → 11 free). Keep logic in `src/search/`; raise the ceiling only if the thin call-site forces it (Slice 9).
- **Zero store leakage:** L1 writes nothing to the store and changes no store read pattern beyond the normal hydrate. A leakage test asserts this (Slice 5).
- **Commit messages:** no Claude/AI attribution (project rule). Use the exact messages given.
- **eager-only:** like the shipped `search()`, `retrieve()` requires eager mode (`prefetch: true`); throw a clear error in lazy mode.

---

## Task 1: i18n segmenter tokenizer with offsets

**Files:**
- Create: `packages/hub/src/search/segment.ts`
- Test: `packages/hub/__tests__/search-segment.test.ts`

**Interfaces:**
- Consumes: `Tokenizer` type from `./tokenize.js` (`(text: string) => string[]`).
- Produces: `interface Token { readonly term: string; readonly offset: number }`; `segmentTokens(text: string): Token[]`; `segmentTokenizer: Tokenizer`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/hub/__tests__/search-segment.test.ts
import { describe, it, expect } from 'vitest'
import { segmentTokens, segmentTokenizer } from '../src/search/segment.js'

describe('segmentTokenizer (#308 L1)', () => {
  it('segments Latin words and lowercases + NFKC-normalizes the term', () => {
    expect(segmentTokenizer('Overdue Invoice')).toEqual(['overdue', 'invoice'])
  })

  it('segments Thai (no inter-word spaces) into multiple words', () => {
    // 'ใบแจ้งหนี้' = invoice; 'ค้างชำระ' = overdue — should NOT collapse to one token
    const toks = segmentTokenizer('ใบแจ้งหนี้ค้างชำระ')
    expect(toks.length).toBeGreaterThan(1)
    expect(toks.join('')).toContain('ใบแจ้งหนี้')
  })

  it('keeps offsets into the ORIGINAL text (for snippets)', () => {
    const t = segmentTokens('Mr Somchai')
    expect(t[0]).toEqual({ term: 'mr', offset: 0 })
    expect(t[1]!.term).toBe('somchai')
    expect('Mr Somchai'.slice(t[1]!.offset, t[1]!.offset + 7)).toBe('Somchai')
  })

  it('drops whitespace/punctuation (non-word segments)', () => {
    expect(segmentTokenizer('a, b.')).toEqual(['a', 'b'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/hub && npx vitest run __tests__/search-segment.test.ts`
Expected: FAIL — `../src/search/segment.js` does not exist.

- [ ] **Step 3: Implement**

```ts
// packages/hub/src/search/segment.ts
/**
 * i18n word tokenizer for the L1 lexical index (#308). Uses Intl.Segmenter
 * (standard ECMAScript — hub-portable) to dictionary-segment Thai/Lao/Khmer/CJK,
 * which the word-run `tokenize` cannot. Terms are matched in NFKC-lowercased form;
 * offsets index the ORIGINAL text so snippets slice the user's text.
 */
import type { Tokenizer } from './tokenize.js'

const SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'word' })

export interface Token {
  readonly term: string
  readonly offset: number
}

/** Word-like tokens with NFKC-lowercased terms + original-text char offsets. */
export const segmentTokens = (text: string): Token[] => {
  const out: Token[] = []
  if (!text) return out
  for (const s of SEGMENTER.segment(text)) {
    if (s.isWordLike) out.push({ term: s.segment.normalize('NFKC').toLowerCase(), offset: s.index })
  }
  return out
}

/** Term-only tokenizer (the public `Tokenizer` shape) — for queries. */
export const segmentTokenizer: Tokenizer = (text: string): string[] =>
  segmentTokens(text).map((t) => t.term)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/hub && npx vitest run __tests__/search-segment.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/search/segment.ts packages/hub/__tests__/search-segment.test.ts
git commit -m "feat(search): i18n segmenter tokenizer with offsets (#308 L1)"
```

---

## Task 2: InvertedIndex — build + multi-field BM25 query

**Files:**
- Create: `packages/hub/src/search/inverted-index.ts`
- Test: `packages/hub/__tests__/search-inverted-index.test.ts`

**Interfaces:**
- Consumes: `segmentTokens` from `./segment.js`; `segmentTokenizer` for queries; BM25 constants mirror `scan.ts` (`K1=1.2`, `B=0.75`).
- Produces:
  - `interface IndexDoc { readonly id: string; readonly fields: ReadonlyArray<{ readonly field: string; readonly locale?: string; readonly text: string }> }`
  - `interface IndexHit { readonly id: string; readonly score: number; readonly field: string; readonly locale?: string; readonly text: string; readonly offset: number }`
  - `interface QueryOptions { readonly limit?: number; readonly match?: 'any' | 'all'; readonly prefix?: boolean }`
  - `class InvertedIndex { static build(docs: ReadonlyArray<IndexDoc>): InvertedIndex; query(query: string, opts?: QueryOptions): IndexHit[] }`

The `IndexDoc` shape is the seam every field type feeds (string=1 entry; i18n/dictKey=1 per locale; blob=1 per filename). Per (record,field,locale) is one BM25 "document"; a record's score = its **max** field-doc score (the winning doc supplies `field`/`locale`/`offset` for the snippet).

- [ ] **Step 1: Write the failing test**

```ts
// packages/hub/__tests__/search-inverted-index.test.ts
import { describe, it, expect } from 'vitest'
import { InvertedIndex, type IndexDoc } from '../src/search/inverted-index.js'

const docs: IndexDoc[] = [
  { id: 'a', fields: [{ field: 'desc', text: 'overdue invoice for TCM' }] },
  { id: 'b', fields: [{ field: 'desc', text: 'paid invoice' }, { field: 'notes', text: 'TCM building rent' }] },
  { id: 'c', fields: [{ field: 'desc', text: 'office supplies' }] },
]

describe('InvertedIndex (#308 L1)', () => {
  it('ranks docs containing the query term, best-field score', () => {
    const idx = InvertedIndex.build(docs)
    const hits = idx.query('invoice')
    expect(hits.map((h) => h.id).sort()).toEqual(['a', 'b'])
    expect(hits.every((h) => h.field === 'desc')).toBe(true)
  })

  it('searches across multiple fields and reports the winning field + offset', () => {
    const idx = InvertedIndex.build(docs)
    const hits = idx.query('TCM')
    const b = hits.find((h) => h.id === 'b')!
    expect(b.field).toBe('notes')
    expect(b.text.slice(b.offset, b.offset + 3)).toBe('TCM')
  })

  it("match:'all' requires every term; 'any' is OR", () => {
    const idx = InvertedIndex.build(docs)
    expect(idx.query('overdue invoice', { match: 'all' }).map((h) => h.id)).toEqual(['a'])
    expect(idx.query('overdue paid', { match: 'any' }).map((h) => h.id).sort()).toEqual(['a', 'b'])
  })

  it('prefix matches the last query term as a prefix (typeahead)', () => {
    const idx = InvertedIndex.build(docs)
    expect(idx.query('inv', { prefix: true }).map((h) => h.id).sort()).toEqual(['a', 'b'])
  })

  it('limit caps results', () => {
    const idx = InvertedIndex.build(docs)
    expect(idx.query('invoice', { limit: 1 }).length).toBe(1)
  })

  it('one hit per record (deduped to the best field)', () => {
    const idx = InvertedIndex.build([{ id: 'x', fields: [{ field: 'desc', text: 'TCM' }, { field: 'notes', text: 'TCM TCM' }] }])
    const hits = idx.query('TCM')
    expect(hits.length).toBe(1)
    expect(hits[0]!.field).toBe('notes') // higher tf
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/hub && npx vitest run __tests__/search-inverted-index.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/hub/src/search/inverted-index.ts
/**
 * In-memory inverted index for the L1 lexical retrieval layer (#308). Built
 * client-side from already-decrypted records; nothing touches the store. BM25
 * mirrors src/search/scan.ts; multi-field with max-field combination so a record
 * ranks by its strongest field, which also supplies the snippet location.
 */
import { segmentTokens, segmentTokenizer } from './segment.js'

const K1 = 1.2
const B = 0.75

export interface IndexDoc {
  readonly id: string
  readonly fields: ReadonlyArray<{ readonly field: string; readonly locale?: string; readonly text: string }>
}

export interface IndexHit {
  readonly id: string
  readonly score: number
  readonly field: string
  readonly locale?: string
  readonly text: string
  readonly offset: number
}

export interface QueryOptions {
  readonly limit?: number
  readonly match?: 'any' | 'all'
  readonly prefix?: boolean
}

interface Doc {
  id: string
  field: string
  locale?: string
  text: string
  len: number
  tf: Map<string, number>
  firstOffset: Map<string, number>
}

export class InvertedIndex {
  // per field: df (term -> #docs), N (#docs), totalLen
  private readonly fieldStats = new Map<string, { df: Map<string, number>; n: number; totalLen: number }>()
  private readonly docs: Doc[] = []

  static build(docs: ReadonlyArray<IndexDoc>): InvertedIndex {
    const idx = new InvertedIndex()
    for (const d of docs) {
      for (const f of d.fields) {
        const tokens = segmentTokens(f.text)
        const tf = new Map<string, number>()
        const firstOffset = new Map<string, number>()
        for (const t of tokens) {
          tf.set(t.term, (tf.get(t.term) ?? 0) + 1)
          if (!firstOffset.has(t.term)) firstOffset.set(t.term, t.offset)
        }
        const doc: Doc = { id: d.id, field: f.field, locale: f.locale, text: f.text, len: tokens.length, tf, firstOffset }
        idx.docs.push(doc)
        let s = idx.fieldStats.get(f.field)
        if (!s) { s = { df: new Map(), n: 0, totalLen: 0 }; idx.fieldStats.set(f.field, s) }
        s.n += 1
        s.totalLen += doc.len
        for (const term of tf.keys()) s.df.set(term, (s.df.get(term) ?? 0) + 1)
      }
    }
    return idx
  }

  query(query: string, opts: QueryOptions = {}): IndexHit[] {
    const terms = segmentTokenizer(query)
    if (terms.length === 0) return []
    const usePrefix = opts.prefix ?? false
    const exact = usePrefix ? terms.slice(0, -1) : terms
    const prefix = usePrefix ? terms[terms.length - 1] : undefined
    const match = opts.match ?? 'any'
    const required = exact.length + (prefix !== undefined ? 1 : 0)

    // best (max-score) doc per record
    const best = new Map<string, IndexHit>()
    for (const doc of this.docs) {
      const stats = this.fieldStats.get(doc.field)!
      const avgdl = stats.totalLen / stats.n || 1
      let score = 0
      let matchedCount = 0
      let snippetOffset = -1

      const scoreTerm = (tf: number, df: number, offset: number): void => {
        if (tf <= 0) return
        matchedCount += 1
        if (snippetOffset < 0 && offset >= 0) snippetOffset = offset
        const idf = Math.log(1 + (stats.n - df + 0.5) / (df + 0.5))
        const denom = tf + K1 * (1 - B + B * (doc.len / avgdl))
        score += idf * ((tf * (K1 + 1)) / (denom || 1))
      }

      for (const qt of exact) scoreTerm(doc.tf.get(qt) ?? 0, stats.df.get(qt) ?? 0, doc.firstOffset.get(qt) ?? -1)

      if (prefix !== undefined) {
        let ptf = 0
        let poff = -1
        let pdf = 0
        for (const [term, c] of doc.tf) {
          if (term.startsWith(prefix)) {
            ptf += c
            if (poff < 0) poff = doc.firstOffset.get(term) ?? -1
          }
        }
        if (ptf > 0) {
          // df for the prefix: docs in this field with any term starting with it
          for (const term of stats.df.keys()) if (term.startsWith(prefix)) pdf += stats.df.get(term)!
          scoreTerm(ptf, pdf || 1, poff)
        }
      }

      if (matchedCount === 0) continue
      if (match === 'all' && matchedCount < required) continue

      const hit: IndexHit = {
        id: doc.id, score, field: doc.field, text: doc.text,
        offset: snippetOffset < 0 ? 0 : snippetOffset,
        ...(doc.locale !== undefined ? { locale: doc.locale } : {}),
      }
      const prev = best.get(doc.id)
      if (!prev || hit.score > prev.score) best.set(doc.id, hit)
    }

    const results = [...best.values()].sort((a, b) => b.score - a.score)
    return opts.limit !== undefined ? results.slice(0, opts.limit) : results
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/hub && npx vitest run __tests__/search-inverted-index.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/search/inverted-index.ts packages/hub/__tests__/search-inverted-index.test.ts
git commit -m "feat(search): in-memory InvertedIndex with multi-field max-field BM25 (#308 L1)"
```

---

## Task 3: Snippet extraction

**Files:**
- Create: `packages/hub/src/search/snippet.ts`
- Test: `packages/hub/__tests__/search-snippet.test.ts`

**Interfaces:**
- Produces: `extractSnippet(text: string, offset: number, window?: number): string` (default window 80). Returns a char-window centered on `offset`, trimmed to word-ish bounds, with `…` markers when truncated. Unicode-safe via `Array.from`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/hub/__tests__/search-snippet.test.ts
import { describe, it, expect } from 'vitest'
import { extractSnippet } from '../src/search/snippet.js'

describe('extractSnippet (#308 L1)', () => {
  it('returns the whole text when shorter than the window', () => {
    expect(extractSnippet('short text', 0, 80)).toBe('short text')
  })

  it('windows around the offset and marks truncation', () => {
    const text = 'x'.repeat(200) + 'TARGET' + 'y'.repeat(200)
    const snip = extractSnippet(text, 200, 20)
    expect(snip).toContain('TARGET')
    expect(snip.startsWith('…')).toBe(true)
    expect(snip.endsWith('…')).toBe(true)
    expect(Array.from(snip).length).toBeLessThanOrEqual(20 + 6) // window + a few chars + ellipses
  })

  it('is unicode-safe (does not split Thai/emoji code points)', () => {
    const text = 'ก'.repeat(50) + 'เป้าหมาย' + 'ข'.repeat(50)
    const snip = extractSnippet(text, 50, 16)
    expect(snip).toContain('เป้าหมาย')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/hub && npx vitest run __tests__/search-snippet.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/hub/src/search/snippet.ts
/**
 * Minimal-disclosure snippet: a char-window around a match offset (#308 L1).
 * Unicode-safe (operates on code points). `…` marks each truncated end.
 */
export function extractSnippet(text: string, offset: number, window = 80): string {
  const chars = Array.from(text)
  if (chars.length <= window) return text
  // offset is a UTF-16 index into `text`; map to a code-point index.
  const cpOffset = Array.from(text.slice(0, Math.max(0, offset))).length
  const half = Math.floor(window / 2)
  let start = Math.max(0, cpOffset - half)
  let end = Math.min(chars.length, start + window)
  start = Math.max(0, end - window)
  const body = chars.slice(start, end).join('')
  return `${start > 0 ? '…' : ''}${body}${end < chars.length ? '…' : ''}`
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/hub && npx vitest run __tests__/search-snippet.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/search/snippet.ts packages/hub/__tests__/search-snippet.test.ts
git commit -m "feat(search): unicode-safe snippet extraction (#308 L1)"
```

---

## Task 4: IndexStore seam + MemoryIndexStore

**Files:**
- Create: `packages/hub/src/search/index-store.ts`
- Test: `packages/hub/__tests__/search-index-store.test.ts`

**Interfaces:**
- Consumes: `InvertedIndex`, `IndexDoc` from `./inverted-index.js`.
- Produces:
  - `interface IndexStore { getOrBuild(build: () => ReadonlyArray<IndexDoc>): InvertedIndex; markDirty(): void; readonly built: boolean }`
  - `class MemoryIndexStore implements IndexStore`

`getOrBuild` builds lazily and caches; `markDirty()` drops the cache so the next `getOrBuild` rebuilds. The opaque-blob backend (L1.5) will implement the same interface.

- [ ] **Step 1: Write the failing test**

```ts
// packages/hub/__tests__/search-index-store.test.ts
import { describe, it, expect } from 'vitest'
import { MemoryIndexStore } from '../src/search/index-store.js'
import type { IndexDoc } from '../src/search/inverted-index.js'

const docs: IndexDoc[] = [{ id: 'a', fields: [{ field: 'desc', text: 'invoice' }] }]

describe('MemoryIndexStore (#308 L1)', () => {
  it('builds once and caches (build fn not called again)', () => {
    const store = new MemoryIndexStore()
    let calls = 0
    const build = () => { calls++; return docs }
    const i1 = store.getOrBuild(build)
    const i2 = store.getOrBuild(build)
    expect(calls).toBe(1)
    expect(i1).toBe(i2)
    expect(store.built).toBe(true)
  })

  it('markDirty forces a rebuild', () => {
    const store = new MemoryIndexStore()
    let calls = 0
    const build = () => { calls++; return docs }
    store.getOrBuild(build)
    store.markDirty()
    expect(store.built).toBe(false)
    store.getOrBuild(build)
    expect(calls).toBe(2)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/hub && npx vitest run __tests__/search-index-store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/hub/src/search/index-store.ts
/**
 * The index persistence seam (#308 L1). MemoryIndexStore is session-scoped and
 * lazy; an opaque-blob backend (L1.5) implements the same interface so the
 * collection call-site is unchanged.
 */
import { InvertedIndex, type IndexDoc } from './inverted-index.js'

export interface IndexStore {
  getOrBuild(build: () => ReadonlyArray<IndexDoc>): InvertedIndex
  markDirty(): void
  readonly built: boolean
}

export class MemoryIndexStore implements IndexStore {
  private index: InvertedIndex | undefined

  get built(): boolean { return this.index !== undefined }

  getOrBuild(build: () => ReadonlyArray<IndexDoc>): InvertedIndex {
    if (this.index === undefined) this.index = InvertedIndex.build(build())
    return this.index
  }

  markDirty(): void { this.index = undefined }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/hub && npx vitest run __tests__/search-index-store.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Update the barrel + commit**

Edit `packages/hub/src/search/index.ts` — append:

```ts
export { segmentTokens, segmentTokenizer, type Token } from './segment.js'
export { InvertedIndex, type IndexDoc, type IndexHit, type QueryOptions } from './inverted-index.js'
export { extractSnippet } from './snippet.js'
export { MemoryIndexStore, type IndexStore } from './index-store.js'
```

```bash
git add packages/hub/src/search/index-store.ts packages/hub/src/search/index.ts packages/hub/__tests__/search-index-store.test.ts
git commit -m "feat(search): IndexStore seam + MemoryIndexStore (#308 L1)"
```

---

## Task 5: `collection.retrieve()` — string fields end-to-end

**Files:**
- Modify: `packages/hub/src/collection.ts` (options interface ~681; a private field; the `search()` neighborhood ~2698; put/delete dirty poke)
- Create: `packages/hub/src/search/build-docs.ts` (maps a collection's records → `IndexDoc[]`; string fields only in this task)
- Test: `packages/hub/__tests__/search-retrieve.test.ts`

**Interfaces:**
- Consumes: `MemoryIndexStore`, `IndexDoc`, `IndexHit`, `extractSnippet`, `getAtPath` (`src/i18n/core.js:462`, `(obj, path) => unknown[]`), `stripI18nFilled`.
- Produces (on `Collection`):
  - config option `textIndexes?: readonly string[]`, `warmIndexOnOpen?: boolean`
  - `interface RetrieveOptions { limit?: number; match?: 'any'|'all'; prefix?: boolean; snippetWindow?: number; fields?: readonly string[]; includeRecord?: boolean }`
  - `interface RetrieveHit<T> { id: string; score: number; field: string; snippet: string; locale?: string; record?: T }`
  - `retrieve(query: string, opts?: RetrieveOptions): Promise<RetrieveHit<T>[]>`
  - `warmIndex(): Promise<void>`
  - `buildIndexDocs(record, textIndexes, fields?): IndexDoc['fields']` helper in `build-docs.ts` (string fields only here; i18n/dictKey/blob added in Tasks 6–8).

- [ ] **Step 1: Write the failing test**

```ts
// packages/hub/__tests__/search-retrieve.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { createNoydb } from '../src/noydb.js'
import { withI18n } from '../src/i18n/index.js'
import type { Noydb } from '../src/noydb.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/types.js'
import { ConflictError } from '../src/errors.js'

// paste the memory() helper verbatim from __tests__/i18n-script-put.test.ts lines 12-48

interface Inv { id: string; description: string; notes: string }
async function db(): Promise<Noydb> {
  return createNoydb({ store: memory(), user: 'a', secret: 'pw-retrieve', i18nStrategy: withI18n() })
}

describe('collection.retrieve() — string fields (#308 L1)', () => {
  let n: Noydb
  beforeEach(async () => { n = await db() })

  async function seed() {
    const v = await n.openVault('v')
    const c = v.collection<Inv>('inv', { textIndexes: ['description', 'notes'] })
    await c.put('a', { id: 'a', description: 'overdue invoice for TCM', notes: '' })
    await c.put('b', { id: 'b', description: 'paid invoice', notes: 'TCM building rent' })
    return c
  }

  it('retrieves across fields, ranked, with snippet + field, no record by default', async () => {
    const c = await seed()
    const hits = await c.retrieve('TCM')
    expect(hits.map((h) => h.id).sort()).toEqual(['a', 'b'])
    const b = hits.find((h) => h.id === 'b')!
    expect(b.field).toBe('notes')
    expect(b.snippet).toContain('TCM')
    expect(b.record).toBeUndefined()
  })

  it('includeRecord returns the decrypted record', async () => {
    const c = await seed()
    const [hit] = await c.retrieve('overdue', { includeRecord: true })
    expect(hit!.record!.id).toBe('a')
  })

  it('reflects writes (dirty-rebuild)', async () => {
    const c = await seed()
    await c.retrieve('invoice')
    await c.put('c', { id: 'c', description: 'new invoice', notes: '' })
    expect((await c.retrieve('invoice')).map((h) => h.id).sort()).toEqual(['a', 'b', 'c'])
  })

  it('warmIndex builds without a query', async () => {
    const c = await seed()
    await c.warmIndex()
    expect((await c.retrieve('invoice')).length).toBe(2)
  })

  it('writes NOTHING to the store during build+retrieve (zero leakage)', async () => {
    const store = memory()
    const writes: string[] = []
    const wrapped: NoydbStore = { ...store, async put(c, col, id, env, ev) { writes.push(`${c}/${col}/${id}`); return store.put(c, col, id, env, ev) } }
    const n2 = await createNoydb({ store: wrapped, user: 'a', secret: 'pw', i18nStrategy: withI18n() })
    const v = await n2.openVault('v')
    const c = v.collection<Inv>('inv', { textIndexes: ['description', 'notes'] })
    await c.put('a', { id: 'a', description: 'overdue invoice', notes: '' })
    const before = writes.length
    await c.warmIndex()
    await c.retrieve('invoice', { prefix: true })
    expect(writes.length).toBe(before) // build+retrieve wrote nothing
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/hub && npx vitest run __tests__/search-retrieve.test.ts`
Expected: FAIL — `retrieve`/`textIndexes`/`warmIndex` don't exist.

- [ ] **Step 3: Create the doc builder (string fields)**

```ts
// packages/hub/src/search/build-docs.ts
/**
 * Map a decrypted record's configured text fields → IndexDoc field entries
 * (#308 L1). String fields only here; i18nText / dictKey / blob add their own
 * expansion in later tasks. Uses getAtPath for nested/[]-wildcard paths.
 */
import { getAtPath } from '../i18n/core.js'
import type { IndexDoc } from './inverted-index.js'

type FieldEntry = IndexDoc['fields'][number]

export function buildStringFieldEntries(
  record: Record<string, unknown>,
  textIndexes: readonly string[],
  only?: readonly string[],
): FieldEntry[] {
  const fields = only ? textIndexes.filter((f) => only.includes(f)) : textIndexes
  const out: FieldEntry[] = []
  for (const field of fields) {
    for (const leaf of getAtPath(record, field)) {
      if (typeof leaf === 'string' && leaf !== '') out.push({ field, text: leaf })
    }
  }
  return out
}
```

- [ ] **Step 4: Wire the collection**

In `packages/hub/src/collection.ts`:

(a) Options interface (~line 681, beside `i18nFields`): add
```ts
  textIndexes?: readonly string[] | undefined
  warmIndexOnOpen?: boolean | undefined
```

(b) Private fields (near `i18nFields` ~314): add
```ts
  private readonly textIndexes: readonly string[] | undefined
  private readonly searchIndexStore: import('./search/index-store.js').IndexStore | undefined
```

(c) Constructor (near `this.i18nFields = opts.i18nFields`): add
```ts
    this.textIndexes = opts.textIndexes
    this.searchIndexStore = opts.textIndexes && opts.textIndexes.length > 0
      ? new (require('./search/index-store.js').MemoryIndexStore)()   // see note
      : undefined
```
NOTE: hub is ESM — do NOT use `require`. Instead add a top-of-file import:
`import { MemoryIndexStore } from './search/index-store.js'` and write
`this.searchIndexStore = opts.textIndexes && opts.textIndexes.length > 0 ? new MemoryIndexStore() : undefined`.
Also import: `import { extractSnippet } from './search/snippet.js'`, `import { buildStringFieldEntries } from './search/build-docs.js'`, and types `import type { IndexDoc, IndexHit } from './search/inverted-index.js'`. (`stripI18nFilled` is already imported.)

(d) Warm-on-open: in the same place the collection first hydrates eagerly (search for the existing eager `ensureHydrated()` used by `search()`), OR at the end of the constructor schedule it; simplest: in `warmIndex()` and call it from wherever the vault opens the collection when `warmIndexOnOpen`. Add this private builder + public methods after `search()` (~line 2713):

```ts
  /** #308 L1 — build IndexDoc[] for the configured text fields over the live cache. */
  private buildRetrievalDocs(only?: readonly string[]): IndexDoc[] {
    const docs: IndexDoc[] = []
    for (const [id, e] of this.cache) {
      const rec = stripI18nFilled(e.record as Record<string, unknown>)
      const fields = buildStringFieldEntries(rec, this.textIndexes ?? [], only)
      if (fields.length > 0) docs.push({ id, fields })
    }
    return docs
  }

  /** #308 L1 — pre-build the lexical index (e.g. on open) so the first retrieve() pays no build scan. */
  async warmIndex(): Promise<void> {
    if (!this.searchIndexStore) return
    if (this.lazy) throw new Error(`Collection "${this.name}": retrieve()/warmIndex() require eager mode (prefetch: true).`)
    await this.ensureHydrated()
    this.searchIndexStore.getOrBuild(() => this.buildRetrievalDocs())
  }

  /** #308 L1 — client-side lexical retrieval; ranked { id, score, field, snippet, locale? }. */
  async retrieve(query: string, opts: RetrieveOptions = {}): Promise<RetrieveHit<T>[]> {
    if (!this.searchIndexStore) throw new Error(`Collection "${this.name}": retrieve() requires a textIndexes config.`)
    if (this.lazy) throw new Error(`Collection "${this.name}": retrieve() requires eager mode (prefetch: true).`)
    await this.ensureHydrated()
    const index = this.searchIndexStore.getOrBuild(() => this.buildRetrievalDocs(opts.fields))
    const hits = index.query(query, { ...(opts.limit !== undefined ? { limit: opts.limit } : {}), ...(opts.match ? { match: opts.match } : {}), ...(opts.prefix ? { prefix: opts.prefix } : {}) })
    const window = opts.snippetWindow ?? 80
    return hits.map((h: IndexHit) => {
      const base: RetrieveHit<T> = {
        id: h.id, score: h.score, field: h.field, snippet: extractSnippet(h.text, h.offset, window),
        ...(h.locale !== undefined ? { locale: h.locale } : {}),
      }
      if (opts.includeRecord) {
        const e = this.cache.get(h.id)
        if (e) (base as { record?: T }).record = stripI18nFilled(e.record as Record<string, unknown>) as T
      }
      return base
    })
  }
```

Add the public types near the top of `collection.ts` (after imports) or in a small `search/retrieve-types.ts` re-exported — define:
```ts
export interface RetrieveOptions {
  readonly limit?: number
  readonly match?: 'any' | 'all'
  readonly prefix?: boolean
  readonly snippetWindow?: number
  readonly fields?: readonly string[]
  readonly includeRecord?: boolean
}
export interface RetrieveHit<T> {
  readonly id: string
  readonly score: number
  readonly field: string
  readonly snippet: string
  readonly locale?: string
  readonly record?: T
}
```
Put these in `packages/hub/src/search/retrieve-types.ts` and `import type { RetrieveOptions, RetrieveHit } from './search/retrieve-types.js'` in collection.ts (keeps collection.ts smaller for the ceiling). Re-export both from `src/search/index.ts` and from the hub root `src/index.ts` (find the existing `SearchResult`/`SearchOptions` re-export and add these beside it).

(e) Dirty poke: at the END of the `put` write paths and the `delete` path, after the record is committed, add — guarded so non-search collections pay nothing:
```ts
    this.searchIndexStore?.markDirty()
```
Place it next to the existing `this.emitter.emit('change', …)` site(s) in `put` (both the CRDT and normal path) and in `_doDelete`. One line each.

(f) warmIndexOnOpen: where the vault constructs the collection and `opts.warmIndexOnOpen` is set, call `void collection.warmIndex()` after construction (find the `new Collection(...)` site in `vault.ts`; do it there, fire-and-forget, eager-only). If that site is awkward, instead set a constructor flag and lazily warm on first access — but the vault call-site is preferred. Keep it one guarded line.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/hub && npx vitest run __tests__/search-retrieve.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Regression + commit**

Run: `cd packages/hub && npx vitest run && npx eslint src/search src/collection.ts && npx tsc --noEmit`
Expected: full suite green; lint/tsc clean.

```bash
git add packages/hub/src/collection.ts packages/hub/src/search/build-docs.ts packages/hub/src/search/retrieve-types.ts packages/hub/src/search/index.ts packages/hub/src/index.ts packages/hub/src/vault.ts packages/hub/__tests__/search-retrieve.test.ts
git commit -m "feat(search): collection.retrieve() + warmIndex over string fields (#308 L1)"
```

---

## Task 6: i18nText fields — all-locale indexing

**Files:**
- Modify: `packages/hub/src/search/build-docs.ts`
- Modify: `packages/hub/src/collection.ts` (pass `i18nFields` descriptors into the doc builder)
- Test: `packages/hub/__tests__/search-retrieve-i18n.test.ts`

**Interfaces:**
- Consumes: `I18nTextDescriptor` (`src/i18n/core.js:187`, value on record is the raw `{ [locale]: string }` map).
- Produces: extend `build-docs.ts` with `buildI18nFieldEntries(record, i18nFields, only?)` emitting one `{ field, locale, text }` per non-empty locale value; update the collection to merge string + i18n entries.

- [ ] **Step 1: Write the failing test**

```ts
// packages/hub/__tests__/search-retrieve-i18n.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { createNoydb } from '../src/noydb.js'
import { withI18n } from '../src/i18n/index.js'
import { i18nText } from '../src/i18n/core.js'
import type { Noydb } from '../src/noydb.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/types.js'
import { ConflictError } from '../src/errors.js'

// paste the memory() helper verbatim from __tests__/i18n-script-put.test.ts lines 12-48

interface Person { id: string; name: Record<string, string> }
async function db(): Promise<Noydb> { return createNoydb({ store: memory(), user: 'a', secret: 'pw-i18n-r', i18nStrategy: withI18n() }) }

describe('retrieve() over i18nText (all locales) (#308 L1)', () => {
  let n: Noydb
  beforeEach(async () => { n = await db() })

  it('finds a bilingual record by a term in EITHER locale; hit carries matched locale', async () => {
    const v = await n.openVault('v')
    const c = v.collection<Person>('people', {
      i18nFields: { name: i18nText({ languages: ['th', 'en'], required: 'any' }) },
      textIndexes: ['name'],
    })
    await c.put('a', { id: 'a', name: { th: 'สมชาย', en: 'Somchai' } })
    const byEn = await c.retrieve('somchai')
    const byTh = await c.retrieve('สมชาย')
    expect(byEn[0]!.id).toBe('a'); expect(byEn[0]!.locale).toBe('en')
    expect(byTh[0]!.id).toBe('a'); expect(byTh[0]!.locale).toBe('th')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/hub && npx vitest run __tests__/search-retrieve-i18n.test.ts`
Expected: FAIL — i18n values aren't indexed (a `{th,en}` map is not a string, so `buildStringFieldEntries` skips it).

- [ ] **Step 3: Implement the i18n expander**

Append to `packages/hub/src/search/build-docs.ts`:
```ts
import type { I18nTextDescriptor } from '../i18n/core.js'

export function buildI18nFieldEntries(
  record: Record<string, unknown>,
  i18nFields: Record<string, I18nTextDescriptor>,
  textIndexes: readonly string[],
  only?: readonly string[],
): FieldEntry[] {
  const fields = (only ? textIndexes.filter((f) => only.includes(f)) : textIndexes).filter((f) => f in i18nFields)
  const out: FieldEntry[] = []
  for (const field of fields) {
    for (const leaf of getAtPath(record, field)) {
      if (!leaf || typeof leaf !== 'object' || Array.isArray(leaf)) continue
      for (const [locale, val] of Object.entries(leaf as Record<string, unknown>)) {
        if (typeof val === 'string' && val !== '') out.push({ field, locale, text: val })
      }
    }
  }
  return out
}
```
Note: `buildStringFieldEntries` already skips non-string leaves, so i18n map fields won't be double-counted there.

- [ ] **Step 4: Merge in the collection**

In `collection.ts` `buildRetrievalDocs`, after the string entries:
```ts
      const fields = buildStringFieldEntries(rec, this.textIndexes ?? [], only)
      if (this.i18nFields) fields.push(...buildI18nFieldEntries(rec, this.i18nFields, this.textIndexes ?? [], only))
      if (fields.length > 0) docs.push({ id, fields })
```
Add `buildI18nFieldEntries` to the import from `./search/build-docs.js`.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/hub && npx vitest run __tests__/search-retrieve-i18n.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/hub/src/search/build-docs.ts packages/hub/src/collection.ts packages/hub/__tests__/search-retrieve-i18n.test.ts
git commit -m "feat(search): index i18nText fields across all locales (#308 L1)"
```

---

## Task 7: dictKey fields — resolved labels (StaticDict + dynamic)

**Files:**
- Modify: `packages/hub/src/search/build-docs.ts`
- Modify: `packages/hub/src/collection.ts` (resolve a `key→labels` map per dictKey field in the build step)
- Test: `packages/hub/__tests__/search-retrieve-dictkey.test.ts`

**Interfaces:**
- Consumes: `StaticDictDescriptor` (`_noydbStaticDict: true`, `table: Record<key, Record<locale,string>>`); `DictKeyDescriptor` (`_noydbDictKey: true`, `name`); `DictionaryHandle.entries(): Promise<{ key: string; labels: Record<string,string> }[]>` via `vault.dictionary(name)`; on-record dictKey value is a scalar key string.
- Produces: `buildDictKeyFieldEntries(record, dictKeyFields, labelMaps, textIndexes, only?)` where `labelMaps: Map<field, Map<key, Record<locale,string>>>` is precomputed in the collection build step.

- [ ] **Step 1: Write the failing test**

```ts
// packages/hub/__tests__/search-retrieve-dictkey.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { createNoydb } from '../src/noydb.js'
import { withI18n } from '../src/i18n/index.js'
import { staticDict } from '../src/i18n/dictionary.js'
import type { Noydb } from '../src/noydb.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/types.js'
import { ConflictError } from '../src/errors.js'

// paste the memory() helper verbatim from __tests__/i18n-script-put.test.ts lines 12-48

interface Inv { id: string; status: string }
async function db(): Promise<Noydb> { return createNoydb({ store: memory(), user: 'a', secret: 'pw-dk-r', i18nStrategy: withI18n() }) }

describe('retrieve() over dictKey labels (#308 L1)', () => {
  let n: Noydb
  beforeEach(async () => { n = await db() })

  it('finds a record by its resolved label text (StaticDict, any locale)', async () => {
    const v = await n.openVault('v')
    const c = v.collection<Inv>('inv', {
      dictKeyFields: { status: staticDict('invStatus', { overdue: { en: 'Overdue', th: 'ค้างชำระ' }, paid: { en: 'Paid', th: 'ชำระแล้ว' } }) },
      textIndexes: ['status'],
    })
    await c.put('a', { id: 'a', status: 'overdue' })
    await c.put('b', { id: 'b', status: 'paid' })
    expect((await c.retrieve('overdue')).map((h) => h.id)).toEqual(['a'])      // en label
    expect((await c.retrieve('ค้างชำระ')).map((h) => h.id)).toEqual(['a'])     // th label
    expect((await c.retrieve('paid')).map((h) => h.id)).toEqual(['b'])
  })
})
```
(If `staticDict`'s exact signature differs, read `src/i18n/dictionary.ts:214` `export function staticDict(...)` and match it — it takes `(name, table)`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/hub && npx vitest run __tests__/search-retrieve-dictkey.test.ts`
Expected: FAIL — the scalar key `'overdue'` is indexed as the literal key, not its labels.

- [ ] **Step 3: Implement the dictKey expander**

Append to `packages/hub/src/search/build-docs.ts`:
```ts
import type { DictKeyDescriptor, StaticDictDescriptor } from '../i18n/dictionary.js'

/** label map: field -> (key -> { locale -> label }). Precomputed in the collection (async for dynamic dicts). */
export function buildDictKeyFieldEntries(
  record: Record<string, unknown>,
  dictKeyFields: Record<string, DictKeyDescriptor | StaticDictDescriptor>,
  labelMaps: Map<string, Map<string, Record<string, string>>>,
  textIndexes: readonly string[],
  only?: readonly string[],
): FieldEntry[] {
  const fields = (only ? textIndexes.filter((f) => only.includes(f)) : textIndexes).filter((f) => f in dictKeyFields)
  const out: FieldEntry[] = []
  for (const field of fields) {
    const map = labelMaps.get(field)
    if (!map) continue
    for (const leaf of getAtPath(record, field)) {
      const keys = typeof leaf === 'string' ? [leaf] : Array.isArray(leaf) ? leaf.filter((k): k is string => typeof k === 'string') : []
      for (const key of keys) {
        const labels = map.get(key)
        if (!labels) continue
        for (const [locale, label] of Object.entries(labels)) {
          if (label !== '') out.push({ field, locale, text: label })
        }
      }
    }
  }
  return out
}
```

- [ ] **Step 4: Precompute label maps + merge in the collection**

In `collection.ts`, add a private async helper that builds `labelMaps` once per `buildRetrievalDocs` cycle, and make `buildRetrievalDocs` accept it. Since `buildRetrievalDocs` is sync but dynamic-dict resolution is async, resolve labels BEFORE building (in `warmIndex`/`retrieve`, which are async):

```ts
  /** #308 L1 — field -> (key -> {locale->label}) for dictKey fields; static from table, dynamic via vault.dictionary().entries(). */
  private async resolveDictLabelMaps(): Promise<Map<string, Map<string, Record<string, string>>>> {
    const maps = new Map<string, Map<string, Record<string, string>>>()
    if (!this.dictKeyFields || !this.textIndexes) return maps
    for (const field of this.textIndexes) {
      const desc = this.dictKeyFields[field]
      if (!desc) continue
      const m = new Map<string, Record<string, string>>()
      if ('_noydbStaticDict' in desc) {
        for (const [key, labels] of Object.entries(desc.table)) m.set(key, labels as Record<string, string>)
      } else {
        const handle = await this.getVaultDictionary(desc.name)   // see note
        for (const e of await handle.entries()) m.set(e.key, e.labels)
      }
      maps.set(field, m)
    }
    return maps
  }
```
NOTE on `getVaultDictionary`: the collection needs a way to reach `vault.dictionary(name)`. Check whether the collection already holds a vault/dictionary accessor (it constructs dictKey label resolution elsewhere — search `dictionary(` / `buildDictionaryHandle` usage reachable from the collection). If the collection lacks a direct accessor, thread a `getDictionary?: (name: string) => Promise<DictionaryHandle>` callback into the collection constructor options from `vault.ts` (mirror how other vault capabilities are injected), and call it here. If only StaticDict support is needed for the first cut, you MAY land static-only and open a follow-up for dynamic — but prefer wiring the callback so both work, since the spec requires both.

Then change `buildRetrievalDocs(only?)` to `buildRetrievalDocs(labelMaps, only?)` and in `retrieve()`/`warmIndex()`:
```ts
    const labelMaps = await this.resolveDictLabelMaps()
    const index = this.searchIndexStore.getOrBuild(() => this.buildRetrievalDocs(labelMaps, opts.fields))
```
and inside `buildRetrievalDocs`, after the i18n merge:
```ts
      if (this.dictKeyFields) fields.push(...buildDictKeyFieldEntries(rec, this.dictKeyFields, labelMaps, this.textIndexes ?? [], only))
```
Add `buildDictKeyFieldEntries` to the import.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/hub && npx vitest run __tests__/search-retrieve-dictkey.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/hub/src/search/build-docs.ts packages/hub/src/collection.ts packages/hub/src/vault.ts packages/hub/__tests__/search-retrieve-dictkey.test.ts
git commit -m "feat(search): index dictKey resolved labels — static table + dynamic entries() (#308 L1)"
```

---

## Task 8: Blob fields — index filenames via listSlots (heaviest, last)

**Files:**
- Modify: `packages/hub/src/search/build-docs.ts`
- Modify: `packages/hub/src/collection.ts` (resolve `recordId → filenames[]` via the existing blob slot reader in the async build step)
- Test: `packages/hub/__tests__/search-retrieve-blob.test.ts`

**Interfaces:**
- Consumes: the collection's existing blob slot listing for a record (find the method that returns `SlotInfo[]` with `.filename`/`.name`; the blob set's `listSlots(recordId)`). `blobFields` config declares which fields are blob fields.
- Produces: `buildBlobFieldEntries(field, filenames)` emitting `{ field, text: filename }`; a precomputed `Map<recordId, Map<field, string[]>>` of filenames in the collection build step.

- [ ] **Step 1: Write the failing test**

```ts
// packages/hub/__tests__/search-retrieve-blob.test.ts
// Mirror the memory()-helper harness; create a collection with a blob field +
// textIndexes naming that blob field, put a record, attach a blob with a known
// filename via the collection's blob API, then assert retrieve('<filename-term>')
// returns that record with field === the blob field.
//
// IMPORTANT: read an existing blob test (grep __tests__ for 'blob' + the put-blob
// API, e.g. with-blobs showcase / blob-set tests) to copy the exact attach call.
```
Implementer: locate the real blob-attach API from an existing blob test and write a concrete failing test asserting `retrieve('invoice')` finds a record whose attached file is `invoice-2024.pdf`. Do not leave this as prose — write the runnable test.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/hub && npx vitest run __tests__/search-retrieve-blob.test.ts`
Expected: FAIL — blob filenames are not indexed.

- [ ] **Step 3: Implement the blob expander**

Append to `packages/hub/src/search/build-docs.ts`:
```ts
export function buildBlobFieldEntries(filenamesByField: Map<string, string[]>): FieldEntry[] {
  const out: FieldEntry[] = []
  for (const [field, names] of filenamesByField) {
    for (const name of names) if (name !== '') out.push({ field, text: name })
  }
  return out
}
```

- [ ] **Step 4: Resolve filenames in the collection build step**

In `collection.ts`, add an async resolver that, for each cached record id, lists slots for the configured blob fields and collects `filename`s. Use the collection's existing slot-listing path (the same one `compaction`/blob APIs use — find `listSlots`). Build `Map<recordId, Map<field, string[]>>` in `retrieve()`/`warmIndex()` (async), pass into `buildRetrievalDocs`, and merge:
```ts
      const blobNames = blobFilenames.get(id)
      if (blobNames) fields.push(...buildBlobFieldEntries(blobNames))
```
Guard entirely behind `this.blobFields && this.textIndexes.some(f => f in this.blobFields)` so non-blob collections do zero slot I/O. Document that blob indexing adds one `listSlots` per record at build time (the heaviest source).

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/hub && npx vitest run __tests__/search-retrieve-blob.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/hub/src/search/build-docs.ts packages/hub/src/collection.ts packages/hub/__tests__/search-retrieve-blob.test.ts
git commit -m "feat(search): index blob filenames via listSlots (#308 L1)"
```

---

## Task 9: Docs, features.yaml, showcase, ceiling, final gate

**Files:**
- Modify: `docs/subsystems/search.md`
- Modify: `features.yaml` (`search-index` node)
- Create: `showcases/src/NNN-with-retrieve.showcase.test.ts` (next free number)
- Modify: `scripts/check-architecture.mjs` (only if `collection.ts` exceeds 4922)

- [ ] **Step 1: Subsystem doc** — extend `docs/subsystems/search.md`: the L0→L4 epic map; L1 `retrieve()` API + `RetrieveHit`; the field-type boundary table (string/i18nText/dictKey ✅, money/number → `where`, blob via listSlots, dictKey labels, blob bytes ⛔); the trusted-tier/zero-leakage rationale (Apple/Opal); `warmIndex()`/`warmIndexOnOpen`; in-memory/session-rebuilt + L1.5 persistence note. Commit:
```bash
git add docs/subsystems/search.md && git commit -m "docs(search): document L1 retrieve() + field-type matrix + trusted-tier rationale (#308)"
```

- [ ] **Step 2: features.yaml** — update the `search-index` node (lines ~254): keep `status: preview`, `experimental: true`; update `name`/description to cover scan + L1 retrieve; add the showcase from Step 3 to `showcases`; spec ref `docs/superpowers/specs/2026-06-22-ai-retrieval-l1-lexical-index-design.md`. Run `node scripts/validate-features.mjs` (must pass). Commit:
```bash
git add features.yaml && git commit -m "chore(features): register L1 retrieve under search-index (#308)"
```

- [ ] **Step 3: Showcase** — model on an existing i18n showcase; demonstrate: a bilingual + dictKey collection, `retrieve('<thai term>')` returning `{id, field, locale, snippet}`, `prefix` autocomplete, and `includeRecord`. Run it: `cd showcases && npx vitest run src/NNN-with-retrieve.showcase.test.ts` (rebuild hub first: `cd packages/hub && npx tsup`). Commit:
```bash
git add showcases/src/NNN-with-retrieve.showcase.test.ts && git commit -m "docs(showcase): client-side retrieve() walkthrough (#308 L1)"
```

- [ ] **Step 4: Ceiling + final gate** — run the full gate:
```bash
cd packages/hub && npx tsup && npx vitest run && npx eslint src && npx tsc --noEmit
cd /Users/vicio/_github/noy-db && node scripts/check-architecture.mjs && node scripts/validate-features.mjs
```
If the architecture check fails on `collection.ts`, raise its ceiling in `scripts/check-architecture.mjs` to `wc -l` + ~10 with a one-line `// Bumped …→… (#308 L1): retrieve()/warmIndex call-sites …` comment, then re-run. Expected: all green. Commit any ceiling bump:
```bash
git add scripts/check-architecture.mjs && git commit -m "chore(arch): raise collection.ts ceiling for retrieve() call-site (#308 L1)"
```

---

## Self-Review

**1. Spec coverage:**
- i18n segmenter tokenizer → Task 1 ✓
- InvertedIndex + multi-field max-field BM25 → Task 2 ✓
- snippet → Task 3 ✓
- IndexStore seam (memory; persistence-ready) → Task 4 ✓
- `retrieve()` + `textIndexes` + `warmIndex`/`warmIndexOnOpen` + dirty-rebuild + includeRecord + eager-only + zero-leakage test → Task 5 ✓
- i18nText all-locale + matched `locale` → Task 6 ✓
- dictKey labels (StaticDict table + dynamic entries(), all locales) → Task 7 ✓
- blob filename via listSlots (heaviest, last) → Task 8 ✓
- money/number excluded (no task indexes them; `buildStringFieldEntries` only takes strings, i18n maps, dict labels, blob names — numbers never enter) ✓; hybrid `retrieve ∩ where` is consumer-composed (documented Task 9) ✓
- transparent `search()` acceleration — NOTE: the spec lists this as a nice-to-have; it is NOT implemented as a task (retrieve() is the L1 surface). Documented as deferred to avoid scope creep. **Gap accepted** (search() keeps its O(n) scan; retrieve() is the indexed path).
- docs/features/showcase/tree-shake/ceiling → Task 9 ✓

**2. Placeholder scan:** Task 8 Step 1 intentionally instructs the implementer to copy the real blob-attach API from an existing test (the attach call varies and must be read from code) — this is a "locate then write the runnable test" instruction, not a code placeholder; the expander + wiring code is complete. Task 5(c) flags the ESM `require` trap and gives the correct `import`. Task 7 Step 4 flags the `getVaultDictionary` wiring decision with a concrete fallback. No "TBD"/"handle errors"/"similar to" placeholders elsewhere.

**3. Type consistency:** `IndexDoc`/`IndexHit`/`QueryOptions` (Task 2) are used unchanged in Tasks 4–8. `FieldEntry = IndexDoc['fields'][number]` is the single shared shape every `build*FieldEntries` returns. `RetrieveOptions`/`RetrieveHit` (Task 5, in `retrieve-types.ts`) are stable. `buildRetrievalDocs` signature changes once (Task 7 adds `labelMaps` param) — all later call-sites updated in the same task. `segmentTokens`/`segmentTokenizer` names consistent across Tasks 1–2.
