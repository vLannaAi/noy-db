/**
 * #1360 (2) — THE MEASUREMENT THAT GATES AN APPROXIMATE INDEX.
 *
 * The issue defers HNSW / IVF / quantisation behind a number rather than a
 * feeling: build one only when a real corpus makes the existing brute-force
 * path exceed a stated interactive budget. This file is that number, and it is
 * re-runnable, so the gate can be re-checked on a consumer's own hardware
 * instead of re-argued.
 *
 * ⛔ Not an option at any corpus size: a managed plaintext vector backend
 * (pgvector, Vectorize, Qdrant). Excluded BY DECISION — the backend would hold
 * plaintext vectors and embedding inversion leaks the source text back out.
 * The only admissible answer to a slow brute force is an in-hub encrypted
 * index. So this measurement decides *whether to build*, never *where to send*.
 *
 * WHAT IS MEASURED: `VectorSet.cosineTopK` — the whole search, brute-force
 * cosine over every vector held in memory, plus the top-k sort. This is the
 * per-query cost.
 *
 * WHAT IS NOT MEASURED, and why it matters more than it looks: the COLD LOAD
 * (`buildVectorLoad` — one `adapter.get` + one AES-GCM decrypt per record)
 * runs once per session and is dominated by store I/O, not by arithmetic. If a
 * consumer reports "semantic search is slow", check which of the two they
 * mean; an approximate index fixes only the one measured here.
 *
 * ⭐ CHUNKING IS A MULTIPLIER ON THIS AXIS. #1360's chunking stores one vector
 * per chunk, so a corpus of R records at C chunks each brute-forces R*C
 * vectors. Read the table by VECTOR count, not record count: 10k documents
 * chunked into 8 sections each sit on the 80k row, not the 10k row.
 *
 * ## MEASURED 2026-09-04 — the trigger, in numbers
 *
 * Node 22.22, Apple Silicon, single thread, `k=10`, 31 queries per cell, two
 * full runs. **Read the `min` column, not the median**: the machine was
 * running four other build agents, and a query cannot execute in less work
 * than it does — the floor is signal, everything above it is interference.
 * The two runs' medians disagreed by up to 5x; their minima agreed to ~10%
 * wherever the cell was not GC-bound.
 *
 * Per-vector cost is flat in the corpus size (i.e. brute force is exactly as
 * linear as it looks), and roughly proportional to dimension:
 *
 * | dim  | µs per vector per query | crosses 100 ms at |
 * |------|-------------------------|-------------------|
 * | 384  | ~0.80                   | **~125,000 vectors** |
 * | 768  | ~1.45                   | **~70,000 vectors**  |
 * | 1536 | ~2.10                   | **~48,000 vectors**  |
 *
 * Raw minima behind the 1536 row (the cleanest block): 1k → 1.85 ms,
 * 10k → 19.84 ms, 50k → 105.79 ms, 100k → 208.62 ms.
 *
 * ✅ **THE GATE WAS MET, and the index exists** (#1360 part 2): IVF-flat,
 * opt-in via `withVectorIndex()`, off below 20,000 vectors. What it bought —
 * crossover, recall@10, build time, memory — is the sibling table in
 * `vector-ann-index.bench.ts`. Keep this file: it is the DENOMINATOR that one
 * is reported against, and re-running both on a consumer's hardware is how the
 * trade is re-checked rather than re-argued.
 *
 * ⚠️ **Re-measured 2026-09-04 on a heavily loaded machine** (≈35 concurrent
 * vitest workers). The 384 and 768 minima reproduced the table above to within
 * ~10% (384: 39.15 ms @50k, 78.92 ms @100k; 768: 61.15 ms @50k, 128.43 ms
 * @100k). The **1536 row did not** — 285 ms @50k against the 105.79 ms
 * recorded here, ~2.7x. `min` filters scheduler noise but not sustained
 * memory-BANDWIDTH contention, and 1536d is the row that is bandwidth-bound
 * (50k × 1536 × 4B ≈ 300 MB per pass). Treat the 1536 crossover as the least
 * portable number in this file.
 *
 * ⭐ **THE GATE.** Build an approximate index when a consumer's corpus is
 * within ~2x of its row above — not before. Below it, brute force is not the
 * bottleneck and an HNSW would add ~600 LOC, an encrypted sidecar to keep
 * consistent, and a recall cliff, to buy nothing. With #1360 chunking, count
 * VECTORS: 6,000 documents at 8 chunks each and 1536 dimensions already sits
 * on the 48k line.
 *
 * Run: `pnpm --filter @noy-db/test-benchmarks bench:vectors`
 * (Deliberately outside `vitest run`'s `*.test.ts` include so it never runs in
 * CI: it is a measurement, not an assertion, and timing assertions on shared
 * runners are the classic flaky test.)
 */
