# i18n multilingual-field hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. TDD throughout; commit per task.

**Goal:** Harden the `i18nText`/`dictKey` subsystem with per-layer `onMissing` policy, declared `substitute` ordering, per-locale script enforcement, and dictKey parity — all as *opt-in* additions with zero behavior change for non-opting fields.

**Architecture:** Extend `I18nTextOptions`/`DictKeyOptions` with new optional fields; route all map→string collapsing through one policy-aware `resolveI18nText()` choke point; thread a `Layer` tag from each read context (app read / guard / derivation / mv / export) into resolution. All new code lives inside the tree-shaken `withI18n()` strategy.

**Tech Stack:** TypeScript, Vitest (`pnpm --filter @noy-db/hub test`), monorepo (pnpm + turbo). Spec: `docs/superpowers/specs/2026-06-05-i18n-multilingual-field-hardening-design.md`. Milestone #17. Resolves #282, #283.

**Durability-first ordering:** Phases A→C are low-risk and independently valuable (land first); Phase D is the invasive per-layer threading; Phase E (dictKey) depends on A. If the run is cut short, A+B+C are shippable on their own.

---

## File structure

| File | Responsibility | Phase |
|---|---|---|
| `src/i18n/policy.ts` (NEW) | `OnMissing`, `Layer` types; `resolvePolicy()`; `LATIN_SCRIPT_LOCALES`/script helpers kept separate | A |
| `src/i18n/core.ts` (MOD) | extend `I18nTextOptions`; policy-aware `resolveI18nText()`; `applyI18nLocale(..., layer)` | A,B |
| `src/i18n/strategy.ts` (MOD) | add `layer` param to `applyI18nLocale`; `NO_I18N` unchanged behavior | B |
| `src/errors.ts` (MOD) | add `ScriptViolationError` | C |
| `src/i18n/script.ts` (NEW) | BCP-47 lang→script table (asymmetric Latin), `validateI18nScript()`, `applyScriptFilter()` | C |
| `src/collection.ts` (MOD) | call `validateI18nScript` on put; pass `layer` through `applyLocaleToRecord`; dictKey resolution wildcard + array + policy | C,D,E |
| `src/guards/read-only-facade.ts` (MOD) | carry `layer` tag; inject into reads | D |
| `src/vault.ts` (MOD) | construct layer-tagged facades for guard vs derivation | D |
| `src/i18n/dictionary.ts` (MOD) | extend `DictKeyOptions`; policy-aware `resolveLabel`; array/pair resolution | E |
| `src/query/groupby.ts` + join planner (MOD) | dictKey key-vs-label binding (`{ by }`) | E |
| `features.yaml` (MOD) | register capability nodes | F |
| `docs/subsystems/*i18n*` (MOD) + `showcases/src/*` (NEW) | docs + showcase | F |

---

## Phase A — Policy core (pure, no integration)

### Task A1: Policy types + `resolvePolicy()`

**Files:** Create `src/i18n/policy.ts`; Test `__tests__/i18n-policy.test.ts`

- [ ] **Step 1: Failing tests** — cover the spec's effective-policy table:

```ts
import { describe, it, expect } from 'vitest'
import { resolvePolicy } from '../src/i18n/policy.js'

describe('resolvePolicy', () => {
  it('undefined onMissing → throw for every layer except guard', () => {
    expect(resolvePolicy(undefined, 'read')).toBe('throw')
    expect(resolvePolicy(undefined, 'mv')).toBe('throw')
    expect(resolvePolicy(undefined, 'guard')).toBe('substitute') // lenient default
  })
  it('scalar applies to all non-guard layers; guard stays lenient', () => {
    expect(resolvePolicy('throw', 'read')).toBe('throw')
    expect(resolvePolicy('substitute', 'mv')).toBe('substitute')
    expect(resolvePolicy('throw', 'guard')).toBe('substitute') // never inherits scalar
  })
  it('explicit guard override beats the lenient default', () => {
    expect(resolvePolicy({ guard: 'throw' }, 'guard')).toBe('throw')
  })
  it('partial object: listed layers use value; unlisted non-guard → throw; guard → substitute', () => {
    const p = { read: 'substitute', mv: 'throw' } as const
    expect(resolvePolicy(p, 'read')).toBe('substitute')
    expect(resolvePolicy(p, 'mv')).toBe('throw')
    expect(resolvePolicy(p, 'join')).toBe('throw')       // unlisted non-guard
    expect(resolvePolicy(p, 'guard')).toBe('substitute') // unlisted guard
  })
})
```

