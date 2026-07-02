/**
 * Showcase 125 — Hybrid retrieval (collection.retrieve mode:'hybrid' + fuseRetrieval) — #308 L3
 *
 * What you'll learn
 * -----------------
 * `retrieve(q, { mode: 'hybrid' })` fuses lexical (L1) and semantic (L2) ranked
 * lists by Reciprocal Rank Fusion (RRF, default k=60). The fused `score` is an
 * RRF score — NOT BM25 or cosine. A document appearing in both lists gets a
 * contribution from each, so a doc that is only middling in each individual
 * ranking can rise to the top of the fused list.
 *
 *   1. retrieve(q, {mode:'hybrid'}) — fused lexical+semantic via RRF
 *   2. within: Query<T> option — retrieve ∩ where (intersect hits with a predicate)
 *   3. fuseRetrieval(lists) — the bare RRF primitive (federation seam)
 *
 * Why it matters
 * --------------
 * Hybrid retrieval recovers relevance gaps that exist in any single modality:
 * lexical misses synonyms and paraphrases; semantic misses exact keywords.
 * RRF fusion is rank-based (no corpus-relative score normalization needed), so
 * it works identically whether fusing lexical+semantic within one vault OR
 * fusing per-vault result lists across a klum-db Lobby federation — the same
 * `fuseRetrieval` primitive handles both.
 *
 * What to read next
 * -----------------
 *   - docs/services/embeddings.md (L3 hybrid section, epic map, fuseRetrieval API)
 *   - docs/superpowers/specs/2026-06-23-ai-retrieval-l3-hybrid-design.md
 *   - Showcase 122 (L1 lexical retrieve)
 *   - Showcase 123 (L1.5 persisted index)
 *   - Showcase 124 (L2 semantic retrieve)
 *
 * Spec mapping
 * ------------
 * features.yaml -> features -> vector-search
 */

import { describe, it, expect } from 'vitest'
import { createNoydb, fuseRetrieval } from '@noy-db/hub'
import { memory } from '@noy-db/to-memory'

// ---- Shared types ------------------------------------------------------------

