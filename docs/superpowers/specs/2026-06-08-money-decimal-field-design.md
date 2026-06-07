# money() — currency-safe, multi-currency decimal field descriptor

**Issue:** #300 (Pilot-3 / i3speedex delegation gap) · **Layer:** Schema · **Cluster:** A (schema fields) alongside #302 computed scalars, #299 cross-record validators.

## Problem

The pilot stores `subtotal` / `taxAmount` / `total` / `unitPrice` as JS `number`. Floating-point cannot represent most decimal money values exactly (`0.1 + 0.2 !== 0.3`), so every VAT/currency computation is a precision/rounding hazard and all of it stays in userland. The existing `sum()` aggregate accumulates in JS `number` (`state + readNumber(...)`, `aggregate/reducers.ts:135`) and therefore drifts.

## Goals

1. A `money({ scale, allowed?, rounding? })` field descriptor — sibling of `i18nText` / `dictKey` — owning fixed-point storage, validation, multi-currency, and locale formatting.
2. **Maximum accuracy, end to end:** no money value is ever a float at any layer the DB stores, sums, or persists. Exact values survive arbitrarily large magnitudes (past `Number.MAX_SAFE_INTEGER`).
3. **First-class multi-currency:** currency travels with each value; `aggregate(sum())` is exact per currency, with explicit (and only explicit) FX conversion.

## Core principles

- **Integers live in storage; decimals live only at the boundary.** Money is a fixed-point integer in storage and arithmetic; the decimal form materializes only on read (display) and on write input (immediately quantized).
- **Exactness is carried as a string, not a JS number.** Stored amount and every exact output (sums, per-currency totals) are decimal/integer **strings**, so accuracy is unbounded. A JS `number` is offered only as an explicit, lossy convenience (`Number(...)`), never as the source of truth.
- **Currency travels with the value.** Mixing currencies is never silently collapsed; conversion is always an explicit, rate-bearing, audited act.

## 1. Public API

```ts
money({
  scale: number,            // required; decimal places for stored amounts. minorUnit = 10^scale
  allowed?: string[],       // optional ISO-4217 whitelist; writes outside it reject
  defaultCurrency?: string, // optional; lets write input omit currency
  rounding?: RoundingMode,  // omitted ⇒ excess input precision REJECTS (no silent mutation)
})

type RoundingMode =
  | 'half-up' | 'half-even' | 'half-down'
  | 'up' | 'down' | 'ceil' | 'floor'
```

Note `currency` is **no longer fixed per field** — it is per record/value. Implementation mirrors the descriptor pattern (`i18n/core.ts:180`):

```ts
interface MoneyDescriptor {
  readonly _noydbMoney: true
  readonly options: MoneyOptions
}
function money(options: MoneyOptions): MoneyDescriptor
function isMoneyDescriptor(x: unknown): x is MoneyDescriptor
```

The collection collects declared descriptors into a per-collection
`moneyFields: Record<fieldPath, MoneyDescriptor>` — same plumbing as
`i18nFields` / `dictKeyFields` (`collection.ts:593-596`).

## 2. Storage shape (on the wire, inside the encrypted envelope)

```jsonc
total: { amount: "12345", currency: "EUR" }   // amount = scaled-integer STRING (BigInt-safe)
```

- `amount` is the scaled integer serialized as a **string** — exact and unbounded, never a JS number.
- `currency` is the per-value ISO-4217 code.
- `null` permitted for nullable fields.

## 3. Write path

Write input accepts, per field:

```ts
{ amount: number | string, currency?: string }   // currency optional iff defaultCurrency set
```

On `put()` (after zod schema validation — mirrors `i18nText` ordering, `collection.ts:1244`):

1. Resolve currency (input ∪ `defaultCurrency`); if `allowed` set and currency ∉ it ⇒ `MoneyCurrencyError`.
2. Reject non-finite input (`NaN`, `Infinity`).
3. Parse to a scaled integer by **decimal-string manipulation** (split on `.`, pad/truncate fraction to `scale`) — never `value * 10^scale` (float multiplication reintroduces drift).
4. Excess fractional precision: `rounding` omitted ⇒ throw `MoneyPrecisionError`; else apply the mode via BigInt.
5. Store `{ amount: <integer-string>, currency }`.

Negatives allowed (credits/refunds).

## 4. Read path

On `get()` / `list()` with locale resolution (`applyLocaleToRecord`):

- Field is exposed as a plain (JSON-clean, methodless) value:
  ```ts
  total: { amount: "123.45", currency: "EUR" }   // amount = EXACT decimal string
  ```
  `amount` is the exact decimal string (not a float). Consumers wanting a number opt in via `Number(total.amount)`.
