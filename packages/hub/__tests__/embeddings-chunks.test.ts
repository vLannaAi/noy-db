/**
 * #1360 (1) — sub-document chunking: multiple vectors per record, top-k over
 * chunks folded to records with the BEST-chunk score, and the matched span
 * returned so a consumer can render a snippet.
 *
 * The three load-bearing properties, one describe each:
 *
 *  1. **Best-chunk folding.** Two chunks of the same record both scoring high
 *     yield ONE hit at the BEST score — never a duplicate record, and never a
 *     summed score (which would reward long documents for being long).
 *  2. **`span` is honest.** A span is a pair of CHARACTER OFFSETS into
 *     `embeddingSourceText(record, descriptor.source)` — the same joined
 *     source text the vectors are derived from — so
 *     `sourceText.slice(start, end)` is exactly the chunk that matched. The
 *     test slices it and compares.
 *  3. **No chunks ⇒ no change.** A descriptor with no `chunk` hook (and one
 *     whose hook returns no spans) stores the same single-vector body as
 *     before and answers `similarTo()` identically.
 *
 * Plus: chunk vectors live in the SAME encrypted `_vec` sidecar as the
 * whole-record vector always has — no plaintext vector reaches the store.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/kernel/noydb.js'
import { withSearch } from '../src/index.js'
import { embeddingSourceText, normalizeChunkSpans, VectorSet } from '../src/with-lookup/embeddings/index.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { ConflictError, EmbeddingDimMismatchError } from '../src/kernel/errors.js'

function toMemory(): NoydbStore {
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
      if (comp) for (const [n, coll] of comp) if (!n.startsWith('_')) {
        const r: Record<string, EncryptedEnvelope> = {}; for (const [id, e] of coll) r[id] = e; s[n] = r
      }
      return s
    },
    async saveAll(c, data) {
      const comp = new Map<string, Map<string, EncryptedEnvelope>>()
      for (const [name, records] of Object.entries(data)) {
        const coll = new Map<string, EncryptedEnvelope>()
        for (const [id, env] of Object.entries(records)) coll.set(id, env)
        comp.set(name, coll)
      }
      const existing = store.get(c)
      if (existing) for (const [name, coll] of existing) if (name.startsWith('_')) comp.set(name, coll)
      store.set(c, comp)
    },
  }
}

interface Doc { id: string; text: string }

/** Deterministic stub encoder — bag-of-chars hash, same one the other embedding suites use. */
const enc = (dim: number, model = 'stub') => ({
  dim, model, source: 'text' as const,
  encode: async (t: string) => { const v = new Float32Array(dim); for (let i = 0; i < t.length; i++) { const idx = t.charCodeAt(i) % dim; v[idx] = (v[idx] ?? 0) + 1 } return v },
})

/** Split on the literal '|' separator — spans are offsets into the joined source text. */
const splitOnPipe = (text: string) => {
  const spans: { start: number; end: number }[] = []
  let start = 0
  for (;;) {
    const i = text.indexOf('|', start)
    const end = i === -1 ? text.length : i
    if (end > start) spans.push({ start, end })
    if (i === -1) break
    start = i + 1
  }
  return spans
}

// ── 1. Best-chunk folding ────────────────────────────────────────────────────

describe('#1360 best-chunk folding: chunks fold to ONE record hit at the BEST score', () => {
  it('a record whose two chunks both match returns exactly one hit, scored max — not duplicated, not summed', async () => {
    const db = await createNoydb({ store: toMemory(), user: 'a', secret: 'pw-chunk-fold', searchStrategy: withSearch() })
    const v = await db.openVault('v')
    const encoder = { ...enc(16), chunk: splitOnPipe }
    const c = v.collection<Doc>('docs', { embeddings: encoder })

    // `long` has TWO chunks that each equal the query text exactly.
    await c.put('long', { id: 'long', text: 'overdue invoice|overdue invoice|zzzz filler qqqq' })
    // `short` has ONE chunk equal to the query text.
    await c.put('short', { id: 'short', text: 'overdue invoice' })

    const qVec = await encoder.encode('overdue invoice')
    const hits = await c.similarTo(qVec, { k: 10 })

    // ONE hit per record — no duplicate row for the second matching chunk.
    expect(hits.filter((h) => h.id === 'long')).toHaveLength(1)
    expect(hits.map((h) => h.id).sort()).toEqual(['long', 'short'])

    const long = hits.find((h) => h.id === 'long')!
    const short = hits.find((h) => h.id === 'short')!
    // Best-chunk, not summed: both records match perfectly, so scores are equal.
    expect(long.score).toBeCloseTo(1, 6)
    expect(long.score).toBeCloseTo(short.score, 6)
    // A summed score would be ~2 and would rank `long` above `short`.
    expect(long.score).toBeLessThanOrEqual(1.0000001)
  })

  it('VectorSet.cosineTopK folds chunks to one hit and reports the winning chunk', () => {
    const vs = new VectorSet()
    const q = new Float32Array([1, 0])
    const set = vs as unknown as { vectors: unknown }
    set.vectors = [
      { id: 'r1', model: 'm', chunks: [
        { id: 'c0', start: 0, end: 3, vec: new Float32Array([0, 1]) },   // score 0
        { id: 'c1', start: 4, end: 7, vec: new Float32Array([1, 0]) },   // score 1  ← winner
      ] },
      { id: 'r2', model: 'm', vec: new Float32Array([1, 1]) },
    ]
    const hits = vs.cosineTopK(q, 10)
    expect(hits).toHaveLength(2)
    expect(hits[0]!.id).toBe('r1')
    expect(hits[0]!.score).toBeCloseTo(1, 6)
    expect(hits[0]!.chunk).toEqual({ id: 'c1', start: 4, end: 7 })
    expect(hits[1]!.id).toBe('r2')
    expect(hits[1]!.chunk).toBeUndefined()
  })
})