- [ ] **Step 2:** Run → FAIL (module missing). `pnpm --filter @noy-db/hub exec vitest run __tests__/i18n-policy.test.ts`
- [ ] **Step 3: Implement** `src/i18n/policy.ts`:

```ts
export type OnMissing = 'substitute' | 'null' | 'throw'
export type Layer = 'read' | 'guard' | 'join' | 'mv' | 'derivation' | 'export'

export function resolvePolicy(
  onMissing: OnMissing | Partial<Record<Layer, OnMissing>> | undefined,
  layer: Layer,
): OnMissing {
  const explicit = onMissing && typeof onMissing === 'object' ? onMissing[layer] : undefined
  const scalar = typeof onMissing === 'string' ? onMissing : undefined
  const layerDefault: OnMissing | undefined = layer === 'guard' ? 'substitute' : undefined
  return explicit ?? layerDefault ?? scalar ?? 'throw'
}
```

- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(hub/i18n): policy types + resolvePolicy (per-layer onMissing)`

### Task A2: Extend `I18nTextOptions` + policy-aware `resolveI18nText`

**Files:** Modify `src/i18n/core.ts`; Test `__tests__/i18n-resolve-policy.test.ts`

Semantics to encode (from spec decision table + backward-compat):
- caller `fallback` ALWAYS applies first (backward compat + read-time override), any policy.
- declared `substitute` applies ONLY under policy `'substitute'`.
- after exhaustion: `'throw'` → throw `LocaleNotSpecifiedError`; `'null'`/`'substitute'` → `null`.
- `locale:'raw'` → return map. Existing 4-arg calls (`value, locale, fallback, field`) must behave exactly as today (default policy `'throw'`, no declared substitute).

- [ ] **Step 1: Failing tests:**

```ts
// resolveI18nText(value, locale, fallback?, field?, opts?: { policy?, substitute? })
const v = { th: 'สมชาย' }
// present
expect(resolveI18nText({en:'A',th:'B'}, 'en')).toBe('A')
// throw (default) — backward compat
expect(() => resolveI18nText(v, 'en')).toThrow(/locale/i)
// substitute via declared list
expect(resolveI18nText(v, 'en', undefined, 'firstName', { policy:'substitute', substitute:['th','any'] })).toBe('สมชาย')
// null policy → null, no throw, declared substitute ignored
expect(resolveI18nText(v, 'en', undefined, 'firstName', { policy:'null', substitute:['th'] })).toBeNull()
// caller fallback always wins, even under throw
expect(resolveI18nText(v, 'en', ['th'], 'firstName')).toBe('สมชาย')
// substitute exhausted → null
expect(resolveI18nText({}, 'en', undefined, 'f', { policy:'substitute', substitute:['th','any'] })).toBeNull()
// raw passthrough
expect(resolveI18nText(v, 'raw')).toEqual(v)
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement.** Add to `I18nTextOptions`: `readonly onMissing?: OnMissing | Partial<Record<Layer, OnMissing>>; readonly substitute?: readonly string[]`. Rewrite `resolveI18nText` to the 5th optional-arg signature with the semantics above. Return type widens to `string | Record<string,string> | null`. Keep a private `pickFromChain(value, chain)` helper handling `'any'`. **Null-widening (advisor):** the `| null` only occurs under new opt-in policies, but TS will flag existing callers — give `resolveI18nText` a function **overload** so the legacy 4-arg form keeps return type `string | Record<string,string>` (it can only throw or return, never null), and the 5-arg opts form returns `… | null`. Verify with `typecheck` at Step 4.
- [ ] **Step 4:** Run → PASS; also run existing `__tests__/i18n.test.ts` → PASS (no regression).
- [ ] **Step 5: Commit** `feat(hub/i18n): policy-aware resolveI18nText (substitute/null/throw)`