- A virtual **`<field>Formatted`** locale string is added (`'€123,45'`) via `Intl.NumberFormat(locale, { style:'currency', currency })`, mirroring `dictKey`'s `<field>Label`. Read-only; stripped before the next write.

*(Review flag: amount-as-exact-string is the maximum-accuracy choice; it replaces the earlier single-currency "decimal number" read shape. Flagged for sign-off.)*

## 5. Exact aggregates

The acceptance criterion — `aggregate(sum())` is exact.

- **`sum` / `min` / `max` group by currency.** When the reduced field is `money`, the reducer accumulates stored integers **in BigInt, partitioned by currency**, and finalizes each partition to an exact decimal string:
  ```ts
  sum('total') → { EUR: "12345.67", USD: "980.00" }   // exact, no FX
  min/max('total') → { EUR: "...", USD: "..." }        // per-currency extremes
  ```
  Aggregates run over raw decrypted records *before* `applyLocaleToRecord`, so the reducer sees the integer string; `scale` comes from `moneyFields`.
- **Opt-in FX conversion** collapses to one currency, explicitly:
  ```ts
  sum('total', { convertTo: 'EUR', rates, rounding?: RoundingMode })
    → "13313.45"   // documented rounding; rate + mode recorded for audit
  ```
  Maximum-accuracy conversion order: sum **exactly per currency first**, then convert each per-currency subtotal **once** (one rounding per currency, not per row), then add. `rates` are exact decimal strings applied at high internal precision (rate scale up to 12 digits) via BigInt; the result rounds to the target currency `scale` with the given mode (default `half-even`).
- **`avg()` — maximum accuracy, not "exact" (division can't be exact).** Per currency, avg computes `sum / count` at an **extended scale** (`scale + guardDigits`, default `guardDigits: 6`) and returns the high-precision decimal string plus the documented final rounding. No silent collapse to a lossy float.

## 6. Boundaries & interplay

- **Schema:** zod declares the field as an object `{ amount: z.union([z.number(), z.string()]), currency: z.string().optional() }` (a provided `moneyField()` zod helper); the descriptor owns scale/rounding/currency-whitelist.
- **i18n ordering:** `<field>Formatted` computed in `applyLocaleToRecord` beside `<field>Label`, same locale resolution.
- **Introspection / devtools:** money fields surface in `introspection/fields.ts` as kind `money` with `{ scale, allowed }`.

### Deferred (separate issues)

- A dynamic FX-rate **provider** subsystem (sourcing/caching live rates) — v1 takes caller-supplied `rates`.
- Exact rational `avg` / carrying remainders.
- Index semantics beyond equality on `(currency, amount)`.
- Money consumed by computed fields — picked up by **#302**.

## 7. Testing

- **Quantization round-trip:** `{amount:"123.45",currency:"EUR"}` → store `"12345"` → read `"123.45"`; number and string inputs; `defaultCurrency` fill.
- **Currency whitelist:** write outside `allowed` ⇒ `MoneyCurrencyError`.
- **Precision/rounding:** table-driven over every `RoundingMode` incl. half-even vs half-up ties (`123.455` / `123.445`); reject-by-default throws `MoneyPrecisionError`.
- **Exactness regression:** `0.1`-class sum exact; sum past `Number.MAX_SAFE_INTEGER` exact via integer-string accumulation.
- **Multi-currency sum:** mixed EUR+USD rows → exact per-currency map; single-currency → single-key map.
- **FX conversion:** known rate set → `convertTo` total matches a hand-computed reference; sum-then-convert-once beats convert-then-sum on accumulated rounding (assert the documented order).
- **avg accuracy:** `10/3`-class avg returns extended-scale string, not a drifted float.
- **Read formatting:** `<field>Formatted` per locale/currency; negatives.
- **Nulls / optional:** nullable money round-trips; excluded from sums.
- **Ordering:** descriptor validation runs after zod.

## Build sequence

1. Descriptor + predicate + types (`money()`, `MoneyDescriptor`, `MoneyOptions`, `MoneyPrecisionError`, `MoneyCurrencyError`) + `moneyField()` zod helper.
2. BigInt fixed-point core: decimal-string ⇄ scaled-integer-string, all rounding modes, high-precision multiply for FX (pure, unit-tested in isolation).
3. Write-path wiring: `moneyFields` collection, currency resolve/whitelist, quantize-on-put after schema validation.
4. Read-path wiring: exact-string decimal exposure + `<field>Formatted` virtual in `applyLocaleToRecord`.
5. Currency-partitioned `sum`/`min`/`max` reducers (exact per-currency map) + opt-in `convertTo`/`rates` collapse + high-accuracy `avg`.
6. Introspection field kind; docs (SUBSYSTEMS / README descriptor table); features.yaml registration.
