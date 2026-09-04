/**
 * Sub-document chunking (#1360) — multiple vectors per record.
 *
 * A long document encoded as ONE vector averages its topics away: a contract
 * whose fortieth clause is the only relevant one scores like a contract about
 * nothing in particular. Chunking encodes SPANS of the record's source text
 * separately, and scores a record by its BEST chunk.
 *
 * ## What a span indexes into — the load-bearing definition
 *
 * `start` / `end` are **character offsets into
 * `embeddingSourceText(record, descriptor.source)`** — the joined source text,
 * NOT into any single field. When `source` names several fields the text is
 * their `' '`-join, so an offset can sit past a join boundary; that is exactly
 * why the offsets are defined against the join and not against a field. The
 * consumer reconstructs the snippet with the same call:
 *
 * ```ts
 * const text = embeddingSourceText(record, descriptor.source)
 * const snippet = text.slice(hit.chunk.start, hit.chunk.end)
 * ```
 *
 * `similarTo()` does precisely that to fill `hit.snippet`, so a returned span
 * is checkable against the record the consumer already holds.
 *
 * ## What is deliberately NOT here
 *
 * No bundled splitter. The splitter is host-supplied like `encode` — chunking
 * a legal clause, a markdown section and a chat transcript are different
 * problems and hub has no business guessing.
 *
 * The approximate index that was deferred here HAS since been built — it is
 * `ivf-flat.ts`, opted into with `withVectorIndex()`, and it is OFF by default
 * (see `vector-set.ts`'s `topK`). This file's own multiplier is what gated it:
 * chunking stores one vector per chunk, so a corpus of R records at C chunks
 * each brute-forces R·C vectors, and the index threshold counts VECTORS.
 * ⛔ Managed plaintext vector backends (pgvector, Vectorize, Qdrant) remain
 * excluded BY DECISION, and building an in-hub index does not reopen that: the
 * backend would hold plaintext vectors, and embedding inversion leaks the text
 * back out. The index built here never leaves the hub and is never persisted.
 */
import type { EmbeddingDescriptor } from './descriptor.js'

/** A span the host's splitter proposes: `[start, end)` into the joined source text. */
export interface EmbeddingChunkSpan {
  readonly start: number
  readonly end: number
  /** Stable chunk id; defaults to `c<index>` when the splitter does not supply one. */
  readonly id?: string
}

/** A chunk as it is stored and returned — a span with a resolved id, no vector. */
export interface EmbeddingChunk {
  readonly id: string
  readonly start: number
  readonly end: number
}

/** A chunk plus its vector, as held in memory by {@link VectorSet}. */
export interface StoredChunk extends EmbeddingChunk {
  readonly vec: Float32Array
}

/**
 * Normalise the splitter's output: drop empty/inverted/out-of-range spans,
 * resolve ids. Invalid spans are DROPPED rather than thrown on — a splitter is
 * host code running over host text, and one degenerate span (a trailing
 * separator, a zero-width match) must not fail the write; a record that ends up
 * with no usable span falls back to the whole-record vector, which is the
 * pre-#1360 behaviour and never worse than not indexing the record at all.
 */
export function normalizeChunkSpans(spans: readonly EmbeddingChunkSpan[], textLength: number): EmbeddingChunk[] {
  const out: EmbeddingChunk[] = []
  for (const s of spans) {
    if (!Number.isInteger(s.start) || !Number.isInteger(s.end)) continue
    if (s.start < 0 || s.end > textLength || s.end <= s.start) continue
    out.push({ id: s.id ?? `c${out.length}`, start: s.start, end: s.end })
  }
  return out
}

/**
 * Encode each chunk of `text` under the descriptor's `encode` hook.
 * Returns `[]` when no `chunk` hook is declared or it yields no usable span —
 * the caller then stores the single whole-record vector, unchanged.
 *
 * Dimension is checked per chunk by the caller (it owns the error's field
 * name), so this stays a pure derive.
 */
export async function deriveChunkVectors(
  text: string,
  descriptor: EmbeddingDescriptor,
): Promise<(EmbeddingChunk & { vec: Float32Array })[]> {
  if (!descriptor.chunk) return []
  const spans = normalizeChunkSpans(descriptor.chunk(text), text.length)
  if (spans.length === 0) return []
  const out: (EmbeddingChunk & { vec: Float32Array })[] = []
  for (const span of spans) {
    out.push({ ...span, vec: await descriptor.encode(text.slice(span.start, span.end)) })
  }
  return out
}
