# money() Field Descriptor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `money()` field descriptor to `@noy-db/hub` that stores currency values as exact scaled integers (string-encoded), formats on read, supports opt-in multi-currency, and makes `sum/min/max` exact end-to-end including magnitudes past `Number.MAX_SAFE_INTEGER`.

**Architecture:** A branded descriptor (`money(opts) → { _noydbMoney: true, options }`) declared per-collection via `options.moneyFields` — identical plumbing to `i18nFields`/`dictKeyFields`. A pure BigInt fixed-point core does all decimal↔integer conversion via string manipulation (never float multiplication). Write quantizes after schema validation; read exposes an exact decimal string plus `<field>Formatted`/`<field>Number` virtuals in `applyLocaleToRecord`. Exact aggregation is achieved by wrapping `sum/min/max` reducers at the `Query` layer (where `moneyFields` is in scope) with a BigInt money reducer that returns per-currency exact-string results.

**Tech Stack:** TypeScript, `BigInt`, `Intl.NumberFormat`, zod (existing schema layer), vitest.

---

## File Structure

- **Create** `packages/hub/src/money/iso4217.ts` — ISO-4217 minor-units table + `scaleForCurrency()`.
- **Create** `packages/hub/src/money/fixed-point.ts` — pure core: `parseToScaledInt`, `formatScaledInt`, rounding modes. No I/O, no descriptor knowledge.
- **Create** `packages/hub/src/money/descriptor.ts` — `money()`, `MoneyDescriptor`, `MoneyOptions`, `isMoneyDescriptor`, construction validation; `MoneyPrecisionError`, `MoneyCurrencyError`.
- **Create** `packages/hub/src/money/normalize.ts` — write-side `quantizeMoneyFields(record, moneyFields)` and read-side `decodeMoneyFields(record, moneyFields, locale)`.
- **Create** `packages/hub/src/money/money-reducer.ts` — BigInt money reducer + `wrapMoneyReducers(spec, moneyFields)` + FX conversion.
- **Create** `packages/hub/src/money/index.ts` — barrel re-export.
- **Modify** `packages/hub/src/vault.ts` — `CollectionOptions.moneyFields`, `moneyFieldRegistry`, populate + pass-through (mirror i18nFields at :531, :615, :751).
- **Modify** `packages/hub/src/collection.ts` — `moneyFields` opt (~596/781), quantize in `putInternal` after `validateSchemaInput` (~1168), decode in `applyLocaleToRecord` (~3081), pass `moneyFields` into `Query` (~2303).
- **Modify** `packages/hub/src/query.ts` — accept `moneyFields`, call `wrapMoneyReducers` before reduction; thread `convertTo`/`fx` aggregate options.
- **Modify** `packages/hub/src/introspection/fields.ts` — emit `money` field kind.
- **Modify** `packages/hub/src/index.ts` — export `money`, `isMoneyDescriptor`, `MoneyDescriptor`, error types.
- **Modify** `SUBSYSTEMS.md`, `packages/hub/README.md`, `features.yaml` — docs + registry.
- **Test dirs:** `packages/hub/__tests__/money/`.

---

## Task 1: ISO-4217 table + scale resolution

**Files:** Create `packages/hub/src/money/iso4217.ts`; Test `packages/hub/__tests__/money/iso4217.test.ts`

- [ ] **Step 1: Failing test**
```ts
import { describe, it, expect } from 'vitest'
import { scaleForCurrency } from '../../src/money/iso4217.js'
describe('scaleForCurrency', () => {
  it('returns ISO-4217 minor units', () => {
    expect(scaleForCurrency('EUR')).toBe(2)
    expect(scaleForCurrency('JPY')).toBe(0)
    expect(scaleForCurrency('BHD')).toBe(3)
    expect(scaleForCurrency('USD')).toBe(2)
  })
  it('returns null for unknown currency', () => {
    expect(scaleForCurrency('ZZZ')).toBeNull()
  })
})
```
- [ ] **Step 2:** `npx vitest run packages/hub/__tests__/money/iso4217.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement.** A `Record<string, number>` covering the common set (EUR/USD/GBP/CHF/JPY/CNY/BHD/KWD/TND and ~40 majors; default 2 not assumed — only listed codes are known). `export function scaleForCurrency(code: string): number | null { return MINOR_UNITS[code] ?? null }`.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(money): ISO-4217 minor-units table`.

