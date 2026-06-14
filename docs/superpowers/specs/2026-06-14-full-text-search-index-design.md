# Full-text / secondary search index (#308)

> **Status:** DESIGN — awaiting maintainer decision (see § Decision).
> **Recommendation in one line:** ship `mode:'scan'` now (zero new leakage,
> solves the pilot); specify but **gate** the blind-index (SSE) behind three hard
> prerequisites — it is **not** appropriate by default for sensitive PII.
> **Context:** Pilot-3 (i3speedex) does typeahead/full-text by scanning the
> decrypted in-memory vault client-side (design §9). Fine at ~500 records; doesn't
> scale and lives outside the DB. This note went through an adversarial review
> (2026-06-14) that corrected the token primitive, surfaced a forget()/erasure
> dependency (#401), and flipped the recommendation to scan-first.

## Problem

`indexing` provides **equality** indexes only (`lookupEqual`/`lookupIn`, plus
range/`orderedBy` in the lazy persisted mirror). There is no token/text index, so
`where('name','contains',q)` / `startsWith` are **linear scans** over decrypted
records (`query/predicate.ts` — no index fast-path for these). A consumer wanting
typeahead must decrypt the whole collection and scan in userland — O(n) per
keystroke, logic outside the store.

The hard constraint: noy-db is zero-knowledge — the store sees only ciphertext.
An index the store can *use* must encode something matchable, which **leaks
structure**. The job is to make that leakage a precise, opt-in, documented choice
(and, where leakage is unacceptable, to offer a zero-leakage fallback) — not to
pretend search is free.

## Current state (grounded)

The cryptographic building blocks already exist; the gaps are tokenization,
ranking, an honest leakage statement, and an erasure fix.

- **Keyed PRF for blind tokens.** `hmacSha256Hex(key, data)` (`crypto.ts:312`)
  is a fixed-length, one-way, DEK-keyed fingerprint — the right primitive for an
  index token (see § Token primitive). Note: the *existing* whole-field
  deterministic-equality feature uses `encryptDeterministic` (`crypto.ts:502`)
  instead, which returns AES-GCM `{iv,data}` whose `data` length ∝ plaintext —
  i.e. it **leaks value length**. We deliberately do NOT reuse that for tokens.
- **`deterministicFields` precedent.** Opt-in per field, gated on
  `acknowledgeDeterministicRisk: true` (`vault.ts:657`, `collection.ts:876`),
  with a documented leakage trade-off (`crypto.ts:455`). The search-index ack
  mirrors this — but louder, because term-granularity leaks more (§ Leakage).
- **Encrypted side-car indexes.** The lazy persisted index stores one encrypted
  record per `(field, recordId)` at `_idx/<field>/<recordId>` under the
  **collection DEK** (so blind matching survives CEK rotation, `types.ts:154`),
  updated mirror-first then side-car with drift reconcile (`collection.ts:3740`).
  `delete()` tears these down (`collection.ts:2272-2289`).
- **Erasure gap (blocking — see #401).** `forget()` crypto-shreds via
  `_writeTombstone`, which **bypasses** the delete path's index teardown
  (`collection.ts:2336`). So persisted `_idx` side-cars **survive crypto-shred**,
  DEK-decryptable — a forgotten subject's indexed values leak. A `_ft` full-text
  index amplifies this (equality-classes → actual terms). #401 must land first.
- **Query fast-path seam.** `QuerySource.getIndexes()` + `lookupById`
  (`query/builder.ts:75`); `candidateRecords` (`builder.ts:1000`) routes `==`/`in`
  to the index, else linear-scans. Lazy mode decrypts only candidate ids.
- **Subsystem pattern.** `indexing` is a tree-shakeable strategy wired via
  `createNoydb({ indexStrategy })` (`active.ts`); engines live off the kernel,
  only thin call-sites touch `collection.ts`/`vault.ts`.

## Two modes

### `mode:'scan'` — zero-extra-leakage (the default, build now)

Move the userland scan *into* the hub: `collection.search(field, q, opts)`
decrypts + matches in memory (reusing the candidate-decrypt path), ranks, pages.
**Nothing new touches the store — zero added leakage, zero write amplification.**
Still O(n) per query, but at the pilot's scale (hundreds–low thousands) that is
entirely adequate, and it gives every consumer the *ergonomic* `search()` API
immediately. This is the correct default, and the only safe option for sensitive
fields (names, notes — PII).

### `mode:'blind-index'` — a searchable-symmetric-encryption (SSE) inverted index

For scale, an opt-in **blind inverted index**, gated behind prerequisites (below)
and a PII-aware acknowledgement.

- **Token primitive (corrected).** For each normalized term `t`, the token is a
  **fixed-length keyed PRF**: `hmacSha256Hex(dek, '${collection}/${field}#'+t)`
  (truncated). Fixed width **hides term length** (unlike `encryptDeterministic`),
  is one-way (you recompute it from the query term — decryption isn't needed), and
  has no GCM IV-reuse failure mode. The DEK keying means the store **cannot** build
  a term→token dictionary offline without the key.
- **Write.** `tokenize(value)` → normalized term set (§ Tokenization). For each
  unique term, write an encrypted posting at `_ft/<field>/<token>/<recordId>` with
  body `{ recordId, tf, positions? }` (tf for ranking; positions reserved for
  phrase search). On update, diff old vs new term sets → add/remove postings.
- **Read.** `tokenize(query)` → tokens → read each posting set (ids only) →
  combine (`match:'all'`=AND / `'any'`=OR) → candidate ids → decrypt **only**
  candidates → rank → page.
- **Ranking — client-side, so order never leaks.** BM25 computed locally over the
  fetched candidates: `df` = posting-set size per token (a `list` count, no
  decrypt), `tf` from the decrypted posting; `N` and `avgdl` from a small
  maintained `_ft_meta` record (or an approximation). The store never sees
  relevance order.
- **Prefix / typeahead.** Opaque tokens can't be range-scanned, so prefix support
  is **write-time edge-n-grams** (`appl` → `a,ap,app,appl`) up to `prefix.maxLen`.
  A separate sub-opt-in — it adds prefix-frequency leakage and ≈`maxLen`× write
  amplification.

## Leakage profile (this IS the contract — read before enabling blind-index)

Per blind-indexed field, the store/host learns:
- **vocabulary size** and, per opaque term, its **document frequency** (posting-set
  sizes);
- **co-occurrence** — which records share which opaque terms (the full graph);
- **query access-pattern** — which posting-sets a search touches;
- with `prefix`: **prefix frequencies** too.

It never learns plaintext terms, field text, value ordering, or anything about
non-indexed fields. This is a standard **SSE L1/L2 profile** — and the df +
co-occurrence + access-pattern combination is precisely what powers **leakage-abuse
query-recovery attacks** (count / IKK) given modest auxiliary knowledge of the
data distribution. **For high-value PII — client names, notes in a private
accounting context — blind-index is the wrong default; use `mode:'scan'`.** Reserve
blind-index for higher-cardinality, lower-sensitivity, or already-semi-public
fields where the scale need is real and the leakage is acceptable.

## Prerequisites for blind-index (all required before building)

1. **#401 — `forget()` must purge index side-cars + report residue.** A
   DEK-encrypted index is exactly what crypto-shred (which keeps the DEK) cannot
   erase; `forget()` must hard-delete `_ft/*/*/<recordId>` (and `_idx`) and surface
   any unpurgeable residue in `ForgetResult`. Without this, blind-index silently
   breaks the erasure SLA.
2. **Token primitive = `hmacSha256Hex`** (fixed-length, length-hiding) — not
   `encryptDeterministic`.
3. **i18n-aware tokenizer.** Whitespace/Unicode-word splitting **fails for Thai**
   (no inter-word spaces) and CJK — the most likely real data here. The tokenizer
   must be ICU/dictionary-segmentation-capable and pluggable, with **Unicode NFKC
   normalization** before tokenizing (so visually-identical strings tokenize
   identically). Edge-n-gram prefixes on Thai/CJK are character-grams with their
   own leakage — treat carefully.

## Decision

- **(1) `mode:'scan'` — recommend BUILD NOW.** Solves the pilot's ergonomics +
  scale-for-now with zero new leakage; gives the `search()` API everyone wants.
- **(2) `mode:'blind-index'` (SSE) — recommend SPECIFY + GATE, build later.** Only
  once the three prerequisites land *and* a concrete scale need justifies the
  leakage; gated on `acknowledgeSearchIndexRisk: true` whose error states the
  leakage profile and the "not for sensitive PII" guidance.
- **(3) `prefix:{maxLen}` edge-n-gram typeahead — sub-opt-in of (2).**
- **(4) fuzzy / trigram typo-tolerance — DEFER** (leaks near-plaintext n-gram
  statistics + index blow-up).

```ts
vault.collection<Contact>('contacts', {
  textIndexes: [
    { field: 'notes', mode: 'scan' },                                  // PII → no side-car
    { field: 'category', mode: 'blind-index', prefix: { maxLen: 8 } }, // low-sensitivity facet
  ],
  acknowledgeSearchIndexRisk: true,   // required for ANY blind-index field
})

const hits  = await contacts.search('notes', 'overdue invoice', { match: 'all' })  // scan, ranked
const tah   = await contacts.search('category', 'con', { prefix: true, limit: 10 }) // typeahead
```

`search()` returns `{ id, score, record }[]` (ranked). Optionally a
`where(field,'textMatch',q)` boolean operator for pure filtering that composes with
the predicate pipeline; composition = (search candidate set) ∩ (where set / post-
filter), ranking applied to the intersection.

## Build

- **`mode:'scan'` (now):** `collection.search()` + tokenizer + BM25 ranker in a new
  tree-shakeable `src/search/` subsystem; thin call-site on the collection. No
  store/schema change.
- **`mode:'blind-index'` (gated):** `SearchIndex` (build/upsert/delete + posting
  reader) reusing `hmacSha256Hex` and the side-car encrypt/reconcile machinery
  (factor shared posting I/O out of `persisted-indexes.ts`). Note: full-text
  reconcile is **rebuild-by-re-tokenize per record**, materially heavier than the
  single-value `_idx` reconcile — not a free reuse. Wire `textIndexes` +
  `acknowledgeSearchIndexRisk` (mirror `deterministicFields` gating at
  `collection.ts:876`); diff-update postings in the put/delete hooks; keep the
  engine off the kernel (watch the `collection.ts`/`vault.ts` ceilings).
- **Query op (optional):** `'textMatch'` in `query/predicate.ts` + a fast-path in
  `candidateRecords` (`builder.ts:1000`); a `.search()` terminal on the builder.
- **Tests + showcase:** scan ranking; (gated) word AND/OR, prefix typeahead, BM25
  order, update removes stale postings, **`forget()` purges all postings (ties to
  #401)**, gate throws without the ack, a leakage-assertion test (store sees fixed-
  length tokens + df only, never plaintext or term length).
- **Docs + features.yaml:** a `search-index` feature (`status: preview`,
  `experimental: true`) leading with the leakage profile + the scan-vs-blind
  guidance; README searchable-index note cross-link.

## Non-goals / open questions (v1)

- **DEK rotation invalidates the blind index** (tokens are DEK-derived) → full
  rebuild, same as a tokenizer change. Treat as `reconcileIndex`/rebuild.
- **Write amplification:** a blind-index put writes `|terms| × (1+prefixLen)`
  encrypted postings → real cost/latency on cloud stores (DynamoDB/S3). A further
  reason scan is the default until scale forces the trade.
- **Mode applicability:** blind-index restricted to eager/persisted modes;
  **not** CRDT/tiered (matches `unique-constraints` rejecting those).
- **Padding / access-pattern obfuscation** (dummy postings, query batching) to
  blunt frequency + access-pattern leakage — a future hardening knob; v1 documents
  leakage rather than masking it.
- **Cross-field / cross-collection search, stored phrase/positional queries,
  stemming, relevance tuning beyond BM25 defaults** — deferred; `tokenizer` is the
  extension seam.
