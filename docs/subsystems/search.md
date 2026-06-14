# Search — full-text / typeahead (#308)

> Status: **preview**. Scan mode only. The store-usable *blind index* (SSE) is a
> separate, explicitly-gated opt-in — design + leakage analysis in
> `docs/superpowers/specs/2026-06-14-full-text-search-index-design.md`.

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

## Scan mode — zero added leakage

Scan mode decrypts the collection in memory and scores client-side (BM25), so
**nothing searchable is written to the store** — it adds *no* leakage beyond
what reading the collection already does. It is the safe default, and the right
choice for sensitive fields (names, notes). Cost is O(n) per query (eager mode
only), which is appropriate at small/medium scale — the point is to replace a
hand-rolled userland scan with one call, not to scale to millions of records.

- `match`: `'any'` (default, OR) or `'all'` (AND of query terms).
- `prefix: true`: the **last** query term matches as a prefix (typeahead).
- `limit`: return the top-N by score.
- Returns `{ id, score, record }[]`, descending by score. Deleted / forgotten
  records never appear (the eager cache is evicted on delete / crypto-shred).

## Tokenization

The default tokenizer is **NFKC-normalize → lowercase → Unicode word-boundary
split**. It does **not** segment scripts written without inter-word spaces
(Thai, Lao, Khmer, CJK) — those collapse to one token per run. A
dictionary/ICU segmenter (pluggable `tokenizer`) is a follow-up; for such data,
prefer substring matching until then. See the design note.

## Not in scan mode (gated / future)

A **store-usable blind index** (searchable symmetric encryption) would let the
store narrow candidates without a full scan — but it leaks per-term document
frequency, co-occurrence, and query access-pattern (a classic SSE profile that
enables leakage-abuse query-recovery attacks). It is therefore **not** built
here: it is gated behind an explicit `acknowledgeSearchIndexRisk` opt-in, a
`forget()` posting-purge (#401), an HMAC token primitive, and an i18n tokenizer
— all detailed in the design note. Blind-index is **not** appropriate by default
for sensitive PII.
