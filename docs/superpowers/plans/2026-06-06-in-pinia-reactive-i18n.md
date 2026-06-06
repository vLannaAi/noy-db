# @noy-db/in-pinia reactive i18n — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. TDD throughout; commit per task.

**Goal:** Make locale reactive in a Pinia/Vue app over the shipped hub i18n surface — one reactive active-locale (`useNoydbI18n`) drives opt-in store resolution and reactive field/label selectors, so a consumer's UI is language-agnostic.

**Architecture:** A `useNoydbI18n` Pinia store holds the active locale (state-only by default; `vault.setLocale` is opt-in). `defineNoydbStore` gains an `i18n` option (default `'raw'` = today's behavior; `'follow'` re-reads `c.list({locale})` and re-reads on locale change). `useDictLabel` is exported and defaults to the shared locale; `useI18nField` is a new reactive `pickLang`. No hub changes.

**Tech Stack:** Vue 3, Pinia, Vitest + happy-dom. Spec: `docs/superpowers/specs/2026-06-06-in-pinia-reactive-i18n-design.md`. Milestone #17. Resolves #286.

**Non-breaking:** default `i18n:'raw'` means existing stores are untouched; resolution is strictly opt-in.

---

## File structure

| File | Responsibility | Slice |
|---|---|---|
| `src/useNoydbI18n.ts` (NEW) | `defineStore('noydb-i18n')` — `locale`, `fallback`, `setLocale(l,{syncVault?})`, `setFallback`, `bindTo(ref)` (state-only) | 1 |
| `src/useI18nField.ts` (NEW) | reactive `pickLang` — `computed` over `resolveI18nText(..., {policy:'null'})` | 2 |
| `src/useDictLabel.ts` (MOD) | default `locale`/`fallback` to `useNoydbI18n` | 3 |
| `src/defineNoydbStore.ts` (MOD) | `i18n: 'raw'|'follow'|{locale,fallback?}` option; locale-aware `refresh`/`add`/`remove`; `watch` under `'follow'` | 4 |
| `src/index.ts` (MOD) | export `useNoydbI18n`, `useI18nField`, `useDictLabel` + types | 1–4 |
| `__tests__/useNoydbI18n.test.ts` etc. (NEW) | unit tests per unit | 1–4 |
| `showcases/src/95-in-pinia-i18n.showcase.test.ts` (NEW) | end-to-end flip | 5 |
| `features.yaml`, `MIGRATING.md` (MOD) | registration + opt-in note | 5 |

Test harness (established): `setActivePinia(createPinia())`, inline `memory()` adapter, `createNoydb({store,user,secret,i18nStrategy:withI18n()})`, `setActiveNoydb(db)`, `effectScope()` for composables. Run: `pnpm --filter @noy-db/in-pinia exec vitest run <file>`.

---

## Slice 1 — `useNoydbI18n` store

**Files:** Create `src/useNoydbI18n.ts`, `__tests__/useNoydbI18n.test.ts`; Modify `src/index.ts`

- [ ] **Step 1: Failing tests**

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { ref } from 'vue'
import { useNoydbI18n } from '../src/useNoydbI18n.js'

beforeEach(() => setActivePinia(createPinia()))

it('defaults to en + [en,any]', () => {
  const i = useNoydbI18n()
  expect(i.locale).toBe('en')
  expect(i.fallback).toEqual(['en', 'any'])
})
it('setLocale updates state (state-only, no vault arg required)', () => {
  const i = useNoydbI18n()
  i.setLocale('th')
  expect(i.locale).toBe('th')
})
it('setFallback updates the chain', () => {
  const i = useNoydbI18n()
  i.setFallback(['th', 'any'])
  expect(i.fallback).toEqual(['th', 'any'])
})
it('bindTo mirrors an external ref one-way', () => {
  const i = useNoydbI18n()
  const ext = ref('ja')
  i.bindTo(ext)           // immediate
  expect(i.locale).toBe('ja')
  ext.value = 'th'
  expect(i.locale).toBe('th')
})
```

- [ ] **Step 2: Run → FAIL** (module missing). `pnpm --filter @noy-db/in-pinia exec vitest run __tests__/useNoydbI18n.test.ts`
- [ ] **Step 3: Implement** `src/useNoydbI18n.ts` (setup store):

```ts
import { defineStore } from 'pinia'
import { ref, watch, type Ref } from 'vue'
import { resolveNoydb } from './context.js'

export const useNoydbI18n = defineStore('noydb-i18n', () => {
  const locale = ref<string>('en')
  const fallback = ref<string[]>(['en', 'any'])

  /**
   * Set the active locale. State-only by default — in-pinia readers pass
   * {locale} explicitly, so the vault ambient locale is never required.
   * `syncVault: true` additionally calls vault.setLocale for non-in-pinia
   * imperative reads (footgun for locale-less vaults — opt-in only).
   */
  function setLocale(l: string, opts?: { syncVault?: boolean }): void {
    locale.value = l
    if (opts?.syncVault) {
      try {
        const db = resolveNoydb(null) as unknown as { openVaults?: () => Iterable<{ setLocale(l: string): void }> }
        for (const v of db.openVaults?.() ?? []) v.setLocale(l)
      } catch { /* no active instance yet — state still updated */ }
    }
  }
  function setFallback(chain: string[]): void { fallback.value = chain }

  /** One-way, state-only follow of an external locale ref (e.g. vue-i18n). */
  function bindTo(ref_: Ref<string>, opts?: { immediate?: boolean }): () => void {
    return watch(ref_, (v) => { locale.value = v }, { immediate: opts?.immediate ?? true })
  }

  return { locale, fallback, setLocale, setFallback, bindTo }
})
```

> **Verify during impl:** confirm the Noydb instance's open-vaults accessor name (grep hub for `openVaults`/`vaults`). If absent, change `syncVault` to accept an explicit `Vault | Vault[]`. `syncVault` is opt-in/secondary — don't block the slice on it; the state-only path (the default + all tests) is the contract that matters.

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5:** Add to `src/index.ts`: `export { useNoydbI18n } from './useNoydbI18n.js'`.
- [ ] **Step 6: Commit** `feat(in-pinia): useNoydbI18n reactive locale store (state-only; vault sync opt-in)`

---

## Slice 2 — `useI18nField` reactive resolver

**Files:** Create `src/useI18nField.ts`, `__tests__/useI18nField.test.ts`; Modify `src/index.ts`

- [ ] **Step 1: Failing tests**

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { ref } from 'vue'
import { useNoydbI18n } from '../src/useNoydbI18n.js'
import { useI18nField } from '../src/useI18nField.js'

beforeEach(() => setActivePinia(createPinia()))

it('resolves a map to the global locale and recomputes on flip', () => {
  const i = useNoydbI18n()
  const name = useI18nField({ th: 'สมชาย', en: 'Somchai' })
  expect(name.value).toBe('Somchai')   // default en
  i.setLocale('th')
  expect(name.value).toBe('สมชาย')
})
it('returns null on miss (policy null, never throws)', () => {
  const name = useI18nField({ th: 'สมชาย' }) // en active, no en, fallback en,any → th? fallback applies
  // fallback default ['en','any'] → 'any' picks th
  expect(name.value).toBe('สมชาย')
})
it('null when truly empty', () => {
  const name = useI18nField({})
  expect(name.value).toBeNull()
})
it('per-call locale override ignores global', () => {
  const i = useNoydbI18n(); i.setLocale('en')
  const th = useI18nField({ th: 'สมชาย', en: 'Somchai' }, { locale: 'th' })
  expect(th.value).toBe('สมชาย')
})
it('reactive getter source recomputes', () => {
  const src = ref<Record<string,string>>({ en: 'A' })
  const v = useI18nField(() => src.value)
  expect(v.value).toBe('A')
  src.value = { en: 'B' }
  expect(v.value).toBe('B')
})
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** `src/useI18nField.ts`:

```ts
import { computed, unref, isRef, type Ref } from 'vue'
import { resolveI18nText } from '@noy-db/hub/i18n'
import { useNoydbI18n } from './useNoydbI18n.js'

type MapSource =
  | Record<string, string>
  | (() => Record<string, string> | undefined | null)

export interface UseI18nFieldOptions {
  readonly locale?: string | Ref<string>
  readonly fallback?: string | readonly string[]
}

export function useI18nField(
  source: MapSource,
  opts: UseI18nFieldOptions = {},
): Ref<string | null> {
  const i18n = useNoydbI18n()
  return computed<string | null>(() => {
    const map = typeof source === 'function' ? source() : source
    if (!map || typeof map !== 'object') return null
    const locale = opts.locale !== undefined ? unref(opts.locale) : i18n.locale
    const fallback = opts.fallback ?? i18n.fallback
    const out = resolveI18nText(map as Record<string, string>, locale, fallback, undefined, { policy: 'null' })
    return typeof out === 'string' ? out : null   // 'raw' (object) can't occur with a real locale
  })
}
```

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5:** `src/index.ts`: `export { useI18nField } from './useI18nField.js'; export type { UseI18nFieldOptions } from './useI18nField.js'`.
- [ ] **Step 6: Commit** `feat(in-pinia): useI18nField reactive i18nText resolver (pickLang)`

---

## Slice 3 — export + default-locale `useDictLabel`

**Files:** Modify `src/useDictLabel.ts`, `src/index.ts`; Test `__tests__/useDictLabel.test.ts` (extend)

- [ ] **Step 1: Failing test** (new case appended to existing file — all 9 existing tests must keep passing):

```ts
it('defaults its locale to the shared useNoydbI18n', async () => {
  setActivePinia(createPinia())               // ensure store available
  const i = useNoydbI18n()
  // dict 'invoiceStatus' seeded with { en:'Paid', th:'ชำระแล้ว' } in the harness
  const label = useDictLabel('invoiceStatus', { vault })   // no locale passed
  const paid = label('paid')
  await nextTick()
  expect(paid.value).toBe('Paid')             // follows global default 'en'
  i.setLocale('th')
  await nextTick()
  expect(paid.value).toBe('ชำระแล้ว')          // recomputes on global flip
})
```

- [ ] **Step 2: Run → FAIL** (current default is a private `ref('en')`, won't follow the store).
- [ ] **Step 3: Implement.** In `src/useDictLabel.ts` `normaliseLocale` / option defaults: when `options.locale === undefined`, use `useNoydbI18n().locale`-backed ref instead of `ref('en')`; when `options.fallback === undefined`, use `useNoydbI18n().fallback`. Keep the existing `watch(localeRef, …)` (now watches the store-backed ref). Concretely:

```ts
import { useNoydbI18n } from './useNoydbI18n.js'
// …
function normaliseLocale(locale: UseDictLabelOptions['locale']): Ref<string> {
  if (locale === undefined) {
    const i18n = useNoydbI18n()
    return toRef(i18n, 'locale')          // reactive, follows the store
  }
  if (typeof locale === 'string') return ref(locale)
  return locale
}
const fallback = options.fallback ?? useNoydbI18n().fallback
```
(Import `toRef` from vue. `useNoydbI18n()` requires an active Pinia — the composable already runs in a setup/effect context, so this holds; document that.)

- [ ] **Step 4: Run → PASS**; re-run the whole file → all existing 9 tests PASS.
- [ ] **Step 5:** `src/index.ts`: `export { useDictLabel } from './useDictLabel.js'; export type { UseDictLabelOptions } from './useDictLabel.js'`.
- [ ] **Step 6: Commit** `feat(in-pinia): export useDictLabel; default its locale/fallback to useNoydbI18n`

---

## Slice 4 — `defineNoydbStore` i18n option (default 'raw')

**Files:** Modify `src/defineNoydbStore.ts`; Test `__tests__/defineNoydbStore.test.ts` (extend)

- [ ] **Step 1: Failing tests**

```ts
// store with i18nFields: firstName i18nText({languages:['th','en'], required:'any'})
it("default ('raw') keeps {th,en} maps (non-breaking)", async () => {
  setActivePinia(createPinia())
  const store = useStore()                       // no i18n option
  await store.$ready
  expect(store.items[0]?.firstName).toEqual({ th: 'สมชาย', en: 'Somchai' })
})
it("i18n:'follow' resolves to the global locale and re-reads on flip", async () => {
  setActivePinia(createPinia())
  const i = useNoydbI18n(); i.setLocale('en')
  const store = useFollowStore()                 // defineNoydbStore(..., { i18n:'follow' })
  await store.$ready
  expect(store.items[0]?.firstName).toBe('Somchai')
  i.setLocale('th')
  await flushPromises()                          // watch → async refresh
  expect(store.items[0]?.firstName).toBe('สมชาย')
})
it("i18n:{locale:'th'} pins regardless of global", async () => {
  setActivePinia(createPinia())
  const i = useNoydbI18n(); i.setLocale('en')
  const store = usePinnedStore()                 // { i18n: { locale: 'th' } }
  await store.$ready
  expect(store.items[0]?.firstName).toBe('สมชาย')
})
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.**
  1. Add to `NoydbStoreOptions<T>`: `i18n?: 'raw' | 'follow' | { locale: string | Ref<string>; fallback?: string | readonly string[] }`.
  2. In the store setup, resolve the read options + optional locale source:

```ts
// near top of the setup body
const i18nMode = options.i18n ?? 'raw'
const i18nStore = i18nMode === 'follow' ? useNoydbI18n() : null
function localeOpts(): { locale: string; fallback?: string | readonly string[] } {
  if (i18nMode === 'raw') return { locale: 'raw' }
  if (i18nMode === 'follow') return { locale: i18nStore!.locale, fallback: i18nStore!.fallback }
  const l = i18nMode.locale
  return { locale: typeof l === 'string' ? l : l.value, ...(i18nMode.fallback ? { fallback: i18nMode.fallback } : {}) }
}
```
  3. Pass `localeOpts()` to all three reads: `refresh()` → `c.list(localeOpts())`; `add()`/`remove()` re-list → `c.list(localeOpts())`.
  4. Re-read on locale change (follow + ref-pinned):

```ts
if (i18nMode === 'follow') {
  watch(() => [i18nStore!.locale, i18nStore!.fallback], () => { void refresh() })
} else if (typeof i18nMode === 'object' && isRef(i18nMode.locale)) {
  watch(i18nMode.locale, () => { void refresh() })
}
```
  Import `watch`, `isRef` from vue; `useNoydbI18n` from `./useNoydbI18n.js`. `liveQuery` is unchanged (raw) — out of scope per spec.

- [ ] **Step 4: Run → PASS**; re-run the whole `defineNoydbStore.test.ts` → all existing tests PASS (default `'raw'` ≡ old `c.list()` for a locale-less vault; verify the existing i18n-forwarding test still sees maps).
- [ ] **Step 5:** export the new option type if needed (it's part of `NoydbStoreOptions`, already exported).
- [ ] **Step 6: Commit** `feat(in-pinia): defineNoydbStore i18n option (raw default; follow re-reads on locale change)`

---

## Slice 5 — showcase, features.yaml, MIGRATING, verification

- [ ] **Step 1:** Create `showcases/src/95-in-pinia-i18n.showcase.test.ts` — set up pinia + a noydb with `withI18n()`, seed a person with `{th,en}` name and a dict; assert: (a) `i18n:'follow'` store resolves + re-resolves after `setLocale('th')`; (b) default `i18n:'raw'` store keeps the `{th,en}` map (feeds a bilingual toggle); (c) `useI18nField` + `useDictLabel` follow the flip. Model imports/harness on `showcases/src/38-in-pinia.showcase.test.ts` + `94-with-i18n-hardening`.
- [ ] **Step 2:** Run the showcase → PASS (build in-pinia first if it resolves to dist: `pnpm --filter @noy-db/in-pinia build`).
- [ ] **Step 3:** Register in `features.yaml` under the in-pinia framework entry: add showcase `95-in-pinia-i18n` + invariants (reactive `useNoydbI18n`; `defineNoydbStore` default `'raw'`, opt-in `'follow'`; `bindTo`/`setLocale` state-only, `syncVault` opt-in; `useI18nField`/`useDictLabel` follow global). Run `node scripts/validate-features.mjs` → OK.
- [ ] **Step 4:** Add a MIGRATING.md note: in-pinia i18n is non-breaking (default `'raw'`); opt into `i18n:'follow'` for display-only stores; keep map/identity/export stores `'raw'`; locale-less vaults use `bindTo`/state-only `setLocale`, avoid `syncVault` (#286).
- [ ] **Step 5:** Full verification:
  - `pnpm --filter @noy-db/in-pinia test` → all green (existing + new)
  - `pnpm --filter @noy-db/in-pinia typecheck` + `lint` → clean
  - `pnpm --filter @noy-db/in-pinia build` → ok (new exports in dist)
  - the new showcase passes; `node scripts/validate-features.mjs` OK
- [ ] **Step 6: Commit** `feat(in-pinia): showcase 95 + features.yaml + MIGRATING (reactive i18n)` and push (updates the branch).

---

## Self-review

- **Spec coverage:** `useNoydbI18n` (S1) ✓; state-only `setLocale`/`bindTo` + `syncVault` opt-in (S1) ✓; `useI18nField` (S2) ✓; export+default `useDictLabel` (S3) ✓; `defineNoydbStore` `i18n` default `'raw'`/`'follow'`/`{locale}` + re-read (S4) ✓; liveQuery deferred (noted) ✓; showcase + features.yaml + MIGRATING #286 (S5) ✓; no hub changes ✓.
- **Type consistency:** `useNoydbI18n` returns `{ locale, fallback, setLocale, setFallback, bindTo }` — used identically in S2/S3/S4. `i18n` option union matches across S4 + spec. `useI18nField(source, opts)` signature stable.
- **Risk:** `syncVault`'s open-vaults accessor is unverified — flagged inline; default state-only path (the contract) is unaffected. `useDictLabel` default-locale change must keep all 9 existing tests green — explicit in S3 Step 4.
