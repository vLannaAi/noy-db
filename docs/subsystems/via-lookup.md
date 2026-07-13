# Lookup — the `lookup`/`enum`/`dict` via-feature (phase D)

`via-lookup` collapses three previously-separate "a field stores a code, resolve its label"
patterns — `dictKey()`/`staticDict()` (the legacy `via-i18n` dict tier), and the open question of
"what if the code refers to a whole reference collection instead of a code table" — into **one**
`ViaBinding` (`brand: 'lookup'`) with **three backing tiers**. `dictKey()`/`staticDict()` still
work, unchanged — they compile onto the **`'i18n'`** via-binding, not the `'lookup'` one described
here; their stored envelopes, `type`/`widget`/`dict` describe() block, and `.join()` dressing stay
byte-identical to the native equivalent (locked by
`packages/hub/__tests__/via/lookup-alias-parity.test.ts`), but they do **not** gain the new
`.lookup` describe() block (see the "describe()" section below) — only a native
`lookup()`/`enum()`/`dict()` field produces one.

## The three tiers — one descriptor shape, `backing` decides

```ts
import { lookup, enum as enumOf, dict } from '@noy-db/hub' // enumOf's public name is `enum`
```

| Tier | Factory | Backing | Vocabulary default | Syncs? |
|---|---|---|---|---|
| **enum** | `enumOf(['a','b'] as const)` | none — inline `keys`, no dimension name | `closed` | n/a (no store) |
| **dict** | `dict('status')` | reserved `_dict_status` micro-collection (`vault.dictionary('status')`) | `open` | yes (#647, below) |
| **matrix** | `lookup('countries')` | a first-class collection (`vault.collection('countries')`) | `open` | yes (ordinary collection sync) |

All three share `LookupDescriptor`: `key` (canonical key field, default `'id'`), `altKeys`,
`vocabulary` (`'open'`\|`'closed'`), `present` (`{ label, by? }` — which backing-row field supplies
`<field>Label`, optionally locale-keyed via `by`), `sortBy`, `onDelete`
(`'restrict'`\|`'cascade'`\|`'nullify'`, default `'restrict'`). `lookup(dimension, opts)` is the one
factory that can construct any tier (`backing: 'static'|'reserved'|'collection'`) —
`dictKey()`/`staticDict()`/`dict()` are all sugar that compile onto it.

## The canonical example — a countries matrix

Every example below is real, shipped-test-derived code from
`packages/hub/__tests__/via/countries-matrix.test.ts` (#650 Task 7) — ISO2 canonical key,
ISO3/callPrefix altKeys, localized names, **sparse** dimensions (populate only what you use), and
extend-on-demand (add a country row any time; no schema migration).

```ts
const countries = vault.collection<Country>('countries', {})
await countries.put('row-US', { id: 'row-US', iso2: 'US', iso3: 'USA', callPrefix: '+1',
  name: { en: 'United States', th: 'สหรัฐอเมริกา' } })
await countries.put('row-TH', { id: 'row-TH', iso2: 'TH', iso3: 'THA', callPrefix: '+66',
  name: { en: 'Thailand', th: 'ประเทศไทย' } })

const orders = vault.collection<Order>('orders', {
  lookupFields: {
    country: lookup('countries', {
      key: 'iso2',                              // the canonical key field — NOT the row's own id
      altKeys: ['iso3', 'callPrefix'],           // candidate values that normalize to `key`
      present: { label: 'name', by: 'locale' },  // <field>Label sources row.name[locale]
      sortBy: 'name',
      backing: 'collection',
      vocabulary: 'closed',
    }),
  },
})
```

Note the row's own PUT-id (`'row-US'`) is deliberately **not** the canonical key (`'US'`) — `key`
names a FIELD on the backing row, not the row's storage id. Every lookup mechanism (membership,
altKey normalization, sort, join dressing) keys by `row[descriptor.key]`, never the PUT-id.

### altKeys — candidate values normalize on `ingest`

```ts
await orders.put('o1', { id: 'o1', country: 'USA' })   // ISO3 altKey candidate
;(await orders.get('o1'))?.country                      // 'US' — normalized to the canonical key

await orders.put('o2', { id: 'o2', country: '+66' })    // callPrefix altKey candidate
;(await orders.get('o2'))?.country                      // 'TH'
```

(`countries-matrix.test.ts`, "canonical recipe" block). Normalization is pure/sync — it consults
an in-memory altKey index built from the backing rows already open in this vault session (matrix
tier: `getCollection(dimension).querySourceForJoin().snapshot()`; reserved tier: the dictionary's
write-through cache) — no store I/O per `put()`. Matrix-tier altKeys require the backing collection
to be open in eager (default, non-`{prefetch:false}`) mode.

An altKey candidate row VALUE may be a string or a number — both normalize through the same
`coerceLookupKey` core (a numeric `callingCode: 1` row value builds the altIndex entry `'1'`, same
as a string `'1'` would), and the ownership-uniqueness check (no two rows may claim the same
candidate) holds across the numeric/string boundary too — a numeric `1` on one row and the string
`'1'` on another still collide and throw `ValidationError` (`lookup-altkeys.test.ts`, "accepts a
numeric altKey value" / "throws ValidationError when a numeric altKey value coerces to the same
string as another row's string altKey").

### Vocabulary — open vs closed, and sparse population

`vocabulary: 'closed'` refuses an unknown key at write time with `UnknownLookupKeyError`:

```ts
await expect(orders.put('o3', { id: 'o3', country: 'ZZ' }))
  .rejects.toThrow(UnknownLookupKeyError)
```

Membership is checked against the backing dimension's **actual current rows** — not a hardcoded
universe of "real" codes, and not a declared key list (matrix tier has none). A legitimate ISO2
code that simply hasn't been populated yet in this vault is refused exactly the same way a fake one
is — this is what makes **sparse, populate-only-used** dimensions safe:

```ts
// Only 'US' and 'TH' were ever put() into `countries` — 'ZA' is a real ISO2 code,
// just not one of the rows this vault populated.
await expect(orders.put('o4', { id: 'o4', country: 'ZA' })).rejects.toThrow(UnknownLookupKeyError)
```

(both from `countries-matrix.test.ts`). The **dict tier differs**: its closed membership is declared
`keys` **union** the reserved dictionary's live rows (`checkLookupMembership`'s reserved branch) —
a key in the descriptor's own `keys` list is always known, even before any row for it exists in
`_dict_<name>`, and a live row for an undeclared key is known too
(`lookup-vocabulary.test.ts`'s "closed with NO declared keys validates against the live dict handle
snapshot" case). `dictKey()` and its native equivalent `dict()` default to `vocabulary: 'open'` —
unaffected; this is additive (#649). `staticDict()` is a separate case: it's closed-by-construction
via its own `validateCodes` option (default `true`), which throws `UnknownDictCodeError` on an
unknown code — a different mechanism and error class from `vocabulary: 'closed'`'s
`UnknownLookupKeyError`, predating this phase and unchanged by it. Pass `{ validateCodes: false }`
to `staticDict()` for open codes.

**Cold-session caveat.** Both tiers' live-rows side reads a cache materialized during **this
session**, not a fresh store read on every `put()` — matrix tier reads the backing collection's own
in-memory eager cache; dict tier reads the reserved dictionary's write-through cache. A **cold
session** — a freshly opened vault, or one right after a `sync().pull()` — that hasn't yet
opened/populated the matrix-tier backing collection, or warmed the dict-tier dictionary cache (dict
tier's declared `keys`, if any, still work — only its live-rows half is affected), sees an EMPTY
live-rows set: a `vocabulary: 'closed'` field refuses even a genuinely valid, already-persisted key
until the dimension is hydrated. Open the backing collection (matrix tier; eager mode, the default —
not `{prefetch:false}`) or call `await vault.dictionary(name).list()` (dict tier) first — the exact
same populate-first requirement `altKeys` normalization has above. This fails safe (refuses rather
than silently accepts an unverified key), but is easy to trip over on a fresh instance. Membership
has never had a live fallback — it is pure-snapshot for both tiers. The matrix tier's *presentation*
path (`<field>Label` resolution, below) is different: it preserves a live cold-session fallback, but
**only** for the default `key: 'id'` (#651, closed).

## Bare-array fields — element-wise support (#661)

A plain field whose OWN value is an array (`tags: ['USA', '+66']` on `tags: lookup('countries',
{...})`) is a DIFFERENT shape from the `[].`-wildcard multi-value path above (`'lines[].country'`
— an array of nested objects). `getAtPath` resolves a bare array to ONE opaque value, not N split
entries, so both write-time hooks (`ingest`'s altKey normalization, `enforceWrite`'s closed-vocab
membership check) treat the bare-array shape element-wise, reusing the exact same
`backing.altIndex`/`cfg.membership` core the scalar and `[].`-wildcard paths already use — no
parallel coercion path:

```ts
const orders = vault.collection<Order>('orders', {
  lookupFields: { tags: lookup('countries', { key: 'iso2', altKeys: ['iso3', 'callPrefix'] }) },
})
await orders.put('o1', { id: 'o1', tags: ['USA', '+66'] })
;(await orders._getStoredRecord('o1'))?.tags   // ['US', 'TH'] — each element normalized

const closed = vault.collection<Order>('orders-closed', {
  lookupFields: { tags: lookup('countries', { key: 'iso2', vocabulary: 'closed' }) },
})
await expect(closed.put('o1', { id: 'o1', tags: ['ZZZ', 'totally-bogus'] }))
  .rejects.toThrow(UnknownLookupKeyError)   // refuses on the FIRST unknown element
```

(`packages/hub/__tests__/via/lookup-bare-array.test.ts`). Duplicate elements after normalization
are kept as-is, not deduped (ingest normalizes values in place — it never changes cardinality, the
same #652 decision the `[].`-wildcard shape already made); a non-string element (number, object,
`null`) is skipped in both hooks, mirroring the scalar branch's own skip; an empty array is a
no-op in both hooks, even under `vocabulary: 'closed'`.

This works identically at a **dotted, non-wildcard path** (`'meta.tags': [...]` for a nested
`{ meta: { tags: [...] } }` shape) — `getAtPath`/`setAtPathInPlace` (`kernel/paths.ts`) resolve
dotted paths generically, so no dedicated code is needed for the nested case; the same
`Array.isArray` branch that handles a top-level `tags` field handles `meta.tags` too:

```ts
const orders = vault.collection<OrderWithMeta>('orders-meta', {
  lookupFields: { 'meta.tags': lookup('countries', { key: 'iso2', altKeys: ['iso3', 'callPrefix'] }) },
})
await orders.put('o1', { id: 'o1', meta: { tags: ['USA', '+66'] } })
;(await orders._getStoredRecord('o1'))?.meta   // { tags: ['US', 'TH'] }
```

(`lookup-bare-array.test.ts`, "at a DOTTED (non-wildcard) path" describe block).

## Late-attach (reconcile) — tier-scoped, #664

`lookupFields`/`i18nFields`/`dictKeyFields` can be declared on a SECOND-OR-LATER
`vault.collection(name, {...})` call against an already-open collection (a "late attach" /
"reconcile"), not just at fresh construction. Before #664 this was silently ignored — the fields
were simply dropped, no error, no effect. `via-reconcile.ts` closes that gap, tier-scoped:

- **enum** (`backing:'static'`, no `table`) / **static** (`+table`) — a clean, self-contained
  attach: membership/labels come from the declared `keys`/`table` alone, no vault registry touch.
- **reserved** (`dict()`) — attaches AND additionally wires the same vault registries fresh
  construction populates (`reservedLookupCollections`/`dictKeyFieldRegistry`), so sync and the
  reference-graph both see the late-attached field immediately.
- **matrix** (`backing:'collection'`) — **refuses** with a `ValidationError` naming the field, the
  backing dimension, and the remedy, unless the backing collection is ALREADY open in this vault
  session AND prefetch-enabled (`{ prefetch: false }` also refuses, with a different message):
  ```ts
  vault.collection<Traveler>('travelers', {})   // no 'countries' opened yet
  expect(() => vault.collection<Traveler>('travelers', {
    lookupFields: { country: lookup('countries') },
  })).toThrow(/matrix field "country".*dimension "countries".*not open/)
  ```
  Opening the backing collection first (eager mode, the default) makes the SAME late-attach
  succeed. (`packages/hub/__tests__/via/reconcile-lookup.test.ts`, "matrix (collection) tier"
  describe block.)

Closed-vocabulary enforcement, altKey normalization, and `<field>Label` dressing all activate
LIVE, immediately post-attach — including for records that were written BEFORE the attach (read-
time dressing/membership are evaluated per-call, not cached at write time). The one true
future-writes-only limit is normalization/enforcement itself: a record written before the attach
never ran altKey-ingest or closed-vocab enforceWrite, so its stored value stays whatever it was —
enforcement is not retroactive. Reference-graph edges (`onDelete: restrict/cascade/nullify`) are
registered at attach time and are live immediately too — `ViaGraph.referencingEdgesOf` sees them
the moment the late-attach call returns, no separate wiring needed.

**The #664 collision guard** runs BEFORE any late-attach mutation, for the whole call: an
incoming field that collides with an ALREADY-declared field of a different via family (e.g.
late-attaching `lookupFields: { amount: enumOf(...) }` onto a field already owned by
`moneyFields`) throws `ValidationError` naming the field and both families — no partial attach.
A single late-attach call may combine `i18nFields`/`dictKeyFields` on one field AND `lookupFields`
on a DIFFERENT field; both attach from that one call (`reconcile-lookup.test.ts`'s `t8r1` describe
block pins this against a future dispatch collapse).

**Known limits — three late-attach residuals**, all rooted in the same cause: a handful of
`Collection` fields (`getDictionary`, `i18nFields`, `dictKeyFields`, `lookupFields`,
`presentForJoin`) are captured ONCE, at fresh construction, from the constructor's `cfg` — late-
attach rebuilds the `ViaPipeline` (`coll._setVia`) but has no seam to reassign these separate,
private-readonly instance fields:

- **`getDictionary`/`resolveDictLabels`** — `collection.describeAsync({ resolveDictLabels: true })`
  resolves a dynamic dict's live labels via `this.getDictionary`, which stays `undefined` if the
  collection was constructed with no `dictKeyFields`/`lookupFields` at all (exactly the case a
  late-attach starts from). A late-attached dict-backed field's labels stay unresolved by
  `resolveDictLabels: true` — the sync inline-`labels` fallback (if declared) still works.
- **`describe()`'s top-level field list** — the legacy per-field `type`/`widget`/`dict` derivation
  (`buildDescription`) reads `this.dictKeyFields`/`this.i18nFields`/`this.lookupFields`, the same
  construction-time snapshot — a late-attached field may not appear in that top-level list at all
  (unless the schema also names it). The NEW `.lookup` describeFragment block (`ViaPipeline.
  describeFragments()`) is unaffected — it folds `_via.bindings` live, so it DOES reflect a
  late-attached field correctly; only the older list-derivation path is stale.
- **`presentForJoin`** — captured once from `cfg.presentForJoin` at construction. When a collection
  is the TARGET of `.join()` (or a matrix-tier lookup's backing dimension), a lookup/i18n field
  late-attached onto it will not dress `<field>Label` through the join-presentation path, even
  though it dresses correctly on a DIRECT read of that same collection.

None of these are fixed here — they're recorded as known limits so a late-attach consumer that
also needs `describeAsync({resolveDictLabels:true})`, a complete `describe()` field list, or
join-dressing on the late-attached side knows to declare the field at fresh construction instead.

## Presentation — `<field>Label`, in reads and in joins

Reading with a locale resolves `<field>Label` on the SAME record (direct `present()`, works for
reserved/static tiers via the vault-built label resolver). For matrix tier, direct (non-join) reads
resolve the backing row through the SAME descriptor-keyed sync snapshot the join path uses
(`resolveBackingRowKey`, #651 Task 3) — keyed by `descriptor.key`, never the backing collection's own
PUT-id, so a custom canonical key like this doc's own `key: 'iso2'` recipe above resolves
`<field>Label` correctly on a direct read too, not just through a join. The snapshot route needs the
dimension collection open/populated in this session (the cold-session caveat above); the default
`key: 'id'` tier ALONE keeps a live `.get()` fallback on a snapshot miss (construct+hydrate
on-demand cold-session behavior, preserved unchanged) — for `key !== 'id'` the snapshot is the sole
source of truth, per the caveat above. Joining to a collection that itself declares a lookup field
resolves that field's label on the JOINED side too — the **snapshot+locale seam** (#650 Task 6,
extended to matrix tier in Task 7), which correctly keys by `descriptor.key`, not the PUT-id:

```ts
const rows = shipments.query().join('orderId', { as: 'order' }).toArray({ locale: 'th' })
rows[0].order.countryLabel  // 'สหรัฐอเมริกา' — dressed through the join, matrix tier included
```

(`countries-matrix.test.ts`, "presentForJoin dresses a matrix-tier field on a REFERENCING
collection"). This retires the #626 kernel→via grandfather: `kernel/query/join.ts` no longer
imports `via/i18n/core.js` — it calls a sync `presentForJoin` hook the `Collection` builds
from its own i18n + lookup bindings (`packages/hub/__tests__/via/via-guards-empty.test.ts` proves
the allowlist that used to carry this one grandfathered import is now EMPTY, and that the guard
still fires on a synthetic kernel→via import).

## Sorting by the resolved label

Two independent channels, because a `sortBy`-declared field's ordering hook
(`ViaBinding.compareForOrder`) carries **no locale parameter**, but `orderBy(..., {by:'label'})`
needs a **per-call** one:

```ts
// (a) compareForOrder — PLAIN orderBy(), no {by:'label'} — needs a declared `displayLocale`
//     (the field's own fixed locale) since there's no per-call one to fall back to. The `orders`
//     collection declared above does NOT set one — add it to the `country` lookup() descriptor:
const ordersFixedLocale = vault.collection<Order>('orders-display-locale', {
  lookupFields: {
    country: lookup('countries', {
      key: 'iso2', present: { label: 'name', by: 'locale' }, sortBy: 'name',
      backing: 'collection', displayLocale: 'en', // <- new, required for channel (a)
    }),
  },
})
ordersFixedLocale.query().orderBy('country', 'asc').toArray()
// sorts by the resolved `name` at the descriptor's own `displayLocale` — 'South Africa' < 'United States'

// (b) orderBy({by:'label'}) — resolves at the QUERY's own per-call locale, no displayLocale needed,
//     so this works on the ORIGINAL `orders` (no `country` field redeclaration required):
orders.query().orderBy('country', 'asc', { by: 'label' }).toArray({ locale: 'en' })  // ZA, US
orders.query().orderBy('country', 'asc', { by: 'label' }).toArray({ locale: 'th' })  // US, ZA — a DIFFERENT order
```

(`countries-matrix.test.ts`, "compareForOrder: plain orderBy" and "orderBy({by:'label'}) at a
PER-CALL locale" blocks — the second proves two different locales genuinely produce two different
orders for the same two rows, not a cached/fixed comparator). Channel (b) is the #650 Task 7
addition: `builder.ts`'s `buildOrderLabelMaps` falls back to a new `ViaPipeline.resolveOrderLabel`
hook for lookup fields the legacy dict-registry bridge doesn't cover (matrix tier) — reserved/
static-tier fields (including `dictKey()`/`staticDict()`) keep resolving through the pre-existing
bridge, tried first, unchanged.

**Silent degrade if you skip `displayLocale`.** A `sortBy` field whose `present.by` is locale-keyed
(as `country` above is) but has no declared `displayLocale` does not throw — `compareForOrder`
degrades to comparing the raw stored keys (code order) with no warning at query time. `lookup()`
fires a one-time `console.warn` at DECLARE time when it detects `sortBy` + locale-keyed `present.by`
with no `displayLocale` (`descriptor.ts`'s `warnIfSortByNeedsDisplayLocale`) — watch for it, or use
channel (b)'s per-call `{ by: 'label' }` instead, which needs no `displayLocale` at all.

## Reference semantics — `restrict` (default) / `cascade` / `nullify`

A lookup field is a constrained reference to its backing dimension. Deleting (or forgetting) a
backing row that's still referenced follows `onDelete` (#648):

```ts
// restrict (default) — throws, names the referencing collection + count:
await expect(vault.dictionary('status').delete('paid')).rejects.toThrow(DictKeyInUseError)
// err.dictionaryName === 'status'; err.usedBy === 'orders'; err.count === 1
await orders.delete('o1')                                    // retire the reference first
await vault.dictionary('status').delete('paid')              // now succeeds
```

```ts
// cascade — deleting the row tombstones every referencing record:
await vault.dictionary('status-c').delete('paid')
;(await orders.get('o1'))                                    // null — cascaded

// nullify — deleting the row nulls the referencing field via an ordinary put:
await vault.dictionary('status-n').delete('paid')
;(await orders.get('o1'))?.status                             // null
```

(all from `packages/hub/__tests__/via/lookup-ref-semantics.test.ts`). The matrix tier behaves
identically against a first-class collection (`countries.delete('US')` throws/cascades/nullifies
the same way), including the non-default-`key` case — `restrict` matches against `row[key]`, not
the row's PUT-id (`lookup-ref-semantics.test.ts`, "matrix tier with a non-default descriptor.key").

**`forget()` composes the same way, additively** (`lookup-forget-ref.test.ts`, fixes #648):
`restrict` refuses the `forget()` call itself, BEFORE any shred, if the subject's row is still
referenced; `cascade`/`nullify` propagate after the shred and are reported on
`ForgetResult.lookupReferencesCascaded`/`lookupReferencesNullified` (additive fields — every
pre-existing `ForgetResult` field is unchanged).

`DictKeyInUseError` (`errors.ts`) was declared and documented since before this phase but never
actually thrown — `lookup-ref-semantics.test.ts` is its first-ever coverage AND first-ever throw
site (closing seam-map surprise 3).

A plain delete on a dictionary/collection row that **no** declared lookup field anywhere actually
references is completely unaffected by any of this — `onDelete` only fires for dimensions a
`lookupFields`/`via(lookup(...))` declaration actually points at.

### Unresolvable compare-key: restrict fails closed, propagation residue-reports (#654)

A matrix dimension with a non-default `key` resolves its compare-key by reading `row[key]` off the
backing row (`resolveLookupCompareKey`). If that row is corrupted — the `key` field is missing or
holds a non-string/non-number value — the compare-key **cannot be resolved**. Two policies apply,
by `onDelete` mode:

- **`restrict`** fails CLOSED: the delete/forget REFUSES with `RestrictRefUnresolvableError`
  (`errors.ts`) naming the dimension, the row's key, and the unresolvable edge
  (`"collection.field"`). Whether a referencer exists can't be proven, so the row is not deleted —
  the same "cannot prove no references ⇒ do not delete" reasoning `DictKeyInUseError` already
  applies when references ARE provably present.
  ```ts
  await expect(countries.delete('row-broken')).rejects.toThrow(RestrictRefUnresolvableError)
  // err.dimension === 'countries'; err.key === 'row-broken'; err.referencing === 'orders.country'
  ```
- **`cascade`/`nullify`** residue-report instead: the delete PROCEEDS (only `restrict` edges are
  fail-closed), but the un-propagated edge is never silently dropped — it's reported on a
  structured `lookup:propagation-residue` event (`{ vault, dimension, key, residue }`, `residue`
  entries formatted `backing:key:collection.field`), the ordinary-delete counterpart of the forget
  path's `ForgetResult.lookupReferencesResidue` channel (which is unaffected — its own edges were
  already residue-reported before #654).
  ```ts
  db.on('lookup:propagation-residue', (e) => { /* e.residue: ['countries:row-broken:orders.country'] */ })
  await countries.delete('row-broken')   // still succeeds
  ```

A resolvable edge (the `key` field present and scalar) behaves exactly as before #654 in every
mode — this is a corruption-class-rarity refinement, not a change to the common path (see
`packages/hub/__tests__/via/lookup-restrict-unresolvable.test.ts`).

## Reserved-tier sync — dictionaries now travel (#647)

Before #647, `_dict_*` rows written through `vault.dictionary(name)` bypassed the mutation choke
point entirely (raw `adapter.put`/`adapter.delete`, no `onDirty`, no dirty-log entry), and
`SyncEngine.pull()` skipped every `_`-prefixed collection by the store contract — so dictionaries
never replicated through `push()`/`pull()`, only through backup/bundle export. #647 (`#650 Task 4`)
fixes both ends: `LookupHandle` writes now fire `onDirty` + a one-shot graph-dispatch wave (the
local-write origin's thin choke-point participation), and `pull()` additionally enumerates an
**explicit reserved-lookup prefix registry** (declared at `collection()`/`dictionary()` time — not
a blanket underscore-glob; every *other* `_`-prefixed namespace keeps its skip semantics) through
the same `applyRemote` path ordinary collections use.

Deletes travel too, as **delete-markers** — a version-ordered marker row, not a raw adapter delete
— the same #589 law every ordinary collection's sync-safe delete already follows, so a deleted
dictionary key can't be silently resurrected by a stale peer's next push. See
`packages/hub/__tests__/via/lookup-reserved-sync.test.ts` for the full pull/push/marker suite.

## `describe()` — the `lookup` block (first-ever `describeFragment` consumer)

`ViaBinding.describeFragment()` was declared since #623 but had zero consumers until #650 Task 7.
`Collection.describe()` now folds every compiled binding's fragment
(`ViaPipeline.describeFragments()`) and the `'lookup'` binding's fragment feeds a normalized
`DescribedField.lookup` block — **alongside**, not instead of, the pre-existing `dict` block
(byte-stable, unchanged, for the `dictKey()`/`staticDict()` alias):

```ts
const described = orders.describe()
described.fields.find(f => f.key === 'country')?.lookup
// {
//   dimension: 'countries', backing: 'collection', vocabulary: 'closed', key: 'iso2',
//   altKeys: ['iso3', 'callPrefix'], present: { label: 'name', by: 'locale' },
//   sortBy: 'name', onDelete: 'restrict',
//   // no `keys` — matrix-tier closed-vocabulary membership lives in the backing
//   // collection's live rows, not a statically declared list
// }
```

(`countries-matrix.test.ts`, "describe() consumes describeFragment"). `widget` derives to
`'select'` whenever a `lookup` block is present (`deriveWidget`'s `dict`/`lookup` check), same as
the legacy `dict` block already did. `dimension` is **omitted**, not emitted as an empty string,
for a bare `enumOf()` field (no backing store, no dimension name — the `dimension: ''` internal
sentinel resolved for the public describe() surface). The realistic hub-side deliverable stops
here — a normalized `lookup` block `schemaFromDescribe`/`fieldInput` can grow a select/autocomplete
widget from; the `@noy-db/ui` widget itself is the sibling repo's follow-up, not built here.

## Architecture

`via/lookup/` (`descriptor.ts`, `binding.ts`, `registry.ts`, `snapshot.ts`, `handle.ts`,
`active.ts`) is the whole feature. `LookupHandle` (renamed from `DictionaryHandle`, which
`via/i18n/dictionary.ts` still re-exports for compat) is the `_dict_*` engine; `registry.ts`
holds the pure declare/warm-time helpers (`materializeBackingTable`, `checkLookupMembership`,
`buildLookupAltIndex`, `buildLookupSnapshotRows`); `snapshot.ts` is the sync
join/locale/order-label seam (`LookupSnapshot`, `buildPresentForJoin`). Reached from the kernel
spine only through `port/with/lookup-strategy.ts` — no `kernel/**` file imports `via/lookup/`
(or any `via/**`) directly (`via-guards-empty.test.ts` proves both architecture-guard allowlists
are EMPTY and still fire on a synthetic violation).

## See also

- [`docs/subsystems/via.md`](via.md) — the Via port overview, phases, architecture guards
- [`docs/subsystems/via-i18n.md`](via-i18n.md) — `i18nText()` + the `dictKey()`/`staticDict()`
  alias story (byte-parity with, not compiled onto, this binding — see the top of this page)
- `packages/hub/src/via/lookup/` — descriptors, binding, registry, snapshot, handle
- `packages/hub/__tests__/via/countries-matrix.test.ts` — the canonical end-to-end example (source
  of every code snippet on this page)
- `packages/hub/__tests__/via/lookup-binding.test.ts`, `lookup-altkeys.test.ts`,
  `lookup-vocabulary.test.ts`, `lookup-ref-semantics.test.ts`, `lookup-forget-ref.test.ts`,
  `lookup-reserved-sync.test.ts`, `lookup-alias-parity.test.ts`, `lookup-extraction-parity.test.ts`,
  `lookup-join-snapshot.test.ts` — the per-tier/per-capability suites
- `packages/hub/__tests__/via/lookup-bare-array.test.ts` — #661: bare-array element-wise ingest +
  enforceWrite, top-level and dotted-path shapes
- `packages/hub/__tests__/via/reconcile-lookup.test.ts` — #664: the late-attach reconcile suite
  (tier-by-tier attach, matrix refusal, graph edges, collision guard, combined-family attach)
