/**
 * #1360 part 2 — THE CROSSOVER MEASUREMENT for the IVF-flat vector index.
 *
 * The sibling `vector-brute-force.bench.ts` measured *whether* to build an
 * approximate index. This one measures *what it bought*, on the same axis, so
 * the two tables can be read side by side:
 *
 *   - at what N does the index beat brute force, per dimension;
 *   - what the build costs, in seconds AND in brute-force-query-equivalents
 *     (the only unit in which a per-session index can be judged: the index
 *     dies with the process, so it must repay its build inside one session);
 *   - what it costs in memory;
 *   - what recall@10 it delivers at each `nprobe`, against exact brute force.
 *
 * ⚠️ Run with `--expose-gc` for the memory column to mean anything; without it
 * the delta is heap noise. `bench:ann` passes it.
 *
 * Run: `pnpm --filter @noy-db/test-benchmarks bench:ann`
 * Deliberately outside `vitest run`'s `*.test.ts` include — a measurement, not
 * an assertion. The ASSERTED recall floor lives in
 * `packages/hub/__tests__/embeddings-ivf-recall.test.ts`.
 */
import { describe, it } from 'vitest'
import { VectorSet, type StoredVector } from '../../../packages/hub/src/with-lookup/embeddings/vector-set.js'
import { IvfFlatIndex, defaultNlist } from '../../../packages/hub/src/with-lookup/embeddings/ivf-flat.js'

const K = 10

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
function gauss(r: () => number): number {
  const u = Math.max(r(), 1e-12)
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r())
}

/**
 * A CLUSTERED corpus, not a uniform one. Uniform high-dimensional noise is
 * nearly orthogonal everywhere, so the true top-10 is a near-tie among
 * thousands of candidates and every partitioning scheme measures as useless.
 * Real embeddings are clustered by topic; the queries are perturbed corpus
 * members, which is what a semantic query actually is.
 */
function corpus(n: number, dim: number, queries: number, seed = 4242): { vectors: StoredVector[]; queries: Float32Array[] } {
  const r = rng(seed)
  const topics = Math.max(8, Math.round(Math.sqrt(n) / 2))
  const centres = Array.from({ length: topics }, () => {
    const c = new Float32Array(dim)
    for (let i = 0; i < dim; i++) c[i] = gauss(r)
    return c
  })
  const vectors: StoredVector[] = []
  for (let i = 0; i < n; i++) {
    const c = centres[i % topics]!
    const v = new Float32Array(dim)
    for (let d = 0; d < dim; d++) v[d] = c[d]! + gauss(r) * 0.55
    vectors.push({ id: `r${i}`, model: 'bench', vec: v })
  }
  const qs: Float32Array[] = []
  for (let i = 0; i < queries; i++) {
    const base = vectors[Math.floor(r() * vectors.length)]!.vec!
    const q = new Float32Array(dim)
    for (let d = 0; d < dim; d++) q[d] = base[d]! + gauss(r) * 0.275
    qs.push(q)
  }
  return { vectors, queries: qs }
}

/** Minimum, not median: on a shared machine a query cannot run faster than its own work. */
function minMs(run: () => void, reps: number): number {
  for (let i = 0; i < 3; i++) run()
  let best = Infinity
  for (let i = 0; i < reps; i++) {
    const t0 = performance.now()
    run()
    best = Math.min(best, performance.now() - t0)
  }
  return best
}

function heapMB(): number {
  ;(globalThis as { gc?: () => void }).gc?.()
  return process.memoryUsage().heapUsed / 1024 / 1024
}

describe('#1360 part 2: IVF-flat vs brute force', () => {
  it('crossover, build cost, memory and recall', () => {
    const grid = [
      { n: 20_000, dim: 768 },
      { n: 50_000, dim: 768 },
      { n: 100_000, dim: 768 },
      { n: 100_000, dim: 384 },
      { n: 50_000, dim: 1536 },
    ]
    const rows: Record<string, string | number>[] = []
    for (const { n, dim } of grid) {
      const c = corpus(n, dim, 40)
      const exact = new VectorSet()
      ;(exact as unknown as { vectors: StoredVector[] }).vectors = c.vectors
      const bruteMs = minMs(() => { for (const q of c.queries.slice(0, 3)) exact.cosineTopK(q, K) }, 5) / 3
      const truth = c.queries.map((q) => new Set(exact.cosineTopK(q, K).map((h) => h.id)))

      for (const nlist of [defaultNlist(n), Math.round(Math.sqrt(n))]) {
        const before = heapMB()
        const idx = new IvfFlatIndex({ nlist })
        const t0 = performance.now()
        idx.build(c.vectors)
        const buildMs = performance.now() - t0
        const memMB = heapMB() - before

        for (const nprobe of [4, 8, 16, 32]) {
          if (nprobe > nlist) continue
          const annMs = minMs(() => { for (const q of c.queries.slice(0, 3)) idx.search(q, K, { nprobe }) }, 5) / 3
          let rec = 0
          for (let i = 0; i < c.queries.length; i++) {
            let hit = 0
            for (const h of idx.search(c.queries[i]!, K, { nprobe })) if (truth[i]!.has(h.id)) hit++
            rec += hit / K
          }
          rec /= c.queries.length
          rows.push({
            dim, vectors: n, nlist, nprobe,
            'brute ms': +bruteMs.toFixed(2),
            'ann ms': +annMs.toFixed(2),
            speedup: +(bruteMs / annMs).toFixed(1),
            'recall@10': +rec.toFixed(3),
            'build s': +(buildMs / 1000).toFixed(2),
            'build = N queries': Math.round(buildMs / bruteMs),
            'index MB': +memMB.toFixed(1),
          })
        }
      }
    }
    // eslint-disable-next-line no-console
    console.table(rows)
  }, 3_600_000)
})

describe('#1360 part 2: incremental maintenance cost', () => {
  it('per-put and per-forget cost against the full-rebuild it replaces', () => {
    const rows: Record<string, string | number>[] = []
    for (const { n, dim } of [{ n: 50_000, dim: 768 }, { n: 100_000, dim: 768 }]) {
      const c = corpus(n, dim, 1)
      const idx = new IvfFlatIndex()
      const t0 = performance.now()
      idx.build(c.vectors)
      const buildMs = performance.now() - t0
      const extra = corpus(200, dim, 0, 99).vectors.map((v, i) => ({ ...v, id: `new${i}` }))
      const t1 = performance.now()
      for (const v of extra) idx.upsert(v)
      const upsertMs = (performance.now() - t1) / extra.length
      const t2 = performance.now()
      for (const v of extra) idx.remove(v.id)
      const removeMs = (performance.now() - t2) / extra.length
      rows.push({
        dim, vectors: n, nlist: idx.nlist,
        'build ms': +buildMs.toFixed(0),
        'upsert µs': +(upsertMs * 1000).toFixed(1),
        'forget µs': +(removeMs * 1000).toFixed(1),
        'puts per rebuild': Math.round(buildMs / upsertMs),
      })
    }
    // eslint-disable-next-line no-console
    console.table(rows)
  }, 1_800_000)
})
