# Money — exact arithmetic via-feature

Declares money fields with ISO 4217 currency codes and enforces exact arithmetic without
floating-point rounding errors. `money({ currency: 'EUR', scale: 2 })` means a field is money
in euros stored as a scaled-integer digit string; reads return the canonical decimal string
(e.g. `'10.50'`) plus `<field>Formatted`/`<field>Number` read-time virtuals whenever the read
locale isn't `'raw'`.

Two modes:

- **fixed** — `money({ currency: 'EUR' })`: one currency for the field. `scale` defaults to the
  ISO-4217 default for the currency (override with `scale`, required for unlisted codes).
- **multi** — `money({ currencies: 'any' | ['EUR', 'USD'] })`: currency travels per record; the
  value stores `{ amount, currency }`. Per-currency scale overrides via `scaleOverrides`.

`currency` and `currencies` are mutually exclusive; an optional `rounding` policy applies to
both modes.

## Declaration

Use the `via()` composer with `money()`, declared under the collection's `viaFields` option
(a sibling of `schema`, never a key inside it):

```ts
const invoices = vault.collection<Invoice>('invoices', {
  schema: z.object({ id: z.string(), total: z.union([z.number(), z.string()]) }),
  viaFields: {
    total: via(money({ currency: 'EUR', scale: 2 })),
  },
})
```

Or the older `moneyFields` sugar spelling (still works, identical internals):

```ts
const invoices = vault.collection<Invoice>('invoices', {
  schema,
  moneyFields: { total: money({ currency: 'EUR', scale: 2 }) },
})
```

Both spellings produce identical stored envelopes and identical `describe()` output. Existing
code using `moneyFields` continues unchanged.

## Storage & reads

A fixed-mode field is stored as a scaled-integer digit string. Reading it back returns the
canonical decimal string:

```ts
await invoices.put('a', { id: 'a', total: 123.45 })
const inv = await invoices.get('a')
// inv.total → '123.45'  (canonical decimal string)
```

Every read additionally unpacks `<field>Formatted` (locale-aware display string, `'en-US'` when
no locale is passed) and `<field>Number` (a JS `number`) as read-time virtuals — except a read
with `{ locale: 'raw' }`, which returns only the canonical decimal (or `{ amount, currency }` in
multi mode) with no virtuals.

## Composing with a virtual computed field (#669)

`via(computed(fn, { mode: 'virtual' }), money(...))` on the SAME field — a virtual computed
field's `fn` output composed with money — is a legal, DRESSED composition, not merely
accepted-but-undressed: money quantizes the fn's MAJOR-UNITS return value to the field's scale
(applying the descriptor's declared `rounding`) and presents it exactly like a stored money
field — the canonical decimal string, plus `<field>Formatted`/`<field>Number` whenever a real
(non-`'raw'`) locale is in effect:

```ts
const c = v.collection<Priced>('priced', {
  viaFields: {
    doubledPrice: via(computed((r) => (r.base as number) * 2, { deps: ['base'], mode: 'virtual' }), money({ currency: 'EUR', scale: 2 })),
  },
})
await c.put('a', { id: 'a', base: 10.5 })
;(await c.get('a'))?.doubledPrice           // '21.00' — quantized decimal string
;(await c.get('a'))?.doubledPriceFormatted  // defined — dressed like any stored money field
```

An fn output that fails to parse at the field's scale (excess precision with no `rounding`
declared) is left RAW, no throw — read-time dressing must never brick a read. Fixed-mode fields
only; a virtual field's output has no natural `{ amount, currency }` shape for multi-currency
mode. Materialized-mode `computed` fields were already dressed before #669 (the fn's output
merges into the record before money's ordinary write-time `encodeWrite` runs); this closes the
matching virtual-mode gap. A taint-redacted virtual field's `Formatted`/`Number` companions are
stripped along with the base field, not left leaking the pre-redaction value. See
[`docs/subsystems/via-computed.md`](via-computed.md) (the "Composition" section) for the full
ordering story (`ViaBinding.presentLate`).

## Query & aggregate

`where()` predicates on money fields quantize operands to the field's scale at build time
(sync). Aggregation over a declared money field rewrites `sum()`, `min()`, and `max()` into
their exact BigInt-based equivalents — no floating-point drift. **`avg()` is not supported** on
a money field and throws `MoneyUnsupportedError`; divide `sum()` by `count()` at the boundary
instead.

### Indexing — the fast path, and an honest mixed-era caveat (#625)

A declared money field indexed via `indexes: [...]` + `indexStrategy: withIndexing()` gets an
index-accelerated fast path for `where(field, '==', ...)` and `where(field, 'in', ...)` in
**fixed mode only** — `ViaBinding.indexProbe` hands the query builder the exact STORED-form
scaled-integer digit string (the same one `quantizeMoneyFields` writes), so the index bucket
lookup (`CollectionIndexes.lookupEqual`/`lookupIn`) hits directly instead of falling back to a
full scan. Multi-currency (`currencies:`) fields always scan in **eager** mode — there is no single
stored-form value a hash index can serve for a `{ amount, currency }` shape
(`packages/hub/__tests__/money/where-comparison.test.ts`, "indexed fast path agrees with the scan"
describe block, spy-proven against `lookupEqual`/`lookupIn`). On **lazy** mode there is no scan
fallback: a multi-currency clause dispatches raw through `lookupEqual`/`lookupIn` (the `{ amount,
currency }` object buckets under `\0OBJECT\0`), so end-to-end correctness there is bounded by the
same `LazyQuery` Via-awareness gap as fixed-mode — tracked in #684. Range/`between` always scan in EAGER
mode (no range probe is ever emitted); LAZY mode's range behavior is different — see below.

