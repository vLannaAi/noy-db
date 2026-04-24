# Pattern — i18n boundaries: what hub knows vs what you own

> **TL;DR** — `@noy-db/hub` is *content-agnostic*. It knows the **shape**
> of multi-locale data (i18nText fields, dictionaries, dictKey
> descriptors) and it knows how to **store** and **resolve** it, but it
> never inspects *what* the content says. Translation, full-text
> search, locale-aware sorting, fiscal calendars — all userland.
>
> This doc names the boundary so adopters stop asking hub to do things
> hub will never do, and start reaching for the right ecosystem package
> or writing small userland code.

---

## Three layers

All i18n / locale concerns in a noy-db deployment fall into one of
these three layers. The layer determines where the code lives.

| Layer | What it knows | Where it lives |
|-------|---------------|----------------|
| **1. Shape** | Multi-locale data has N slots; which locales are required; how to resolve a locale map to a single value; what's a stable identity vs a render-time label | `@noy-db/hub/i18n` subpath |
| **2. Content** | The actual translated strings. What Thai looks like. Whether "สวัสดี" is a valid translation of "Hello". What language this string is in. | **Userland** (your app code) — bridged into hub via the `plaintextTranslator` hook |
| **3. Locale-specific logic** | Thai fiscal calendar · BE year conversion · RTL handling · plural rules · locale-aware collation · stemming · currency glyphs · stop words · phonetic matching | **Userland** — adopters build their own helpers or use general-purpose libraries (`date-fns`, `dayjs`, `Intl.*`). noy-db deliberately does not ship market-specific `locale-*` packages. |

Hub touches layer 1 only. Every language-specific function adopters
might reach for is layer 2 or 3.

---

## Where each noy-db primitive sits

### `i18nText` fields — layer 1

```ts
vault.collection<Invoice>('invoices', {
  i18nFields: {
    description: i18nText({ languages: ['en', 'th', 'ar'], required: 'all' }),
  },
})
```

Hub's responsibilities:
- **Validate shape at put time** — reject if a required locale is missing.
- **Store the locale map** — every locale's string ends up inside the
  encrypted envelope as a plain object key-value map.
- **Resolve at read time** — given a requested locale, return the
  right string (with configurable fallback).

Hub's *non*-responsibilities:
- Verifying that `labels.th` actually contains Thai characters (layer 2).
- Auto-translating missing locales (layer 2 — opt-in via
  `plaintextTranslator`).
- Normalising / stemming / case-folding strings (layer 3).

### `DictionaryHandle` + `dictKey` — layer 1

```ts
vault.dictionary('status').putAll({
  draft: { en: 'Draft', th: 'ฉบับร่าง', ar: 'مسودة' },
  paid:  { en: 'Paid',  th: 'ชำระแล้ว',  ar: 'مدفوع' },
})

vault.collection<Invoice>('invoices', {
  dictKeyFields: {
    status: dictKey('status', ['draft', 'paid'] as const),
  },
})
```

Dictionaries are just **another encrypted collection** with a reserved
`_dict_*` name. The per-entry labels map is layer-1 shape; the
**content of each label** (the string itself) is layer 2.

The critical invariant: the record field `status` stores the STABLE
KEY (`'paid'`) — not a localised label. Every operation on the record
— query, groupBy, FK join — works off the key, not the label. Labels
are render-time only.

### Queries — layer 1

```ts
invoices.query()
  .where('status', '==', 'paid')            // stable key, not localised
  .where('extracted.total', '>', 1000)
  .orderBy('amount', 'desc')
  .groupBy('clientId')
  .toArray()
```

- `.where(field, op, value)` — symbolic operator, raw value comparison.
- `.orderBy(field, direction)` — uses `compareValues`:
  numbers numeric, dates chronological, **strings byte-compared
  (code-point order, not locale-aware)**. Verified in
  `packages/hub/src/query/builder.ts` line 827:
  `a < b ? -1 : a > b ? 1 : 0`. No `localeCompare`, no `Intl.Collator`.