// ── 2. `span` locates the text it claims ─────────────────────────────────────

describe('#1360 span: character offsets into embeddingSourceText(record, source)', () => {
  it('the returned span slices the source text back to exactly the matching chunk, and is echoed as the snippet', async () => {
    const db = await createNoydb({ store: toMemory(), user: 'a', secret: 'pw-chunk-span', searchStrategy: withSearch() })
    const v = await db.openVault('v')
    const encoder = { ...enc(16), chunk: splitOnPipe }
    const c = v.collection<Doc>('docs', { embeddings: encoder })

    const record: Doc = { id: 'd', text: 'boring preamble|the overdue invoice clause|trailing notes' }
    await c.put('d', record)

    const qVec = await encoder.encode('the overdue invoice clause')
    const hits = await c.similarTo(qVec, { k: 1 })
    expect(hits).toHaveLength(1)
    const hit = hits[0]!
    expect(hit.chunk).toBeDefined()

    // The span indexes into the JOINED source text — the same string the
    // vectors were derived from — so slicing it yields the chunk verbatim.
    const sourceText = embeddingSourceText(record as unknown as Record<string, unknown>, encoder.source)
    expect(sourceText.slice(hit.chunk!.start, hit.chunk!.end)).toBe('the overdue invoice clause')
    expect(hit.snippet).toBe('the overdue invoice clause')
  })

  it('spans index into the JOINED text when `source` is several fields, not into one field', async () => {
    interface Two { id: string; a: string; b: string }
    const db = await createNoydb({ store: toMemory(), user: 'a', secret: 'pw-chunk-join', searchStrategy: withSearch() })
    const v = await db.openVault('v')
    const base = enc(16)
    const encoder = { ...base, source: ['a', 'b'] as const, chunk: splitOnPipe }
    const c = v.collection<Two>('docs', { embeddings: encoder })

    const record: Two = { id: 'd', a: 'first field text', b: 'second|target clause here' }
    await c.put('d', record)

    const qVec = await encoder.encode('target clause here')
    const hits = await c.similarTo(qVec, { k: 1 })
    const hit = hits[0]!
    const sourceText = embeddingSourceText(record as unknown as Record<string, unknown>, encoder.source)
    // 'first field text second|target clause here' — the winning span sits past
    // the join boundary, which only works because offsets are into the join.
    expect(sourceText.slice(hit.chunk!.start, hit.chunk!.end)).toBe('target clause here')
    expect(hit.chunk!.start).toBeGreaterThan('first field text'.length)
  })
})

// ── 3. No chunks ⇒ byte-for-byte the old behaviour ───────────────────────────