## Task 2: Pure BigInt fixed-point core

**Files:** Create `packages/hub/src/money/fixed-point.ts`; Test `packages/hub/__tests__/money/fixed-point.test.ts`

Interface:
```ts
export type RoundingMode = 'half-up'|'half-even'|'half-down'|'up'|'down'|'ceil'|'floor'
// Parse a decimal (number|string) to a scaled BigInt. Returns { value } or throws RangeError-like
// signal via a discriminated result so the descriptor layer can map to MoneyPrecisionError.
export function parseToScaledInt(input: number | string, scale: number, rounding?: RoundingMode):
  { ok: true; value: bigint } | { ok: false; reason: 'precision' | 'nonfinite' }
// Render a scaled BigInt back to a canonical decimal string, e.g. (12345n, 2) → '123.45'; (5n,0)→'5'
export function formatScaledInt(value: bigint, scale: number): string
```

- [ ] **Step 1: Failing tests** (table-driven):
```ts
import { describe, it, expect } from 'vitest'
import { parseToScaledInt, formatScaledInt } from '../../src/money/fixed-point.js'
const ok = (r: ReturnType<typeof parseToScaledInt>) => { if (!r.ok) throw new Error('expected ok'); return r.value }
describe('parseToScaledInt', () => {
  it('exact, no rounding needed', () => {
    expect(ok(parseToScaledInt('123.45', 2))).toBe(12345n)
    expect(ok(parseToScaledInt(123.45, 2))).toBe(12345n)
    expect(ok(parseToScaledInt('5', 0))).toBe(5n)
    expect(ok(parseToScaledInt('-0.01', 2))).toBe(-1n)
    expect(ok(parseToScaledInt('1.20', 2))).toBe(120n)
  })
  it('never uses float multiplication (0.1-class stays exact)', () => {
    expect(ok(parseToScaledInt('0.1', 2))).toBe(10n)
    expect(ok(parseToScaledInt('0.2', 2))).toBe(20n)
  })
  it('exact past 2^53', () => {
    expect(ok(parseToScaledInt('90071992547409.91', 2))).toBe(9007199254740991n)
  })
  it('rejects excess precision without rounding', () => {
    expect(parseToScaledInt('123.456', 2)).toEqual({ ok: false, reason: 'precision' })
  })
  it('rejects non-finite', () => {
    expect(parseToScaledInt(NaN, 2)).toEqual({ ok: false, reason: 'nonfinite' })
    expect(parseToScaledInt(Infinity, 2)).toEqual({ ok: false, reason: 'nonfinite' })
  })
  it('rounding modes on the tie digit', () => {
    expect(ok(parseToScaledInt('123.455', 2, 'half-up'))).toBe(12346n)
    expect(ok(parseToScaledInt('123.445', 2, 'half-up'))).toBe(12345n)
    expect(ok(parseToScaledInt('123.455', 2, 'half-even'))).toBe(12346n) // 5→6 even
    expect(ok(parseToScaledInt('123.445', 2, 'half-even'))).toBe(12344n) // 4→4 even
    expect(ok(parseToScaledInt('123.451', 2, 'half-down'))).toBe(12345n)
    expect(ok(parseToScaledInt('123.451', 2, 'down'))).toBe(12345n)
    expect(ok(parseToScaledInt('123.451', 2, 'up'))).toBe(12346n)
    expect(ok(parseToScaledInt('-123.451', 2, 'ceil'))).toBe(-12345n)
    expect(ok(parseToScaledInt('-123.451', 2, 'floor'))).toBe(-12346n)
  })
})
describe('formatScaledInt', () => {
  it('renders canonical decimal strings', () => {
    expect(formatScaledInt(12345n, 2)).toBe('123.45')
    expect(formatScaledInt(-1n, 2)).toBe('-0.01')
    expect(formatScaledInt(5n, 0)).toBe('5')
    expect(formatScaledInt(9007199254740991n, 2)).toBe('90071992547409.91')
  })
})
```
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement.** Algorithm — coerce `input` to a canonical decimal *string* (for `number`, use `String(input)`; reject if it contains `e`/`E` exponent by expanding, or reject non-finite first). Split on `.`. Take `frac`; if `frac.length > scale`: the digits beyond `scale` are the discarded part — if all zero, truncate exactly; else if `rounding` undefined → `{ok:false,reason:'precision'}`; else compute the rounding increment from the first discarded digit + remainder + sign + mode. Build the integer string `intPart + frac.padEnd(scale,'0').slice(0,scale)`, parse `BigInt`, apply increment. Sign handled on the BigInt. `formatScaledInt`: work on `abs`, left-pad to `scale+1`, insert `.` at `len-scale`, strip trailing-`.000` only when `scale===0`, re-apply sign.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(money): pure BigInt fixed-point core`.

## Task 3: Descriptor + construction validation + errors

**Files:** Create `packages/hub/src/money/descriptor.ts`; Test `packages/hub/__tests__/money/descriptor.test.ts`

Types:
```ts
export interface MoneyOptionsFixed { currency: string; scale?: number; rounding?: RoundingMode }
export interface MoneyOptionsMulti { currencies: 'any' | string[]; scaleOverrides?: Record<string,number>; rounding?: RoundingMode }
export type MoneyOptions = MoneyOptionsFixed | MoneyOptionsMulti
export interface MoneyDescriptor {
  readonly _noydbMoney: true
  readonly mode: 'fixed' | 'multi'
  readonly options: MoneyOptions
  readonly rounding?: RoundingMode
  // resolved helpers:
  scaleFor(currency: string): number   // throws MoneyCurrencyError if unresolvable
  currencyOf(value: unknown): string   // fixed → options.currency; multi → value.currency
  allows(currency: string): boolean
}
export class MoneyPrecisionError extends Error { constructor(public field: string, public value: unknown, public scale: number) {…} }
export class MoneyCurrencyError extends Error { constructor(public field: string, public currency: string, public reason: 'not-allowed'|'unknown-scale') {…} }
```
- [ ] **Step 1: Failing test**
```ts
import { describe, it, expect } from 'vitest'
import { money, isMoneyDescriptor, MoneyCurrencyError } from '../../src/money/descriptor.js'
describe('money()', () => {
  it('fixed mode resolves scale from ISO-4217 when omitted', () => {
    const d = money({ currency: 'EUR' }); expect(d.mode).toBe('fixed'); expect(d.scaleFor('EUR')).toBe(2)
  })
  it('fixed mode honors explicit scale', () => { expect(money({ currency:'XAU', scale:4 }).scaleFor('XAU')).toBe(4) })
  it('multi mode resolves per-currency scale', () => {
    const d = money({ currencies: ['EUR','JPY'] }); expect(d.scaleFor('EUR')).toBe(2); expect(d.scaleFor('JPY')).toBe(0)
  })
  it('multi scaleOverrides win', () => { expect(money({ currencies:'any', scaleOverrides:{ FOO:5 } }).scaleFor('FOO')).toBe(5) })
  it('multi rejects disallowed currency', () => {
    expect(() => money({ currencies:['EUR'] }).scaleFor('USD')).toThrow(MoneyCurrencyError)
  })
  it('unknown currency without scale throws at construction', () => { expect(() => money({ currency:'ZZZ' })).toThrow(MoneyCurrencyError) })
  it('currency + currencies together throws', () => {
    // @ts-expect-error mutually exclusive
    expect(() => money({ currency:'EUR', currencies:'any' })).toThrow()
  })
  it('isMoneyDescriptor predicate', () => { expect(isMoneyDescriptor(money({currency:'EUR'}))).toBe(true); expect(isMoneyDescriptor({})).toBe(false) })
})
```
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement** using `scaleForCurrency` from Task 1. Construction validates mutual exclusivity, and for fixed mode eagerly resolves+caches scale (throw if unknown & no `scale`). `scaleFor` for multi: `scaleOverrides[c] ?? scaleForCurrency(c)`; throw `MoneyCurrencyError` if not allowed or unresolved.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(money): descriptor + construction validation + typed errors`.