**Mixed-era data (#672).** A record whose stored value predates the field's `money()`
declaration, or otherwise bypassed the money write path, may hold a non-canonical scaled string
(e.g. `'0100'` instead of `'100'`). The eager index no longer buckets it under that raw string:
`CollectionIndexes` consults a money-aware index-key canonicalizer (`ViaPipeline.
canonicalizeIndexKey`, backed by `moneyScaledValue`'s BigInt re-parse) whenever it mutates a
bucket, so a legacy value lands in the SAME bucket a canonical write produces — an `==`/`in` probe
for the canonical amount finds it, matching the fallback scan exactly. The guarantee holds across
**every** eager-index bucket-mutation site — build (incl. rebuild-on-hydrate), `put()` (upsert),
and `delete()` (remove) — so updating or deleting a legacy record cleans up its canonical bucket
correctly instead of stranding the id there (a gap the initial #672 fix left open, closed in
review).

**Eager late-attach (#686).** `money()` can also arrive on an existing, already-hydrated
collection via a SECOND `vault.collection(name, { moneyFields })` call — e.g. an earlier
`vault.collection(name, { indexes: [...] })` call (no `moneyFields`) already triggered eager-index
hydration and built its buckets from raw stringified values. `_applyMoneyFields` now detects an
already-hydrated collection and re-runs the eager-index rebuild (the same
`rebuildEagerIndexesFromCache` hydrate-on-open uses) as part of attaching the money declaration, so
rows indexed before the late-attach are re-canonicalized immediately — no gap window, and no manual
`rebuildIndexes()` call required. Before this fix such rows were silently under-returned by a
canonical `==`/`in` probe until the next full rebuild (was: self-corrected only on the next
hydrate-from-cold or an explicit `rebuildIndexes()`).

**Lazy mode (#677).** Lazy-mode collections (`prefetch: false`) keep their own durable
`PersistedCollectionIndex` side-cars — a separate implementation from the eager
`CollectionIndexes`, but now with the SAME canonicalization guarantee. Every bucket-mutation site
(`ingest` bulk-load from side-cars, `upsert`, `remove`) consults the same registered
`ViaPipeline.canonicalizeIndexKey`, and the lazy query planner (`lazy-builder.ts`'s
`resolveCandidateIds()`) canonicalizes an `==`/`in` probe value before calling
`lookupEqual`/`lookupIn` — mirroring the eager path's `candidateRecords()` resolving
`clause.via.indexValue` before its own lookup. A legacy non-canonical record and a canonical one
now land in, and are found via, the same bucket on the lazy fast path too. Range/`between` do
**not** behave the same across modes: eager mode's `moneyIndexProbe` never emits a range probe, so
`candidateRecords()` never calls an index for a money range clause and always scans. Lazy mode's
`resolveCandidateIds()` dispatches EVERY range clause — including money fields — through
`PersistedCollectionIndex.lookupRange` unconditionally, with **no scan fallback**; the comparison
is on the raw, uncanonicalized typed value, so a money field's lazy-mode range correctness (e.g.
mixed-era or non-canonical stored values) is a live, pre-existing gap, tracked in #684.
Because a lazy-mode legacy record predating the field's `indexes: [...]` declaration has no
`_idx/<field>/*` side-car at all until backfilled, `reconcileOnOpen: 'auto'` (or an explicit
`collection.reconcileIndex()`/`rebuildIndexes()` call) is required for such a record to become
visible to the fast path.

**Residual boundary, not fixed by #677 — tracked in #684.** `LazyQuery`'s post-filter
(`lazy-builder.ts`'s `matchesAll`) re-evaluates every clause — including the index-driving one —
against the DECODED record (`getRecord()` runs `via.present()`), via the generic (non-Via-aware)
`evaluateClause`, because `LazyQuery.where()` never builds a `clause.via` the way
`Query.where()`/`ScanBuilder.where()` do. At `scale: 0` this doesn't surface (decode is an
identity transform). At `scale > 0` it does, and it is NOT merely a "pass the stored form"
workaround: even a query value spelled correctly in the field's STORED (canonical scaled-int)
form reaches the right candidate ids via the index, but the post-filter then compares that same
raw value against the DECODED record (e.g. `'100'` vs `'1.00'`) and rejects every match. **The
practical result: `lazyQuery().where(moneyField, ...).toArray()` returns an empty array
end-to-end for any money field with `scale > 0`, regardless of how the query value is spelled.**
Only the index layer itself (bucket + probe canonicalization, #677) is fixed today; full parity
with `scan().where()` (Via-aware post-filtering, major-unit quantization) is tracked in #684.

## See also

- [`docs/subsystems/via.md`](via.md) — the Via port (field features, unified pipeline, phases)
- `packages/hub/src/via/money/` — the descriptor, binding, and arithmetic engine
