# AI Retrieval L2 — Semantic/Vector (encrypted, local) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-collection `embeddings: { source, encode, dim, model }` derives a vector per record at write via a pluggable `encode` hook, stores it ENCRYPTED in a reserved `_vec` sidecar, and answers `retrieve(q, { mode:'semantic' })` / `collection.similarTo(vec, { k })` by brute-force cosine over decrypted vectors in the trusted tier. Zero-knowledge; managed backends deferred.

**Architecture:** New tree-shakeable `src/embeddings/` (cosine, VectorSet, descriptor+errors). **Config-gated like L1's `searchIndexStore`** (not a `createNoydb` strategy): collection.ts imports the engine and constructs a `VectorSet` only when `embeddings` is configured. Vectors live per-record in a reserved `_vec` collection (collection DEK, excluded from hydration, dropped on `forget()`), loaded into an in-memory `VectorSet` (cached, dirty-on-write) — same load/cache/dirty shape as L1's index.

**Tech Stack:** TypeScript (ESM, `.js` specifiers), vitest (`vitest run` from `packages/hub`), `Float32Array` cosine, reusing the `_ftindex` encrypt/adapter sidecar pattern + L1's `RetrieveHit`.

**Spec:** `docs/superpowers/specs/2026-06-22-ai-retrieval-l2-semantic-vector-design.md`

## Global Constraints

- Hub-portable: no Node-only imports in `packages/hub/src/**`.
- Tree-shakeable: engine in `src/embeddings/`; constructed only when a collection sets `embeddings` (zero cost otherwise).
- Zero added store leakage: vectors stored ENCRYPTED per `_vec/<id>` (collection DEK); store sees ciphertext only; `_vec` excluded from record hydration (reserved `_`-prefixed collection) and never returned by record reads.
- `retrieve()`/`similarTo()` are eager-only (throw in lazy mode, like L1).
- `exactOptionalPropertyTypes` on — spread-conditional for optional props.
- No Claude/AI attribution in commits.
- Managed/plaintext vector backends, HNSW, chunking, `query().similarTo().where()` builder-chaining are OUT (deferred; consumers compose `collection.similarTo()` ids with `query().where()` meanwhile).

---

## Task 1: cosine similarity (pure)

**Files:**
- Create: `packages/hub/src/embeddings/cosine.ts`
- Test: `packages/hub/__tests__/embeddings-cosine.test.ts`

**Interfaces:**
- Produces: `cosine(a: Float32Array | number[], b: Float32Array | number[]): number` (returns 0 for zero-norm or length mismatch).

- [ ] **Step 1: Write the failing test**

```ts
// packages/hub/__tests__/embeddings-cosine.test.ts
import { describe, it, expect } from 'vitest'
import { cosine } from '../src/embeddings/cosine.js'

describe('cosine (#308 L2)', () => {
  it('identical vectors → 1', () => { expect(cosine([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 6) })
  it('orthogonal → 0', () => { expect(cosine([1, 0], [0, 1])).toBeCloseTo(0, 6) })
  it('opposite → -1', () => { expect(cosine([1, 0], [-1, 0])).toBeCloseTo(-1, 6) })
  it('zero-norm → 0 (no NaN)', () => { expect(cosine([0, 0], [1, 1])).toBe(0) })
  it('length mismatch → 0', () => { expect(cosine([1, 2], [1, 2, 3])).toBe(0) })
})
```

- [ ] **Step 2: Run to verify it fails** — `cd packages/hub && npx vitest run __tests__/embeddings-cosine.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement**

```ts
// packages/hub/src/embeddings/cosine.ts
/** Cosine similarity in [-1,1]; 0 on zero-norm or length mismatch (no NaN). (#308 L2) */
export function cosine(a: Float32Array | number[], b: Float32Array | number[]): number {
  if (a.length !== b.length) return 0
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!, y = b[i]!
    dot += x * y; na += x * x; nb += y * y
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}
```

- [ ] **Step 4: Run to verify it passes** — same command → PASS (5). Then `npx tsc --noEmit` clean.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/embeddings/cosine.ts packages/hub/__tests__/embeddings-cosine.test.ts
git commit -m "feat(embeddings): pure cosine similarity (#308 L2)"
```

---