describe('#1360 no-chunks regression guard: a descriptor with no chunk hook is unchanged', () => {
  it('stores a single-vector body with NO `chunks` key, and similarTo returns snippet "" and no chunk', async () => {
    const store = toMemory()
    const db = await createNoydb({ store, user: 'a', secret: 'pw-chunk-none', searchStrategy: withSearch() })
    const v = await db.openVault('v')
    const encoder = enc(8)   // no `chunk` hook
    const c = v.collection<Doc>('docs', { embeddings: encoder })
    await c.put('alpha', { id: 'alpha', text: 'alpha text example' })
    await c.put('beta', { id: 'beta', text: 'beta completely different zzzzzz' })

    const raw = await store.get('v', '_vec', 'docs/alpha')
    expect(raw).not.toBeNull()
    // Ciphertext, as always — no plaintext vector, no plaintext source text.
    expect(JSON.stringify(raw)).not.toContain('alpha text example')
    expect(JSON.stringify(raw)).not.toContain('"vec"')
    expect(JSON.stringify(raw)).not.toContain('"chunks"')

    const hits = await c.similarTo(await encoder.encode('alpha text example'), { k: 1 })
    expect(hits).toHaveLength(1)
    expect(hits[0]!.id).toBe('alpha')
    expect(hits[0]!.snippet).toBe('')
    expect(hits[0]!.chunk).toBeUndefined()
    expect(hits[0]!.field).toBe('(vector)')
  })

  it('a chunk hook that yields no spans falls back to the whole-record vector', async () => {
    const db = await createNoydb({ store: toMemory(), user: 'a', secret: 'pw-chunk-empty', searchStrategy: withSearch() })
    const v = await db.openVault('v')
    const encoder = { ...enc(8), chunk: () => [] }
    const c = v.collection<Doc>('docs', { embeddings: encoder })
    await c.put('alpha', { id: 'alpha', text: 'alpha text example' })

    const hits = await c.similarTo(await encoder.encode('alpha text example'), { k: 1 })
    expect(hits[0]!.id).toBe('alpha')
    expect(hits[0]!.chunk).toBeUndefined()
  })
})

// ── 4. Chunk vectors are encrypted at rest, and dimension-checked ────────────

describe('#1360 chunk vectors: encrypted sidecar, dimension-checked', () => {
  it('no plaintext chunk vector or chunk text reaches the store', async () => {
    const store = toMemory()
    const db = await createNoydb({ store, user: 'a', secret: 'pw-chunk-enc', searchStrategy: withSearch() })
    const v = await db.openVault('v')
    const encoder = { ...enc(16), chunk: splitOnPipe }
    const c = v.collection<Doc>('docs', { embeddings: encoder })
    await c.put('d', { id: 'd', text: 'sensitive clause one|sensitive clause two' })

    const raw = await store.get('v', '_vec', 'docs/d')
    const asText = JSON.stringify(raw)
    expect(asText).not.toContain('sensitive clause')
    expect(asText).not.toContain('"chunks"')
    expect(asText).not.toContain('"start"')
    // The vector sidecar is the ONLY place chunk vectors live: no new store collection.
    expect((await store.list('v', '_vec'))).toEqual(['docs/d'])
  })

  it('a chunk vector of the wrong dimension throws EmbeddingDimMismatchError', async () => {
    const db = await createNoydb({ store: toMemory(), user: 'a', secret: 'pw-chunk-dim', searchStrategy: withSearch() })
    const v = await db.openVault('v')
    const base = enc(8)
    // encode() returns dim 8 for short text but dim 4 for the second chunk.
    const encoder = {
      ...base,
      chunk: splitOnPipe,
      encode: async (t: string) => (t === 'bad' ? new Float32Array(4) : base.encode(t)),
    }
    const c = v.collection<Doc>('docs', { embeddings: encoder })
    await expect(c.put('d', { id: 'd', text: 'good|bad' })).rejects.toThrow(EmbeddingDimMismatchError)
  })
})

// ── 5. Span normalisation: a degenerate splitter degrades, never throws ───────

describe('#1360 normalizeChunkSpans: invalid spans are DROPPED, not thrown on', () => {
  it('drops zero-width, inverted, out-of-range and non-integer spans and keeps the rest', () => {
    const kept = normalizeChunkSpans(
      [
        { start: 0, end: 4 },      // keep
        { start: 4, end: 4 },      // zero-width  — a trailing separator match
        { start: 6, end: 2 },      // inverted
        { start: -1, end: 3 },     // before the string
        { start: 5, end: 99 },     // past the end
        { start: 1.5, end: 4 },    // non-integer
        { start: 5, end: 9 },      // keep
      ],
      10,
    )
    expect(kept).toEqual([
      { id: 'c0', start: 0, end: 4 },
      { id: 'c1', start: 5, end: 9 },
    ])
  })

  it('ids default to c<index> over the KEPT spans, and a supplied id wins', () => {
    // The default id numbers the kept spans, not the proposed ones — so a
    // dropped span never leaves a hole in the id sequence.
    expect(normalizeChunkSpans([{ start: 3, end: 3 }, { start: 0, end: 2 }], 5)).toEqual([{ id: 'c0', start: 0, end: 2 }])
    expect(normalizeChunkSpans([{ start: 0, end: 2, id: 'clause-7' }], 5)).toEqual([{ id: 'clause-7', start: 0, end: 2 }])
  })

  it('a splitter proposing only invalid spans yields none — the caller then falls back to the whole-record vector', () => {
    expect(normalizeChunkSpans([{ start: 2, end: 1 }, { start: 9, end: 20 }], 5)).toEqual([])
  })
})