---

## Phase B — Wire the `read` layer (app-facing get/list)

### Task B1: `applyI18nLocale` honors per-field policy at layer 'read'

**Files:** Modify `src/i18n/core.ts` (`applyI18nLocale`, `applyAtPath`), `src/i18n/strategy.ts`; Test `__tests__/i18n-read-layer.test.ts`

- [ ] **Step 1: Failing test** through a real collection: define `firstName` i18nText with `required:'any', substitute:['en','th','any'], onMissing:{read:'substitute'}`; put `{th:'สมชาย'}`; `get` under active locale `en` returns `'สมชาย'`; a field with default policy still throws on missing locale.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement.** Thread `layer: Layer = 'read'` param into `applyI18nLocale(record, fields, locale, fallback, layer='read')` and `applyAtPath`. For each field, compute `policy = resolvePolicy(desc.options.onMissing, layer)` and call `resolveI18nText(raw, locale, fallback, path, { policy, substitute: desc.options.substitute })`. When result is `null`, set the field to `null` (don't drop the key). Update `I18nStrategy.applyI18nLocale` signature (append optional `layer`); `NO_I18N` stays identity.
- [ ] **Step 4:** Run → PASS; existing i18n tests PASS.
- [ ] **Step 5: Commit** `feat(hub/i18n): read-layer onMissing/substitute resolution on get/list`

---

## Phase C — Script enforcement (independent, resolves #283)

### Task C1: `ScriptViolationError`

**Files:** Modify `src/errors.ts`; Test `__tests__/i18n-script.test.ts` (start)

- [ ] **Step 1:** Failing test: `new ScriptViolationError('firstName','en',['Latin'],'ส').message` contains field, expected scripts, offending sample; `instanceof NoydbError`.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Add `ScriptViolationError extends NoydbError` mirroring `MissingTranslationError` shape (fields: `field`, `expected: readonly string[]`, `sample?: string`).
- [ ] **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(hub): ScriptViolationError`

### Task C2: script table + `validateI18nScript` (asymmetric Latin)

**Files:** Create `src/i18n/script.ts`; Test `__tests__/i18n-script.test.ts`

- [ ] **Step 1: Failing tests:**

```ts
// inferScripts(locale) — asymmetric Latin tolerance (#283)
expect(inferScripts('en')).toEqual(['Latin'])
expect(inferScripts('th')).toEqual(['Thai','Latin'])
expect(inferScripts('ja')).toEqual(['Han','Hiragana','Katakana','Latin'])
expect(inferScripts('th-Latn')).toEqual(['Latin'])
// validateI18nScript: Common (digits) always ok; Thai+embedded-Latin ok; Thai-in-en rejected
const desc = i18nText({ languages:['th','en'], required:'any', script:'auto' })
expect(() => validateI18nScript({ th:'9/9 อาคาร TCM ถนนรัชดาภิเษก' }, 'firstName', desc)).not.toThrow()
expect(() => validateI18nScript({ en:'สมชาย' }, 'firstName', desc)).toThrow(ScriptViolationError)
expect(() => validateI18nScript({ th:'สมชาย 2024' }, 'firstName', desc)).not.toThrow() // Latin digits = Common
// explicit tightening
const strict = i18nText({ languages:['th'], required:'any', script:{ th:['Thai'] } })
expect(() => validateI18nScript({ th:'อาคาร TCM' }, 'f', strict)).toThrow(ScriptViolationError)
// onScriptViolation:'filter' strips; 'warn' allows
```

- [ ] **Step 2:** FAIL.
- [ ] **Step 3: Implement** `src/i18n/script.ts`:
  - `LATIN_LOCALES` set + `inferScripts(locale)`: if locale or its `-Xxxx` subtag is Latin → `['Latin']`; Cyrl subtag → `['Cyrillic','Latin']`; else base-language table (`th→['Thai','Latin']`, `ja→['Han','Hiragana','Katakana','Latin']`, `ko→['Hangul','Han','Latin']`, `ar→['Arabic','Latin']`, `ru/uk→['Cyrillic','Latin']`, Latin-base langs `en/fr/de/es/it/pt/nl/...→['Latin']`). Always conceptually `+ Common` in the matcher.
  - `allowedFor(desc, locale)`: explicit `desc.options.script[locale]` if object; else `inferScripts(locale)`.
  - matcher: build `new RegExp(\`^[\\p{Script=Common}\\p{Script=Inherited}\\p{Mark}\\s${scripts.map(s=>`\\p{Script=${s}}`).join('')}]*$\`, 'u')`. **`Inherited`/`Mark` are always-on baseline alongside `Common`** — combining diacritics, joiners, Arabic harakat, Thai tone marks are `Script=Inherited`, NOT `Common`; omitting them false-rejects valid in-script text (advisor finding). Add tests: Thai tone-mark word `น้ำ` and an IPA-with-diacritics sample must PASS under their allowed scripts.
  - `validateI18nScript(value, field, desc)`: skip if `!desc.options.script`. For each locale slot string, test matcher; on violation honor `onScriptViolation`: `'reject'`(default)→throw `ScriptViolationError` (compute offending chars sample), `'filter'`→return a cleaned copy (strip disallowed), `'warn'`→return value + emit (return a `{ value, warnings }` tuple consumed by put). Provide both a throwing validate and a `applyScriptFilter` for the filter/warn paths.
  - Extend `I18nTextOptions`: `readonly script?: 'auto' | Partial<Record<string, readonly string[]>>; readonly onScriptViolation?: 'reject'|'filter'|'warn'`.
- [ ] **Step 4:** PASS (verify `\p{Script=...}` works under the repo's TS/node target; tsconfig `target` ≥ ES2018 + `u` flag — confirm).
- [ ] **Step 5: Commit** `feat(hub/i18n): per-locale script enforcement (asymmetric Latin, #283)`

### Task C3: wire `validateI18nScript` into `Collection.put`

**Files:** Modify `src/collection.ts` (put pipeline, beside `validateI18nTextValue`); Test extends C2 via a real put.

- [ ] **Step 1:** Failing test: put a record with `{en:'สมชาย'}` on a `script:'auto'` field → rejects with `ScriptViolationError`; valid Thai-with-Latin address puts fine; `filter` mode stores stripped value.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** In put, where i18n fields are validated, also call the i18n strategy's script validator (add `validateI18nScript` to `I18nStrategy` + `withI18n()`; `NO_I18N` no-op since fields require strategy anyway). For `filter`/`warn`, mutate/keep the record value before encryption.
- [ ] **Step 4:** PASS; existing tests PASS.
- [ ] **Step 5: Commit** `feat(hub): enforce i18n script on put`

---

## Phase D — Per-layer threading (guard / derivation / mv / export)

### Task D0 (GATE): spike whether MV/join resolution even has a call site

**Advisor finding:** query resolution is NOT automatic — caller passes `{locale}` at the chain terminal. So inside an MV's `query(db).groupBy('firstName')`, `firstName` may still be the raw `{locale:string}` map, never resolved — meaning `mv:'throw'` has **no call site to fire from**, and tagging a facade `layer:'mv'` does nothing. Guard/derivation reads DO have call sites (`facade → get() → applyLocaleToRecord(defaultLocale)`); MV/join are the suspects.

- [ ] **D0 spike:** write a throwaway test — an MV that `groupBy`s an i18nText field — and inspect whether the bucket key is a resolved string or the raw map. Also check the join expansion path. **Decision gate:**
  - If resolution already runs in MV/join → D2/D3 are small (just thread the layer tag).
  - If it does NOT → **do not invent resolution-injection under autonomy.** Land D1 (guard/derivation, real call sites) + A+B+C+E1–E3, and convert D2 (mv/export) and D3 (join) into documented follow-up tasks under milestone #17. A clean partial beats a forced aggregation-pipeline change.

### Task D1: layer-tagged `ReadOnlyVaultFacade`

**Files:** Modify `src/guards/read-only-facade.ts`, `src/guards/types.ts`, `src/vault.ts`; Test `__tests__/i18n-layers.test.ts`

- [ ] **Step 1: Failing tests:** a field `onMissing:{read:'substitute', mv:'throw', derivation:'null', guard:'substitute'}`, stored `{th:..}` only; a derivation reading `firstName` (en active) sees `null`; an MV bucketing on the en value throws on refresh; a guard reading it substitutes.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3: Implement.** Give `ReadOnlyVaultFacade` a `readonly layer: Layer` ctor arg (default `'read'`). Its `collection().get/list/query` inject `layer` into the resolution path (extend `LocaleReadOptions` with optional `_layer`, OR have the facade pass a layer-bearing option that `applyLocaleToRecord` reads). In `vault.ts`, construct distinct facades: guard-seeding → `layer:'guard'`, derivation-seeding → `layer:'derivation'`. (Keep the cached default-`read` facade for general use.)
- [ ] **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(hub/i18n): layer-tagged read facades (guard/derivation)`

### Task D2: MV refresh + export layers

**Files:** Modify MV executor (`src/materialized-views/executor.ts`) read context + `src/bundle/bundle.ts` / public-envelope export to pass `layer:'mv'` / `'export'`.

- [ ] **Step 1:** Failing test: MV query reading an i18n field resolves at layer `'mv'` (throws when policy says so); export/bundle resolves at `'export'`.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Thread the layer into the MV read context (the MV's `query(db)` uses a facade — give it `layer:'mv'`) and the export collapse (`pickLocale` path → policy at `'export'`).
- [ ] **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(hub/i18n): mv + export resolution layers`

### Task D3: join layer

**Files:** Modify `src/query/join.ts` expansion to resolve joined i18n fields at layer `'join'`.

- [ ] **Step 1:** Failing test: a join that expands a record with an i18n field, active locale missing → substitutes under `join:'substitute'`.
- [ ] **Step 2:** FAIL → **Step 3:** thread layer into join right-side record resolution → **Step 4:** PASS → **Step 5: Commit** `feat(hub/i18n): join resolution layer`

---

## Phase E — dictKey parity (Slice 3; depends on Phase A)

### Task E1: policy on `resolveLabel`

**Files:** Modify `src/i18n/dictionary.ts` (`DictKeyOptions`, `resolveLabel`); Test `__tests__/dictkey-policy.test.ts`

- [ ] **Step 1:** Failing tests: `resolveLabel` under `'null'` returns `undefined` (today's behavior); `'substitute'` walks declared `substitute`; `'throw'` raises `LocaleNotSpecifiedError`.
- [ ] **Step 2:** FAIL → **Step 3:** add `onMissing`/`substitute` to `DictKeyOptions`; in `resolveLabel`, compute policy (needs the layer — thread from the dictLabelResolver call in collection.ts, default `'read'`) and apply identical semantics to `resolveI18nText`. Reuse a shared `pickFromChain`. → **Step 4:** PASS → **Step 5: Commit** `feat(hub/i18n): dictKey resolveLabel honors onMissing/substitute`

### Task E2: array-of-keys → `[{key,label}]` pair objects

**Files:** Modify `src/collection.ts` dictKey label populator (`~3031`); Test extends E1.

- [ ] **Step 1:** Failing test: field `tags:['urgent','vip','x']` (x dangling) under `'null'` → `tagsLabel = [{key:'urgent',label:'..'},{key:'vip',label:null},{key:'x',label:null}]`; `'throw'` fails on first missing; `'substitute'` per-element.
- [ ] **Step 2:** FAIL → **Step 3:** in the populator, when `result[field]` is an array, map element-wise to pair objects (resolve each key's label under policy). When scalar string, keep current `<field>Label` string behavior. → **Step 4:** PASS → **Step 5: Commit** `feat(hub/i18n): dictKey array-of-keys → pair objects`

### Task E3: wildcard-path dictKey (`contacts[].title`, #282)

**Files:** Modify `src/collection.ts` populator to walk `[].` paths (reuse `getAtPath`/`applyAtPath` from core); Test extends E1.

- [ ] **Step 1:** Failing test: `dictKeyFields: { 'contacts[].title': dictKey('contactTitle',['mr','ms']) }`; put `contacts:[{name,title:'mr'},{name,title:'ms'}]`; get (th active) → each element gains `titleLabel:'คุณ'`, keeps `title`.
- [ ] **Step 2:** FAIL → **Step 3:** detect `[].` in field path; traverse arrays, set per-element sibling `<leaf>Label`. → **Step 4:** PASS → **Step 5: Commit** `feat(hub/i18n): wildcard-path dictKey resolution (#282)`

### Task E4: key-vs-label binding for groupBy/orderBy

**Files:** Modify `src/query/groupby.ts` / order path; Test `__tests__/dictkey-groupby.test.ts`

- [ ] **Step 1:** Failing test: `groupBy('title')` on a dictKey field buckets by KEY (mr≠ms, locale-independent); `orderBy('title',{by:'label'})` sorts by resolved label in active locale (Mr./Ms.→คุณ adjacent). Verify default is key.
- [ ] **Step 2:** FAIL → **Step 3:** teach groupBy/orderBy that a dictKey field defaults to key binding; add `{ by:'label' }` option resolving the label (active locale) for the sort/group key. Confirm current behavior already keys on stored key (likely) → make explicit + add label opt-in. → **Step 4:** PASS → **Step 5: Commit** `feat(hub/i18n): dictKey groupBy/orderBy key-vs-label binding`

---

## Phase F — Registry, docs, showcase, verification

- [ ] **F1:** Update `features.yaml` — register capability nodes for onMissing/substitute, script enforcement, dictKey parity (link spec + plan). Run the spec-coverage check (`pnpm ...` / the CI job script) → green.
- [ ] **F2:** Extend `docs/subsystems/` i18n section with the policy table, script model (asymmetric Latin), dictKey parity.
- [ ] **F3:** Add showcase under `showcases/src/`: bilingual person-name + honorific-on-`contacts[]` + Thai-address-with-Latin; exercise write/substitute-read/strict-MV-throw/lenient-guard/script-reject. Register in `features.yaml` if showcases are tracked there.
- [ ] **F4:** Full suite: `pnpm --filter @noy-db/hub test` + `pnpm --filter @noy-db/hub typecheck` + `pnpm lint` (or repo equivalents) → all green. Verify `NO_I18N` default bundle unaffected.
- [ ] **F5:** Open PR against `main` with `Closes #282`, `Closes #283`, milestone #17. (Do NOT merge — main is protected; leave for review.)

---

## Self-review

- **Spec coverage:** onMissing per-layer (A1,B1,D1-3) ✓; substitute (A2) ✓; script asymmetric-Latin (C2) ✓; onScriptViolation reject/filter/warn (C2,C3) ✓; error taxonomy (A2,C1) ✓; dictKey policy (E1) ✓; array pair-objects (E2) ✓; wildcard-path #282 (E3) ✓; key-vs-label #283-adjacent binding (E4) ✓; densifyOnWrite — deferred, not planned ✓; in-pinia reactive — companion, out of scope ✓.
- **Type consistency:** `OnMissing`/`Layer`/`resolvePolicy` defined in A1, reused everywhere; `resolveI18nText` 5-arg signature fixed in A2 and used by B1/E-shared.
- **Risk notes:** Phase D is the invasive one — if facade-layer threading proves deeper than D1-3 assume, land A+B+C and open the PR with D/E as follow-up tasks under the milestone. Confirm `\p{Script}` regex support against tsconfig target before C2.
