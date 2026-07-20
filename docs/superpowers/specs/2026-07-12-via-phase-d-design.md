# Via port phase D — via-lookup: reference binding, three tiers, altKeys, vocabulary governance, ref semantics (#650)

**Date:** 2026-07-12
**Issue:** [#650](https://github.com/vLannaAi/noy-db/issues/650) · **Milestone:** #28 "Via port: unified field features [api]" · Phases A (#628), B (#630), C (#643) merged; branch base = main `9f29ea53`.
**Fixes structurally:** [#647](https://github.com/vLannaAi/noy-db/issues/647) (dictionaries never sync), [#648](https://github.com/vLannaAi/noy-db/issues/648) (DictKeyInUseError never thrown), [#649](https://github.com/vLannaAi/noy-db/issues/649) (dictKey validation documented but nonexistent). **Retires the #626 `join.ts → via-i18n/core.js` grandfather — the `via-layering` allowlist ends EMPTY.**
**Surface:** `api` — additive binding + declaration sugar; existing `dictKey`/`staticDict` preserved as aliases; `/adapter` and `/cargo` byte-untouched.
**Ground truth:** `.superpowers/sdd/seam-map-lookup.md` (file:line anchors for every seam named here). Behavior locks: the FULL dict/i18n/join/refs/indexing suites pass **unchanged** (alias equivalence is the lock for the dictKey/staticDict migration), with sanctioned exceptions listed in §8.

## Reframing (from the seam map)

The seed said "dictionary keys are already a via-feature; split them out." The map says stronger: **the dict tier is broken in exactly the ways via-lookup fixes** —

- `DictionaryHandle` writes bypass the mutation choke point (raw `adapter.put`, no `onDirty`) and pull's `loadAll` skips `_` names: **dictionary data never syncs** (#647). Only the first-class (matrix) tier syncs today.
- Dynamic `dictKey` put-time validation **does not exist** — declared `keys` are dropped at registration (vault.ts:958); only `staticDict` validates (#649).
- `dictionary.delete(key, { mode: 'strict' })`'s reference check is an empty comment block; `DictKeyInUseError` is exported dead code (#648). Forget/delete of referenced rows has implicit **ignore** semantics — refs dangle.
- "dictKey IS a ref" is aspirational: `ref()` rejects `_`-prefixed targets (refs.ts:142-147); dict joins are a parallel bolt-on; `nullify` exists nowhere.
- `describeFragment` has **zero consumers** today; label-sort bypasses `compareForOrder` (builder-level labelMaps from `resolveDictSource` snapshots) and the hook carries no locale — the same gap that blocks the #626 fix.
- Ceilings have almost no room (collection.ts +13, vault.ts +3, noydb.ts +2): **extraction funds the phase**.
- The old arc plan's "phase D" bundled indexed/searchable; this spec is via-lookup ONLY (user-ratified) — via-indexed/via-searchable are later cycles. `shape/via-lookup` (field grain) deliberately coexists with the existing `with-lookup/` service folder (vault grain: indexing/aggregate) — grammar-consistent, named here to prevent collision confusion.

## Decision summary (user-ratified 2026-07-12)

1. **Scope: via-lookup only.** Three tiers, altKeys, vocabulary governance, backing choice, ref semantics, #626 retirement, #647–#649 fixes. Nothing else.
2. **The reserved tier SYNCS.** Reserved-collection writes route through the mutation choke point and underscore collections join pull — #647 closes structurally, and dict-tier reference-row updates reach the phase-C dispatch wave.
3. **Ref forget/delete default = `restrict`.** Deleting/forgetting a referenced lookup row is REFUSED while references exist (`DictKeyInUseError` thrown for real — #648); `cascade` and `nullify` are opt-in per declaration; the retired-keys entry lifecycle (seed) is the sanctioned retire-don't-delete path. Today's dangling behavior remains only for undeclared (non-lookup) refs.

## Design

### 1. The primitive

```ts
country: lookup('countries', {
  key: 'iso2',                               // canonical key stored on the record
  altKeys: ['iso3', 'callPrefix'],           // candidate keys; ingest normalizes ('USA' | '+1' → 'US')
  vocabulary: 'open' | 'closed',             // closed = enum semantics (unknown key = write refusal)
  present: { label: 'name', by: 'locale' },  // dressing dimension (i18n rides here)
  sortBy: 'name',                            // compareForOrder against the materialized snapshot
  backing: 'reserved' | 'collection',        // default: reserved for enum/dict tiers; 'collection' for matrices
  onDelete: 'restrict' | 'cascade' | 'nullify',  // default restrict
})
```

Tiers: **enum** = `enum(['draft','sent','paid'])` sugar → static in-config table (no backing store); **dict** = `dict('status')` sugar → reserved micro-collection; **matrix** = `lookup('countries', {...})` against a first-class collection with typed rows. One binding (`shape/via-lookup/binding.ts`, brand `'lookup'`) implements all three; the tier is a backing detail. `dictKey`/`staticDict` become aliases compiling to the same binding — alias equivalence is behavior-locked byte-level against today's dict suites.

### 2. Reserved-tier sync (#647)

Reserved lookup collections (existing `_dict_*` and any `_lookup_*`) write through `Collection`-grade choke-point participation: entries get `onDirty` and `_onRecordMutated` (origin `local-write`), pull includes declared reserved prefixes (an explicit prefix registry — NOT a blanket underscore-glob; other `_` namespaces keep their semantics), and the crypto stays on `reservedEnvelopes(prefix)` exactly as phase B built it. Reference-row updates therefore feed the phase-C wave: a renamed label recomputes/invalidates dependents' presentation per the graph's edges.

### 3. Membership + altKeys

`vocabulary: 'closed'` validates at write time on the `enforceRefsOnPut` precedent (seam map part 4: async cross-collection `get` at write is established; #553 binds query hooks and the zero-via fast path only). The binding's write hook receives a **vault-built membership closure** (the refs pattern) — never a collection reference; `ViaWriteCtx` stays narrow. `'open'` permits unknown keys (declaration option `upsertOnUse` deferred — NOT in this phase). **altKeys**: ingest normalizes any candidate key to the canonical key; declare-time uniqueness across `key` + `altKeys` values is enforced when the backing table is materialized (the CHE/SWZ drift class); collision = declare-time `ValidationError`.

### 4. Ref semantics via the graph

A new `'ref'` `EdgeKind`; lookup declarations register cross-collection edges (the graph already handles cross-collection `FieldRef`s — seam map part 6; the declare-path extension is the work). `onDelete`/forget of a referenced row consults the reverse edges: `restrict` (default) throws `DictKeyInUseError` naming the referencing collection(s); `cascade` tombstones referencing records through ordinary origin-tagged deletes (fanout-visible); `nullify` clears the referencing field via ordinary puts. Forget-fanout (phase C) composes: forgetting a referenced row under `restrict` is refused BEFORE any shred; under `cascade`/`nullify` the fanout reports the propagation additively. Taint composes: a lookup INTO a collection with classified fields folds that collection's field postures into the derived presentation posture (the `'*'`-node posture frame from #642 is NOT built here — lookup edges are field-level and carry real postures).

### 5. The snapshot+locale seam (#626 retirement)

One combined seam — a sync **lookup snapshot** (materialized key→row map, the `active.ts` pattern) plus a locale-aware presentation function — serves: join dressing (the shape the #626 reviewer spec'd: a sync `presentI18nForJoin`-class hook on `JoinableSource`), dimension sort (`compareForOrder` gains the snapshot via binding closure — the hook signature does NOT change), and membership queries. `join.ts` consumes the binding's hook instead of importing `via-i18n/core.js`; **the `via-layering` allowlist ends EMPTY** and the guard must still fire on synthetics (the phase-B deletion recipe).

### 6. describe()/UI

`describeFragment` carries the key set (closed vocabularies), dimensions, and presentation metadata. Wiring `describe()` to consume via `describeFragment`s (today it is config-direct; the fragment mechanism has zero consumers — seam map part 7) is IN scope hub-side; the `@noy-db/ui` select/autocomplete widget is the sibling repo's follow-up (issue to file at wrap-up). The **countries matrix** is the canonical example in every doc/showcase this phase touches (standing user directive): ISO2 canonical, ISO3/callPrefix altKeys, localized names, sparse dimensions, populate-only-used.

### 7. Extraction-first economics

The phase OPENS with the extraction task: the ~350-line dict registry/handle block (including dead `vault.applyLocale`) leaves vault.ts for `shape/via-lookup/` + `port/with/` seams, byte-parity locked by the dict suites — funding every later task's ceiling budget (current room: collection.ts +13, vault.ts +3, noydb.ts +2; ceilings ratchet DOWN after extraction per the checker convention).

### 8. Testing

Behavior locks: dict/i18n/join/refs/indexing suites unchanged; alias equivalence (dictKey/staticDict → lookup binding) byte-level. **Sanctioned exceptions:** tests that pin the #647/#648/#649 defect behaviors flip to pin the fixes (enumerated in the plan per file, the phase-C pin-flip recipe). New: tier matrix (enum/dict/matrix × open/closed × backing); altKey normalization + collision refusal; membership refusal (closed) + open permits; reserved-tier sync end-to-end (two instances, vocabulary edit propagates + wave fires); restrict/cascade/nullify trio incl. forget interplay + report additivity; #626 retirement (join suites green with the import gone; guard fires on synthetic); snapshot-sort parity with today's label-sort output; describe() fragment consumption; countries-matrix showcase.

## Out of scope

via-indexed / via-searchable (later cycles); `upsertOnUse`; the `@noy-db/ui` widget (sibling repo); the `'*'`-node collection posture frame (#642); declassification (phase E); matrix-to-matrix recursive ref UX beyond what plain refs give; any `/adapter` or envelope-format change.
