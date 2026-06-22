# AI retrieval — L2: semantic / vector retrieval (encrypted, local) — design

> **Status:** DESIGN — ready for plan.
> **One line:** `withEmbeddings({ source, encode, dim, model })` derives a vector per
> record at write via a **pluggable encode hook** (host/remote, no bundled model),
> stores it **encrypted at rest** in a reserved `_vec` sidecar, and answers
> `retrieve(q, { mode: 'semantic' })` / `query().similarTo(vec, { k })` by **brute-force
> cosine over decrypted vectors in the trusted tier**. Zero-knowledge: the store sees
> only ciphertext; no vector ever leaves your control. Managed vector backends (which
> would see plaintext vectors → embedding-inversion) are **deferred/gated** — the
> blind-index twin.

## Context

L2 is the semantic layer of the AI-retrieval epic ([[project_search_ai_retrieval_epic]]):
L0 scan ✅, L1 lexical ✅, L1.5 persisted ✅, **L2 semantic (this)**, L3 hybrid, L4
ORAM/enclave (deferred). It realizes the **embeddings dimension #13**
(`docs/superpowers/specs/2026-05-01-dimensions/13-embeddings.md`) under the epic's
trusted-tier privacy stance. The #13 doc's central tradeoff (encryption vs
searchability) is resolved here as **encrypted-vectors + local cosine** (#13's option
b) — the consistent choice for PII-heavy accounting data, parallel to L1's
scan-over-blind-index decision.

There is no existing vector/embedding code in the hub (verified). The precedents this
reuses: the `withI18n`-style tree-shakeable strategy, the `plaintextTranslator`/
`autoTranslate` write-time hook, L1.5's reserved-sidecar-under-collection-DEK +
load/cache/dirty pattern, and L1's `RetrieveHit` shape.

## Scope — in

