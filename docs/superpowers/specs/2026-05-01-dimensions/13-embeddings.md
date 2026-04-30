# Dimension 13 — Embedding / vector data shape

## Purpose

Add a **vector data shape** for similarity search — semantic indexing of vault contents, retrieval-augmented generation (RAG), nearest-neighbour lookup. Embeddings are a fundamentally different query model: not predicate-evaluation but vector-similarity (kNN, cosine, dot-product). This shape is the natural completion of the `in-ai` family — semantic search over a vault is the obvious next ergonomic for any small app that already has structured records.

## Relationship to Dimension 14 (derived data)

Embeddings are a *specific application* of Dimension 14's general `withDerivation` primitive. The dimension is preserved as its own file because the *shape* of the output (a fixed-dimension numeric vector with kNN query semantics) is novel and demands its own storage backends, query primitives, and metering — none of which apply to other derivations like PDF previews or image thumbnails. After 14 lands, the embedding strategy is implementable as `withDerivation({ derive: encode, outputs: { vec: { shape: 'embedding', store: 'vector' } } })` with `withEmbeddings` becoming a typed shorthand. The two dimensions ship in either order; 13 doesn't depend on 14 to be useful.

## Why embeddings are a distinct shape

| Axis | Record | Stream | **Embedding** |
|---|---|---|---|
| Addressing | by id | by offset | **by vector proximity** |
| Index structure | B-tree, hash | append log | **HNSW, IVF, scalar quantized** |
| Query primitive | predicate eval | windowing | **`similarTo(v, k)`** |
| Mutation | put / delete | append | put / delete (with re-index) |
| Storage shape | document | log segments | **fixed-shape numeric arrays** |

## Current state

- `in-ai` provides LLM function-calling and prompt-templating, but no vector storage primitive
- No similarity / kNN query in the chainable builder
- No `withEmbeddings` strategy
- No vector-shaped storage backends
- Apps that want semantic search reimplement everything externally (Pinecone direct, custom HNSW, etc.)

## Target state

Records can declare an *embedding companion* — a derived vector that's automatically maintained when the source record changes. The query DSL gains `.similarTo(vector, { k })`. Backends advertise `shape: 'embedding'` capability to opt in. The default in-memory HNSW backend works for small vaults (zero cost, zero dependency); larger vaults route to managed free-tier vector backends (pgvector via Supabase / Neon, Cloudflare Vectorize, Turso vector).

## Concrete additions

**Hub primitives:**
- `withEmbeddings({ source: fields, encode, dim, indexShape, k })` — strategy declaring an embedding companion to a collection
- `Collection<T>.query().similarTo(vector, { k, minScore? })` — kNN query terminator
- `Collection<T>.query().similarTo(vector, { k }).where(predicate)` — Qdrant-style **payload filtering during kNN** (predicate evaluated against the source record without leaving the index)
- `vault.embeddings.encode(text): Promise<Vector>` — encoding hook (host-process or remote callback)
- `vault.embeddings.reindex({ collection, since? })` — bulk re-derivation primitive
- `withHybridSearch({ sparse: 'bm25', dense: 'embedding', combiner: 'rrf' | 'weighted' })` — Pinecone / Weaviate / Vespa-style **hybrid sparse+dense search** combining lexical (BM25) + semantic (vector) signals
- `withVectorVersioning()` — LanceDB-style data-versioning on vectors (track index versions, branch indexes, roll back)
- `withMemoryTiers({ short, working, long })` — mem0 / Letta / Zep-shaped **hierarchical agent memory**: short-term buffer, working-set retrieval, long-term consolidated. Pairs with Dim 14 (summarisation as a derivation that promotes records between tiers).

**Vector-shaped storage backends (free-tier-aligned where possible):**
- `to-vector-hnsw-memory` — in-memory HNSW; zero cost, default for vaults <100K vectors
- `to-vector-pgvector` — pgvector via `to-postgres` / `to-supabase` / `to-neon`; Supabase free tier (500MB), Neon free tier
- `to-vector-cf-vectorize` — Cloudflare Vectorize; free tier ~5M dimensions / month
- `to-vector-turso` — Turso vector (libSQL extension); free tier
- `to-vector-qdrant-cloud` — Qdrant free tier (1GB)
- `to-vector-pinecone-free` — Pinecone free tier (1 index, 100K vectors) — flag as proprietary
- `to-vector-weaviate-cloud` — Weaviate free trial (sandbox cluster) — flag as time-limited