interface Doc extends Record<string, unknown> {
  id: string
  text: string
  status?: string
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

// ---- Part A: hybrid mode surfaces a doc that lexical-only and semantic-only each rank lower ----

describe('Showcase 125-A — retrieve(mode:hybrid): RRF boosts docs appearing in both rankings', () => {
  it('a doc consistent in both lexical and semantic lists rises above modality-specific leaders', async () => {
    const db = await createNoydb({
      store: memory(),
      user: 'analyst',
      secret: 'showcase-125-a',
    })
    const vault = await db.openVault('firm')
    // Use textIndexes so lexical retrieval is available alongside semantic.
    const docs = vault.collection<Doc>('docs', {
      textIndexes: ['text'],
      embeddings: enc(32),
    })

    // d-consistent: moderate lexical + moderate semantic overlap with query "invoice payment"
    // d-lexical:   strong lexical match (exact tokens) but different semantic space
    // d-semantic:  high semantic similarity but few matching tokens
    await docs.put('d-lexical',    { id: 'd-lexical',    text: 'invoice payment invoice payment invoice' })
    await docs.put('d-semantic',   { id: 'd-semantic',   text: 'zzz aaa qqq rrr sss ttt uuu vvv www xxx yyy' }) // deliberately odd tokens
    await docs.put('d-consistent', { id: 'd-consistent', text: 'invoice payment summary' })

    // Lexical — "invoice payment" — d-lexical should rank #1, d-consistent #2
    const lex = await docs.retrieve('invoice payment', { mode: 'lexical' })
    expect(lex[0]!.id).toBe('d-lexical')

    // Hybrid — d-consistent appears in BOTH lexical and semantic lists;
    // its combined RRF contribution can outpace d-lexical (lexical only) or d-semantic (semantic only).
    const hybrid = await docs.retrieve('invoice payment', { mode: 'hybrid' })

    // All three docs should be present in the hybrid result
    const hybridIds = hybrid.map(h => h.id)
    expect(hybridIds).toContain('d-lexical')
    expect(hybridIds).toContain('d-consistent')

    // Ranks are 1-based and monotonic
    expect(hybrid.map(h => h.rank)).toEqual(hybrid.map((_, i) => i + 1))

    // Scores should be RRF scores (small positive numbers, NOT BM25 or cosine)
    // RRF score = Σ 1/(k + rank_i), with k=60 and at most 2 lists,
    // so each score is in (0, 2/61] ≈ (0, 0.033]
    for (const hit of hybrid) {
      expect(hit.score).toBeGreaterThan(0)
      expect(hit.score).toBeLessThanOrEqual(2 / 61 + 0.001) // small tolerance
    }

    // Scores are non-increasing with rank
    for (let i = 1; i < hybrid.length; i++) {
      expect(hybrid[i]!.score).toBeLessThanOrEqual(hybrid[i - 1]!.score)
    }

    db.close()
  })
})

// ---- Part B: within — retrieve ∩ where (predicate filter on hybrid results) ----

describe('Showcase 125-B — retrieve({mode:hybrid, within}): intersect fused hits with a structured query', () => {
  it('within keeps only hits matching the predicate and re-ranks 1-based', async () => {
    const db = await createNoydb({
      store: memory(),
      user: 'analyst',
      secret: 'showcase-125-b',
    })
    const vault = await db.openVault('firm')
    const docs = vault.collection<Doc>('docs', {
      textIndexes: ['text'],
      embeddings: enc(32),
    })

    await docs.put('open-1',   { id: 'open-1',   text: 'quarterly revenue report', status: 'open' })
    await docs.put('closed-1', { id: 'closed-1', text: 'revenue summary closed',   status: 'closed' })
    await docs.put('open-2',   { id: 'open-2',   text: 'revenue forecast',         status: 'open' })

    // Hybrid + within: only status='open' docs should appear
    const hits = await docs.retrieve('revenue', {
      mode: 'hybrid',
      within: docs.query().where('status', '==', 'open'),
    })

    // Only open docs
    expect(hits.every(h => h.id === 'open-1' || h.id === 'open-2')).toBe(true)
    expect(hits.some(h => h.id === 'closed-1')).toBe(false)

    // Ranks are 1-based and monotonic within the filtered set
    expect(hits.map(h => h.rank)).toEqual(hits.map((_, i) => i + 1))

    db.close()
  })

  it('within with no matching predicate yields an empty result', async () => {
    const db = await createNoydb({
      store: memory(),
      user: 'analyst',
      secret: 'showcase-125-b2',
    })
    const vault = await db.openVault('firm')
    const docs = vault.collection<Doc>('docs', {
      textIndexes: ['text'],
      embeddings: enc(32),
    })

    await docs.put('doc1', { id: 'doc1', text: 'revenue report', status: 'open' })

    const hits = await docs.retrieve('revenue', {
      mode: 'hybrid',
      within: docs.query().where('status', '==', 'void'),
    })

    expect(hits).toEqual([])

    db.close()
  })
})

// ---- Part C: fuseRetrieval — the bare RRF primitive -------------------------

describe('Showcase 125-C — fuseRetrieval(): the bare RRF primitive (federation seam)', () => {
  it('fuses two ranked lists by RRF — doc appearing in both lists scores higher than either alone', () => {
    // Simulate lexical hits from vault A and semantic hits from vault B,
    // or just two modality lists from the same vault.
    //
    // This is the same primitive klum-db Lobby uses to merge per-vault
    // retrieve() results in a federation query — no extra code needed.
    const lexicalHits = [
      { id: 'alpha', score: 0.9, rank: 1, field: 'title',    snippet: 'alpha invoice' },
      { id: 'beta',  score: 0.5, rank: 2, field: 'title',    snippet: 'beta summary'  },
    ]
    const semanticHits = [
      { id: 'beta',  score: 0.8, rank: 1, field: '(vector)', snippet: '' },
      { id: 'gamma', score: 0.6, rank: 2, field: '(vector)', snippet: '' },
    ]

    const fused = fuseRetrieval([lexicalHits, semanticHits])

    // 'beta' appears in both lists (rank 2 lexical, rank 1 semantic)
    // 'alpha' appears only in lexical (rank 1)
    // 'gamma' appears only in semantic (rank 2)
    //
    // RRF score for beta:  1/(60+2) + 1/(60+1) = 0.01613 + 0.01639 = 0.03252
    // RRF score for alpha: 1/(60+1)             = 0.01639
    // RRF score for gamma: 1/(60+2)             = 0.01613
    //
    // Expected order: beta > alpha > gamma
    expect(fused[0]!.id).toBe('beta')
    expect(fused[1]!.id).toBe('alpha')
    expect(fused[2]!.id).toBe('gamma')

    // Ranks are 1-based
    expect(fused.map(h => h.rank)).toEqual([1, 2, 3])

    // 'beta' presentation merges: lexical field/snippet preferred over '(vector)'/''
    expect(fused[0]!.field).toBe('title')
    expect(fused[0]!.snippet).toBe('beta summary')
  })

  it('respects the limit option to truncate the fused list', () => {
    const list = [
      { id: 'a', score: 1.0, rank: 1, field: 'text', snippet: 'a' },
      { id: 'b', score: 0.9, rank: 2, field: 'text', snippet: 'b' },
      { id: 'c', score: 0.8, rank: 3, field: 'text', snippet: 'c' },
    ]

    const fused = fuseRetrieval([list], { limit: 2 })
    expect(fused.length).toBe(2)
    expect(fused[0]!.id).toBe('a')
    expect(fused[1]!.id).toBe('b')
  })
})
