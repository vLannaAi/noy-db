# i18n multilingual-field hardening (hub core / i18n) — design

> Extends the existing `i18nText` subsystem ([`packages/hub/src/i18n/core.ts`](../../../packages/hub/src/i18n/core.ts)) with **per-layer missing-value policy**, **declared substitute ordering**, and **per-locale script enforcement** — so that proper-name / multi-script identity fields are managed by noy-db with strong schema enforcement, instead of proliferating thousands of lines of brittle locale-handling in user land.
>
> **Foundation decision: extend in place, not rebuild.** Every capability lands as new *optional* fields on `I18nTextOptions`. Fields that don't opt in behave exactly as they do today — zero breaking change.

## Motivation — the practical issue

A person's first name is **mandatory**, but in a bilingual interface (assume `th`, `en`) the value is not a *translation* — it is a **proper name** written in one script. The library must answer questions that today have no first-class home and leak into application code:

- What is required on write? (both languages, one, or one-present-other-derivable?)
- On read in the active locale, if that locale's value is absent — substitute another language? return `null`? throw?
- With 3+ languages, is there a *preferred* substitute order?
- Must enforcement differ by **layer** — lenient at the store/guard boundary, strict inside a derivation or materialized view?
- For script-specific languages (Thai, Korean, Japanese, Arabic, Cyrillic…), can the field **reject the wrong script** in a slot (no Thai letters in the `en` slot) while still tolerating common usage (Latin digits inside Thai text)?

Solved in user land, each of these becomes per-call-site boilerplate with weak, inconsistent enforcement. Solved in noy-db, they become **field-level declarations** honored uniformly by every read/write path — the USP for any multi-language, and especially multi-script, deployment.

## What already exists (and is reused, not rebuilt)

| Capability | Where | Reused as |
|---|---|---|
| `{ [locale]: string }` storage + descriptor pattern | `i18n/core.ts` | unchanged storage shape |
| `required: 'all' \| 'any' \| string[]` write-time presence | `validateI18nTextValue()` | **the write-time presence floor** — independent of new `onMissing` |
| Single map→string collapse function | `resolveI18nText()` | **the one resolution choke point** every layer routes through |
| Caller fallback chain + `'any'` | `resolveI18nText()` | becomes the per-read override of the new declared `substitute` |
| `locale: 'raw'` escape hatch | `resolveI18nText()` | unchanged; bypasses all policy |
| Ambient active locale | `vault.setLocale()`, `openVault(name, { locale })`, `collection.defaultLocale` (`collection.ts:3018`) | "store in one language, `get` returns the active language" — **already built** |
| Write-time `autoTranslate` + `plaintextTranslator` hook | `core.ts` / `createNoydb` | unchanged; translation stays write-time only |
| Tree-shake seam | `i18n/strategy.ts` (`NO_I18N`) / `i18n/active.ts` (`withI18n()`) | all new code lives here; non-i18n bundles pay nothing |

## Success criteria (acceptance)

- A field can declare `onMissing` as a single policy **or a per-layer map**, and each read/validation path honors the policy for *its* layer.
- A field can declare an ordered `substitute` preference list (with `'any'` catch-all); a caller-supplied `fallback` overrides it per read.
- The driving trace passes (see § Worked example): write `{ th }` under `required:'any'`; `get`/`join` substitute; `mv` throws; `derivation` sees `null`; `guard` is lenient.
- A field can declare `script: 'auto'` (inferred per locale) or an explicit per-locale script set; values violating the allowed scripts are **rejected** by default at write, with `filter`/`warn` opt-outs.
- Latin digits inside a Thai value pass; Latin *letters* inside the `en` slot's wrong-script value (Thai text) are rejected.
- **No behavior change** for any existing `i18nText` field that does not set a new option. Conformance tests for current i18n behavior stay green.
- New code is fully inside the tree-shaken `withI18n()` strategy.

## v1 SCOPE — what's in

