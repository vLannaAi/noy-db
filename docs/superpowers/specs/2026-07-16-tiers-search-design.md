# Arc 6 — tiers × search: elevated records leave tier-0 search (#721)

**Issue:** [#721](https://github.com/vLannaAi/noy-db/issues/721) + [recon comment](https://github.com/vLannaAi/noy-db/issues/721#issuecomment-4989771260). **CRITICAL** — a cold-readable, at-rest, *full-plaintext* leak.
**Predecessors (merged):** #700/#710/#714/#717 (read surface) · #719 (write ring) · #723 (#709 — field indexes). This is the search analogue of #709.

## The problem (recon-confirmed, worse than the issue first stated)

The search subsystem persists two artifacts derived from a record's plaintext, both encrypted **always under the tier-0 collection DEK** (via `encryptJsonString`'s no-CEK branch → `record-codec.ts:258`), and `elevate()` touches neither:

1. **`_ftindex/<name>` — the lexical inverted index (top severity).** The persisted snapshot stores `text: d.text` per doc (`inverted-index.ts:149-159`) — the **complete verbatim field text**, not tokens or postings. A tier-0 read of the blob recovers an elevated record's *entire* indexed plaintext + term offsets. Cold-readable.
2. **`_vec/<recordId>` — the embedding sidecar.** Holds the raw (un-quantized) embedding (`collection-facade.ts:382`). The code itself calls a vector "text-invertible" (`collection.ts:4194`, `vault.ts:2396`). `buildVectorLoad` (`:190-204`) and `VectorSet.cosineTopK` are ungated, so a **cold** `similarTo()` surfaces the elevated record's id + similarity score with no warm cache.

Warm (same-session) leak too: the in-memory `InvertedIndex`/`VectorSet` are session-resident and evicted only via `markDirty()`, which tier ops never call — so a warm `retrieve()`/`similarTo()` in the elevating session returns the elevated record, with a snippet drawn from the index's **own** stored text (cache eviction cannot suppress it).

`forget()` purges both (`_purgeSearchIndex` `collection.ts:4203`, `_purgeVector` `:4196`). **`elevate()` has no analogue** — the campaign's recurring shape: *every `forget()` purge site is an `elevate()` bug.*

## Decision (follows the #709 precedent): purge/rebuild, elevated records leave search

Consistent with #709's field-index choice — an elevated record is **not present in any search index**, so it is not findable by `retrieve()` or `similarTo()`, **including from a session that holds its tier DEK**. `getAtTier`/`listAtTier` remain the tier-aware read surfaces. (Rejected: *refuse search+tiers at registration* like unique+tiers — removes a working combination; the primitives to fix it cleanly already exist. Deferred: *tier-scoped search artifacts* so cleared callers keep searching elevated records — a real future option, not needed to close the leak.)

## Design — the asymmetry the recon found: two artifacts, two shapes

**The lexical index is cache-driven, so it is already correct — it only needs invalidation.** `buildRetrievalDocs` (`search/collection-facade.ts:99`) rebuilds from `for (const [id, e] of ctx.cache)` — and `ctx.cache` is elevated-free (hydration skips elevated #701; `syncCache` evicts on elevate #691). So the rebuild *already* excludes elevated records; the only bug is that nothing triggers it and the stale at-rest blob survives. Fix = on any tier move, **`_purgeSearchIndex()`** (delete the persisted blob + `markDirty()` the in-memory index). Next `retrieve()` rebuilds lazily from the elevated-free cache — excluding the record after elevate, including it after demote (the cache is re-seeded by `syncCache`). No at-rest window (blob deleted immediately); no explicit gate loop needed (the cache is the gate).

**The vector sidecar is per-record and computed at write time, so it needs real purge + re-embed.** On elevate → `_purgeVector(id)` (deletes `_vec/<id>` + dirties the `VectorSet`). On demote-to-0 → re-embed the now-tier-0 record via `embedOnWrite(searchContext, id, record, version)`. Defense-in-depth (belt to the purge's braces, since `forget()`-style purge is best-effort and a legacy `_vec` predates this fix): **gate `buildVectorLoad`** to skip a `_vec` row whose owning record is elevated. `_vec` envelopes carry no `_tier` of their own, so the gate reads the canonical record's tier (`liveRecordIsElevated`, `kernel/tier-visibility.ts`) — one extra `adapter.get` per loaded vector; acceptable on a non-hot search-load path, and it makes the load correct even if the purge wiring ever regresses.

### The hook

`TiersContext` gains one callback, mirroring `syncIndexes` (#709):

```ts
/** Sync the collection's SEARCH artifacts after a tier move (#721). Both the
 *  lexical `_ftindex` blob and the `_vec/<id>` embedding are encrypted under
 *  the tier-0 DEK and hold the record's derived plaintext (full field text /
 *  a text-invertible vector), so leaving them means elevation never hid what
 *  the record was searchable by — the `forget()` precedent, unapplied to
 *  elevate. `null` → the record left tier 0: purge its `_vec`, and invalidate
 *  the `_ftindex` blob (the cache-driven rebuild then excludes it). A record →
 *  it is tier-0 again: re-embed it, and invalidate `_ftindex` (rebuild
 *  includes it). No-op fast when the collection has no search. */
syncSearch(id: string, record: T | null, version?: number): Promise<void>
```

Wired in `tiersContext()` to a new `syncTierSearch` helper in `search/collection-facade.ts` (no ceiling there). Called by `elevate`/`demote`/`putAtTier` **after** `adapter.put` lands — **no ordering dependency on `syncCache`** (unlike `syncIndexes`): the `_ftindex` rebuild is deferred to next `retrieve()`, and `_vec` re-embed reads the record argument directly, not the cache.

## Constraints

- Ceiling: `collection.ts` **4548** exact. Expect ~+1 (the `syncSearch` wiring line) → fund with one mechanical shrink-join. Never edit ceiling values; `vault.ts`/`noydb.ts` untouched. `search/collection-facade.ts` / `tiers/index.ts` / `tier-visibility.ts` have no ceiling.
- Zero-knowledge: the `_ftindex` invalidation and `_vec` purge resolve no key material; the `buildVectorLoad` gate is an envelope peek; demote re-embed reads a record already at tier 0.
- `syncSearch` no-ops fast when `searchIndexStore` and `vectorSet` are both undefined.
- **Coverage gap:** only `introspection/dump-schema.test.ts` declares search + tiers, and only introspects — **zero behavioral coverage** of `elevate()` + `retrieve()`/`similarTo()`. Tests must cover the persisted lexical blob, the `_vec` sidecar, warm AND cold sessions, and demote-restores.
- Intended functional loss (document in the changeset): an elevated record is unsearchable by anyone until demoted.
