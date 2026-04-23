# Issue #82 — feat(core): i18nText schema type — multi-language content fields with locale fallback

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-07
- **Closed:** 2026-04-09
- **Milestone:** v0.8.0
- **Labels:** type: feature, area: core

---

## Target package

`@noy-db/core`

## Spawned from

Discussion vLannaAi/noy-db#78. Part of the v0.8 i18n epic. Independent of vLannaAi/noy-db#81 (`dictKey`) — they ship together but neither blocks the other.

## Problem

Per-record prose — invoice notes, product descriptions, line-item descriptions, article bodies — needs to exist in N languages **per record**. The dictionary model from #81 doesn't fit because the values aren't shared across records.

Today consumers solve this with parallel fields (`description`, `description_en`, `description_th`) that silently lose translations on write — there's no schema-level enforcement that "all declared languages must be present" or "Thai is required, English is optional."

## Proposed solution

A new schema type whose value is a `{ [locale]: string }` map, with declarative enforcement and read-time resolution.

```ts
const LineItem = z.object({
  id: z.string(),
  amount: z.number(),
  description: i18nText({
    languages: ['en', 'th'],
    required: 'all',                 // 'all' | 'any' | ['en']
  }),
})

// Write — strict mode requires all declared languages
await lineItems.put('li-1', {
  id: 'li-1',
  amount: 1000,
  description: { en: 'Consulting hours', th: 'ค่าที่ปรึกษา' },
})
// → MissingTranslationError if 'th' is missing in 'all' mode

// Read with declarative locale fallback
const li = await lineItems.get('li-1', { locale: 'th', fallback: 'en' })
// → { id: 'li-1', amount: 1000, description: 'ค่าที่ปรึกษา' }

// Raw mode for consumers that need every language at once
const raw = await lineItems.get('li-1', { locale: 'raw' })
// → { id: 'li-1', amount: 1000, description: { en: '...', th: '...' } }
```

### Enforcement modes

| `required` | Behavior at `put()` time | Behavior at read time |
|---|---|---|
| `'all'` | Every declared language must be present. Missing → `MissingTranslationError`. | Resolves to caller's locale; throws if missing (since strict put guarantees presence). |
| `'any'` | At least one declared language must be present. | Resolves to caller's locale; falls back per the chain; throws only if every language in the chain is missing. |
| `['en']` (list) | Listed languages required, others optional. | Same as `'any'` — fallback chain handles the optional languages. |

### Read modes

- **`{ locale: 'th' }`** — resolve to Thai, throw if missing and no fallback
- **`{ locale: 'th', fallback: 'en' }`** — resolve to Thai, fall back to English, throw if both missing
- **`{ locale: 'th', fallback: ['en', 'any'] }`** — fall back to English, then to "any present language", deterministic order
- **`{ locale: 'raw' }`** — return the full `{ [locale]: string }` map, no resolution
- **No `locale` option** — uses the per-open compartment locale (set via `openCompartment(id, { locale })`); throws `LocaleNotSpecifiedError` if neither is set and the field is read

### Schema validation

- Runs through the existing v0.4 Standard Schema pipeline, before encryption on `put()` and after decryption on read
- Adding a language to the schema retroactively produces validation errors on old records — caught at read time, same as any other schema drift

## Out of scope (named explicitly to prevent future surprise)

These are the consumer's UI layer's job, not noy-db's. Stating them here so nobody expects them later:

- **Pluralization** (ICU MessageFormat `one`/`other`/`few`/`many`). `i18nText` returns one string per locale. Plural variants are the templating layer's job.
- **Date / number / currency formatting.** `Intl.*` in the consumer's UI layer.
- **RTL/LTR rendering.** Locales are opaque BCP 47 codes to noy-db; rendering is the UI layer's job.
- **Sorting collation.** When `query().orderBy('description')` runs over an `i18nText` field, the comparator uses **`Intl.Collator(callerLocale)` after decryption**. Sorting by an unspecified locale would be a heisenbug; sorting by the writer's locale would be wrong for any cross-locale query. Documented + tested in v1, no other special-case behavior.
- **Per-locale CRDT merging in sync.** v0.8 ships with whole-field LWW. Per-locale merging is gated on v0.9 sync v2 and is not part of this issue.

## Acceptance

- [ ] `i18nText({ languages, required })` schema type with `'all'` / `'any'` / `string[]` enforcement modes
- [ ] `MissingTranslationError` thrown on `put()` when strict mode is violated
- [ ] Per-call `{ locale, fallback }` options on `get`, `list`, `query`, `scan`
- [ ] Raw mode (`{ locale: 'raw' }`) returning the full language map
- [ ] Compartment-default locale via `openCompartment(id, { locale })`
- [ ] `LocaleNotSpecifiedError` when neither call-level nor open-level locale is set
- [ ] `Intl.Collator(callerLocale)` used by `orderBy()` on `i18nText` fields, documented
- [ ] Tests covering all three enforcement modes, raw mode, fallback chain (single + multi-step + 'any'), missing-locale errors, schema validation on put + read, and `orderBy` collation
- [ ] Out-of-scope statements (pluralization, RTL, formatting, per-locale CRDT) included in the JSDoc and the package README so consumers don't expect them
- [ ] Changeset (`@noy-db/core: minor`)

## Invariant compliance

- [x] Adapters never see plaintext — `i18nText` fields are part of the same encrypted record envelope
- [x] No new runtime crypto dependencies
- [x] 6-method adapter contract unchanged
- [x] KEK never persisted; DEKs never stored unwrapped
- [x] Zero new external dependencies

v0.8.0 milestone. Independent of #81 — both can land in the same release.
