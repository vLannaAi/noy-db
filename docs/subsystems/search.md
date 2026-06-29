# Search — full-text / typeahead / lexical retrieval (#308)

> Status: **preview** (`experimental: true`). Includes L0 scan mode and L1
> client-side lexical index. The store-usable *blind index* (SSE) is superseded —
> see the trusted-tier rationale below and the L1 design spec:
> `docs/superpowers/specs/2026-06-22-ai-retrieval-l1-lexical-index-design.md`.

---

## Epic map: L0 → L4

| Layer | What | Status |
|---|---|---|
| **L0** | `collection.search(field, query, opts)` — in-memory decrypt + BM25 scan, zero leakage | ✅ shipped |
| **L1** | `collection.retrieve(query, opts)` — client-side **lexical inverted index**, i18n tokenizer, multi-field, snippet | ✅ shipped (#308) |
| **L1.5** | Persisted **opaque encrypted** index blob (warm cross-session, fingerprint staleness check, debounced flush) | ✅ shipped (#308 L1.5) |
| **L2** | Client-side **semantic / vector** retrieval — `retrieve({mode:'semantic'})` + `similarTo()` | ✅ shipped (#308 L2) |
| **L3** | **Hybrid retrieval** — `retrieve({mode:'hybrid'})` (RRF lexical+semantic) + `fuseRetrieval` + `within` filter | ✅ shipped (#308 L3) |
| L4 | Access-pattern privacy (ORAM) + attested-enclave (PCC-style) compute tier | research-grade |

---

## L0 — Scan mode (`collection.search`)

`collection.search(field, query, opts)` ranks records by relevance against a
tokenized query — moving full-text / typeahead out of userland and into the DB
**without weakening zero-knowledge**.

```ts
const hits = await docs.search('title', 'overdue invoice')         // OR, BM25-ranked
//   → [{ id, score, record }, …]  (best first)

await docs.search('title', 'overdue invoice', { match: 'all' })    // AND
await docs.search('title', 'mee', { prefix: true })                // typeahead
await docs.search('title', 'invoice', { limit: 10 })               // top-N
```

Scan mode decrypts the collection in memory and scores client-side (BM25), so
**nothing searchable is written to the store** — it adds *no* leakage beyond
what reading the collection already does. It is the safe default for sensitive
fields (names, notes). Cost is O(n) per query (eager mode only).

- `match`: `'any'` (default, OR) or `'all'` (AND of query terms).
- `prefix: true`: the **last** query term matches as a prefix (typeahead).
- `limit`: return the top-N by score.
- Returns `{ id, score, record }[]`, descending by score. Deleted / forgotten
  records never appear (the eager cache is evicted on delete / crypto-shred).

---

## L1 — Client-side lexical index (`collection.retrieve`)

`collection.retrieve(query, opts)` is the indexed retrieval path. It builds an
**in-memory inverted index** on first call (or on open when `warmIndexOnOpen:
true`), then scores query terms with **multi-field BM25** and returns ranked
hits with **per-hit snippet extraction**.

```ts
// Configure the collection — opt-in fields:
const invoices = vault.collection<Invoice>('invoices', {
  textIndexes: ['title', 'statusLabel', 'attachmentName'],
  warmIndexOnOpen: true,                 // pre-build on open (optional)
  i18nFields: { statusLabel: i18nText(…) },
  dictKeyFields: { category: dictKey('category', …) },
})

// Multi-field ranked search:
const hits = await invoices.retrieve('ใบแจ้งหนี้')
// → RetrieveHit[]  (best first)
//   { id, score, field, snippet, locale?, record? }

// Prefix autocomplete (typeahead):
const ac = await invoices.retrieve('ใบแจ้ง', { prefix: true, limit: 5 })

// Include the full decrypted record:
const detail = await invoices.retrieve('overdue', { includeRecord: true })
```

### `RetrieveHit<T>` shape

```ts
interface RetrieveHit<T> {
  readonly id: string       // record key
  readonly score: number    // BM25, descending
  readonly rank: number     // 1-based position — federation-ready (Reciprocal Rank Fusion across vaults/modalities)
  readonly field: string    // winning field (highest per-field BM25)
  readonly snippet: string  // ±window chars around the best match
  readonly locale?: string  // set for i18nText and dictKey hits
  readonly record?: T       // only when includeRecord: true
}
```

`rank` is 1-based and monotonic with score order. It enables cross-vault Reciprocal
Rank Fusion in the klum-db Lobby (L3) without sharing corpus-relative BM25 scores
across vault boundaries (which would leak global document frequency). It also powers
L3's lexical⊕semantic hybrid fusion.

### `RetrieveOptions`

| Option | Default | Meaning |
|---|---|---|
| `mode` | `'lexical'` | `'lexical'` (L1 BM25), `'semantic'` (L2 cosine), or `'hybrid'` (L3 RRF fusion — requires `embeddings`) |
| `limit` | — | Return top-N hits only |
| `match` | `'any'` | `'any'` = OR, `'all'` = AND of query terms |
| `prefix` | `false` | Last query term is a prefix (typeahead / autocomplete) |
| `snippetWindow` | `80` | Half-window char count around the best match |
| `fields` | all `textIndexes` | Restrict search to a subset of indexed fields |
| `includeRecord` | `false` | Attach the full decrypted record to each hit |
| `within` | — | `Query<T>` from `collection.query().where(…)` — intersects hits with a predicate (eager-mode only, zero store writes); see [Hybrid retrieval docs](embeddings.md#hybrid-retrieval-l3) |

### `textIndexes` collection option

```ts
vault.collection<T>('name', {
  textIndexes: ['title', 'notes', 'category', 'attachmentName'],
  warmIndexOnOpen: true,   // auto-build on collection open
})
```

`textIndexes` is an **opt-in allowlist** of field paths (supports nested paths
and `[]`-wildcard arrays). Only fields in this list enter the index — collections
with no `textIndexes` pay zero overhead.

---

## Field-type matrix

| Field type | Indexed by `retrieve()`? | How |
|---|---|---|
| `string` | ✅ | Tokenized directly |
| `i18nText` (`{[locale]:string}`) | ✅ | **All locale values** indexed; hit carries matched `locale`; locale-agnostic search |
| `dictKey` label | ✅ opt-in | **Resolved labels** (all locales) from the dictionary; opaque key not text-indexed (use `where` for key equality) |
| Blob field — `filename` | ✅ (heaviest, last) | Slot metadata via `listSlots(recordId)` (async per-record, separate `_blob_*` collection); bytes never tokenized |
| `money` / `number` / `date` / `boolean` | ⛔ by design | Use `where('amount', '>', 1000)` — text-formatting variance makes full-text wrong |
| Blob **content** (PDF / image bytes) | ⛔ out of scope | App extracts text into a `string` field (OCR / PDF→text), which then indexes |

**Hybrid pattern:** combine `retrieve()` and `where()` in the caller:

```ts
const textHits = new Set((await invoices.retrieve('overdue')).map((h) => h.id))
const rows = invoices.query().where('amount', '>', 1000).run()
const combined = rows.filter((r) => textHits.has(r.id))
```

---

## i18n tokenizer — `Intl.Segmenter`

The L1 tokenizer uses **`Intl.Segmenter`** (`granularity:'word'`) → NFKC-normalize
→ lowercase → keep word-like segments. This correctly segments Thai, CJK, and
other scripts without inter-word spaces (e.g. a Thai word run is split into
individual words rather than collapsed into one token per run).

A custom tokenizer is pluggable via the `Tokenizer` interface:

```ts
import type { Tokenizer } from '@noy-db/hub'
// Tokenizer = (text: string) => string[]
```

The L0 (`search`) tokenizer is **NFKC + lowercase + Unicode word-boundary split**
(no `Intl.Segmenter`). For Thai/CJK fields, prefer `retrieve()` (L1) which uses
the segmenter.

---

## `warmIndex()` and `warmIndexOnOpen`

The index is **lazy by default** — built on the first `retrieve()` call. To
pre-build:

```ts
// 1. On-demand pre-build:
await invoices.warmIndex()

// 2. Auto-build on collection open (set in collection options):
vault.collection<Invoice>('invoices', {
  textIndexes: ['title'],
  warmIndexOnOpen: true,
})
```

Both require **eager mode** (`prefetch: true`, the default). Calling
`warmIndex()` on a lazy collection throws immediately.

---

## In-memory, session-rebuilt — and L1.5 persisted index

The L1 index is **session-scoped and in-memory** by default:

- It is built from the **decrypted eager cache** — no extra store reads.
- It is **never written to the store** — zero leakage.
- On a new session the index rebuilds on first `retrieve()` / `warmIndex()`.
- A write (`put` / `delete`) marks the index **dirty**; the next `retrieve()`
  triggers a full rebuild. Incremental posting updates are an L1.5+ optimization.

**L1.5 — `textIndexPersist: true` (shipped #308 L1.5):** Opt-in persisted backend
that survives sessions and devices with **zero added leakage**.

### `textIndexPersist` option

```ts
vault.collection<Invoice>('invoices', {
  textIndexes: ['title', 'notes'],
  textIndexPersist: true,   // opt-in: persist the index as an opaque encrypted blob
  warmIndexOnOpen: true,    // combine with warm load for instant first retrieve()
})
```

When `textIndexPersist: true`:

- The in-memory index is serialized and **encrypted under the collection DEK** (the
  same key used for all records in the collection). The store sees **one opaque
  ciphertext blob** at `_ftindex/<collection>` — no terms, postings, or plaintext.
  Per-term addressability (the blind-index leakage profile) is structurally absent.
- On `retrieve()` / `warmIndex()` in a new session: the blob is loaded and
  **fingerprint-checked** (`{ count, maxVersion }` derived from the eager cache).
  If the fingerprint matches, the index is used as-is (cold load with no re-tokenize
  scan). If it does not match (a write on another device/tab), the index is rebuilt
  and re-persisted (self-healing).
- Writes (`put` / `delete`) mark the index dirty and schedule a **debounced flush**
  — typically ~1 blob write per burst of writes, not per record.
- **`flushIndex()`** — force-persist the index immediately (call before saving state
  to a checkpoint, or before a known idle window):

  ```ts
  await invoices.flushIndex()
  ```

- **Close-flush** — `db.close()` triggers a best-effort flush of any pending dirty
  index so the next session finds the freshest blob.
- **`forget()` teardown** — `vault.forget(subject)` crypto-shreds records and **also
  deletes the `_ftindex` blob** (calls `remove()` + `markDirty`). The blob's DEK
  scope means it would still decrypt the forgotten subject's indexed terms if left in
  place — so it is purged. The next `retrieve()` rebuilds from the post-forget record
  set. If the blob could not be deleted (e.g. store is offline at shred time), this
  is reported as a **residue warning** in the `forget()` return value — the same
  residue-tracking contract as the `_idx` side-cars (per #401).

### Fingerprint `{ count, maxVersion }`

The fingerprint is derived cheaply from the in-memory eager cache at load time:
`count` = number of records in the cache, `maxVersion` = the highest `_v` across
all records. Every `put` bumps `_v`; every `delete` changes `count`. A fingerprint
mismatch means the record-set has changed since the blob was built, so the blob is
discarded and the index rebuilt. This is best-effort (two corpora can share count +
maxVersion by coincidence), but in practice every normal operation changes at least
one of the two values.

### Zero-leakage guarantee

`textIndexPersist` does **not** add any new store leakage beyond the opaque blob
size. Specifically:

- No per-term keys (blind-index pattern): the entire posting list is one blob.
- The blob is ciphertext under the collection DEK — the store cannot distinguish
  index writes from record writes by content.
- The fingerprint is stored **inside** the encrypted envelope — the store never sees
  plaintext fingerprint values.
- `textIndexPersist: false` (default) writes nothing — collections without this
  option pay zero overhead.

See the L1.5 design spec for detailed threat analysis:
`docs/superpowers/specs/2026-06-22-ai-retrieval-l1.5-persisted-index-design.md`

---

## Trusted-tier / zero-leakage rationale

The design is motivated by state-of-the-art private personal-AI retrieval:

- **Apple Intelligence / Spotlight** — the semantic index runs **on-device**; the
  RAG context is assembled locally; only the relevant excerpt reaches the model.
- **Apple Private Cloud Compute** — when on-device isn't enough, an **attested,
  stateless, non-retaining** enclave handles inference; trust comes from hardware
  attestation, not operator goodwill.
- **Opal (2026)** — query/retrieval reasoning in a **trusted enclave**; the
  untrusted disk holds encrypted data behind ORAM; the store learns only fixed
  access patterns.

The unifying principle: **keep retrieval in the trusted tier; the untrusted store
sees only ciphertext.**

noy-db's architecture already embodies this: the untrusted store = the cloud; the
key-holding client = on-device ("Spotlight for your vault"). The L1 lexical index
lives **entirely client-side**, is **never written to the store**, and adds **zero**
leakage beyond what reading the collection already does.

The earlier alternative — a *store-usable blind index* (SSE) — would put a
queryable index in the untrusted store and leak per-term document frequency,
co-occurrence, and query access-pattern. That is the classic profile behind
IKK/count query-recovery attacks, and **not appropriate for PII-heavy data by
default**. The SSE path is superseded by the client-side index.

---

## Cross-references

- L1 design + field-type analysis: `docs/superpowers/specs/2026-06-22-ai-retrieval-l1-lexical-index-design.md`
- L1.5 persisted index design: `docs/superpowers/specs/2026-06-22-ai-retrieval-l1.5-persisted-index-design.md`
- L3 hybrid design: `docs/superpowers/specs/2026-06-23-ai-retrieval-l3-hybrid-design.md`
- Showcase 111: L0 scan-mode search — `showcases/src/111-scan-search.showcase.test.ts`
- Showcase 122: L1 `retrieve()` walkthrough — `showcases/src/122-with-retrieve.showcase.test.ts`
- Showcase 123: L1.5 persisted index warm load — `showcases/src/123-persisted-index.showcase.test.ts`
- Showcase 124: L2 semantic retrieve — `showcases/src/124-semantic-retrieve.showcase.test.ts`
- Showcase 125: L3 hybrid retrieve + fuseRetrieval — `showcases/src/125-hybrid-retrieve.showcase.test.ts`
- L2/L3 semantic + hybrid docs: `docs/subsystems/embeddings.md`
- `features.yaml` → `features` → `search-index`
