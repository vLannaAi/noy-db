# Money — exact arithmetic via-feature

Declares money fields with ISO 4217 currency codes. Stores scaled integers (cents for most currencies, smallest unit for the currency) and enforces exact arithmetic without floating-point rounding errors. `money('EUR')` means a field is money in euros; reads present `Formatted` and `Number` virtual fields for display and conversion.

## Declaration

Use the `via()` composer with `money()`:

```ts
collection<Invoice>({
  schema: {
    subtotal: via(money('EUR')),
    vat: via(money('EUR')),
    total: via(money('EUR'))
  }
})
```

Or the older `moneyFields` spelling (still works, identical internals):

```ts
collection<Invoice>({
  moneyFields: { subtotal: 'EUR', vat: 'EUR', total: 'EUR' }
})
```

Both spellings produce identical stored envelopes and identical `describe()` output. Existing code using `moneyFields` continues unchanged.

## Virtuals & display

Reading a money field unpacks two read-time virtuals for convenience: `<field>Formatted` (locale-aware display string) and `<field>Number` (the numeric value):

```ts
const inv = await collection.first()
// inv.subtotal         → { value: 1050, scale: 2 }  (underlying storage)
// inv.subtotalFormatted → '€10.50'                   (locale-aware)
// inv.subtotalNumber   → 10.50                       (numeric)
```

## Query & aggregate

`where()` predicates on money fields quantize operands to the field's scale at build time (sync). Aggregation supports exact `sum()` / `avg()` / `min()` / `max()` reducers with no floating-point drift.

## See also

- [`docs/subsystems/via.md`](via.md) — the Via port (field features, unified pipeline, phases)
- `@noy-db/hub/shape/via-money` — the binding and engine