import { describe, it } from 'vitest'
// `VectorSet` is an INTERNAL service — it is not a published `@noy-db/hub/*`
// subpath and must not become one for a benchmark's convenience, so this
// imports the source directly. The benchmark measures the real code path, not
// a copy of the loop (a copied loop would drift from the thing it gates).
import { VectorSet, type StoredVector } from '../../../packages/hub/src/with-lookup/embeddings/vector-set.js'

/** A plausible interactive budget for search-as-you-type: the query must not own the frame. */
const INTERACTIVE_BUDGET_MS = 100

function randomVector(dim: number): Float32Array {
  const v = new Float32Array(dim)
  for (let i = 0; i < dim; i++) v[i] = Math.random() * 2 - 1
  return v
}

function buildSet(count: number, dim: number): VectorSet {
  const vectors: StoredVector[] = []
  for (let i = 0; i < count; i++) vectors.push({ id: `r${i}`, model: 'bench', vec: randomVector(dim) })
  const vs = new VectorSet()
  ;(vs as unknown as { vectors: StoredVector[] }).vectors = vectors
  return vs
}

function timeQueries(vs: VectorSet, dim: number, runs: number): { median: number; p95: number; min: number } {
  const queries = Array.from({ length: runs }, () => randomVector(dim))
  // Warm the JIT before measuring — an unwarmed first call is 5-20x the steady state.
  for (let i = 0; i < 5; i++) vs.cosineTopK(queries[0]!, 10)
  const samples: number[] = []
  for (const q of queries) {
    const t0 = performance.now()
    vs.cosineTopK(q, 10)
    samples.push(performance.now() - t0)
  }
  samples.sort((a, b) => a - b)
  // `min` is the least contaminated estimate on a shared machine: a query
  // cannot run FASTER than the work it does, so the floor is the signal and
  // everything above it is interference (GC, other processes). Report the
  // median as the honest user-facing number and the min as the sanity check —
  // a median far above the min means the run was noisy, not that the code is
  // slow, and the two together are what makes this table auditable.
  return { median: samples[Math.floor(samples.length / 2)]!, p95: samples[Math.floor(samples.length * 0.95)]!, min: samples[0]! }
}

describe('#1360 gate: brute-force cosine kNN latency vs corpus size', () => {
  it('reports where brute force crosses the interactive budget', () => {
    const dims = [384, 768, 1536]
    const counts = [1_000, 10_000, 50_000, 100_000, 250_000]
    const rows: Record<string, string | number>[] = []
    for (const dim of dims) {
      for (const count of counts) {
        // Skip cells whose vector pool alone would exceed ~1GB of RSS.
        if (count * dim * 4 > 1_000_000_000) continue
        let vs: VectorSet | undefined = buildSet(count, dim)
        const { median, p95, min } = timeQueries(vs, dim, 31)
        vs = undefined
        // Drop the previous pool before building the next one: a 250k x 1536
        // pool is ~1.5GB of live Float32Arrays and GC pressure from the
        // PREVIOUS cell is the main way this table goes non-monotonic.
        ;(globalThis as { gc?: () => void }).gc?.()
        rows.push({
          dim,
          vectors: count,
          'min ms': +min.toFixed(2),
          'median ms': +median.toFixed(2),
          'p95 ms': +p95.toFixed(2),
          [`median over ${INTERACTIVE_BUDGET_MS}ms?`]: median > INTERACTIVE_BUDGET_MS ? 'YES' : 'no',
        })
      }
    }
    // eslint-disable-next-line no-console
    console.table(rows)
  }, 600_000)
})
