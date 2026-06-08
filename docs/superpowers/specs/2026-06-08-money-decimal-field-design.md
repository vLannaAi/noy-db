# money() — currency-safe decimal field descriptor

**Issue:** #300 (Pilot-3 / i3speedex delegation gap) · **Layer:** Schema · **Cluster:** A (schema fields) alongside #302 computed scalars, #299 cross-record validators.

## Problem

The pilot stores `subtotal` / `taxAmount` / `total` / `unitPrice` as JS `number`. Floating-point cannot represent most decimal money values exactly (`0.1 + 0.2 !== 0.3`), so every VAT/currency computation is a precision/rounding hazard and all of it stays in userland. The existing `sum()` aggregate accumulates in JS `number` (`state + readNumber(...)`, `aggregate/reducers.ts:135`) and therefore drifts.

## Goal

A `money({ currency | currencies, scale, rounding })` field descriptor — a sibling of `i18nText` / `dictKey` — that owns fixed-point storage, rounding, validation, multi-currency, and locale formatting, and makes `aggregate(sum())` over the field **exact end-to-end**, including magnitudes past `Number.MAX_SAFE_INTEGER`.

## Core principle

**Integers live in storage as digit strings; decimals live only at the boundary.** Money never exists as a JS `number` anywhere the DB performs arithmetic or persistence — a `number` truncates past 2^53, so the scaled integer is stored as a **string of digits**, parsed to `BigInt` for arithmetic, and rendered to a decimal string at the boundary. The convenience `number` form is offered only as a clearly-lossy read virtual. Aggregates run over the raw stored integers, before any read-time transform.

## 1. Public API

```ts
// Fixed single currency (default):
money({
  currency: string,            // ISO 4217 code
  scale?: number,              // default: ISO-4217 minor units for `currency`
  rounding?: RoundingMode,     // omitted ⇒ excess precision REJECTS
})

// Multi-currency (opt-in): currency travels per-record
money({
  currencies: 'any' | string[],   // allow-list, or 'any'
  scaleOverrides?: Record<string, number>, // override ISO-4217 default per currency
  rounding?: RoundingMode,
})

type RoundingMode =
  | 'half-up' | 'half-even' | 'half-down'
  | 'up' | 'down' | 'ceil' | 'floor'
```

`currency` and `currencies` are **mutually exclusive** (validated at descriptor construction). Scale is resolved per currency from a built-in **ISO-4217 minor-units table** (`EUR→2`, `JPY→0`, `BHD→3`, …); `scale` (fixed mode) or `scaleOverrides` (multi mode) override it. Unknown currency with no override ⇒ descriptor-construction error.

Implementation mirrors the existing descriptor pattern (`i18n/core.ts:180`):

```ts
interface MoneyDescriptor {
  readonly _noydbMoney: true
  readonly options: MoneyOptions   // normalized: { mode:'fixed'|'multi', ... }
}
function money(options: MoneyOptions): MoneyDescriptor
function isMoneyDescriptor(x: unknown): x is MoneyDescriptor
```

The collection collects declared descriptors into a per-collection
`moneyFields: Record<fieldPath, MoneyDescriptor>` — same plumbing as
`i18nFields` / `dictKeyFields` (`collection.ts:593-596`).

## 2. Write path

Accepts `number | string` decimal input (`123.45` or `'123.45'`); multi-currency fields accept `{ amount, currency }` (or a bare amount only if a single allow-listed currency makes it unambiguous). On `put()`:

1. Reject non-finite (`NaN`, `Infinity`).
2. **Multi-currency:** validate `currency` ∈ allow-list (or any non-empty ISO code if `'any'`); resolve `scale` for that currency.
3. Parse to a scaled integer by **decimal-string manipulation** (never `value * 10^scale` on a float — that reintroduces drift). Split on `.`, pad/truncate the fractional part to `scale`, concatenate, parse to `BigInt`.
4. Excess fractional precision:
   - `rounding` omitted ⇒ throw typed **`MoneyPrecisionError`** (field, value, scale).
   - `rounding` set ⇒ apply the mode to the excess digits.
5. Store the scaled integer **as a digit string** — fixed mode: `total: '12345'`; multi mode: `total: { amount: '12345', currency: 'EUR' }`.

Negative values allowed (credits / refunds). `null` allowed for nullable fields. Runs **after** zod schema validation, mirroring `i18nText` ordering (`collection.ts:1244`).

## 3. Read path

On `get()` / `list()` with locale resolution (`applyLocaleToRecord`):

- The field is exposed as an **exact decimal string** — fixed: `total: '123.45'`; multi: `total: { amount: '123.45', currency: 'EUR' }`.
- Virtual **`<field>Formatted`** — locale currency string `'€123,45'` via `Intl.NumberFormat(locale, { style:'currency', currency })`. In multi mode it uses the record's own currency. Mirrors `dictKey`'s `<field>Label`.
- Virtual **`<field>Number`** — convenience JS `number` (`123.45`), explicitly documented as **lossy for magnitudes past `Number.MAX_SAFE_INTEGER`**; for exact math callers use the string.
- Both virtuals are read-only and stripped before the next write (existing virtual-field lifecycle).

