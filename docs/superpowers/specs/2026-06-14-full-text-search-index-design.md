# Full-text / secondary search index (#308)

> **Status:** DESIGN — awaiting maintainer decision (see § Decision).
> **Context:** Pilot-3 (i3speedex) does typeahead/full-text search by scanning
> the decrypted in-memory vault client-side (design §9). Fine at ~500 records;
> it doesn't scale and lives outside the DB. The README already advertises
> "deterministic encryption for searchable indexes" as an opt-in tradeoff —
> this scopes how a *term-level* search index works on top of that primitive.

## Problem

`indexing` provides **equality** indexes only (`lookupEqual`/`lookupIn`, plus
range/`orderedBy` in the lazy persisted mirror). There is no token/text index,
so `where('name','contains',q)` / `startsWith` are **linear scans** over decrypted
records (`query/predicate.ts` — `contains`/`startsWith` have no index fast-path).
A consumer who wants typeahead must decrypt the whole collection and scan in
userland — O(n) per keystroke, and business logic outside the store.

The hard constraint: noy-db is zero-knowledge. The store sees only ciphertext.
A search index that the store can *use* must encode something the store can match
against — which necessarily **leaks structure**. The job is to make that leakage
a precise, opt-in, documented choice — not to pretend it's free.

## Current state (grounded)

noy-db already ships the exact cryptographic primitive a search index needs —
just applied at *whole-field* granularity:

- **Deterministic field tokens (blind equality).** `deterministicFields` +
  `acknowledgeDeterministicRisk: true` (`vault.ts:657`, gated in
  `collection.ts:876`). On write, `encryptDeterministic(plaintext, dek, context)`
  (`crypto.ts:502`) derives a **stable** token via HKDF-SHA256 (salt
  `'noydb-deterministic-v1'`, info `'${collection}/${field}\x00${plaintext}'`,
  keyed by the **collection DEK**) → AES-GCM → stored on the envelope as
  `_det[field] = 'iv:data'` (`collection.ts:4088`). `findByDet`/`queryByDet`
  match by recomputing the token and string-comparing — **no record body is
  decrypted** (`collection.ts:4107`). Documented leakage: **equality + frequency,
  not ordering** (`collection.ts:740`).
- **Encrypted side-car indexes.** The lazy persisted index already stores one
  encrypted record per `(field, recordId)` at `_idx/<field>/<recordId>`, under the
  **collection DEK** (not per-record CEK — so blind matching survives CEK rotation,
  `types.ts:154`), updated mirror-first then side-car with drift reconcile
  (`collection.ts:3777`). `PersistedCollectionIndex` exposes
  `lookupEqual/lookupIn/lookupRange/orderedBy` (`persisted-indexes.ts`).
- **Query fast-path seam.** `QuerySource.getIndexes()` + `lookupById`
  (`query/builder.ts:75`); `candidateRecords` (`builder.ts:1000`) routes `==`/`in`
  to the index and materialises only hits, else linear-scans. Lazy mode
  (`lazy-builder.ts`) decrypts only candidate ids and throws `IndexRequiredError`
  rather than scanning.
- **Subsystem pattern.** `indexing` is a tree-shakeable strategy wired via
  `createNoydb({ indexStrategy: withIndexing() })` → threaded into every
  collection (`vault.ts:872`, `active.ts`). Engines live off the kernel; only thin
  call-sites touch `collection.ts`/`vault.ts`.

**So #308 is "deterministic equality, but per *term* instead of per *field*,"**
plus tokenization, ranking, and an honest leakage statement. Everything below
reuses `encryptDeterministic` and the `_idx`-style encrypted side-car.

## Core design — a blind inverted index (SSE)

Tokenize an indexed field into terms; deterministically tokenize each **term**;
store an encrypted **posting** per (term, record). Query = tokenize the query,
recompute term tokens, intersect/union posting sets to a candidate id set,
decrypt **only** the candidates, rank client-side.