- `.groupBy(field)` — buckets by raw field value. When the field is a
  `dictKey`, buckets are **stable across locales** because the key
  doesn't change when the label does.
- `.join(field, { as })` — FK resolution by id match.

Everything in the query executor is content-agnostic. The downstream
consequence: **if you need Thai-collated sort, Arabic-RTL-aware
grouping, or full-text relevance, you do that in userland** — pull
the records into memory and post-process.

### `plaintextTranslator` hook — THE boundary

This is the one line in hub where userland-supplied logic runs over
plaintext content. Consumer provides a function; hub invokes it,
caches the result, writes an audit entry:

```ts
createNoydb({
  store: ...,
  plaintextTranslator: async ({ text, from, to, field, collection }) => {
    const translated = await myLLM.translate(text, { from, to })
    return translated
  },
})
```

Hub's responsibilities:
- Invoke the hook when an `i18nText` field has `autoTranslate: true`
  and a required locale is missing.
- Cache results (keyed by `field + from + to + text`) so the hook
  fires once per unique text.
- Write an audit entry to the ledger (field + collection + mechanism +
  timestamp — **never content hashes**, per SPEC.md non-correlation
  design).
- Clear the cache on `db.close()`.

Hub's *non*-responsibilities:
- Ship any default translator (no SDK dependencies, PRs rejected).
- Retry on translator failure (userland decides).
- Validate output language (userland decides).
- Detect input language (userland decides).

The hook is the **explicit** boundary line. Everything inside it is
hub's job; everything the hook calls out to is userland.

---

## The stable-key invariant

The content-agnostic guarantee rests on one design rule that runs
through every layer-1 primitive:

> **Identity is stable across locales. Labels are render-time.**

Concretely:
- `Collection` record ids are opaque strings — never localised.
- `dictKey` fields store the stable key (`'paid'`) — never the
  label (`'Paid'` / `'ชำระแล้ว'`).
- Query operators compare stable keys, not labels.
- FK refs (`ref()`) target record ids, not display names.
- GroupBy buckets by stable keys, so bucket counts are identical
  whether you render in English or Thai.

A consumer who follows this rule gets a deployment that runs the same
way in every locale. A consumer who puts localised strings into
identity fields (`id: 'สวัสดี'`) is opting out of this guarantee and
accepts the consequence (queries break when the label changes, FKs
dangle when a translator revises the string).

**The one documented exception.** Plaintext exports (`@noy-db/as-xlsx`
and the wider `as-*` family) deliberately resolve `dictKey` values to
locale labels on the way out — the spreadsheet's `status` column
renders `"Paid"` / `"ชำระแล้ว"` not `"paid"`. This is a
render-time transform at the egress boundary, not a breach of the
invariant: the record still stores `"paid"`, queries still compare
stable keys, only the exported bytes carry labels. See
[`docs/patterns/as-exports.md`](./as-exports.md) §"Multi-sheet,
dictionary-expanded Excel".

---

## What userland does

Below the boundary, everything that "feels" language-aware. A sampler:

| Need | Where it lives | How |
|------|----------------|-----|
| Full-text search over OCR text | Userland | Decrypt records, run JS `.includes()` / Lunr / FlexSearch / MiniSearch in-memory. Hub can't help — the in-memory cache is the index. |
| Thai / Arabic / Chinese collation | Userland | Wrap `orderBy` output with `Intl.Collator('th').compare` in post-processing, or pass a custom comparator if the ecosystem gets one. |
| Locale-aware date formatting (BE year) | Userland | `Intl.DateTimeFormat('th-TH-u-ca-buddhist')` + hand-rolled BE-year + fiscal-deadline helpers. |
| Plural rules | Userland | `Intl.PluralRules`. |
| RTL text direction for HTML rendering | Userland | CSS `dir="auto"` / `Intl.Locale.textInfo`. |
| Translation — bulk / on-demand | Userland | Pass a `plaintextTranslator` into `createNoydb` (DeepL, GPT, local LLM, human queue). |
| Language detection | Userland | Browser `Intl.DisplayNames` / tinyld / heuristic before calling the translator. |
| Phonetic matching / stemming | Userland | Lunr has stemmers; Elasticsearch-lite libraries like FlexSearch. Run post-decrypt. |
| Stop words | Userland | Language-specific word lists; userland filters. |