| Feature | In v1 | Notes |
|---|:---:|---|
| `onMissing: OnMissing \| Partial<Record<Layer, OnMissing>>` | ✓ | `OnMissing = 'substitute' \| 'null' \| 'throw'`; default `'throw'` (today's behavior) |
| `Layer = 'read' \| 'guard' \| 'join' \| 'mv' \| 'derivation' \| 'export'` | ✓ | No `store` key — writes governed by `required` (see § Layer taxonomy) |
| `substitute: readonly string[]` declared preference | ✓ | `'any'` = first non-empty; caller `fallback` overrides per-read |
| Route join / mv / derivation / export read paths through `resolveI18nText()` with a `Layer` tag | ✓ | The single-choke-point discipline is the core of the feature |
| `guard` layer defaults to lenient `'substitute'` | ✓ | Even when top-level `onMissing` is `'throw'`; overridable |
| `'substitute'` exhausted ⇒ `null` | ✓ | Best-effort by definition; not an error |
| `script: 'auto' \| Partial<Record<locale, Script[]>>` | ✓ | Absent ⇒ no check (backward-compat). `Common` always in baseline |
| BCP-47 lang→script inference table + `-Latn`/`-Cyrl` subtag awareness | ✓ | Small maintained table inside `withI18n()` |
| `onScriptViolation: 'reject' \| 'filter' \| 'warn'`, default `'reject'` | ✓ | New `ScriptViolationError`; validated write-time beside `validateI18nTextValue()` |
| `ScriptViolationError` distinct from `MissingTranslationError` / `LocaleNotSpecifiedError` | ✓ | Callers distinguish write-shape / read-hole / wrong-script |
| Subsystem doc + showcase | ✓ | Reader-facing; bilingual person-name end-to-end |

## v1 SCOPE — what's deferred

| Feature | Deferred to | Why |
|---|---|---|
| `densifyOnWrite?: boolean` (eager-fill empty slots from substitute at write) | v1.x | Changes stored bytes + provenance; mutually exclusive with strict-MV (a substituted copy is not a real translation). Clean as its own opt-in slice. |
| Nearest-script **smart** substitution (prefer same-or-readable script: Thai→Latin over CJK) | v2 | Strongest multi-script USP, but needs a richer script-relation map. Declared-list mechanism ships first; smart selection layers on top. |
| Lazy auto-translation **on read** | — (out) | Read stays pure/synchronous; network I/O + caching must not poison `get()`. Translation remains write-time `autoTranslate`. |
| Per-locale CRDT merge | — (out) | Already out of scope in current i18n; unchanged. |
| Pluralization, RTL, date/number formatting | — (out) | Rendering concerns; belong in the view layer. |
| Native-digits-only enforcement (reject Latin digits in Thai) | v2 | `Common` baseline permits Latin digits, which is the common-usage default. A strict `digits: 'native'` toggle can come later. |

## Architecture

### Where it sits

```
┌────────────────────────────────────────────────────────────────┐
│ Application                                                    │
│   people.collection('people', {                                │
│     i18nFields: { firstName: i18nText({                        │
│       languages: ['th','en'], required: 'any',                 │
│       substitute: ['en','th','any'],                           │
│       onMissing: { read:'substitute', join:'substitute',       │
│                    mv:'throw', derivation:'null' },            │
│       script: 'auto', onScriptViolation: 'reject',             │
│     }) } })                                                     │
└───────────────┬───────────────────────────────┬────────────────┘
        write path                        read paths (per layer)
                ▼                                 ▼
┌────────────────────────────┐   ┌──────────────────────────────────┐
│ Collection.put()           │   │ get/list  → Layer 'read'          │
│  ├ validateSchemaInput      │   │ join expand → Layer 'join'        │
│  ├ validateI18nTextValue ◄──┼─┐ │ MV input   → Layer 'mv'           │
│  │   (required floor)       │ │ │ deriv input→ Layer 'derivation'   │
│  └ validateI18nScript ◄─────┼─┤ │ guard read → Layer 'guard'        │
│      (NEW, write-time)      │ │ │ bundle/exp → Layer 'export'       │
└────────────────────────────┘ │ └──────────────┬───────────────────┘
                               │                ▼
                               │   ┌──────────────────────────────────┐
            withI18n() strategy└──►│ resolveI18nText(value, {          │
            (tree-shaken)          │   locale, layer, policy,          │
                                   │   substitute, callerFallback })   │
                                   │   ── the ONE choke point ──       │
                                   └──────────────────────────────────┘
```

### Resolution policy model

```ts
type OnMissing = 'substitute' | 'null' | 'throw'        // default 'throw'
type Layer = 'read' | 'guard' | 'join' | 'mv' | 'derivation' | 'export'

interface I18nTextOptions {
  readonly languages: readonly string[]
  readonly required: 'all' | 'any' | readonly string[]   // UNCHANGED — write-time floor
  readonly autoTranslate?: boolean                        // UNCHANGED

  // NEW — resolution policy
  readonly onMissing?: OnMissing | Partial<Record<Layer, OnMissing>>
  readonly substitute?: readonly string[]                 // ordered; 'any' = first non-empty

  // NEW — script enforcement
  readonly script?: 'auto' | Partial<Record<string, readonly Script[]>>
  readonly onScriptViolation?: 'reject' | 'filter' | 'warn'   // default 'reject'
}
```

**Effective policy resolution** for layer `λ`:

```
explicit(λ) = typeof onMissing === 'object' ? onMissing[λ] : undefined   // per-layer override only
scalar      = typeof onMissing === 'string' ? onMissing : undefined      // shared scalar policy

policy(λ)   = explicit(λ) ?? layerDefault(λ) ?? scalar ?? 'throw'

layerDefault('guard') = 'substitute'   // lenient unless EXPLICITLY overridden — never inherits a scalar
layerDefault(other)   = undefined      // non-guard layers inherit the scalar, else 'throw'
```

Consequences (all intentional):
- `onMissing: 'throw'` (scalar) ⇒ every layer throws **except** `guard`, which stays `'substitute'`. This is the R5 lenient-guard rule: a guard reading a display value must not hard-fail on a missing locale unless you ask it to (`onMissing: { guard: 'throw' }`).
- `onMissing: { read: 'substitute', mv: 'throw' }` (partial object) ⇒ listed layers use their value; `guard` ⇒ `'substitute'` (its default); every **other** unlisted non-guard layer (`join`, `derivation`, `export`) ⇒ `'throw'`. Per-layer opt-in is explicit; the safe default is strict.

### Resolution decision table

For a field resolved to target locale `L` in layer `λ`, with `p = policy(λ)`:

| State | `p = 'substitute'` | `p = 'null'` | `p = 'throw'` |
|---|---|---|---|
| `L` present (non-empty) | `value[L]` | `value[L]` | `value[L]` |
| `L` absent, substitute chain hits | first non-empty in `callerFallback ?? substitute` | `null` | **throw `LocaleNotSpecifiedError`** |
| `L` absent, chain exhausted | `null` | `null` | **throw `LocaleNotSpecifiedError`** |
| `locale: 'raw'` | full map (policy bypassed) | full map | full map |

- Caller `fallback` (passed to `get`/`list`/query terminal) **takes precedence** over the declared `substitute` list.
- `'substitute'` never throws — it degrades to `null` when nothing is available.
- `'throw'` is the default, preserving today's exact semantics for non-opting fields.

### Layer taxonomy — the `store` reconciliation

`onMissing` governs **resolution** (collapsing the map to a string when the target locale is absent), which only happens on **reads**. Write-time presence is a *separate* concern already owned by `required`. Therefore:

- There is **no `store` key** in the `onMissing` map. A write missing a non-required language is simply stored sparse; `required` decides whether the write is legal at all.
- The optional desire to *materialize* a substitute into empty slots at write time (so storage is dense and downstream layers never hit a hole) is the **deferred** `densifyOnWrite` boolean — separated because it changes stored bytes and provenance, and is **mutually exclusive with strict-MV** (an eager-filled `th` slot would make `mv:'throw'` on missing `th` unreachable).

### Script enforcement model

```ts
type Script =
  | 'Latin' | 'Thai' | 'Han' | 'Hiragana' | 'Katakana'
  | 'Hangul' | 'Arabic' | 'Cyrillic' | 'Common' | string  // Unicode script names
```

- Validation runs **write-time**, in `Collection.put()` beside `validateI18nTextValue()`, via a new `validateI18nScript(value, field, descriptor)` in the `withI18n()` strategy.
- Each provided locale slot's string is tested character-by-character (or via a compiled `RegExp` of allowed scripts) using `\p{Script=…}` with the `u` flag.
- **`Common` is always in the allowed baseline** — digits `0-9`, whitespace, and common punctuation are `Script=Common`, so Latin digits inside a Thai value pass while Latin *letters* in the `en`-expected `th` content are rejected. (Thai digits `๐-๙` are `Script=Thai`; allowed in Thai slots.)
- `script: 'auto'` derives the allowed set per locale from a built-in table:

  | Locale | Inferred allowed (+ `Common`) |
  |---|---|
  | `en`, `fr`, `de`, … (Latin langs) | `Latin` |
  | `th` | `Thai` |
  | `ko` | `Hangul`, `Han` |
  | `ja` | `Han`, `Hiragana`, `Katakana` |
  | `ar` | `Arabic` |
  | `ru`, `uk`, … | `Cyrillic` |
  | any `*-Latn` (e.g. `th-Latn`, `ja-Latn` romaji, IPA-style) | `Latin` (subtag wins) |
  | any `*-Cyrl` | `Cyrillic` (subtag wins) |

- `script: { en: ['Latin'], ja: ['Han','Hiragana','Katakana','Latin'] }` overrides per slot (e.g. a `ja` field that tolerates embedded Latin brand names).
- `onScriptViolation`:
  - `'reject'` (default) — throw `ScriptViolationError` naming the slot, expected scripts, and the offending characters; the write fails.
  - `'filter'` — strip disallowed characters before storing (resilient to messy paste; risk of silent loss — documented).
  - `'warn'` — store as-is and emit an `i18n:script-violation` diagnostic event (migration/audit mode).

### Error taxonomy

| Error | Raised at | Means |
|---|---|---|
| `MissingTranslationError` (exists) | write | `required` presence floor violated, or value not a `{ [locale]: string }` map |
| `LocaleNotSpecifiedError` (exists) | read | target locale absent and policy is `'throw'` with no usable substitute |
| `ScriptViolationError` (NEW) | write | a slot's string contains characters outside its allowed script set under `onScriptViolation: 'reject'` |

## Worked example (the driving trace)

Field `firstName`: `languages:['th','en']`, `required:'any'`, `substitute:['en','th','any']`,
`onMissing:{ read:'substitute', join:'substitute', mv:'throw', derivation:'null' }`, `script:'auto'`.

| Step | Input / context | Outcome |
|---|---|---|
| Write | `{ th: 'สมชาย' }` (no `en`) | passes `required:'any'`; `th` is valid Thai script ✅ |
| Write (bad script) | `{ en: 'สมชาย' }` | `ScriptViolationError` — `en` expects `Latin`, got `Thai` ✅ |
| Write (digits) | `{ th: 'สมชาย 2024' }` | passes — Latin digits are `Common` ✅ |
| `get`, active `en` | `en` absent → `read:'substitute'` → chain `en,th,any` | returns `'สมชาย'` (Thai shown to en reader — acceptable for a name) ✅ |
| `join` onto invoice, active `en` | `join:'substitute'` | `'สมชาย'` ✅ |
| `mv` bucketed by `en` name | `en` absent → `mv:'throw'` | **`LocaleNotSpecifiedError`** — MV refresh fails loudly ✅ |
| `derivation` reads `firstName.en` | `derivation:'null'` | derive fn receives `null`, branches explicitly ✅ |
| `guard` compares `firstName` | not in map → `layerDefault('guard') = 'substitute'` | `'สมชาย'`, guard does not hard-fail on a display hole ✅ |

## Build sequence (independently shippable slices)

1. **Resolution policy** — `onMissing` (per-layer) + `substitute`; thread a `Layer` tag through `resolveI18nText()` and every read path (read / join / mv / derivation / export / guard). Includes `LocaleNotSpecifiedError` reuse and the lenient-guard default. *(Slice 1)*
2. **Script enforcement** — `script` + `onScriptViolation` + `ScriptViolationError` + BCP-47 inference table + `validateI18nScript()`. *(Slice 2, independent of Slice 1)*
3. **`densifyOnWrite` eager-fill** — deferred; optional follow-on. *(Slice 3)*

## Integration & non-code obligations

- **`features.yaml`** — register the new capability nodes (spec ↔ artefact) or CI's "Spec coverage" job fails on dangling refs. Touch this in the implementation PR.
- **Subsystem doc** — extend `docs/subsystems/` i18n section with the policy table + script model.
- **Showcase** — add a bilingual person-name showcase under `showcases/src/` exercising the full worked trace (write, substitute read, strict-MV throw, lenient guard, script reject).
- **Conformance** — new behavior tested on `to-memory` and `to-file`; existing i18n conformance must stay green to prove zero-breaking-change.
- **Tree-shaking** — all new logic inside `withI18n()`; verify `NO_I18N` default bundle size is unchanged.

## Out-of-scope (restated)

Nearest-script smart substitution (v2), lazy on-read translation (out), per-locale CRDT merge (out), pluralization / RTL / formatting (out), native-digits-only enforcement (v2), `densifyOnWrite` (v1.x).