## Task 2: EmbeddingDescriptor + errors

**Files:**
- Create: `packages/hub/src/embeddings/descriptor.ts`
- Modify: `packages/hub/src/errors.ts` (3 new error classes)
- Test: `packages/hub/__tests__/embeddings-descriptor.test.ts`

**Interfaces:**
- Produces:
  - `interface EmbeddingDescriptor { readonly source: string | readonly string[]; readonly encode: (text: string) => Promise<Float32Array>; readonly dim: number; readonly model: string }`
  - `embeddingSourceText(record, source): string` (join the source fields' text via `getAtPath`).
  - errors `EmbeddingEncoderNotConfiguredError`, `EmbeddingDimMismatchError`, `EmbeddingModelMismatchError` (extend `NoydbError`, codes `EMBEDDING_*`).

- [ ] **Step 1: Write the failing test**

```ts
// packages/hub/__tests__/embeddings-descriptor.test.ts
import { describe, it, expect } from 'vitest'
import { embeddingSourceText } from '../src/embeddings/descriptor.js'
import { EmbeddingDimMismatchError, EmbeddingModelMismatchError } from '../src/errors.js'

describe('embeddingSourceText (#308 L2)', () => {
  it('joins multiple source fields, skipping empties', () => {
    expect(embeddingSourceText({ a: 'overdue', b: '', c: 'invoice' }, ['a', 'b', 'c'])).toBe('overdue invoice')
  })
  it('single string source', () => {
    expect(embeddingSourceText({ desc: 'TCM rent' }, 'desc')).toBe('TCM rent')
  })
  it('nested/wildcard path via getAtPath', () => {
    expect(embeddingSourceText({ items: [{ d: 'a' }, { d: 'b' }] }, 'items[].d')).toBe('a b')
  })
})

describe('embedding errors (#308 L2)', () => {
  it('dim mismatch carries field/expected/actual', () => {
    const e = new EmbeddingDimMismatchError('vec', 768, 384)
    expect(e).toBeInstanceOf(Error); expect(e.message).toContain('768'); expect(e.message).toContain('384')
  })
  it('model mismatch carries the two models', () => {
    const e = new EmbeddingModelMismatchError('minilm-v2', 'minilm-v1')
    expect(e.message).toContain('minilm-v2'); expect(e.message).toContain('minilm-v1')
  })
})
```

- [ ] **Step 2: Run to verify it fails** — `cd packages/hub && npx vitest run __tests__/embeddings-descriptor.test.ts` → FAIL.

- [ ] **Step 3: Add errors to `errors.ts`**

Find the `NoydbError` base + an existing subclass (e.g. `MoneyPrecisionError`) for the exact pattern, then add:

```ts
export class EmbeddingEncoderNotConfiguredError extends NoydbError {
  constructor(collection: string) {
    super('EMBEDDING_ENCODER_NOT_CONFIGURED',
      `Collection "${collection}" declares embeddings but no encode() hook was configured.`)
  }
}
export class EmbeddingDimMismatchError extends NoydbError {
  constructor(field: string, expected: number, actual: number) {
    super('EMBEDDING_DIM_MISMATCH',
      `Embedding for "${field}" has dim ${actual}, expected ${expected}.`)
  }
}
export class EmbeddingModelMismatchError extends NoydbError {
  constructor(expected: string, found: string) {
    super('EMBEDDING_MODEL_MISMATCH',
      `Embedding model mismatch: collection uses "${expected}" but a stored vector is "${found}". ` +
        `Run vault.embeddings.reindex() after changing the encoder.`)
  }
}
```

(Match the actual `NoydbError` constructor signature — read it; if it's `(message)` with a `code` property set differently, adapt. Reuse the `MONEY_*`/`ComputedFieldError` convention.)

- [ ] **Step 4: Create `descriptor.ts`**

```ts
// packages/hub/src/embeddings/descriptor.ts
/** Per-collection embedding config (#308 L2). The encode hook is host/remote — no bundled model. */
import { getAtPath } from '../i18n/core.js'

export interface EmbeddingDescriptor {
  readonly source: string | readonly string[]
  readonly encode: (text: string) => Promise<Float32Array>
  readonly dim: number
  readonly model: string
}

/** Concatenate the record's source-field text (skips empties; supports nested/[]-wildcard paths). */
export function embeddingSourceText(record: Record<string, unknown>, source: string | readonly string[]): string {
  const fields = typeof source === 'string' ? [source] : source
  const parts: string[] = []
  for (const f of fields) {
    for (const leaf of getAtPath(record, f)) {
      if (typeof leaf === 'string' && leaf !== '') parts.push(leaf)
    }
  }
  return parts.join(' ')
}
```

- [ ] **Step 5: Run to verify it passes** — `npx vitest run __tests__/embeddings-descriptor.test.ts` → PASS; `npx tsc --noEmit` clean.

- [ ] **Step 6: Commit**

```bash
git add packages/hub/src/embeddings/descriptor.ts packages/hub/src/errors.ts packages/hub/__tests__/embeddings-descriptor.test.ts
git commit -m "feat(embeddings): EmbeddingDescriptor + source-text + errors (#308 L2)"
```

---

## Task 3: VectorSet (in-memory, model-guarded cosine kNN)

**Files:**
- Create: `packages/hub/src/embeddings/vector-set.ts`
- Create: `packages/hub/src/embeddings/index.ts` (barrel)
- Test: `packages/hub/__tests__/embeddings-vector-set.test.ts`

**Interfaces:**
- Consumes: `cosine` (`./cosine.js`); `EmbeddingModelMismatchError` (`../errors.js`).
- Produces:
  - `interface StoredVector { readonly id: string; readonly vec: Float32Array; readonly model: string }`
  - `interface VectorHit { readonly id: string; readonly score: number }`
  - `class VectorSet { ensureLoaded(load: () => Promise<StoredVector[]>): Promise<void>; markDirty(): void; cosineTopK(query: Float32Array, k: number, opts?: { minScore?: number; expectModel?: string }): VectorHit[]; readonly loaded: boolean }`

- [ ] **Step 1: Write the failing test**

```ts
// packages/hub/__tests__/embeddings-vector-set.test.ts
import { describe, it, expect } from 'vitest'
import { VectorSet, type StoredVector } from '../src/embeddings/vector-set.js'
import { EmbeddingModelMismatchError } from '../src/errors.js'

const vecs: StoredVector[] = [
  { id: 'a', vec: new Float32Array([1, 0, 0]), model: 'm1' },
  { id: 'b', vec: new Float32Array([0.9, 0.1, 0]), model: 'm1' },
  { id: 'c', vec: new Float32Array([0, 1, 0]), model: 'm1' },
]

describe('VectorSet (#308 L2)', () => {
  it('loads once (load fn not called twice) and ranks by cosine', async () => {
    const vs = new VectorSet()
    let calls = 0
    const load = async () => { calls++; return vecs }
    await vs.ensureLoaded(load); await vs.ensureLoaded(load)
    expect(calls).toBe(1); expect(vs.loaded).toBe(true)
    const hits = vs.cosineTopK(new Float32Array([1, 0, 0]), 2)
    expect(hits.map((h) => h.id)).toEqual(['a', 'b']) // a=1.0, b≈0.994
    expect(hits[0]!.score).toBeCloseTo(1, 5)
  })
  it('k limits, minScore filters', async () => {
    const vs = new VectorSet(); await vs.ensureLoaded(async () => vecs)
    expect(vs.cosineTopK(new Float32Array([1, 0, 0]), 1).length).toBe(1)
    expect(vs.cosineTopK(new Float32Array([1, 0, 0]), 5, { minScore: 0.99 }).map((h) => h.id)).toEqual(['a', 'b'])
  })
  it('markDirty forces reload', async () => {
    const vs = new VectorSet(); let calls = 0
    const load = async () => { calls++; return vecs }
    await vs.ensureLoaded(load); vs.markDirty(); expect(vs.loaded).toBe(false)
    await vs.ensureLoaded(load); expect(calls).toBe(2)
  })
  it('model guard throws on mismatch', async () => {
    const vs = new VectorSet(); await vs.ensureLoaded(async () => vecs)
    expect(() => vs.cosineTopK(new Float32Array([1, 0, 0]), 2, { expectModel: 'm2' })).toThrow(EmbeddingModelMismatchError)
  })
})
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run __tests__/embeddings-vector-set.test.ts` → FAIL.

- [ ] **Step 3: Implement**

```ts
// packages/hub/src/embeddings/vector-set.ts
/** In-memory vector set for L2 semantic retrieval (#308). Loaded once per session from
 *  decrypted _vec sidecars (injected loader), brute-force cosine kNN, model-guarded. */
import { cosine } from './cosine.js'
import { EmbeddingModelMismatchError } from '../errors.js'

export interface StoredVector { readonly id: string; readonly vec: Float32Array; readonly model: string }
export interface VectorHit { readonly id: string; readonly score: number }

export class VectorSet {
  private vectors: StoredVector[] | undefined
  get loaded(): boolean { return this.vectors !== undefined }

  async ensureLoaded(load: () => Promise<StoredVector[]>): Promise<void> {
    if (this.vectors === undefined) this.vectors = await load()
  }

  markDirty(): void { this.vectors = undefined }

  cosineTopK(query: Float32Array, k: number, opts: { minScore?: number; expectModel?: string } = {}): VectorHit[] {
    const all = this.vectors ?? []
    const minScore = opts.minScore ?? -Infinity
    const hits: VectorHit[] = []
    for (const v of all) {
      if (opts.expectModel !== undefined && v.model !== opts.expectModel) {
        throw new EmbeddingModelMismatchError(opts.expectModel, v.model)
      }
      const score = cosine(query, v.vec)
      if (score >= minScore) hits.push({ id: v.id, score })
    }
    hits.sort((a, b) => b.score - a.score)
    return hits.slice(0, k)
  }
}
```

- [ ] **Step 4: Run to verify it passes** — PASS (4). `npx tsc --noEmit` clean.

- [ ] **Step 5: Barrel + commit**

Create `packages/hub/src/embeddings/index.ts`:
```ts
export { cosine } from './cosine.js'
export { embeddingSourceText, type EmbeddingDescriptor } from './descriptor.js'
export { VectorSet, type StoredVector, type VectorHit } from './vector-set.js'
```
```bash
git add packages/hub/src/embeddings/vector-set.ts packages/hub/src/embeddings/index.ts packages/hub/__tests__/embeddings-vector-set.test.ts
git commit -m "feat(embeddings): VectorSet — model-guarded cosine kNN (#308 L2)"
```

---

## Task 4: Write-time derivation — `embeddings` option + encrypted `_vec` sidecar

**Files:**
- Modify: `packages/hub/src/collection.ts` (ctor option/field ~706/320/925 patterns; derive in `put` after the auto-translate block ~1534; `_vec` write + load callbacks; dirty handle)
- Modify: `packages/hub/src/vault.ts` (public `collection()` `embeddings` option + threading, ~679/1008 patterns)
- Test: `packages/hub/__tests__/embeddings-write.test.ts`

**Interfaces:**
- Consumes: `EmbeddingDescriptor`, `embeddingSourceText`, `VectorSet`, `StoredVector` (`./embeddings/index.js`); `encryptJsonString`/`decryptJsonString`/`adapter`/`cache` (collection); the 3 embedding errors.
- Produces (on `Collection`): `embeddings?: EmbeddingDescriptor` option/field; `private vectorSet: VectorSet | undefined`; `private buildVectorLoad(): () => Promise<StoredVector[]>` (list+get+decrypt `_vec`); derive-on-`put`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/hub/__tests__/embeddings-write.test.ts
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/noydb.js'
import type { Noydb } from '../src/noydb.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/types.js'
import { ConflictError, EmbeddingDimMismatchError } from '../src/errors.js'

// paste the memory() helper verbatim from i18n-script-put.test.ts lines 12-48

interface Doc { id: string; text: string }
// deterministic stub encoder: 3-dim bag-of-chars hash → unit-ish vector
const enc = (dim: number, model = 'stub') => ({
  dim, model, source: 'text' as const,
  encode: async (t: string) => { const v = new Float32Array(dim); for (let i = 0; i < t.length; i++) v[t.charCodeAt(i) % dim] += 1; return v },
})

describe('embeddings write derivation (#308 L2)', () => {
  it('put derives an ENCRYPTED _vec sidecar (no plaintext vector), not hydrated as a record', async () => {
    const store = memory()
    const puts: string[] = []
    const wrapped: NoydbStore = { ...store, async put(c, col, id, e, ev) { puts.push(`${col}/${id}`); return store.put(c, col, id, e, ev) } }
    const db = await createNoydb({ store: wrapped, user: 'a', secret: 'pw-emb' })
    const v = await db.openVault('v')
    const c = v.collection<Doc>('d', { embeddings: enc(8) })
    await c.put('x', { id: 'x', text: 'overdue invoice' })
    expect(puts.some((p) => p.startsWith('_vec/x'))).toBe(true)
    const env = await wrapped.get('v', '_vec', 'x')
    expect(JSON.stringify(env)).not.toContain('overdue')          // source text not leaked
    expect((await c.toArray()).map((r) => r.id)).toEqual(['x'])   // _vec not a phantom record
  })

  it('dim mismatch → EmbeddingDimMismatchError', async () => {
    const db = await createNoydb({ store: memory(), user: 'a', secret: 'pw' })
    const v = await db.openVault('v')
    const c = v.collection<Doc>('d', { embeddings: { ...enc(8), encode: async () => new Float32Array(4) } })
    await expect(c.put('x', { id: 'x', text: 'hi' })).rejects.toThrow(EmbeddingDimMismatchError)
  })
})
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run __tests__/embeddings-write.test.ts` → FAIL.

- [ ] **Step 3: Add the option/field + vault threading**

(a) `collection.ts` ctor options interface (beside `i18nFields` ~706): `embeddings?: EmbeddingDescriptor | undefined`. Field (~320): `private readonly embeddings: EmbeddingDescriptor | undefined`; `private vectorSet: VectorSet | undefined`. Ctor (~925): `this.embeddings = opts.embeddings; this.vectorSet = opts.embeddings ? new VectorSet() : undefined`. Imports from `./embeddings/index.js` + the errors.
(b) `vault.ts` public `collection()` option (~679): `embeddings?: EmbeddingDescriptor`; threading (~1008): `if (options?.embeddings !== undefined) collOpts.embeddings = options.embeddings`.

- [ ] **Step 4: Derive on put + the `_vec` load callback**

In `collection.ts`, right AFTER the auto-translate block (~line 1534, before script enforcement), add the derive step:

```ts
    // #308 L2 — derive the embedding vector at write (encode → encrypted _vec sidecar).
    if (this.embeddings) {
      const text = embeddingSourceText(record as Record<string, unknown>, this.embeddings.source)
      const vec = await this.embeddings.encode(text)
      if (vec.length !== this.embeddings.dim) throw new EmbeddingDimMismatchError('embeddings', this.embeddings.dim, vec.length)
      const body = JSON.stringify({ vec: Array.from(vec), model: this.embeddings.model, dim: this.embeddings.dim })
      const env = await this.encryptJsonString(body, version)
      await this.adapter.put(this.vault, '_vec', id, env)
      this.vectorSet?.markDirty()
    }
```
NOTE: `version` must be in scope here — if the final record version isn't computed until later, write the `_vec` AFTER the main record write using the same version, OR use a constant version (the `_vec` envelope `_v` is not OCC-checked). If `version` isn't available at this point, move this block to just after the main `adapter.put` of the record (still pre-return); read the surrounding code to place it where both `id` and the record's `version` exist. The `_vec` write must not block the record write — wrap in the same error flow.

Add the loader builder + a private helper near the search helpers:

```ts
  /** #308 L2 — load + decrypt all _vec sidecars into StoredVector[] for the VectorSet. */
  private buildVectorLoad(): () => Promise<import('./embeddings/index.js').StoredVector[]> {
    return async () => {
      const ids = await this.adapter.list(this.vault, '_vec')
      const out: import('./embeddings/index.js').StoredVector[] = []
      for (const id of ids) {
        const env = await this.adapter.get(this.vault, '_vec', id)
        if (!env) continue
        const body = await this.decryptJsonString(env)
        if (body === null) continue
        const parsed = JSON.parse(body) as { vec: number[]; model: string }
        out.push({ id, vec: new Float32Array(parsed.vec), model: parsed.model })
      }
      return out
    }
  }
```

- [ ] **Step 5: Run + full suite + commit**

`cd packages/hub && npx vitest run __tests__/embeddings-write.test.ts && npx vitest run && npx eslint src/embeddings src/collection.ts && npx tsc --noEmit` → all green.

```bash
git add packages/hub/src/collection.ts packages/hub/src/vault.ts packages/hub/__tests__/embeddings-write.test.ts
git commit -m "feat(embeddings): derive encrypted _vec sidecar on write (#308 L2)"
```

---

## Task 5: `retrieve(mode:'semantic')` + `collection.similarTo`

**Files:**
- Modify: `packages/hub/src/search/retrieve-types.ts` (`RetrieveOptions.mode`)
- Modify: `packages/hub/src/collection.ts` (`retrieve()` semantic branch; new `similarTo()`)
- Test: `packages/hub/__tests__/embeddings-retrieve.test.ts`

**Interfaces:**
- Consumes: `VectorSet`, `cosine`; `RetrieveHit` (existing); the embeddings descriptor + `buildVectorLoad`.
- Produces: `RetrieveOptions.mode?: 'lexical' | 'semantic'` (default `'lexical'`); `collection.similarTo(vector: Float32Array, opts?: { k?: number; minScore?: number; includeRecord?: boolean }): Promise<RetrieveHit<T>[]>`; `retrieve(q,{mode:'semantic'})`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/hub/__tests__/embeddings-retrieve.test.ts
// memory() helper + the enc() stub from embeddings-write.test.ts (copy both).
// interface Doc { id: string; text: string }
//
// Test A: collection with embeddings: enc(8); put 3 docs with distinct text;
//   retrieve('<text matching doc x>', { mode:'semantic' }) returns x as rank-1,
//   hits carry rank (1-based) and score (cosine).
// Test B: collection.similarTo(enc.encode('<x text>'), { k:1 }) returns [x].
// Test C: minScore filters out far docs.
// Test D (model guard): store a vec under model 'stub', open the collection with
//   embeddings model 'stub2' → retrieve(mode:'semantic') throws EmbeddingModelMismatchError.
// Test E (leakage): wrapped store — retrieve(mode:'semantic') reads _vec (get) but
//   writes nothing new; _vec env body has no plaintext source term.
// Write these as concrete runnable tests using the deterministic stub encoder.
```
Implementer: write the 5 concrete tests above with the deterministic `enc()` stub (same as Task 4) so similarity is reproducible. Don't leave as prose.

- [ ] **Step 2: Run to verify it fails** — FAIL (`mode`/`similarTo` missing).

- [ ] **Step 3: Add `mode` + the semantic branch + `similarTo`**

(a) `retrieve-types.ts`: add `readonly mode?: 'lexical' | 'semantic'` to `RetrieveOptions`.

(b) `collection.ts retrieve()`: at the top, branch on mode:
```ts
    if (opts.mode === 'semantic') return this.retrieveSemantic(query, opts)
```
Add `retrieveSemantic` + `similarTo` + a shared `vectorTopKToHits`:
```ts
  private async retrieveSemantic(query: string, opts: RetrieveOptions): Promise<RetrieveHit<T>[]> {
    if (!this.embeddings) throw new Error(`Collection "${this.name}": retrieve({mode:'semantic'}) requires an embeddings config.`)
    if (this.lazy) throw new Error(`Collection "${this.name}": retrieve() requires eager mode (prefetch: true).`)
    const qVec = await this.embeddings.encode(query)
    return this.similarTo(qVec, { ...(opts.limit !== undefined ? { k: opts.limit } : {}), ...(opts.minScore !== undefined ? { minScore: opts.minScore } : {}), ...(opts.includeRecord ? { includeRecord: true } : {}) })
  }

  /** #308 L2 — raw-vector kNN over the encrypted vector set (decrypted in the trusted tier). */
  async similarTo(vector: Float32Array, opts: { k?: number; minScore?: number; includeRecord?: boolean } = {}): Promise<RetrieveHit<T>[]> {
    if (!this.embeddings || !this.vectorSet) throw new Error(`Collection "${this.name}": similarTo() requires an embeddings config.`)
    if (this.lazy) throw new Error(`Collection "${this.name}": similarTo() requires eager mode (prefetch: true).`)
    await this.ensureHydrated()
    await this.vectorSet.ensureLoaded(this.buildVectorLoad())
    const hits = this.vectorSet.cosineTopK(vector, opts.k ?? 10, { ...(opts.minScore !== undefined ? { minScore: opts.minScore } : {}), expectModel: this.embeddings.model })
    return hits.map((h, i) => {
      const base: RetrieveHit<T> = { id: h.id, score: h.score, rank: i + 1, field: '(vector)', snippet: '' }
      if (opts.includeRecord) { const e = this.cache.get(h.id); if (e) (base as { record?: T }).record = stripI18nFilled(e.record as Record<string, unknown>) as T }
      return base
    })
  }
```
Note: `RetrieveOptions` needs `minScore?` too — add `readonly minScore?: number` to `RetrieveOptions` (used only by semantic mode). The `snippet` is `''` for vector hits in v1 (semantic match isn't span-located); a follow-up could derive a snippet from the source field. Document that.

- [ ] **Step 4: Run + full suite + commit**

`cd packages/hub && npx vitest run __tests__/embeddings-retrieve.test.ts && npx vitest run && npx eslint src && npx tsc --noEmit` → green.

```bash
git add packages/hub/src/search/retrieve-types.ts packages/hub/src/collection.ts packages/hub/__tests__/embeddings-retrieve.test.ts
git commit -m "feat(embeddings): retrieve(mode:semantic) + similarTo() (#308 L2)"
```

---

## Task 6: `forget()` teardown of `_vec` sidecars

**Files:**
- Modify: `packages/hub/src/collection.ts` (`_purgeVector(id)`)
- Modify: `packages/hub/src/vault.ts` (`forget()` per-ref purge + residue)
- Test: `packages/hub/__tests__/embeddings-forget.test.ts`

**Interfaces:**
- Produces: `Collection._purgeVector(id: string): Promise<void>` (delete `_vec/<id>` + `vectorSet?.markDirty()`).

- [ ] **Step 1: Write the failing test**

```ts
// packages/hub/__tests__/embeddings-forget.test.ts
// Copy the forget harness from forget.test.ts (withForgetCascade/forgetStrategy) +
// the enc() stub. Configure a collection with embeddings + forget subject. After
// vault.forget(subject), assert adapter.get(vault,'_vec',recordId) === null AND a
// subsequent retrieve(mode:'semantic') excludes the forgotten record. Add a
// resilience case: a store whose delete throws for '_vec' → forget resolves +
// surfaces residue. Write runnable; locate the real forget harness first.
```
Implementer: locate `forget.test.ts`'s subject/forget-strategy wiring, write the concrete tests (blob gone + excluded-from-semantic + delete-throws-resilience+residue).

- [ ] **Step 2: Run to verify it fails** — FAIL.

- [ ] **Step 3: Add `_purgeVector` + wire forget**

`collection.ts`:
```ts
  /** #308 L2 — drop a record's encrypted _vec sidecar on erasure (a vector is text-invertible). */
  async _purgeVector(id: string): Promise<void> {
    await this.adapter.delete(this.vault, '_vec', id)
    this.vectorSet?.markDirty()
  }
```
`vault.ts forget()` — in the PER-REF loop (beside `_purgePersistedIndexes(ref.id)`), add resilient purge:
```ts
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (coll as any)._purgeVector(ref.id)
      } catch {
        indexResidue.push(`${ref.collection}:${ref.id}:_vec`)
      }
```
(`coll` is the per-ref collection already obtained in that loop; mirror `_purgePersistedIndexes`'s try/catch + residue.)

- [ ] **Step 4: Run + full suite + commit**

`cd packages/hub && npx vitest run __tests__/embeddings-forget.test.ts && npx vitest run && npx tsc --noEmit` → green.

```bash
git add packages/hub/src/collection.ts packages/hub/src/vault.ts packages/hub/__tests__/embeddings-forget.test.ts
git commit -m "feat(embeddings): forget() purges encrypted _vec sidecars + residue (#308 L2)"
```

---

## Task 7: Docs, features.yaml, showcase, ceiling, final gate

**Files:** `docs/subsystems/`, `features.yaml`, `showcases/src/<next>`, `scripts/check-architecture.mjs`

- [ ] **Step 1: Subsystem doc** — create/extend an embeddings/vector-search subsystem doc: the `embeddings` config + `encode`-hook contract (host/remote, no bundled model), the encrypted-local privacy model (`_vec` sidecar, zero-knowledge, managed-backends-deferred), `retrieve(mode:'semantic')`/`similarTo`, model-versioning guard + `reindex`, `forget()` teardown, and the L2 line of the epic map. Commit `docs(embeddings): document semantic retrieval + encrypted-local model (#308 L2)`.
- [ ] **Step 2: features.yaml** — add a `vector-search` feature (`status: preview`, `experimental: true`) leading with the encrypted-local model + deferred managed-backend note; spec ref `docs/superpowers/specs/2026-06-22-ai-retrieval-l2-semantic-vector-design.md`; add the showcase. `node scripts/validate-features.mjs` must pass. Commit `chore(features): register vector-search (#308 L2)`.
- [ ] **Step 3: Showcase** — `showcases/src/<next>-semantic-retrieve.showcase.test.ts`: a collection with `embeddings` using a **deterministic stub encoder** (e.g. char-bucket hash → Float32Array, same as the tests — runs without a real model); put a few docs; `retrieve('<query>', {mode:'semantic'})` returns the nearest; demonstrate `similarTo()` and the model-mismatch guard. Build hub first (`cd packages/hub && npx tsup`), run it. Commit `docs(showcase): semantic retrieve walkthrough (#308 L2)`.
- [ ] **Step 4: Ceiling + final gate** —
```bash
cd packages/hub && npx tsup && npx vitest run && npx eslint src && npx tsc --noEmit
cd /Users/vicio/_github/noy-db && node scripts/check-architecture.mjs && node scripts/validate-features.mjs
```
If `collection.ts`/`vault.ts` exceed ceilings in `scripts/check-architecture.mjs`, raise each to `wc -l` + ~10 with a one-line `// Bumped …→… (#308 L2): embeddings derive/retrieve/forget call-sites (engine in src/embeddings/)` comment. Re-run until green. Commit any bump.

---

## Self-Review

**1. Spec coverage:** cosine → T1 ✓; `EmbeddingDescriptor` + source-text + errors → T2 ✓; `VectorSet` + model-guarded cosine kNN → T3 ✓; `embeddings` config + encode-on-write + encrypted `_vec` sidecar + dim error + not-hydrated → T4 ✓; `retrieve(mode:'semantic')` + `similarTo` + model guard + `rank` → T5 ✓; `forget()` `_vec` teardown + residue → T6 ✓; docs/features/showcase/ceiling + leakage tests → T4/T5/T7 ✓. Deferred per spec (managed backends, HNSW, chunking, `query().similarTo().where()` builder chaining, cross-vault, multimodal, combined-blob persistence) — correctly absent. NOTE: `vault.embeddings.reindex()` is referenced in errors/docs but NOT built as a task — v1 surfaces the model-mismatch error; `reindex` (re-derive all `_vec`) is a small follow-up. **Gap flagged**: either add a Task or document `reindex` as deferred (the error tells the user to re-derive; a manual re-put achieves it). Resolve by documenting `reindex` deferred in T7's doc.

**2. Placeholder scan:** T5 Step 1 and T6 Step 1 are "locate harness / write concrete tests with the deterministic stub" instructions (the encoder stub + forget harness must be read from the repo) — not code placeholders; all implementation steps carry full code. T2 Step 3 flags matching the real `NoydbError` ctor. T4 Step 4 flags the `version`-in-scope placement decision with a concrete fallback (write `_vec` after the record put). No "TBD"/bare "handle errors".

**3. Type consistency:** `EmbeddingDescriptor {source,encode,dim,model}` (T2) consumed verbatim in T4/T5. `StoredVector {id,vec,model}` + `VectorSet.cosineTopK(query,k,{minScore,expectModel})` (T3) used in T4 (`buildVectorLoad` returns `StoredVector[]`) + T5 (`similarTo`). `EmbeddingModelMismatchError`/`EmbeddingDimMismatchError` (T2) thrown in T3/T4/T5. `RetrieveOptions.mode`+`minScore` (T5) and the existing `RetrieveHit.rank` consistent. `_vec` reserved collection + id=recordId consistent across T4 (write/load), T6 (purge).