## Task 4: Write/read normalization helpers

**Files:** Create `packages/hub/src/money/normalize.ts`; Test `packages/hub/__tests__/money/normalize.test.ts`

```ts
// Write: mutate a shallow clone — money fields → canonical stored form.
//   fixed: '12345'   |   multi: { amount:'12345', currency:'EUR' }
export function quantizeMoneyFields<T extends Record<string,unknown>>(record: T, moneyFields: Record<string,MoneyDescriptor>): T
// Read: stored form → exact decimal string + virtuals (<f>Formatted, <f>Number)
export function decodeMoneyFields<T extends Record<string,unknown>>(record: T, moneyFields: Record<string,MoneyDescriptor>, locale: string | undefined): T
```
- [ ] **Step 1: Failing test** covering: fixed write `123.45`→`'12345'`; multi write `{amount:123.45,currency:'EUR'}`→`{amount:'12345',currency:'EUR'}`; bare-amount accepted in multi only when allow-list length 1; null passthrough; precision throw → `MoneyPrecisionError`; read fixed `'12345'`→`total:'123.45'`, `totalFormatted` (locale `'de-DE'` → contains `123,45`), `totalNumber:123.45`; read of >2^53 keeps `total` exact-string and documents `totalNumber` lossy (assert string exact, number defined).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement.** Write uses `parseToScaledInt` + descriptor `rounding`/`scaleFor`; map `{ok:false}` to `MoneyPrecisionError`/non-finite throw. Read uses `formatScaledInt`; `<f>Formatted` via `new Intl.NumberFormat(locale ?? 'en-US', { style:'currency', currency }).format(Number(decimalString))` (format is display-only; exactness lives in the string); `<f>Number = Number(decimalString)`.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(money): write/read normalization helpers`.

## Task 5: Wire into Vault + Collection (write + read paths)

**Files:** Modify `packages/hub/src/vault.ts`, `packages/hub/src/collection.ts`; Test `packages/hub/__tests__/money/collection-roundtrip.test.ts`

- [ ] **Step 1: Failing integration test** — open a vault, declare `collection('invoices', { schema, moneyFields: { total: money({currency:'EUR',scale:2}) } })`, `put('a',{ id:'a', total: 123.45 })`, then `get('a', { locale:'de-DE' })` → `total==='123.45'`, `totalFormatted` contains `123,45`, `totalNumber===123.45`. Raw read (`locale:'raw'` or no locale) → stored `'12345'` is decoded to `'123.45'` (decode always runs; raw only skips Intl formatting/virtuals — match dictKey's `locale!=='raw'` gate).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement wiring** (mirror i18nFields exactly):
  - `vault.ts`: add `moneyFields?: Record<string,MoneyDescriptor>` to `CollectionOptions` (~531); `moneyFieldRegistry: Map<string, Record<string,MoneyDescriptor>>` (~332); populate in `collection()` (~615); pass to `collOpts` (~751).
  - `collection.ts`: add `moneyFields` to constructor opts type (~596) + field (~781); in `putInternal` after `validateSchemaInput` (~1168) call `record = quantizeMoneyFields(record, this.moneyFields)` when present; in `applyLocaleToRecord` (~3081) call `record = decodeMoneyFields(record, this.moneyFields, locale)` (always decode stored→decimal; gate the Intl virtuals on `locale!=='raw'` inside the helper).
- [ ] **Step 4:** Run → PASS; also run `packages/hub/__tests__/i18n` to confirm no regression in the shared apply path.
- [ ] **Step 5: Commit** `feat(money): wire descriptor into vault + collection write/read paths`.

## Task 6: Exact money-aware aggregation

**Files:** Create `packages/hub/src/money/money-reducer.ts`; Modify `packages/hub/src/collection.ts` (~2303), `packages/hub/src/query.ts`; Test `packages/hub/__tests__/money/aggregate.test.ts`

Design: aggregates run over **raw** records (money = scaled-int string). `wrapMoneyReducers(spec, moneyFields)` inspects each reducer's `.op`/`.field`; when `field ∈ moneyFields` and `op ∈ {sum,min,max}`, replaces it with a money reducer whose state is per-currency `Map<string,bigint>` and whose `finalize` returns either a single exact string (fixed mode / single currency present) or a `Record<currency,string>` map (multi). `sum(field,{convertTo,fx})` converts via `fx` to one exact string.

- [ ] **Step 1: Failing test**
```ts
// fixed-mode exact sum incl >2^53; per-currency map for multi; FX convert; min/max
// e.g. put lines total 0.1,0.2,0.3 → sum '0.60' exact
// multi EUR+USD → sum { EUR:'...', USD:'...' }; with {convertTo:'EUR', fx:{ 'USD->EUR':0.9 }} → single string
```
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement.** Verify (in-test) that `Query`'s record source is raw, pre-`applyLocaleToRecord`; if not, route aggregate over raw records. Pass `moneyFields` into `Query` at collection.ts:2303 and into the aggregate execution; call `wrapMoneyReducers` before `reduceRecords`/groupby. Money reducer parses stored integer strings to BigInt, accumulates per currency, finalizes with `formatScaledInt`. FX: for each currency subtotal, look up `fx['${cur}->${convertTo}']` (throw if missing), multiply (decimal-safe via scaled-int), sum.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(money): exact BigInt money-aware sum/min/max with per-currency + FX`.

