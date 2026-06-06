# @noy-db/in-pinia — reactive i18n binding — design

> The companion to the hub i18n hardening epic ([`2026-06-05-i18n-multilingual-field-hardening-design.md`](./2026-06-05-i18n-multilingual-field-hardening-design.md)). Hub is the pure synchronous resolution engine; this layer makes locale **reactive** in a Pinia/Vue app: a single reactive active-locale drives store re-reads and resolved selectors, so a consumer's UI becomes *language-agnostic* — flip the locale, everything re-renders resolved. Together they close the niwat "language-agnostic consumer" goal.

## Motivation

`@noy-db/in-pinia` already forwards `i18nFields`/`dictKeyFields` to collections, and ships a `useDictLabel` composable — but i18n is **not actually wired**: `defineNoydbStore` calls `c.list()` with no locale (so `store.items` hold raw `{th,en}` maps and unlabeled keys), `useDictLabel` is **not exported**, each call invents its own `ref('en')`, and there is **no shared reactive active-locale**. A consumer cannot flip one switch and have stores + labels re-render. This upgrade supplies the reactive spine and is the last piece before the lockstep release.

## What already exists (reused)

| Piece | File | Status |
|---|---|---|
| `defineNoydbStore` (items via `shallowRef` + `refresh()`/`list()`) | `src/defineNoydbStore.ts` | reads raw (`c.list()`, no locale) — to make locale-aware |
| `useDictLabel` (reactive label factory, watches a locale ref, `db.on('change')`) | `src/useDictLabel.ts` (+9 tests) | built, **not exported**, owns a private `ref('en')` — to export + bind to shared locale |
| `liveQuery` (wraps hub `LiveQuery.subscribe`) | `src/defineNoydbStore.ts` | raw — i18n resolution deferred (see scope-out) |
| active-instance binding | `src/context.ts` | reused |
| hub i18n surface: `resolveI18nText(map, locale, fb, field, {policy})`, `applyLocaleToRecord`, `<field>Label` on `get`/`list`, `vault.setLocale`/`getLocale`, `I18nMap` | `@noy-db/hub` / `@noy-db/hub/i18n` | shipped (PR #284) — **no new hub work** |

## Success criteria (acceptance)

- A single `useNoydbI18n().setLocale('th')` flips the language app-wide: every `i18n:'follow'` store re-reads resolved, every `useDictLabel`/`useI18nField` recomputes, and `vault.setLocale` is updated so imperative hub reads agree.
- `useNoydbI18n` can `bindTo(externalRef)` (e.g. vue-i18n's `locale`) — one-way follow, no second source of truth.
- `defineNoydbStore` accepts `i18n: 'follow' | 'raw' | { locale, fallback? }`; **default is `'follow'`** (resolved to the global locale).
- A `i18n:'raw'` store yields `{th,en}` maps unchanged, feeding a bilingual per-cell toggle (Case 1) — the components own the toggle, the store owns the raw data.
- `useDictLabel` is exported and defaults its locale to the shared `useNoydbI18n.locale`.
- `useI18nField(mapOrGetter, opts?)` returns a reactive `Ref<string | null>` resolving one i18nText map, following the global locale unless overridden.
- No breaking change for stores **without** i18n fields. Behavior change is limited to stores **with** `i18nFields`/`dictKeyFields` that don't set `i18n` (they now resolve instead of returning raw) — acceptable in the `0.2.0-pre` line and documented in MIGRATING.

## SCOPE — in

| Feature | In | Notes |
|---|:---:|---|
| `useNoydbI18n` Pinia store (`locale`, `fallback`, `setLocale`, `setFallback`, `bindTo`) | ✓ | `setLocale` also calls `vault.setLocale` on the active instance's open vaults |
| `defineNoydbStore` `i18n` option (`'follow'` default / `'raw'` / `{locale,fallback?}`) | ✓ | `'follow'` watches the global locale and re-reads `c.list({locale,fallback})` |
| Export `useDictLabel`; default its locale to `useNoydbI18n` | ✓ | otherwise unchanged; existing 9 tests stay green |
| `useI18nField(mapOrGetter, opts?)` reactive resolver (the reactive `pickLang`) | ✓ | `resolveI18nText(..., {policy:'null'})`; sync recompute on locale/source change |
| In-pinia i18n showcase | ✓ | global flip → re-resolve; `'raw'` store → bilingual toggle; field + dict label follow |
| `features.yaml` registration + MIGRATING note | ✓ | new exports + showcase |

## SCOPE — out (YAGNI / follow-ups)

| Feature | Why |
|---|---|
| `liveQuery` i18n resolution | Live queries are subscriptions; re-reading on locale change is a separate design, and client-side mapping would contradict the chosen re-read model. v1: live queries return raw; resolve in-component via `useI18nField`. Documented. |
| Fixing dict-mutation reactivity (dict `put()` bypasses the collection emitter) | Pre-existing hub limitation; `useDictLabel`'s workaround (locale change / re-create) stays. Tracked separately. |
| Per-store **independent** reactive locale machinery beyond `{locale: ref}` | The `{locale}` override already covers "this section is always TH". |
| Any hub change | This layer is purely a reactive wrapper over the shipped hub surface. |

## Architecture

```
            ┌─────────────────────────── useNoydbI18n (Pinia store) ──────────────────────────┐
            │  state: { locale: Ref<string>, fallback: Ref<string[]> }                          │
            │  actions: setLocale(l) · setFallback(c) · bindTo(externalRef)                      │
            └───────────────┬─────────────────────────────────────────────┬────────────────────┘
        setLocale(l):       │ watch(locale)                                 │ reads {locale,fallback}
          vault.setLocale(l)▼                                               ▼
   ┌──────────────────────────────────┐   ┌──────────────────────┐   ┌──────────────────────────┐
   │ defineNoydbStore(i18n:'follow')   │   │ useDictLabel(key)     │   │ useI18nField(mapOrGetter)│
   │  watch(locale) → refresh()        │   │  watch(locale) →      │   │  computed →              │
   │  c.list({locale,fallback})        │   │  resolveLabel(...)    │   │  resolveI18nText(...)    │
   │  → items: resolved strings        │   │  → Ref<string>        │   │  → Ref<string|null>      │
   └──────────────────────────────────┘   └──────────────────────┘   └──────────────────────────┘
   i18n:'raw' → c.list({locale:'raw'}) → items keep {th,en}  ──▶ bilingual component owns the toggle
```

### `useNoydbI18n` (`src/useNoydbI18n.ts`, new)
A `defineStore('noydb-i18n', ...)`:
- **state** `locale: string` (default `'en'`), `fallback: string[]` (default `['en','any']`).
- **`setLocale(l)`** — sets state; resolves the active Noydb (`resolveNoydb()`) and calls `vault.setLocale(l)` on each open vault so imperative reads agree.
- **`setFallback(chain)`** — sets the default fallback chain used by `'follow'` stores + composables.
- **`bindTo(ref, { immediate=true })`** — `watch`es an external `Ref<string>` and mirrors it into `locale` (one-way). Returns the stop handle.

### `defineNoydbStore` locale wiring (`src/defineNoydbStore.ts`, modify)
- Resolve the effective i18n mode: option `i18n` (default `'follow'`).
- `mode === 'follow'`: `const i18n = useNoydbI18n()`; `refresh()` reads `c.list({ locale: i18n.locale, fallback: i18n.fallback })`; add `watch(() => i18n.locale, refresh)` (and `i18n.fallback`). `liveQuery` unchanged (raw).
- `mode === 'raw'`: reads `c.list({ locale: 'raw' })`; no locale watch.
- `mode === { locale, fallback? }`: reads with the fixed/own-ref locale; if `locale` is a ref, watch it.
- Stores **without** any i18n/dictKey fields behave identically regardless (nothing to resolve), so the only observable change is for i18n-bearing stores — call this out in MIGRATING.

### `useDictLabel` (`src/useDictLabel.ts`, modify + export)
- Default `options.locale` to `useNoydbI18n().locale` (was `ref('en')`); default `options.fallback` to `useNoydbI18n().fallback`. All else unchanged. Add to `src/index.ts`.

### `useI18nField` (`src/useI18nField.ts`, new)
```ts
function useI18nField(
  source: Record<string,string> | (() => Record<string,string> | undefined),
  opts?: { locale?: string | Ref<string>; fallback?: string | readonly string[] },
): Ref<string | null>
```
A `computed` that reads the (optionally getter-wrapped, reactive) map and returns `resolveI18nText(map, locale, fallback, undefined, { policy: 'null' })` — locale/fallback default to `useNoydbI18n`. Pure, synchronous, recomputes on map or locale change. `null` when absent (never throws, never `undefined`).

## Error handling
- `useI18nField` uses `{policy:'null'}` → never throws; returns `null` for an absent locale with no fallback hit.
- `useDictLabel` keeps its `onMissing: 'key'|'empty'|'placeholder'` render policy.
- `setLocale` calling `vault.setLocale` is best-effort across open vaults; if no instance is bound yet it no-ops (the reactive state still updates; stores read it on next refresh).

## Testing
Vitest + happy-dom (existing). Per-unit tests with `ref()`/`effectScope()` (no component mount, matching the package):
- `useNoydbI18n`: `setLocale` updates state + calls `vault.setLocale`; `bindTo` follows an external ref.
- `defineNoydbStore`: `i18n:'follow'` store re-reads resolved on `setLocale`; `i18n:'raw'` keeps maps; `{locale}` pin ignores global; non-i18n store unchanged.
- `useDictLabel`: existing 9 tests stay green; new test for "defaults to global locale".
- `useI18nField`: resolves to global locale; recomputes on flip; `null` on miss; per-call override.
- Showcase (`showcases/src/95-in-pinia-i18n.showcase.test.ts`): the end-to-end flip.

## Integration & non-code obligations
- **`features.yaml`** — register the new exports/showcase under the in-pinia framework entry (CI "Spec coverage").
- **MIGRATING.md** — note the `defineNoydbStore` default-`'follow'` behavior change for i18n-bearing stores.
- **Release** — this is the last item before the lockstep `0.2.0-pre.8` bump (manual release PR; main protected).

## Build sequence (slices)
1. `useNoydbI18n` store + tests. *(no consumers yet — safe)*
2. `useI18nField` + tests. *(pure, depends on #1)*
3. Export `useDictLabel` + default it to the shared locale + test. *(small)*
4. `defineNoydbStore` `i18n` option + locale watch/re-read + tests. *(the behavior-changing slice)*
5. Showcase + `features.yaml` + MIGRATING note + full verification.