---

## The three places hub *looks* language-aware but isn't

I checked each carefully — all content-agnostic:

### 1. `resolveI18nText(value, locale, fallback)`

Iterates the locale map in insertion order. The `'any'` fallback
returns the first present entry — no language priority hardcoded. The
locale-list fallback order is user-supplied.

```ts
resolveI18nText({ en: 'Hello' }, 'th', 'any')      // 'Hello'
resolveI18nText({ en: 'Hello' }, 'th', ['jp', 'en']) // 'Hello'
resolveI18nText({ en: 'Hello', th: 'สวัสดี' }, 'raw') // full map
```

Hub never decides "Thai is closer to English than Japanese". The
adopter-supplied fallback list makes that judgement.

### 2. `DictionaryHandle.list()` and `snapshotEntries()`

Returns entries in the adapter's native order (typically insertion).
The snapshot used for dict-joins doesn't sort by label — it sorts by
**key** (insertion). Language-independent.

### 3. Error messages

Hub ships errors in English. The `code` field on every `NoydbError`
subclass is stable (`NO_ACCESS`, `DICT_KEY_MISSING`, …) so consumers
can localise messages in userland. Hub will never ship translated
error text — that's userland's concern.

---

## Consequences for the ecosystem

This boundary has three downstream effects on how we structure the
project:

### 1. Locale-specific logic lives in userland, not in noy-db

Thai fiscal helpers (BE-year conversion, RD deadlines), Japanese
Reiwa-era date formatting, German VAT-period rules — all of this is
Layer 3. Hub stays universal; **noy-db deliberately ships no
market-specific `locale-*` packages**. An early attempt to publish
`@noy-db/locale-th` was withdrawn (issue #245) because the package
was pure date-math with no dependency on hub, making it structurally
indistinguishable from a general-purpose date utility — no value was
added by the `@noy-db/` scope, and shipping it would have implied a
maintenance commitment to future `locale-jp` / `locale-eu-gdpr` / …
packages that noy-db maintainers cannot realistically support across
every market.

Adopters with market-specific needs build their own helpers in
userland, or use established general-purpose libraries (`date-fns`,
`dayjs`, `Intl.*`). Community-published packages remain welcome — just
not under the `@noy-db/` scope.

### 2. Tree-shaking is already free

`@noy-db/hub/i18n` is already a subpath export (v0.15.1 refactor).
English-only apps pay no bundle cost for the multi-locale machinery.
This works *because* hub is content-agnostic — there's no hidden
locale-specific code buried in other hub modules that dependency-walks
back to i18n.

### 3. The `plaintextTranslator` hook is a commitment device

As long as hub doesn't ship a default translator, the content-agnostic
promise holds. The README explicitly rejects PRs that add translator
SDKs. This boundary is **defended by policy**, not just by current
implementation — worth preserving as the package grows.

---

## Cross-references

- **[`docs/guides/topology-matrix.md`](../topology-matrix.md)** — multi-locale showcase (#14) exercises the i18nText + dictionary primitives end-to-end.
- **[`docs/patterns/email-archive.md`](./email-archive.md)** — composite entities; email bodies in multi-locale settings apply the same layer-1 / layer-2 split.
- **[`SPEC.md`](../../SPEC.md) — "What zero-knowledge does and does not promise"** — the `plaintextTranslator` section is the authoritative definition of the boundary. This pattern doc is the practitioner companion.
- **Issue #245** — `@noy-db/locale-th` proposal (withdrawn) — historical record of why market-specific packages live in userland, not under the `@noy-db/` scope.

---

*Pattern doc last updated: 2026-04-23.*
