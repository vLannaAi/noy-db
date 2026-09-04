/**
 * #1360 part 2 — THE CROSSOVER MEASUREMENT for the IVF-flat vector index.
 *
 * The sibling `vector-brute-force.bench.ts` measured *whether* to build an
 * approximate index. This one measures *what it bought*, on the same axis, so
 * the two tables can be read side by side:
 *
 *   - at what N does the index beat brute force, per dimension — reported
 *     primarily as `scan %`, the fraction of the corpus a query scores, which
 *     is exact arithmetic and identical on every machine. Wall-clock columns
 *     are kept but are SECONDARY: measured 2026-09-04 on a machine running ~90
 *     other processes, the naive timing came out non-monotonic in `nprobe`
 *     (an exhaustive scan "faster" than a single probe), which is a fact about
 *     the machine and not about the index. Multiply `scan %` by the
 *     brute-force table's µs-per-vector for a latency estimate that does not
 *     depend on who else is on the box;
 *   - what the build costs, in seconds AND in brute-force-query-equivalents
 *     (the only unit in which a per-session index can be judged: the index
 *     dies with the process, so it must repay its build inside one session);
 *   - what it costs in memory;
 *   - what recall@10 it delivers at each `nprobe`, against exact brute force.
 *
 * ⚠️ MEMORY: `heap MB` is a `heapUsed` delta around the build and needs
 * `--expose-gc` (which `bench:ann` passes) — it still goes NEGATIVE on a busy
 * machine, because a forced GC mid-run can free more than the build allocated.
 * `struct MB` is the analytic figure and is the one to quote: centroids
 * (`nlist·dim·4` bytes) plus ~32 bytes of bookkeeping per point. The index
 * holds the caller's `Float32Array`s BY REFERENCE and never a normalised copy,
 * so the vectors themselves are not charged to it — that is the design choice
 * `struct MB` exists to show.
 *
 * ## MEASURED 2026-09-04 — clustered corpus, k=10, 40 queries per cell
 *
 * Machine was heavily loaded (a game at ~88% CPU plus ~90 concurrent vitest
 * workers), so ONLY the deterministic columns are quoted here. The wall-clock
 * columns from that run are in the noise — one cell reported an exhaustive
 * scan as 300x faster than brute force, which is a fact about the scheduler.
 *
 * | dim  | vectors | nlist         | nprobe | scan % | work speedup | recall@10 |
 * |------|---------|---------------|--------|--------|--------------|-----------|
 * | 768  |  50,000 |  56 (default) | 4      |  7.77  | 12.9x        | 0.802     |
 * | 768  |  50,000 |  56 (default) | **8**  | 14.86  |  6.7x        | **0.897** |
 * | 768  |  50,000 |  56 (default) | 16     | 28.62  |  3.5x        | 0.972     |
 * | 768  |  50,000 | 224 (√n)      | 8      |  4.24  | 23.6x        | 0.745     |
 * | 768  | 100,000 |  79 (default) | 4      |  5.39  | 18.6x        | 0.795     |
 * | 768  | 100,000 |  79 (default) | **8**  | 10.34  |  9.7x        | **0.895** |
 * | 768  | 100,000 |  79 (default) | 16     | 20.82  |  4.8x        | 0.952     |
 * | 768  | 100,000 |  79 (default) | 32     | 40.53  |  2.5x        | 0.995     |
 * | 768  | 100,000 | 316 (√n)      | 8      |  2.96  | 33.8x        | 0.813     |
 * | 768  | 100,000 | 316 (√n)      | 16     |  5.55  | 18.0x        | 0.887     |
 * | 384  | 100,000 |  79 (default) | **8**  | 10.55  |  9.5x        | **0.942** |
 * | 1536 |  50,000 |  56 (default) | **8**  | 16.42  |  6.1x        | **0.918** |
 *
 * BUILD, in brute-force-query-equivalents (the ratio survives contention even
 * though the seconds do not): 56 at 768d/100k/nlist=79, 288 at nlist=316 —
 * both close to the predicted `nlist`, which is the identity this scheme is
 * chosen for. INCREMENTAL: ~79 µs per `upsert` and ~81 µs per `remove` at
 * 768d/100k — roughly 290,000 puts before a `put()` has cost as much as one
 * rebuild.
 *
 * MEMORY at 768d/100k/nlist=79: **3.4 MB** structural (centroids + ~32 B per
 * point). The 307 MB of vectors is NOT charged to the index — it holds the
 * caller's `Float32Array`s by reference and one `1/‖v‖` scalar per point.
 *
 * ⭐ WHY `defaultNlist` IS `√n/4` AND NOT `√n`. At 768d/100k the √n row reaches
 * the same recall (0.887 vs 0.895) at HALF the scan (5.55% vs 10.34%) — and at
 * FOUR TIMES the build (288 query-equivalents vs 56). For a per-session index
 * with nothing to amortise against but this session's own queries, the cheap
 * build wins below a few hundred queries. A consumer with a long-lived,
 * query-heavy session should pass `nlist: Math.round(Math.sqrt(n))` and raise
 * `nprobe` to 16 — that is what the knob is for, and this table is how to
 * decide.
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

/**
 * Per-call minimum over FIXED-DURATION windows.
 *
 * ⚠️ The obvious version — time three calls, take the min of five reps — was
 * measured to be worthless here: on a machine running other work, the same
 * cell varied by ~100x between reps and the table came out non-monotonic in
 * `nprobe` (an exhaustive scan "faster" than a single probe). A ~10 ms window
 * is one scheduler preemption wide, so `min` was minimising over noise, not
 * over work.
 *
 * So each window runs as many calls as fit in `windowMs` and divides. A long
 * window averages contention INTO the sample instead of letting one preemption
 * define it, and `min` across windows then picks the least-contended stretch.
 * Wall clock is still the secondary number — `scan %` below is the primary.
 */