**Vector-shaped exports (Dimension 03 retrofit):**
- `as-parquet` — vectors export as columnar arrays (matches the existing Parquet entry's value prop)
- `as-arrow` — zero-copy in-process for `in-ai` consumers
- (No `as-csv` for vectors — poor format fit)

**Vector-shaped metering (Dimension 06 retrofit):**
- Query latency at K, recall@K, index build time, vector dimension distribution, re-index frequency

## Hard tradeoff: encryption vs searchability

This is the dimension's central honest tradeoff, parallel to Dimension 08's runtime-defence framing:

**Vector search requires plaintext vectors at query time.** AES-GCM ciphertext doesn't preserve geometric proximity (no homomorphism). The crypto-research literature has tried (homomorphic encryption, encrypted search, secure multi-party computation) — all impractical at SME scale (orders of magnitude slowdown, complexity tax).

Two honest paths the user picks between:

- **(a) Plaintext vectors, encrypted source records (default).** Vectors are stored in plaintext; the *source record they derive from* stays encrypted. Storage backend sees vectors but not records. The leak: vectors disclose semantic structure (clustering, neighbourhood relations) without revealing literal text. For most SME use cases this is acceptable; for sensitive corpora it's not. Documented warning required.
- **(b) Encrypted vectors, decrypt-and-search-locally.** All vectors encrypted at rest; query decrypts the full set in-memory and runs HNSW locally. Preserves zero-knowledge; defeats backend scaling (caps at ~10K vectors before memory pressure). Only viable for `to-vector-hnsw-memory` style local-only deployments.

Default: **(a) with explicit warning UX**. Opt-in to **(b)** via `withEmbeddings({ ..., encrypted: true })`. Storage backends advertising `shape: 'embedding'` declare which mode they support.

## Non-goals & tradeoffs

- **Hosting the embedding model.** noy-db is storage + index + query; the user supplies the model (local or remote callback). Defaults document common choices (sentence-transformers MiniLM for local; OpenAI/Cohere/Voyage for remote).
- **Re-ranking pipelines, cross-encoders, hybrid search.** Application concern, not noy-db's.
- **Sub-100ms query at 100M+ vectors.** SME-scale: tens of thousands to a few million.
- **Auto-quantization without opt-in.** Quantization is lossy; users opt in for storage savings, with documented recall impact.

## Dependencies / sequencing

- `in-ai` family already exists — extend, don't replace
- Capability metadata `shape: 'embedding'` (Dimension 01)
- Vector metering signals integrated into `to-meter` v2 (Dimension 06)
- Domain primitive `withEmbeddingConsistency` (Dimension 07): when source record changes, embedding must re-derive (or be marked stale)
- `withHistory` interaction: an old record version's embedding — retain, drop, or recompute on demand?

## Cross-references

- `features.yaml` → propose new `vector_collections` section; storage backends register under `adapters` with `shape: 'embedding'` capability
- Related: Dimension 04 (`in-ai`), Dimension 01 (`to-vector-*` backends), Dimension 03 (Parquet/Arrow exports), Dimension 06 (vector metering), Dimension 07 (embedding-source consistency invariant), Dimension 09 (the read-only viewer could expose semantic search)
- Spec anchor: new `SUBSYSTEMS.md#embeddings` section

## Open questions

- **Vector dimension as schema constraint.** `vector: { dim: 768 }` in the collection schema, or implicit from the model?
- **Default model.** Ship a default (e.g., bundled MiniLM via `transformers.js`)? Or always require user-supplied? Bundled = friction-free DX, but adds bundle weight (~25MB for MiniLM).
- **Encrypted-mode default.** (a) plaintext-vectors-with-warning or (b) encrypted-vectors-defaults-on? Privacy-first project leans (b); ergonomics-first project leans (a).
- **Recall vs latency defaults.** HNSW `efSearch` parameter — pick recall@10 = 95% as default? Document the tradeoff.
- **Quantization defaults.** None initially; opt-in int8 / binary later as a retrofit.
- **Cross-vault similarity.** Searching across multiple vaults (e.g., a dashboard over many SME vaults) requires explicit cross-vault key sharing — couples to Dimension 11's cross-vault join idea.
- **Embedding versioning.** When the encoder model changes (v1 → v2), the existing index is incompatible. How does noy-db expose this — explicit `model: 'minilm-v2'` tag, or hash of model weights, or refuse to mix? (Probably: tag, refuse to query across tags.)
- **Multimodal.** Image embeddings, audio embeddings — same primitive, different encoder. Default scope to text-only, design for extensibility.
