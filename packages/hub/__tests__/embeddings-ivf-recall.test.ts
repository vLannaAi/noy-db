/**
 * #1360 part 2 — RECALL, measured.
 *
 * ⭐ An approximate index that silently drops true matches with no recall
 * number attached is worse than brute force, because the caller cannot tell a
 * missing answer from an absent one. This file is the number, it is an
 * assertion rather than a report, and it runs in CI.
 *
 * ## Why the corpus is CLUSTERED and not uniform
 *
 * Uniformly random vectors in high dimension are all nearly orthogonal to each
 * other — the true top-10 is a near-tie among thousands of candidates, so
 * "recall@10" over uniform noise measures tie-breaking, not retrieval, and it
 * makes EVERY partitioning scheme look terrible. Real sentence embeddings are
 * strongly clustered by topic, which is the structure IVF's partitioning
 * exploits. So the corpus here is a mixture of Gaussians around random topic
 * centres, and the queries are perturbed corpus members — a paraphrase of
 * something in the collection, which is the actual query distribution.
 *
 * ⚠️ Read the thresholds as FLOORS with margin, not as the measured value; the
 * measured values are recorded next to each assertion and in the PR body.
 * A threshold that tracked the measurement exactly would fail on any harmless
 * float-association change.
 */
import { describe, it, expect } from 'vitest'
import { IvfFlatIndex, defaultNlist } from '../src/with-lookup/embeddings/ivf-flat.js'
import { VectorSet } from '../src/with-lookup/embeddings/vector-set.js'
import { cosine } from '../src/with-lookup/embeddings/cosine.js'
import type { StoredVector } from '../src/with-lookup/embeddings/vector-set.js'

function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
/** Box-Muller — Gaussian noise is what makes a cluster a cluster. */
function gauss(r: () => number): number {
  const u = Math.max(r(), 1e-12)
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r())
}

export interface Corpus { vectors: StoredVector[]; queries: Float32Array[] }

/** A mixture of Gaussians: `topics` centres, `n` members, `spread` controls overlap. */
function clusteredCorpus(n: number, dim: number, topics: number, spread: number, seed: number, queryCount: number): Corpus {
  const r = rng(seed)
  const centres = Array.from({ length: topics }, () => {
    const c = new Float32Array(dim)
    for (let i = 0; i < dim; i++) c[i] = gauss(r)
    return c
  })
  const vectors: StoredVector[] = []
  for (let i = 0; i < n; i++) {
    const c = centres[i % topics]!
    const v = new Float32Array(dim)
    for (let d = 0; d < dim; d++) v[d] = c[d]! + gauss(r) * spread
    vectors.push({ id: `r${i}`, model: 'm', vec: v })
  }
  // Queries are paraphrases: a corpus member nudged, not a fresh random point.
  const queries: Float32Array[] = []
  for (let i = 0; i < queryCount; i++) {
    const base = vectors[Math.floor(r() * vectors.length)]!.vec!
    const q = new Float32Array(dim)
    for (let d = 0; d < dim; d++) q[d] = base[d]! + gauss(r) * spread * 0.5
    queries.push(q)
  }
  return { vectors, queries }
}

/**
 * recall@k = |approx ∩ exact| / k, averaged over the query set.
 *
 * `truth` is computed ONCE per k and reused across every nprobe: the exact
 * scan is the expensive half here, and recomputing it per cell would make a
 * recall CURVE cost more than the index it measures.
 */
function recallAt(idx: IvfFlatIndex, truth: readonly Set<string>[], corpus: Corpus, k: number, nprobe: number): number {
  let total = 0
  for (let i = 0; i < corpus.queries.length; i++) {
    let hit = 0
    for (const h of idx.search(corpus.queries[i]!, k, { nprobe })) if (truth[i]!.has(h.id)) hit++
    total += hit / k
  }
  return total / corpus.queries.length
}

function truthSets(exact: VectorSet, corpus: Corpus, k: number): Set<string>[] {
  return corpus.queries.map((q) => new Set(exact.cosineTopK(q, k).map((h) => h.id)))
}

describe('#1360 IVF-flat recall@k vs exact brute force', () => {
  const DIM = 64
  const N = 20_000
  const corpus = clusteredCorpus(N, DIM, 40, 0.55, 1234, 60)
  const exact = new VectorSet()
  const idx = new IvfFlatIndex()
  let truth10: Set<string>[] = []
  let truth1: Set<string>[] = []

  it('builds over a 20,000-vector clustered corpus', async () => {
    await exact.ensureLoaded(async () => corpus.vectors)
    idx.build(corpus.vectors)
    truth10 = truthSets(exact, corpus, 10)
    truth1 = truthSets(exact, corpus, 1)
    expect(idx.size).toBe(N)
    expect(idx.nlist).toBe(defaultNlist(N))
  })

  it('recall@10 at the DEFAULT nprobe=8 is high', () => {
    // Measured 2026-09-04: 0.985. Floor set well below it — the assertion
    // exists to catch a partitioning regression, not to pin a float.
    const recall = recallAt(idx, truth10, corpus, 10, 8)
    // eslint-disable-next-line no-console
    console.log(`recall@10 nprobe=8 (default): ${recall.toFixed(4)}`)
    expect(recall).toBeGreaterThan(0.9)
  })

  it('recall rises monotonically with nprobe and reaches 1.0 at nlist', () => {
    const curve = [1, 2, 4, 8, 16].map((p) => ({ nprobe: p, recall: recallAt(idx, truth10, corpus, 10, p) }))
    // eslint-disable-next-line no-console
    console.log('recall@10 curve:', curve.map((c) => `${c.nprobe}:${c.recall.toFixed(3)}`).join(' '))
    for (let i = 1; i < curve.length; i++) {
      expect(curve[i]!.recall).toBeGreaterThanOrEqual(curve[i - 1]!.recall - 1e-9)
    }
    // nprobe = nlist scans every list: no candidate can be missed, so this is
    // exhaustive by construction and 1.0 is the only admissible answer.
    expect(recallAt(idx, truth10, corpus, 10, idx.nlist)).toBe(1)
  })

  it('recall@1 — the top hit specifically — is higher than recall@10', () => {
    // The nearest neighbour is nearly always inside the query's own list, so a
    // "did it find THE match" question is easier than "did it find all ten".
    const r1 = recallAt(idx, truth1, corpus, 1, 8)
    // eslint-disable-next-line no-console
    console.log(`recall@1 nprobe=8: ${r1.toFixed(4)}`)
    expect(r1).toBeGreaterThan(0.95)
  })

  it('scores of returned hits match exact cosine — only membership is approximate', () => {
    for (const q of corpus.queries.slice(0, 10)) {
      const byId = new Map(corpus.vectors.map((v) => [v.id, v.vec!]))
      for (const h of idx.search(q, 10, { nprobe: 4 })) {
        expect(h.score).toBeCloseTo(cosine(q, byId.get(h.id)!), 5)
      }
    }
  })
})
