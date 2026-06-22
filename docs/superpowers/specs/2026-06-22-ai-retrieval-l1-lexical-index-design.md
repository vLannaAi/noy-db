# AI retrieval layer — L1: client-side lexical index (#308) — design

> **Status:** DESIGN — ready for plan.
> **One line:** A client-side, session-rebuilt, **in-memory inverted index** with an
> **i18n-aware tokenizer**, exposed as `collection.retrieve(query, opts)` returning
> ranked **`{ id, score, field, snippet }`** — minimal-disclosure retrieval to ground
> an AI agent **without** a full per-query scan and **without** ingesting the whole
> vault into the model's context. **Zero added store leakage** (pure client-side,
> nothing written to the store).

## Why this reframes #308

#308 originally proposed two modes: `mode:'scan'` (shipped, #403) and a store-side
`mode:'blind-index'` (SSE). The driving use case has since sharpened: the real goal
is **privacy-preserving retrieval for an AI agent** — when a request is *wide* and
refers to *specific contents inside documents* ("the invoice line item with
description X"), a full decrypt-and-scan is expensive and dumping the whole corpus
into the model context is both costly and a privacy regression.

The state-of-the-art for private personal-AI retrieval keeps the index/retrieval in
the **trusted tier** and treats the untrusted store as ciphertext-only:

- **Apple Intelligence semantic index / Spotlight** — an **on-device** index;
  RAG runs locally and feeds the model *only the relevant context*.
- **Apple Private Cloud Compute** — when on-device isn't enough, an **attested,
  stateless, non-retaining** enclave; trust via attestation, not operator goodwill.
- **Opal: Private Memory for Personal AI (2026)** — query/retrieval reasoning in a
  **trusted enclave**; the untrusted disk holds encrypted data behind **ORAM** and
  learns only *fixed access patterns*, never which documents were retrieved.

The unifying principle: **keep retrieval in the trusted tier; the untrusted store
sees only ciphertext.** This *inverts* the original blind-index recommendation,
which puts a queryable index **in the untrusted store** and leaks doc-frequency +
co-occurrence + access-pattern (the exact trio behind IKK/count query-recovery
attacks). For PII-heavy private-accounting data, that is the wrong direction.

noy-db's architecture already **is** the Apple model: the untrusted store = the
cloud; the key-holding client = on-device. So the retrieval index belongs
**client-side** — "Spotlight for your vault."

## The epic (context — only L1 is in scope here)

| Layer | What | Status |
|---|---|---|
| **L0** | `mode:'scan'` — in-memory decrypt+match+BM25, zero leakage | ✅ shipped (#403) |
| **L1** | **client-side lexical inverted index + i18n tokenizer + `retrieve()`** | **THIS SPEC** |
| L1.5 | persisted **opaque** encrypted index blob (warm cross-session) | deferred (seam built in L1) |
| L2 | client-side **semantic/vector** retrieval (embeddings, dim #13) → `retrieve(…, {mode:'semantic'\|'hybrid'})` | future spec |
| L3 | formalized **agent retrieval API** (hybrid ranking, context assembly) | future spec |
| L4 | **access-pattern privacy (ORAM)** + **attested-enclave (PCC-style)** compute tier | research-grade; defer |

L1 deliberately introduces `retrieve()` as the seed of L3, so L2/L3 extend one stable
method rather than inventing a new surface later.

## What exists (reused, not rebuilt)

| Capability | Where | Reused as |
|---|---|---|
| BM25 scan ranker | `src/search/scan.ts` — `searchScan()`, `K1=1.2`,`B=0.75`, `fieldText()` | BM25 math + `fieldText` coercion lifted into the inverted-index scorer |
| Word-run tokenizer | `src/search/tokenize.ts` — `tokenize`, `type Tokenizer` | kept as the zero-dep fallback; new i18n segmenter becomes the default |
| Single-field scan API | `collection.search(field, query, opts)` (call-site of `searchScan`) | unchanged; transparently index-accelerated when the field is in `textIndexes` |
| Nested / array-wildcard path access | `getAtPath` (`src/i18n/core.ts:440`) | resolve `lineItems[].description`-style indexed fields |
| Tree-shake seam | `src/search/index.ts` barrel; reaches the bundle only when search is used | all L1 code lives here; non-search bundles pay nothing |
| features.yaml node | `search-index` (`status: preview`, `experimental: true`, `subsystem_doc: docs/subsystems/search.md`) | extended, not added |

## Scope — in

| Item | Notes |
|---|---|
| `Intl.Segmenter`-based i18n tokenizer (`src/search/segment.ts`) | `granularity:'word'`, NFKC-normalize → lowercase → keep word-like segments; dictionary-segments Thai/CJK. Pluggable (`Tokenizer` override). |
| In-memory `InvertedIndex` (`src/search/inverted-index.ts`) | per-field `term → [{id, tf, offsets[]}]` + BM25 stats (`df`, doc lengths, `avgdl`) + per-field text refs for snippets |
| `IndexStore` seam (`src/search/index-store.ts`) + `MemoryIndexStore` | session-scoped, lazy-built, cached on the collection; the persisted-blob backend (L1.5) implements the same interface |
| Snippet extraction (`src/search/snippet.ts`) | char-window around the best match, offsets from the segmenter |
| `collection.retrieve(query, opts)` | multi-field, returns `{ id, score, field, snippet }[]`, ranked |
| `textIndexes: string[]` collection config | opt-in indexed fields; supports nested + `[]` wildcard paths |
| **i18nText fields → index ALL locale values** | a query term in any language matches whichever locale holds it; hit carries matched `locale`; snippet from that locale |
| **Blob fields → index `filename` + `userMeta`** | blob *metadata* only; blob *bytes* are never tokenized (content extraction is app-side) |
| Multi-field BM25, **max-field** combination | a doc's score = its best field's BM25; `field` is that winning field; snippet from it |
| Dirty-on-write invalidation | a write to the collection marks the cached index dirty → rebuilt on next `retrieve()` |
| Transparent index-acceleration of `search(field,…)` | when `field ∈ textIndexes`, route through the index instead of re-tokenizing all docs |

## Scope — out (deferred)

| Item | Deferred to | Why |
|---|---|---|
| Persisted opaque encrypted index blob | L1.5 | seam (`IndexStore`) is built now; the blob backend + maintenance/reconcile/write-amp come when corpus scale demands |
| In-session **incremental** index update | L1.5 | v1 marks dirty → full rebuild on next `retrieve()`; incremental posting diff is an optimization |
| Semantic / vector retrieval | L2 | embeddings dimension (#13); `retrieve()` gains `mode:'semantic'\|'hybrid'` |
| Store-side `mode:'blind-index'` (SSE) | — (superseded) | wrong direction for PII per the reframe; replaced by the client-side index |
| ORAM access-pattern hiding + attested enclave | L4 | research-grade |
| Multiple snippets per record; phrase/positional queries; stemming; fuzzy/trigram | future | `tokenizer` + the index structure are the extension seams |

## Field-type handling (the lexical vs. structured boundary)

L1 indexes **text-bearing** fields only; **value-typed** fields belong to the
structured `where` pipeline. Trying to full-text a money field is the same category
error as `where('>')` on a paragraph.

| Field type | In the text index? | How |
|---|---|---|
| `string` | ✅ | tokenized as-is |
| `i18nText` (`{[locale]:string}`) | ✅ | **all locale values** indexed under the field name; matched `locale` returned; locale-agnostic search |
| Blob field (`filename`, `userMeta`) | ✅ | metadata strings tokenized; **bytes never** tokenized |
| `dictKey` label | ⛔ deferred | needs async dictionary resolution; L2-adjacent |
| `money` / `number` / `date` / `boolean` | ⛔ by design | use `where('amount','>',1000)` etc. — formatting variance makes text-matching values wrong |
| Blob **content** (PDF/image bytes) | ⛔ out of scope | app extracts text into a normal field (OCR/PDF→text), which then indexes |

The builder detects `i18nFields` descriptors and blob fields from the collection
config; `getAtPath` resolves nested/wildcard paths. `fieldText` is extended to emit
**`{ text, locale? }` segments** (one per i18n locale / blob-meta string) rather than
a single string, so postings carry locale attribution.

**Hybrid (money + text together)** — the agent/UI composes `retrieve()` (text
candidate ids) with the existing query pipeline (`query().where('amount','>',1000)`):
intersect the id sets, then rank. L1 supports this by exposing candidate ids;
**L3 formalizes** a single hybrid call. Money/date filtering stays in `where`, where
it's exact.

## Dual use — agents AND humans (AI optional)

`retrieve()` is a **general retrieval primitive**, not agent-only. One index, three
consumers:

- **Human "google-like" search** — results list; `snippet` is the result preview.
- **Autocomplete / typeahead** — `prefix:true` on the last term; per-keystroke calls
  are O(postings) after the index is warm.
- **Agent RAG** — `snippet`s fed into the model context (minimal disclosure);
  `includeRecord` off by default.

**No AI required** — AI is one caller. (A reactive `in-pinia`/`in-vue` search-box
wrapper over `retrieve()` is a natural follow-on, out of scope here.)

**Latency:** the first `retrieve()` per session builds the index (one decrypt+
tokenize scan); subsequent calls — including per-keystroke autocomplete — are fast.
For a snappy human box on a large corpus, call `warmIndex()` on vault open, or adopt
the L1.5 persisted blob. At the pilot's scale the cold build is negligible.

## Architecture

### Components

```
src/search/
  segment.ts         # i18n Tokenizer via Intl.Segmenter (new default) + word-run fallback (existing tokenize.ts)
  inverted-index.ts  # InvertedIndex: build(entries, fields, tokenizer) ; query(queryTerms, opts) -> scored postings
  snippet.ts         # extractSnippet(text, offsets, window) -> minimal-disclosure excerpt
  index-store.ts     # interface IndexStore + MemoryIndexStore (session-scoped, lazy, cached, dirty-flag)
  scan.ts            # (existing) no-index fallback, unchanged
  index.ts           # barrel — re-export new surface
```

`collection.ts` gains only: the `textIndexes` config field, a cached `IndexStore`
handle, the `retrieve()` call-site, and a dirty-flag poke in the put/delete paths.
Watch the 4922 kernel ceiling — all real logic lives in `src/search/`.

### `InvertedIndex` shape

```ts
interface Posting { id: string; tf: number; offsets: number[] }   // offsets = char start of each occurrence
interface FieldIndex {
  postings: Map<string, Posting[]>   // term -> postings
  df: Map<string, number>            // term -> document frequency
  docLen: Map<string, number>        // recordId -> token count (this field)
  avgdl: number
  text: Map<string, string>          // recordId -> field text (for snippets); session-only, in memory
}
class InvertedIndex {
  static build(entries: {id,record}[], fields: string[], tok: Tokenizer): InvertedIndex
  query(queryTerms: string[], opts): { id: string; score: number; field: string; offset: number }[]
}
```

### API

```ts
vault.collection<Invoice>('invoices', {
  textIndexes: ['description', 'notes', 'lineItems[].description'],
})

interface RetrieveOptions {
  limit?: number              // top-N (default all)
  match?: 'any' | 'all'       // default 'any' (OR of query terms)
  prefix?: boolean            // last query term is a prefix (typeahead)
  snippetWindow?: number      // chars around the match (default ~80)
  fields?: string[]           // restrict to a subset of textIndexes
  includeRecord?: boolean     // also return the decrypted record (default false — minimal disclosure)
}
interface RetrieveHit<T> {
  id: string; score: number; field: string; snippet: string
  locale?: string            // matched locale, when `field` is an i18nText field
  record?: T                 // only when opts.includeRecord
}

retrieve(query: string, opts?: RetrieveOptions): Promise<RetrieveHit<T>[]>

// Optional: pre-build the index (e.g. on vault open) so the first human
// keystroke / agent call doesn't pay the one-time build scan.
warmIndex(): Promise<void>
```

One hit **per record** (its best-scoring field), deduped — clean for context
assembly. `includeRecord` is opt-in; the default returns only the excerpt so an
agent feeds the model minimal content and fetches full records by id on demand.

### Data flow

1. **Build (lazy, once per session):** first `retrieve()` → `ensureHydrated()` →
   `MemoryIndexStore.build(entries, textIndexes, segmenter)` over the configured
   fields (using `getAtPath` for nested/wildcard) → cache the `InvertedIndex` on the
   collection. Cost = one decrypt+tokenize pass per session (not per query).
2. **Query:** segment the query → per field, gather matching postings (exact terms +
   optional prefix on the last term) → BM25 per field (reusing the scan formula) →
   **per record, take the max field score**; drop records failing `match:'all'` →
   sort → take `limit`.
3. **Snippet:** for each top hit, `extractSnippet(fieldIndex.text[id], offset,
   snippetWindow)` from the winning field.
4. **Invalidation:** any `put`/`delete` on the collection marks the cached index
   dirty; the next `retrieve()` rebuilds. (Incremental update = L1.5.)

### i18n tokenizer

```ts
// src/search/segment.ts
const seg = new Intl.Segmenter(undefined, { granularity: 'word' })
export const segmentTokenizer: Tokenizer = (text) => {
  if (!text) return []
  const out: string[] = []
  for (const s of seg.segment(text.normalize('NFKC').toLowerCase())) {
    if (s.isWordLike) out.push(s.segment)   // offset available via s.index for snippets
  }
  return out
}
```

`Intl.Segmenter` is standard ECMAScript (Node 16+, modern browsers, Deno, Workers) —
**hub-portable** (passes the `hub-portable` architecture check; no Node-only import).
It dictionary-segments Thai/Lao/Khmer/CJK, which the word-run `tokenize` cannot. The
index stores **char offsets** (`segment.index`) per occurrence so snippets are exact.
A consumer may still pass a custom `Tokenizer` (e.g. a domain segmenter). The build
path needs an offset-aware variant of the tokenizer for the index (term + offset);
plain `Tokenizer` (term-only) remains the public override type, with offsets derived
by re-segmenting when a custom tokenizer is supplied.

## Decisions

- **`retrieve()` is a new method**, not an overload of `search(field,…)` — keeps the
  shipped single-field API stable and seeds the L3 agent surface (L2 adds
  `mode:'semantic'|'hybrid'` here).
- **Max-field score combination** — a record ranks by its strongest field; that field
  is reported and snipped. Avoids long-document bias and keeps snippet attribution
  unambiguous. (Sum-across-fields considered and rejected for v1.)
- **Default `includeRecord:false`** — minimal disclosure is the default for the agent
  use case.
- **Session-rebuilt in-memory, behind `IndexStore`** — zero store footprint now;
  opaque-blob persistence (L1.5) plugs into the same seam without an API change.

## Privacy & leakage (the contract)

L1 is **pure client-side, in-memory**. Build and query touch **only already-
decrypted records in the trusted tier**; **nothing is written to the store** and no
store read pattern changes beyond the normal hydrate. Therefore L1 adds **zero**
leakage over L0 — the store remains zero-knowledge (ciphertext only). This is the
explicit reason L1 supersedes the store-side blind-index for PII data. (Access-
pattern hiding for any future server-side retrieval is L4/ORAM, out of scope.)

## Build sequence (independently shippable slices)

1. **Segmenter tokenizer** (`segment.ts`) + offset support + tests (Thai/CJK/NFKC). *Slice 1*
2. **`InvertedIndex`** (`inverted-index.ts`) — build (with i18n all-locale + blob filename/userMeta field expansion via `getAtPath` + descriptors; money/number excluded) + multi-field BM25 max-field query, reusing the scan formula; unit tests vs the scan ranker for parity on single-field. *Slice 2*
3. **Snippet** (`snippet.ts`) + tests. *Slice 3*
4. **`IndexStore`/`MemoryIndexStore`** seam + dirty-flag. *Slice 4*
5. **`collection.retrieve()` + `warmIndex()`** call-site + `textIndexes` config + dirty poke in put/delete + transparent `search()` acceleration + integration tests + leakage test (no store writes). *Slice 5*
6. **Docs + features.yaml + showcase** (Thai agent-retrieval query; snippet minimal-disclosure). *Slice 6*

## Testing & non-code obligations

- TDD throughout; conformance on `to-memory`.
- i18n: Thai/CJK segmentation + NFKC equivalence; word-run fallback parity for Latin.
- Ranking: multi-field max-field order; `match any/all`; prefix typeahead (autocomplete);
  single-field `retrieve` matches `searchScan` order (regression vs L0).
- **i18n:** a bilingual record is found by a term in *either* locale; hit carries the
  matched `locale`; snippet comes from that locale.
- **Blob metadata:** `filename`/`userMeta` are searchable; blob bytes are never read/
  tokenized by the index.
- **Field-type boundary:** money/number/date fields are NOT in the index (asserted);
  the hybrid pattern `retrieve ∩ where('amount','>',N)` returns the expected rows.
- **Dual-use / latency:** `warmIndex()` pre-builds so a subsequent `retrieve()` issues
  no build scan; autocomplete via repeated `prefix` calls reuses the warm index.
- Snippets: window bounds, multi-occurrence picks best, unicode-safe slicing.
- Lifecycle: dirty-rebuild after `put`/`delete`; `includeRecord` toggle.
- **Leakage test:** wrap the store; assert build+`retrieve` issue **zero writes** and
  no new key patterns (the zero-knowledge contract).
- Tree-shaking: default bundle unchanged unless `retrieve()`/search used.
- `features.yaml` `search-index` node updated (L1 capabilities; still preview/experimental);
  `docs/subsystems/search.md` extended (client-side index, i18n tokenizer, `retrieve`,
  the trusted-tier privacy rationale + epic L0–L4 map); showcase added.
- Kernel ceiling: keep `collection.ts` under 4922 (logic in `src/search/`); raise only if the thin call-site forces it.