## Task 7: Introspection field kind

**Files:** Modify `packages/hub/src/introspection/fields.ts`; Test `packages/hub/__tests__/money/introspection.test.ts`

- [ ] **Step 1: Failing test** — introspecting a collection with a money field yields a field entry `{ kind:'money', currency|currencies, scale }`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement** — extend the field walker to recognize `isMoneyDescriptor` and emit the `money` kind (follow how i18nText/dictKey are surfaced).
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(money): introspection money field kind`.

## Task 8: Public exports + docs + registry

**Files:** Modify `packages/hub/src/index.ts`, `packages/hub/src/money/index.ts`, `SUBSYSTEMS.md`, `packages/hub/README.md`, `features.yaml`

- [ ] **Step 1:** Export `money`, `isMoneyDescriptor`, types `MoneyDescriptor`/`MoneyOptions`/`RoundingMode`, `MoneyPrecisionError`, `MoneyCurrencyError` from `index.ts` (alongside the i18n descriptor exports ~668-686).
- [ ] **Step 2:** Add a `money()` row to the README descriptor table and a short section to `SUBSYSTEMS.md` (Schema layer). Register the feature in `features.yaml` (artefact → spec/plan/showcase refs) so the Spec-coverage CI job passes — **mandatory**.
- [ ] **Step 3: Typecheck + build** `npx tsc -p packages/hub/tsconfig.json --noEmit` and the package build. Expected: clean.
- [ ] **Step 4: Commit** `feat(money): export public surface + docs + features.yaml`.

## Task 9: Full-pipeline integration + verification

**Files:** Test `packages/hub/__tests__/money/end-to-end.test.ts`

- [ ] **Step 1:** Write an invoice-shaped end-to-end test: lines with `unitPrice`/`taxAmount`/`total`; sum over `total` exact; a value whose scaled int > `Number.MAX_SAFE_INTEGER` round-trips and sums exactly; multi-currency breakdown; negative credit; null optional excluded from sum; rounding-mode write; `MoneyPrecisionError` on excess precision without rounding.
- [ ] **Step 2:** `npx vitest run packages/hub/__tests__/money` → all PASS.
- [ ] **Step 3:** Full hub suite `npx vitest run packages/hub` → green (no regressions, esp. i18n/aggregate/introspection).
- [ ] **Step 4:** Lint + typecheck + build clean.
- [ ] **Step 5: Commit** `test(money): full-pipeline integration incl >2^53 exactness`.

---

## Self-Review

- **Spec coverage:** §1 API→T3; §2 write→T2/T4/T5; §3 read→T4/T5; §4 aggregates(per-currency+FX+>2^53)→T2/T6/T9; §5 boundaries(zod-loose, i18n order, introspection)→T5/T7; §6 testing→every task + T9; ISO-4217 scale→T1/T3. No gaps.
- **Type consistency:** `MoneyDescriptor.scaleFor/currencyOf/allows`, `parseToScaledInt`/`formatScaledInt`, `quantizeMoneyFields`/`decodeMoneyFields`, `wrapMoneyReducers` referenced consistently across T2–T6.
- **Placeholder scan:** none — algorithms and test cases are concrete.
- **Risk note (verify during T6):** confirm the aggregate record source is raw (pre-locale). If aggregation runs post-`applyLocaleToRecord`, the money reducer must parse the decimal-string form instead — handled by reading `scaleFor` and parsing accordingly; the test in T6 Step 3 asserts which form arrives.