Locale resolution reuses the same default-locale machinery as `i18nText`.

## 4. Exact aggregates

The acceptance criterion — `aggregate(sum())` is exact.

- A **money-aware reducer path** for `sum` / `min` / `max`: when the reduced field is declared `money` on the source collection, the reducer accumulates the **stored integers in `BigInt`** (parsed from the digit strings) and renders an exact decimal **string** at `finalize`. No float anywhere; exact past 2^53.
- Aggregates run over raw decrypted records *before* `applyLocaleToRecord`, so the reducer sees the integer string, not the read-time decimal. Scale is read from `moneyFields`.
- **Multi-currency reduction is currency-aware:** `sum`/`min`/`max` return an **exact per-currency map** by default — `{ EUR:'1234.50', USD:'990.00' }` — never silently converting across currencies. Fixed-mode fields return a single exact string.
- **Opt-in FX conversion to one figure:** `sum('total', { convertTo:'EUR', fx })` where `fx` supplies rates; the reducer converts each currency's exact subtotal and sums to a single exact string. Missing rate ⇒ throws (never fabricates a rate). `convertTo` without `fx` ⇒ throws.
- **`avg()` over money is explicitly NOT exactness-guaranteed in v1** (division) — documented. `sum` / `min` / `max` are exact.

## 5. Boundaries & interplay

- **Schema:** the zod schema declares the field loosely (`z.union([z.number(), z.string()])`, or an `{amount,currency}` object in multi mode); the descriptor owns canonical form, scale, currency, and rounding. Schema validates shape first, descriptor quantizes second.
- **i18n ordering:** `<field>Formatted` is computed in `applyLocaleToRecord` alongside `<field>Label`, using the same locale resolution; no new ordering rules.
- **FX source:** `fx` is a caller-supplied rate map / lookup (`{ from, to } → rate`), passed per aggregate call — noy-db neither stores nor sources rates in v1 (a persisted FX-rate companion field remains a separate follow-up).
- **Introspection / devtools:** *deferred.* The introspection walker is schema-derived (`vault._introspectState()`) and currently surfaces **no** field-descriptor metadata — `i18nText` and `dictKey` are not introspected either. Surfacing money alone would be asymmetric; descriptor introspection (money + i18n + dictKey, uniformly) is its own follow-up.

### Deferred (separate issues, not v1)

- **Descriptor introspection** (money/i18n/dictKey surfaced in `dumpSchema`) — none are today; do them together.
- **Persisted** FX-rate companion field / historical-rate storage (per-call `fx` is supported; storing rates is not).
- Exact `avg()` over money.
- Money consumed by computed fields — picked up by **#302**.
- Index semantics beyond equality on the scaled integer. Equality/`unique` on a *multi-mode* `{amount,currency}` value needs a canonical composite key (fixed-mode scaled-int strings index as-is); index a derived scalar until a follow-up.

## 6. Testing

- **Quantization round-trip:** write `123.45` → store `'12345'` → read `'123.45'`; string and number inputs; fixed and multi mode.
- **Exactness past 2^53:** store/read/sum a value whose scaled integer exceeds `Number.MAX_SAFE_INTEGER` (e.g. `90071992547409.91`) — exact through the full store→read→reduce pipeline, not just sum finalize. Assert `<field>Number` is documented-lossy here.
- **Precision handling:** table-driven over every `RoundingMode`, incl. half-even vs half-up tie-breaking (`123.455`, `123.445`); reject-by-default throws `MoneyPrecisionError`.
- **Multi-currency:** per-record currency stored + read; scale derived per ISO-4217 (JPY=0, EUR=2, BHD=3); write with disallowed currency rejects; `scaleOverrides` honored.
- **Currency-aware aggregates:** `sum` over mixed currencies returns the exact per-currency map; `convertTo`+`fx` yields one exact figure; missing-rate and `convertTo`-without-`fx` both throw.
- **Read formatting:** `<field>Formatted` per locale uses the record's currency; symbol/grouping; negatives.
- **Nulls / optional fields:** nullable money round-trips and is excluded from sums correctly.
- **Ordering:** descriptor validation runs after zod; a schema-invalid record never reaches quantization.
- **Descriptor construction:** `currency`+`currencies` together throws; unknown currency without override throws.

## Build sequence

1. ISO-4217 minor-units table + scale resolution; descriptor + predicate + types (`money()`, `MoneyDescriptor`, `MoneyOptions`, `MoneyPrecisionError`), incl. fixed/multi normalization and mutual-exclusion validation.
2. BigInt fixed-point core: decimal-string ⇄ scaled-integer (string-encoded), all rounding modes (pure, unit-tested in isolation).
3. Write-path wiring: `moneyFields` collection, currency validation, quantize-on-put after schema validation; fixed vs `{amount,currency}` storage.
4. Read-path wiring: exact-string exposure + `<field>Formatted` + `<field>Number` virtuals in `applyLocaleToRecord`.
5. Money-aware `sum`/`min`/`max` reducer path: BigInt over string integers, per-currency maps, exact-string finalize, opt-in `convertTo`/`fx`.
6. Introspection field kind; docs (SUBSYSTEMS / README descriptor table); features.yaml registration.
