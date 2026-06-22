# Embeddings — semantic / vector retrieval (L2, encrypted-local)

> Status: **preview** (`experimental: true`). Configured directly on the
> collection via the `embeddings` option (no separate subpath). See the L2 epic
> map below.

---

## Epic map: L0 -> L4

| Layer | What | Status |
|---|---|---|
| **L0** | `collection.search(field, query, opts)` — in-memory decrypt + BM25 scan, zero leakage | shipped |
| **L1** | `collection.retrieve(query, opts)` — client-side lexical inverted index, i18n tokenizer, multi-field BM25 | shipped (#308 L1) |
| **L1.5** | Persisted opaque encrypted index blob (warm cross-session, fingerprint staleness check, debounced flush) | shipped (#308 L1.5) |
| **L2** | Client-side **semantic / vector** retrieval — `retrieve({mode:'semantic'})` + `similarTo()` — this doc | shipped (#308 L2) |
| L3 | Formalized agent retrieval API (hybrid ranking, context assembly, `fuseRetrieval`) | future spec |
| L4 | Access-pattern privacy (ORAM) + attested-enclave (PCC-style) compute tier | research-grade |

---

## What it does

L2 adds **semantic retrieval** to any collection: configure an `embeddings`
descriptor, and noy-db derives a floating-point vector for every record at
write time, stores it **encrypted** in a reserved `_vec` sidecar under the
collection DEK, and answers nearest-neighbour queries by brute-force cosine
over the decrypted in-memory `VectorSet`.

Key properties:

- **Zero-knowledge** — the store sees only ciphertext per `_vec/<id>`; vector
  values and source text never leave the trusted tier.
- **No bundled model** — the `encode` hook is caller-supplied (call any local
  or remote embedding API; the descriptor is your adapter).
- **Brute-force cosine** — adequate at SME/pilot scale (~10 k vectors);
  HNSW/IVF deferred.
- **Managed vector backends deferred/gated** — a backend that would receive
  plaintext vectors (pgvector, Vectorize, Qdrant...) is the blind-index twin;
  v1 is encrypted-local only.

Engine lives in `packages/hub/src/embeddings/` (cosine.ts, descriptor.ts,
vector-set.ts, index.ts). `collection.ts` and `vault.ts` hold thin call-sites
only (derive, load/cache, retrieve branch, forget wiring).

---

## Configuration: `embeddings` collection option

```ts
interface EmbeddingDescriptor {
  source: string | string[]                          // field path(s) to embed
  encode: (text: string) => Promise<Float32Array>    // pluggable encode hook
  dim: number                                        // expected vector dimension
  model: string                                      // version tag for model-guard
}

const docs = vault.collection<Doc>('docs', {
  embeddings: {
    source: 'text',                                  // single field
    encode: async (t) => myEmbeddingApi(t),          // host/remote — no bundled model
    dim: 1536,
    model: 'text-embedding-3-small',
  },
})
```

- `source` may be a single field path or an array of paths; values are joined
  (space-separated) before encoding.
- `encode` is async; errors propagate like `autoTranslate` — write fails if the
  encoder throws.
- `dim` is validated on every write: `encode()` returning a vector of wrong
  length throws `EmbeddingDimMismatchError`.
- **CRDT collections are unsupported** — constructing a collection with both
  `embeddings` and `crdt` set throws immediately. Use a non-CRDT collection for
  semantic search (L2 scope).
- An empty source field (blank or absent value) yields a near-zero vector; the
  record is stored and retrieved but will score low on all queries.

---

## `_vec` sidecar and privacy model

Each embedded record gets a `_vec/<id>` entry in the store: the body
`{ vec: number[], model: string, dim: number }` is encrypted under the
**collection DEK** (the same key used for all records in the collection).

The store learns:

- The count of `_vec` rows (one per embedded record) — same metadata any
  record set already exposes.
- Write timing (one `_vec` write per `put`).

The store learns **nothing** about vector values, source text, or semantic
proximity. This is the zero-knowledge equivalent of L1's client-side lexical
scan — retrieval stays entirely in the trusted tier.

**Managed/plaintext vector backends are deferred and gated.** Any backend
that receives plaintext vectors (pgvector, Cloudflare Vectorize, Qdrant,
Pinecone, ...) would expose vectors to embedding inversion — the same threat
profile as the blind index for lexical search. That path is explicitly
deferred; v1 is encrypted-local only.

---

## Retrieval API

### `retrieve(q, { mode: 'semantic', k?, minScore? })`

```ts
const hits = await docs.retrieve('overdue invoice', { mode: 'semantic' })
// Returns RetrieveHit[] — best first
// { id, score, rank, field: '(vector)', snippet?, record? }

// Limit to top-5:
const top5 = await docs.retrieve('overdue invoice', { mode: 'semantic', k: 5 })

// Filter by minimum cosine similarity:
const strong = await docs.retrieve('quarterly report', { mode: 'semantic', minScore: 0.8 })
```

Flow: `encode(q)` (via the collection's `encode` hook) -> `VectorSet.ensureLoaded()` (list+get+decrypt all `_vec`, cached per session; rebuilt when dirty after a write) -> model-guard check -> `cosineTopK(qVec, k, minScore)` -> map to `RetrieveHit[]` with `rank` (1-based) and cosine `score`.

`RetrieveHit` shape:

```ts
interface RetrieveHit<T> {
  readonly id: string
  readonly score: number   // cosine similarity, descending
  readonly rank: number    // 1-based
  readonly field: string   // '(vector)' for semantic hits
  readonly snippet?: string
  readonly record?: T      // only when includeRecord: true
}
```

### `collection.similarTo(vector, { k?, minScore? })`

Accepts a raw `Float32Array` (caller has already encoded the query). This is
the "bring your own vector" path — useful when the query has already been
encoded by the caller.

```ts
const qVec = await myEncoder('quarterly report')
const hits = await docs.similarTo(qVec, { k: 10 })

// Manual hybrid filter: intersect similarTo() ids with a predicate query result:
const vecHits = await docs.similarTo(qVec, { k: 20 })
const active = new Set((await docs.query().where('status', '=', 'active').run()).map((r) => r.id))
const filtered = vecHits.filter((h) => active.has(h.id))
```

> **Note:** `query().similarTo().where()` chaining (hybrid filtering in one
> expression) is **deferred**. The workaround above — intersecting two result
> sets manually — is the supported pattern in L2.

---

## Model-version guard

Every stored vector is tagged with the `model` string from the descriptor. On
retrieval, if any stored vector's `model` differs from the current descriptor's
`model`, noy-db throws `EmbeddingModelMismatchError`.

Changing the `model` string invalidates the embedding space: cosine similarity
across vectors from different models is meaningless, and results would be
silently wrong without this guard.

**Recovery in v1:** `vault.embeddings.reindex()` is DEFERRED. In v1, the error
surfaces; re-derive by re-putting records (triggers fresh `encode()` + new
`_vec` write). A full `reindex()` helper is planned for L2.x.

---

## `forget()` teardown

`vault.forget(subject)` crypto-shreds records and **also drops each affected
record's `_vec/<id>` sidecar** (resilient try/catch + residue in `ForgetResult`,
mirroring `_ftindex` and `_idx` teardown). The `VectorSet` is marked dirty so
the next retrieval reloads from the store (without the forgotten vectors).

Forgotten vectors must not survive crypto-shred: a vector can be inverted back
toward the source text (embedding inversion), so it is treated as sensitive as
the record itself.

---

## Edge cases

| Situation | Behaviour |
|---|---|
| `encode()` returns wrong length | `EmbeddingDimMismatchError` at write time |
| Model mismatch on retrieval | `EmbeddingModelMismatchError`; re-put records to re-derive |
| Collection has no `embeddings` config | `similarTo()` / `retrieve(mode:'semantic')` throws (no-op descriptor) |
| `VectorSet` dirty after a write | Rebuilt lazily on the next `retrieve`/`similarTo` call |
| ~10 k vectors (SME scale) | Brute-force cosine adequate; HNSW/IVF deferred |

---

## Cross-references

- L2 design spec: `docs/superpowers/specs/2026-06-22-ai-retrieval-l2-semantic-vector-design.md`
- L1/L1.5 search subsystem: `docs/subsystems/search.md`
- Showcase 124: semantic retrieve walkthrough — `showcases/src/124-semantic-retrieve.showcase.test.ts`
- `features.yaml` -> `features` -> `vector-search`