- **Write path.** For an indexed field, `tokenize(value)` → normalized term set
  (Unicode word-split + lowercase + optional accent-fold). For each unique term
  `t`, derive `tok = encryptDeterministic(t, dek, '${collection}/${field}#term')`
  and write an encrypted posting at `_ft/<field>/<tok>/<recordId>` with body
  `{ recordId, tf, positions? }` (tf = term count for ranking; positions optional
  for phrase search). Mirror-first + side-car, exactly like `_idx` (reuses the
  drift/reconcile machinery). On update, diff old vs new term sets → add/remove
  postings. On delete/`forget()`, delete `_ft/*/*/<recordId>` (postings are
  record-keyed, so erasure is clean — see § Forget interplay).
- **Read path.** `tokenize(query)` → term tokens → for each, read its posting set
  (`_ft/<field>/<tok>/*`, ids only) → combine (`match: 'all'`=AND / `'any'`=OR) →
  candidate ids → decrypt only those → rank → page. A term whose token has no
  postings short-circuits an AND to empty.
- **Ranking (no ordering leak).** The store must never learn relevance order, so
  ranking happens **client-side over the already-fetched candidates**: BM25 using
  document frequency `df` = posting-set size per term-token (cheap — a count, no
  decrypt) and `tf` from the decrypted posting body. This keeps retrieval sublinear
  (touch only matching postings) while ranking stays exact.
- **Prefix / typeahead.** Opaque tokens can't be range-scanned, so prefix support
  is **write-time edge-n-grams**: index the prefixes of each term up to
  `prefix.maxLen` (`appl` → `a, ap, app, appl`) as additional term tokens. A
  typeahead query tokenizes the last word as a prefix lookup. This is the classic
  typeahead tradeoff and leaks **prefix frequency** on top of term frequency — so
  it's a separate opt-in knob, off by default.

### Leakage profile (state it loudly — this IS the feature's contract)

Per indexed field, the store/host learns:
- the **number of distinct terms** (vocabulary size) and, per opaque term, its
  **document frequency** (how many records contain it — from posting-set sizes);
- **co-occurrence** — which records share which opaque terms;
- with `prefix`: **prefix frequencies** too;
- **query access pattern** — which posting-sets a search touches (correlatable
  over time; a known-vocabulary attacker can fingerprint frequent terms).

It does **not** learn: the plaintext terms, the field text, value ordering/
magnitude, or anything about non-indexed fields. This is a standard **searchable
symmetric encryption (SSE)** L1/L2 profile — strictly richer than today's
whole-field deterministic equality (term granularity + co-occurrence), and so it
demands its own explicit acknowledgement, separate from `deterministicFields`.

## Decision

Layered, independently shippable; decide how far to go.

### 1. `mode: 'scan'` — zero-extra-leakage fallback — recommend YES (cheap)

Move the userland scan *into* the hub: `collection.search(field, q, opts)` that
decrypts + matches in-memory (reusing the candidate-decrypt path). **No new
leakage** (no side-car, nothing extra hits the store); still O(n). This is the
correct default for small or maximally-sensitive collections and gives every
consumer the *ergonomic* API immediately, with the index as an opt-in upgrade.

### 2. `mode: 'blind-index'` — the SSE inverted index above — recommend YES, gated

Opt-in per field, **gated on `acknowledgeSearchIndexRisk: true`** (mirrors
`acknowledgeDeterministicRisk`; the gate error states the leakage profile). Lives
in a new tree-shakeable `src/search/` subsystem behind the index-strategy seam —
**no kernel growth** beyond thin call-sites. Word-level AND/OR + client-side BM25.

### 3. `prefix: { maxLen }` — edge-n-gram typeahead — recommend YES as a sub-opt-in

Off by default; when on, documents the added prefix-frequency leakage. Bounded
`maxLen` caps index blow-up (≈ maxLen postings per term).

