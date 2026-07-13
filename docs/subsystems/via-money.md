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
full scan. Multi-currency (`currencies:`) fields and every operator besides `==`/`in`
(`between`, range comparisons) always scan — there is no single stored-form value a hash index
can serve for those (`packages/hub/__tests__/money/where-comparison.test.ts`, "indexed fast path
agrees with the scan" describe block, spy-proven against `lookupEqual`/`lookupIn`).

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

**Boundary: eager mode only.** Lazy-mode collections (`prefetch: false`) keep their own durable
`PersistedCollectionIndex` side-cars, which bucket by the raw stored value and do not consult
money canonicalization. A lazy-mode collection with mixed-era money data can still see its fast
path diverge from a forced scan; that gap is tracked separately, not fixed here.

## See also

- [`docs/subsystems/via.md`](via.md) — the Via port (field features, unified pipeline, phases)
- `packages/hub/src/via/money/` — the descriptor, binding, and arithmetic engine