function perCallMs(run: () => void, windowMs = 250, reps = 7): number {
  for (let i = 0; i < 3; i++) run()
  let best = Infinity
  for (let r = 0; r < reps; r++) {
    let calls = 0
    const t0 = performance.now()
    let dt = 0
    do { run(); calls++; dt = performance.now() - t0 } while (dt < windowMs)
    best = Math.min(best, dt / calls)
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
      let qi = 0
      const bruteMs = perCallMs(() => { exact.cosineTopK(c.queries[qi++ % c.queries.length]!, K) })
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
          let ai = 0
          const annMs = perCallMs(() => { idx.search(c.queries[ai++ % c.queries.length]!, K, { nprobe }) })
          let rec = 0
          let probed = 0
          for (let i = 0; i < c.queries.length; i++) {
            let hit = 0
            for (const h of idx.search(c.queries[i]!, K, { nprobe })) if (truth[i]!.has(h.id)) hit++
            rec += hit / K
            probed += idx.lastProbedPoints
          }
          rec /= c.queries.length
          // The DETERMINISTIC half: the fraction of the corpus a query scored,
          // plus the centroid comparisons it paid to decide which lists those
          // were. Identical on every machine, and the thing IVF actually
          // changes — wall clock is this multiplied by a machine constant.
          const scanFrac = (probed / c.queries.length + nlist) / n
          rows.push({
            dim, vectors: n, nlist, nprobe,
            'scan %': +(scanFrac * 100).toFixed(2),
            'work speedup': +(1 / scanFrac).toFixed(1),
            'recall@10': +rec.toFixed(3),
            'brute ms': +bruteMs.toFixed(2),
            'ann ms': +annMs.toFixed(2),
            'wall speedup': +(bruteMs / annMs).toFixed(1),
            'build s': +(buildMs / 1000).toFixed(2),
            'build = N queries': Math.round(buildMs / bruteMs),
            'struct MB': +((nlist * dim * 4 + idx.size * 32) / 1e6).toFixed(1),
            'heap MB': +memMB.toFixed(1),
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
