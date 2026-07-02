/**
 * Showcase 124 — Semantic / vector retrieval (collection.retrieve mode:'semantic' + similarTo) — #308 L2
 *
 * What you'll learn
 * -----------------
 * `collection.embeddings` derives a Float32Array vector for every record at
 * write time (encrypted under the collection DEK in a _vec sidecar), then
 * `retrieve(q, { mode: 'semantic' })` encodes the query with the same hook
 * and returns ranked hits by brute-force cosine similarity — all in the
 * trusted tier, zero store leakage of vector values or source text.
 *
 *   1. retrieve(q, {mode:'semantic'}) — query string path (encode + cosine)
 *   2. collection.similarTo(vec, {k}) — raw-vector path (bring your own vector)
 *   3. Model-version guard — EmbeddingModelMismatchError when stored model != descriptor model
 *
 * Why it matters
 * --------------
 * Semantic retrieval in the trusted tier (encrypted vectors, local cosine) is
 * the right model for private data — analogous to Apple Intelligence's on-device
 * semantic index. The store sees only ciphertext; vector values and source text
 * never leave your control.
 *
 * What to read next
 * -----------------
 *   - docs/services/embeddings.md (epic map, privacy model, API reference)
 *   - docs/superpowers/specs/2026-06-22-ai-retrieval-l2-semantic-vector-design.md
 *   - Showcase 122 (L1 lexical retrieve — collection.retrieve mode:'lexical')
 *   - Showcase 123 (L1.5 persisted index — textIndexPersist)
 *
 * Spec mapping
 * ------------
 * features.yaml -> features -> vector-search
 */

import { describe, it, expect } from 'vitest'
import { createNoydb, EmbeddingModelMismatchError } from '@noy-db/hub'
import { memory } from '@noy-db/to-memory'

// ---- Shared types ------------------------------------------------------------

interface Doc extends Record<string, unknown> {
  id: string
  text: string
}

// Deterministic stub encoder: bag-of-chars hash -> Float32Array of given dim.
// Each character increments the bucket at (charCode % dim). Different strings
// produce meaningfully different vectors, making similarity reproducible in tests.
const enc = (dim: number, model = 'stub') => ({
  dim,
  model,
  source: 'text' as const,
  encode: async (t: string) => {
    const v = new Float32Array(dim)
    for (let i = 0; i < t.length; i++) v[t.charCodeAt(i) % dim] += 1
    return v
  },
})

// ---- Part A: retrieve(q, {mode:'semantic'}) -----------------------------------

describe('Showcase 124-A — retrieve(mode:semantic): query-string path', () => {
  it('returns rank-1 as the exact-match doc; all hits carry rank and positive score', async () => {
    const db = await createNoydb({
      store: memory(),
      user: 'analyst',
      secret: 'showcase-124-a',
    })
    const vault = await db.openVault('firm')
    const docs = vault.collection<Doc>('docs', { embeddings: enc(16) })

    await docs.put('invoice', { id: 'invoice', text: 'overdue invoice payment' })
    await docs.put('client',  { id: 'client',  text: 'client account setup' })
    await docs.put('report',  { id: 'report',  text: 'quarterly financial report' })

    // Query that exactly matches 'invoice' record text.
    const hits = await docs.retrieve('overdue invoice payment', { mode: 'semantic' })

    expect(hits.length).toBeGreaterThan(0)
    // The exact-match record should be ranked first.
    expect(hits[0]!.id).toBe('invoice')
    expect(hits[0]!.rank).toBe(1)
    expect(hits[0]!.score).toBeGreaterThan(0)

    // Ranks are 1-based and monotonic; scores are non-increasing.
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i]!.rank).toBe(i + 1)
      expect(hits[i]!.score).toBeLessThanOrEqual(hits[i - 1]!.score)
    }

    db.close()
  })
})

// ---- Part B: collection.similarTo(vec, {k}) -----------------------------------

describe('Showcase 124-B — similarTo(vec, {k:1}): raw-vector path', () => {
  it('returns the doc whose encoding is closest to the supplied vector', async () => {
    const db = await createNoydb({
      store: memory(),
      user: 'analyst',
      secret: 'showcase-124-b',
    })
    const vault = await db.openVault('firm')
    const encoder = enc(16)
    const docs = vault.collection<Doc>('docs', { embeddings: encoder })

    await docs.put('alpha', { id: 'alpha', text: 'alpha text example query' })
    await docs.put('beta',  { id: 'beta',  text: 'completely different content zzzzzz' })

    // Encode the query ourselves and pass the raw vector.
    const queryVec = await encoder.encode('alpha text example query')
    const hits = await docs.similarTo(queryVec, { k: 1 })

    expect(hits.length).toBe(1)
    expect(hits[0]!.id).toBe('alpha')
    expect(hits[0]!.score).toBeGreaterThan(0)

    db.close()
  })
})

// ---- Part C: model-version guard -----------------------------------------------

describe('Showcase 124-C — model-version guard: EmbeddingModelMismatchError', () => {
  it('throws EmbeddingModelMismatchError when the descriptor model differs from stored vectors', async () => {
    const store = memory()

    // Session 1: write vectors under model 'stub-v1'.
    const db1 = await createNoydb({ store, user: 'analyst', secret: 'showcase-124-c' })
    const v1 = await db1.openVault('firm')
    const c1 = v1.collection<Doc>('docs', { embeddings: enc(16, 'stub-v1') })
    await c1.put('doc1', { id: 'doc1', text: 'some document text here' })
    db1.close()

    // Session 2: re-open with a DIFFERENT model tag ('stub-v2').
    // The stored vectors are tagged 'stub-v1'; the descriptor says 'stub-v2'.
    // Cosine across model versions is meaningless — noy-db guards this.
    const db2 = await createNoydb({ store, user: 'analyst', secret: 'showcase-124-c' })
    const v2 = await db2.openVault('firm')
    const c2 = v2.collection<Doc>('docs', { embeddings: enc(16, 'stub-v2') })

    await expect(
      c2.retrieve('some document text here', { mode: 'semantic' }),
    ).rejects.toThrow(EmbeddingModelMismatchError)

    db2.close()
  })
})