| Item | Notes |
|---|---|
| `withEmbeddings({ source, encode, dim, model })` strategy | tree-shakeable (`src/embeddings/`); `NO_EMBEDDINGS` no-op default. `source: string \| string[]` (fields to embed); `encode(text) => Promise<Float32Array>`; `dim: number`; `model: string` (version tag) |
| `encode` hook — pluggable, host/remote, **no bundled model** | configured per-collection on `withEmbeddings`; runs at write (derive) AND query (embed the query). `EmbeddingEncoderNotConfiguredError` if a collection declares embeddings without an encoder; encode errors propagate (like `autoTranslate`) |
| Write-time derivation | on `put`, encode the `source` text → store the vector **encrypted** in reserved `_vec` sidecar (collection `_vec`, id = recordId, collection DEK). Re-derive when the source changes (embedding-consistency #07). dim mismatch → `EmbeddingDimMismatchError` |
| `_vec` sidecar | reserved `_vec` collection (excluded from record hydration like `_ftindex`); per-record `{ vec: number[], model, dim }` body, encrypted; **dropped on `forget()`** (resilient + residue, like `_ftindex`) |
| In-memory `VectorSet` | `src/embeddings/vector-set.ts` — loaded once per session (list+get+decrypt all `_vec`), cached, **dirty-on-write** (mirrors L1's IndexStore); `cosineTopK(queryVec, k, minScore?)` |
| `retrieve(q, { mode: 'semantic', k, minScore? })` | `encode(q)` → `VectorSet.cosineTopK` → `RetrieveHit[]` (`{ id, score, rank, field:'(vector)', snippet?, record? }`). `mode: 'lexical'(L1) \| 'semantic'(L2)` (`'hybrid'` is L3) |
| `query().similarTo(vector, { k, minScore? })` | raw-vector kNN terminator (#13); composes with `.where(pred)` (payload filtering — intersect cosine top-k with the predicate set) |
| **Model-version guard** | each vector tagged with `model`; a query whose collection `model` ≠ a stored vector's `model` is a hard error (`EmbeddingModelMismatchError`) — changing the encoder invalidates the space. `vault.embeddings.reindex({ collection })` re-derives all |
| brute-force cosine, in-memory, zero-dep | adequate at SME/pilot scale (~10k vectors); `Float32Array` math, hub-portable |
| features.yaml + subsystem doc + showcase | `vector-search` feature (`preview`/`experimental`) leading with the encrypted-local privacy model; subsystem doc; a semantic-retrieve showcase |

## Scope — out (deferred)

| Item | Deferred to | Why |
|---|---|---|
| Managed/plaintext vector backends (`to-vector-pgvector`/`cf-vectorize`/`qdrant`/…) | gated later | backend sees plaintext vectors → embedding-inversion → PII leak (blind-index twin); needs `acknowledgeVectorBackendRisk` |
| HNSW / IVF / quantization | later | brute-force suffices at SME scale; HNSW adds a dep/complexity |
| Sub-document chunking (multiple vectors per record) | later | v1 = one vector per record over the `source` fields |
| Combined vector-blob persistence (avoid re-decrypt per session) | L2.x | v1 loads+caches per session like L1; an L1.5-style blob is an optimization |
| `retrieve(mode:'hybrid')` + `fuseRetrieval` reducer | **L3** | lexical⊕semantic rank fusion (shared with klum federation) |
| Cross-vault semantic search | **klum** | cosine federates cleanly (same model → comparable); fan-out is orchestration |
| Multimodal (image/audio) | later | the `encode` hook is modality-agnostic; v1 text-only |

## Architecture

### Components (`src/embeddings/`, tree-shakeable)

```
src/embeddings/
  strategy.ts      # EmbeddingStrategy iface + NO_EMBEDDINGS no-op + withEmbeddings()
  encode.ts        # EmbeddingDescriptor { source, encode, dim, model } + validation
  vector-set.ts    # VectorSet: in-memory id->{vec,model}; cosineTopK(q,k,minScore)
  cosine.ts        # pure cosine(a,b): number (Float32Array)
  index.ts         # barrel
```

`collection.ts` gains thin call-sites only: derive-on-`put` (encode → `_vec` sidecar), the `_vec` load/cache/dirty handle, the `retrieve(mode:'semantic')` branch, `similarTo()` on the query builder, and `forget()`/close wiring — mind the kernel ceiling (logic in `src/embeddings/`).

### Write flow

`put(id, record)` → if `embeddingFields` configured: `text = join(getAtPath(record, source))` → `vec = await encode(text)` → assert `vec.length === dim` → encrypt `{ vec:[...], model, dim }` under collection DEK → `adapter.put(vault, '_vec', id, env)` → mark the in-memory `VectorSet` dirty. Re-runs on every write of the record (source change → fresh vector). (Encode failure propagates; missing encoder → `EmbeddingEncoderNotConfiguredError`.)

### Query flow

`retrieve(q, { mode:'semantic', k })` → `qVec = await encode(q)` → `VectorSet.ensureLoaded()` (list+get+decrypt all `_vec`, cached; rebuilt when dirty) → guard: all loaded vectors' `model` === the collection's `model` (else `EmbeddingModelMismatchError`) → `cosineTopK(qVec, k, minScore)` → map to `RetrieveHit[]` with `rank` (1-based) + optional snippet (from the record's source field). `query().similarTo(vector, {k})` skips the `encode(q)` step (caller supplies the vector) and composes with `.where()` by intersecting the cosine top-k ids with the predicate result.

### Privacy / leakage (the contract)

Vectors are **encrypted at rest** (collection DEK) and decrypted only in the trusted
tier for in-memory cosine. The store sees opaque ciphertext per `_vec/<id>` — never a
plaintext vector, never the source text. This is the zero-knowledge equivalent of L1's
client-side scan. The store learns the **count** of vectors (one `_vec` row per
embedded record) and write timing — the same metadata any record already exposes; it
learns nothing about vector *values* or proximity. The managed-backend path (which
would expose plaintext vectors) is explicitly deferred and gated.

### Erasure

`forget(subject)` drops each affected record's `_vec/<id>` sidecar (resilient try/catch
+ residue in `ForgetResult`, mirroring L1.5's `_ftindex` + `_idx` teardown) and marks
the `VectorSet` dirty — a forgotten subject's vector (from which text is invertible)
must not survive crypto-shred.

## Decisions (resolved)

- **Encrypted-vectors + local cosine** is the default and only v1 storage model (zero-knowledge); managed backends deferred/gated.
- **Per-record `_vec` sidecar** (not a combined blob, not an in-record field) — cleanest re-derive (write one vector per record change) + forget (drop one sidecar); brute-force loads all into a cached `VectorSet` anyway.
- **`encode` configured on `withEmbeddings`** (per-collection) — different collections may use different models.
- **Brute-force cosine** v1 (zero-dep); HNSW deferred.
- **One vector per record** over the `source` fields; chunking deferred.
- **Model-version is a hard guard** (refuse to query across mismatched `model`), not a silent best-effort.

## Testing

- `cosine.ts`: known-vector cosine values; orthogonal → 0, identical → 1.
- `VectorSet`: load+decrypt round-trip; `cosineTopK` ordering + `k`/`minScore`; dirty-rebuild after write.
- Write: `put` derives + encrypts a `_vec` sidecar; re-put with changed source re-derives; dim mismatch → `EmbeddingDimMismatchError`; missing encoder → `EmbeddingEncoderNotConfiguredError`.
- Query: `retrieve(mode:'semantic')` returns nearest records ranked, with `rank` 1-based; `similarTo(vec)` raw path; `similarTo().where()` payload filtering; `minScore` cutoff.
- Model guard: a vector tagged `model:'v1'` queried under a `model:'v2'` collection → `EmbeddingModelMismatchError`; `reindex()` re-derives and clears it.
- Erasure: `forget()` removes `_vec/<id>` + residue on delete failure; subsequent semantic query excludes the forgotten record.
- **Leakage:** wrap the store; assert `_vec` bodies are ciphertext (no plaintext vector numbers / source text); a non-embedding collection writes no `_vec`.
- Tree-shaking: `NO_EMBEDDINGS` default bundle unchanged; all logic in `src/embeddings/`.

## Non-code obligations

- `features.yaml`: new `vector-search` feature (`status: preview`, `experimental: true`) leading with the encrypted-local model + the deferred/gated managed-backend note; spec ref.
- `docs/subsystems/`: an embeddings/vector-search subsystem doc — the encode-hook contract, encrypted-local privacy model, model-versioning, `retrieve(mode:'semantic')`/`similarTo`, and the L2 line of the epic map.
- Showcase: a semantic-retrieve walkthrough (a tiny deterministic stub `encode` so the showcase runs without a real model — e.g. a fixed hash-based pseudo-embedding) demonstrating nearest-neighbour retrieval + the model-mismatch guard.
- Kernel ceiling: keep `collection.ts`/`vault.ts` under ceiling (logic in `src/embeddings/`); raise minimally if call-sites force it.