### 4. Fuzzy / typo-tolerance — recommend DEFER

Trigram tokens give fuzzy match but leak trigram frequency (close to plaintext
n-gram statistics) and balloon the index. Defer until a pilot needs it; revisit
with a padding/obfuscation knob.

**Recommendation: ship 1 + 2 + 3, defer 4.** API sketch:

```ts
vault.collection<Contact>('contacts', {
  textIndexes: [
    { field: 'name',  mode: 'blind-index', prefix: { maxLen: 12 } },
    { field: 'notes', mode: 'scan' },                 // sensitive: no side-car
  ],
  acknowledgeSearchIndexRisk: true,                   // required for any blind-index field
})

// Typeahead (prefix on the last token), ranked, paged:
const hits = await contacts.search('name', 'joh', { prefix: true, limit: 10 })
// Boolean AND across terms, BM25-ranked:
const hits2 = await contacts.search('name', 'john smith', { match: 'all' })
// Compose with a normal filter (candidate set ∩ where):
const hits3 = await contacts.query().where('status','==','active').search('name','john')
```

`search()` returns `{ id, score, record }[]` (ranked). Optionally expose a
`where(field,'textMatch',q)` boolean operator (no ranking) for pure filtering that
composes with the existing predicate pipeline via the index fast-path.

## Build (if approved)

- **`src/search/` subsystem** — `tokenize` (Unicode words + fold + optional
  edge-n-grams), `SearchIndex` (build/upsert/delete + posting reader), BM25 ranker.
  Reuses `encryptDeterministic` (`crypto.ts`) for term tokens and the `_idx`
  side-car encrypt/reconcile machinery (factor the shared posting I/O out of
  `persisted-indexes.ts`).
- **Collection wiring (thin):** `textIndexes` option + `acknowledgeSearchIndexRisk`
  gate (mirror `deterministicFields` at `collection.ts:876`); diff-and-update
  postings in the put/delete hooks alongside the existing `_idx` update
  (`collection.ts:3777`); `collection.search()` call-site. Keep the engine off the
  kernel — watch the `collection.ts`/`vault.ts` ceilings.
- **Query op (optional):** `'textMatch'` in `query/predicate.ts` + a fast-path
  branch in `candidateRecords` (`builder.ts:1000`) that resolves via the posting
  reader, plus a `.search()` terminal on the builder.
- **Forget interplay:** postings are `recordId`-keyed under the **collection DEK**
  (consistent with `_idx`/`_det`); `forget()`/crypto-shred must delete
  `_ft/*/*/<recordId>`. Cross-check the forget-cascade design's deterministic-field
  note (`2026-06-08-forget-cascade-design.md` §"Tier/deterministic-field
  interplay") — same concern, same resolution (DEK-scoped, record-keyed → eager
  delete on forget).
- **Tests + showcase:** word AND/OR, prefix typeahead, BM25 ordering, update
  removes stale postings, forget purges postings, the gate throws without the ack;
  a leakage-assertion test (store sees term tokens + df, never plaintext).
- **Docs + features.yaml:** a `search-index` feature entry (`status: preview`,
  `experimental: true`) with the leakage profile front-and-center; README
  searchable-index note cross-link.

## Non-goals / open questions (v1)

- **Cross-field / cross-collection search**, relevance tuning beyond BM25 defaults,
  and stored phrase/positional search (positions are reserved in the posting body
  but phrase queries are deferred).
- **Padding / access-pattern obfuscation** (dummy postings, query batching) to
  blunt frequency + access-pattern leakage — a future hardening knob; v1 documents
  the leakage rather than masking it.
- **Re-homing an index after a tokenizer change** — changing `tokenize` invalidates
  existing tokens; treat as a `reconcileIndex`/rebuild, not a live migration.
- **Stemming / language-aware tokenization** — v1 ships Unicode word-split + fold;
  pluggable `tokenizer` is the extension seam.
