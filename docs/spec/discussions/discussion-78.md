# Discussion #78 — i18n as a first-class primitive: normalized dictionary keys + multi-lang content fields + translator hook

- **Category:** Ideas
- **Author:** @vLannaAi
- **Created:** 2026-04-07
- **State:** closed
- **Comments:** 1
- **URL:** https://github.com/vLannaAi/noy-db/discussions/78

---

noy-db today treats every string field as opaque text. For any consumer building software that needs to present the same data in multiple languages — product catalogs, enterprise apps with international users, accounting/compliance tools in regulated markets, any app with a bilingual audience — that opacity forces the consumer to solve i18n by hand on top of the library, usually in two incompatible ways at once (shared locale files for enum labels, parallel `foo` / `foo_en` fields for prose). Both patterns have well-known failure modes: the shared files drift from the runtime data, and the parallel fields silently lose translations on write.

This discussion proposes two complementary schema-level primitives that would let noy-db own i18n natively, plus an explicit stance on the trickiest part (AI-assisted translation) that preserves the zero-knowledge invariant by *not* pretending to solve something the library shouldn't.

## Two shapes, not one

The critical observation is that i18n content in real schemas splits into **two structurally different cases**, and trying to unify them into one primitive produces a worse API than shipping both.

### Shape A — Normalized dictionary keys (the "enum with translations" case)

Bounded sets of stable values: status enums, category codes, filing types, payment methods, role names, country codes, regulated-industry code lists. The *set* is known, the *labels* differ per locale. Today consumers store the label as a string (fragile) or the key as a string and resolve from a locale file (drifts from runtime state, can't be audited, can't be encrypted).

**Proposal:** a new schema type `dictKey('name')` that declares "this field is a key into the encrypted dictionary `name` in this compartment." Storage holds the key. Reads resolve to the caller's locale on the way out.

```ts
// Compartment bootstrap: populate the dictionary (encrypted like any other collection)
await company.dictionary('status').putAll({
  draft:    { en: 'Draft',    th: 'ฉบับร่าง' },
  open:     { en: 'Open',     th: 'เปิด' },
  paid:     { en: 'Paid',     th: 'ชำระแล้ว' },
  cancelled:{ en: 'Cancelled',th: 'ยกเลิก' },
})

// Collection schema references the dictionary
const Invoice = z.object({
  id: z.string(),
  amount: z.number(),
  status: dictKey('status'),   // runtime type: keyof dictionary 'status'
})

// Read resolves to the caller's locale
const inv = await invoices.get('inv-1', { locale: 'th' })
// → { id: 'inv-1', amount: 5000, status: 'paid', statusLabel: 'ชำระแล้ว' }
```

**Properties:**

- **Encrypted.** The dictionary is stored as a reserved collection (`_dict_<name>/`) under the same compartment DEK. Adapters still see ciphertext only. Zero-knowledge preserved.
- **Per-compartment.** Tenant isolation stays intact. A shared "official codes" dictionary across compartments is explicitly out of scope for v1 — it would cross the isolation boundary.
- **Ledger-tracked.** Renaming a label is an auditable mutation; the v0.4 hash chain covers dictionary writes like any other write.
- **Ref-integrity.** `dictKey('status')` is a specialization of v0.4 `ref()` — same strict/warn/cascade modes apply when a key is missing or deleted.
- **Type narrowing.** If the dictionary is populated at schema-construction time (or declared statically), the field's TypeScript type narrows to a literal union (`'draft' | 'open' | 'paid' | 'cancelled'`) rather than plain `string`. This is the single biggest DX win over the "string + locale file" status quo.
- **Groups/aggregations use the key, not the label.** A `groupBy('status')` (see discussion #65) groups by the stable key — grouping by localized label would produce different buckets per reader, which is obviously wrong.

### Shape B — Multi-language content fields (the "prose that exists in N languages" case)

Record-specific free text: invoice notes, product descriptions, article bodies, custom category names, line-item descriptions written by the user. The dictionary model doesn't fit — the values aren't shared across records, they're per-record.

**Proposal:** a new schema type `i18nText({ languages, required })` for fields whose value is a language → string map.

```ts
const LineItem = z.object({
  id: z.string(),
  amount: z.number(),
  description: i18nText({
    languages: ['en', 'th'],
    required: 'all',                 // 'all' | 'any' | list
  }),
})

// Write — strict mode requires all declared languages
await lineItems.put('li-1', {
  id: 'li-1',
  amount: 1000,
  description: { en: 'Consulting hours', th: 'ค่าที่ปรึกษา' },
})

// Read resolves to the caller's locale with fallback
const li = await lineItems.get('li-1', { locale: 'th', fallback: 'en' })
// → { id: 'li-1', amount: 1000, description: 'ค่าที่ปรึกษา' }

// Raw access when the consumer needs all languages (e.g. for a bilingual PDF)
const liRaw = await lineItems.get('li-1', { locale: 'raw' })
// → { id: 'li-1', amount: 1000, description: { en: '...', th: '...' } }
```

**Properties:**

- **Strict vs relaxed enforcement** at schema level. `required: 'all'` forces every declared language before `put()`. `required: 'any'` accepts the first language available and leaves others empty (useful for legacy data migration). `required: ['en']` is a middle ground — "English is required, Thai is optional."
- **Locale fallback on read** is declarative, not per-consumer logic: `{ locale: 'th', fallback: 'en' }` returns Thai if present, English otherwise, throws if neither.
- **Raw mode** returns the full map for consumers that need every language at once (bilingual invoice PDFs, export to XML with namespaced language elements, etc.).
- **Schema-validated.** Runs through the existing v0.4 Standard Schema pipeline. Adding a language to the schema retroactively produces validation errors on old records — caught at read time, same as any other schema drift.

## Enforcement modes

Both shapes need a clear story for what "required" means at the schema boundary:

| Mode | Dictionary keys | Multi-lang fields |
|---|---|---|
| `strict` | Key must exist in the dictionary at `put()` time. Missing → `DictKeyMissingError`. | All declared languages must be present at `put()` time. Missing → `MissingTranslationError`. |
| `warn` | Key missing at `put()` emits a warning but stores anyway. Read returns the raw key as the label. | Missing language stored as `null`; read falls back per the fallback chain. |
| `relaxed` / `any` | Key must exist in at least one locale in the dictionary. | At least one declared language must be present. |

Strict is the right default for production; `warn` is the right default for development and data migration. `relaxed` is the right default for user-editable fields where enforcement would block legitimate writes.

## The AI / external translation hook — explicit zero-knowledge stance

This is the part that's philosophically touchy and needs an explicit maintainer position before anyone writes code.

A common request for multi-lang fields is "auto-translate missing languages before `put()`." The obvious implementation — have noy-db call an external translation API — **violates the zero-knowledge invariant** the moment the plaintext leaves the library over a TLS connection to OpenAI / DeepL / Google / Claude / etc. It doesn't matter that the adapter never sees plaintext: the text just left the zero-knowledge boundary through a different door.

I think the right answer is not "don't support it" — that leaves consumers reinventing the same pre-put wrapper badly — but rather: **the library ships the integration point, not the integration itself.**

```ts
// Consumer provides the translator implementation. Library ships none.
const db = await createNoydb({
  adapter: ...,
  user: 'alice',
  secret: '...',
  translator: async ({ text, from, to, field, collection }) => {
    // Consumer's choice: self-hosted LLM, Argos Translate, Claude with their own
    // data policy, DeepL Pro with DPA, human review queue, literally anything.
    // noy-db does not know or care.
    return await myTranslator.translate(text, from, to)
  },
})

// Schema opts a specific field into auto-translation
const LineItem = z.object({
  description: i18nText({
    languages: ['en', 'th'],
    required: 'all',
    autoTranslate: true,   // only this field leaves the boundary via the hook
  }),
})
```

**The invariant statement I'd add to `NOYDB_SPEC.md` alongside this feature:**

> noy-db guarantees that adapters never see plaintext. It does **not** guarantee that plaintext never leaves the library's process — consumers who opt fields into the `translator` hook are explicitly sending those fields' plaintext to whatever implementation they provided. The library ships no translator, logs every translator invocation to the ledger (field, timestamp, *not* content), and requires per-field opt-in in the schema. Responsibility for the translator's data policy rests entirely with the consumer.

**Why this is the right line:**

- Core noy-db stays dep-free and crypto-invariant-pure. No translator SDKs bundled.
- The opt-in is per-field, not per-collection and not global. A schema that doesn't set `autoTranslate: true` on any field cannot accidentally send plaintext anywhere.
- The ledger entry for translator invocations gives an auditable trail of "what fields were exposed externally, and when" without logging the content itself.
- Userland can ship optional packages (`@noy-db/translator-deepl`, `@noy-db/translator-argos`, `@noy-db/translator-claude`) that implement the hook against specific services, each with their own peer deps and security docs. Same pattern as adapters and export formats.
- The consumer who wants zero external calls sets no translator and gets a hard `MissingTranslationError` in strict mode — the enforcement pressure lives in the schema, not in a hidden network call.

## Interactions with existing features and open discussions

1. **v0.4 schema validation (#42).** Both primitives plug into the Standard Schema pipeline. The validator runs before encryption on `put()` and after decryption on read, same as today.
2. **v0.4 refs (#45).** `dictKey('name')` is a specialization of `ref('_dict_name')` with locale resolution on read. Same integrity modes.
3. **v0.4 ledger (#43).** Dictionary writes and translator invocations both ledger-track. The chain verification story is unchanged.
4. **Query DSL joins (#64).** A `.join()` on a `dictKey` field resolves the label in the caller's locale. Natural extension.
5. **Aggregations (#65).** `groupBy` on a `dictKey` field groups by **stable key**, not localized label. The label only appears when projected on the result.
6. **Exports (#70).** Exports need an explicit locale policy: (a) resolve to a single locale and write plaintext labels, (b) export keys with the dictionary as a sidecar, or (c) multi-locale export (XML is a natural fit — see the XML comment on #70). The export primitive `exportStream()` should surface dictionary metadata alongside record streams so format packages can implement any of the three.
7. **Sync v2 (#66-ish / v0.6 roadmap).** Two users editing the same dictionary key in different languages is a textbook CRDT merge case. Per-locale LWW is probably the right default; explicit conflict resolution for overlapping-locale edits.
8. **Blob store (#67).** Blob metadata (filename, contentType, description) could use `i18nText` fields the same way records do. Nothing special required.

## Concrete design questions for the discussion

1. **One dictionary collection or many?** `_dict_status`, `_dict_filing_type`, … (one collection per dictionary, maps cleanly to existing collection primitives) or `_dictionary/` (one collection with namespaced keys)? The former composes better with v0.4 refs; the latter is simpler to enumerate.

2. **Who can write the dictionary?** Default: owner/admin only. User-editable dictionaries (custom tags, user-defined categories) need an explicit per-dictionary permission that falls back to the compartment ACL. Worth naming now.

3. **Dictionary value shape.** Just `{ [locale]: string }` or richer `{ [locale]: { label, description, short } }`? I'd start with flat and allow richer as a v2 extension — the flat form covers 90% of use and the richer form can be a `ref()` to a full record if a consumer needs it today.

4. **Locale source.** Is `locale` a per-call option (`get(id, { locale: 'th' })`), a per-compartment-open option (`openCompartment(id, { locale: 'th' })`), or both? Both is right — per-open is the common case, per-call is the escape hatch for mixed-locale reads in one session.

5. **Type narrowing from populated dictionaries.** If the dictionary is declared statically (keys known at compile time), can the field's TypeScript type narrow to a literal union? This requires either (a) a codegen step that reads the populated dictionary and emits a types file, or (b) passing the key union at schema-construction time: `dictKey('status', ['draft', 'open', 'paid', 'cancelled'] as const)`. The latter is simpler, no codegen required, and doesn't lose much.

6. **Dictionary deletion and cascade.** Deleting a dictionary key that's referenced by records: same strict/warn/cascade modes as v0.4 refs. Cascade cannot mean "delete referring records" for a dict-key (nonsensical — you'd lose data) so cascade here means "rewrite referring records to a fallback key." Worth explicit definition.

7. **Translator invocation contract.** Sync or async? Batched (translate many fields across a `putAll`) or per-field? Cacheable by content hash? I'd specify async + per-field + library-level content-hash caching so repeated puts of the same text don't re-hit the translator. Caching the plaintext-hash doesn't leak plaintext to adapters (the cache is in-process).

8. **Ledger attribution for translator calls.** The ledger entry should record `{field, fromLocale, toLocale, translatorName, timestamp, contentHash}` — enough to audit "what was sent where, when" without storing the plaintext. `translatorName` is a consumer-provided string, not enforced.

9. **Read-time locale mismatch with cached labels.** If the dictionary is updated (a label is renamed) *after* an export was generated, the export's snapshot of labels is now stale. `exportStream()` should capture the dictionary state alongside the data so the export remains self-consistent; the ledger head (see #70) pins the dictionary version used.

10. **Default locale for export vs read.** If no locale is specified on an export, does the export run in "raw" mode (ship keys + dictionary) or "default" mode (resolve to a configured default locale)? I'd default to **raw** — it's reversible, preserves information, and format packages can re-resolve to any locale they want. Consumers who want "just give me Thai labels" pass `{ locale: 'th' }` explicitly.

## What I'd like out of this discussion

- **Alignment that the two-shape split is correct** — dictionary keys and multi-lang fields as separate primitives, not a unified "i18n field" that tries to be both and fails at both.
- **Explicit stance on the translator hook:** agreement that core ships the integration point, never the integration, with the invariant statement spelled out in `NOYDB_SPEC.md`.
- **Rough roadmap placement.** This is v0.6 / v0.7 material — it builds on v0.4 schemas and refs, and it composes with features still in discussion (joins, aggregations, exports, blob store). Shipping it before those settle would force revisions.
- **Agreement on whether the type-narrowing story is ambitious (codegen) or pragmatic (pass-the-keys-at-schema-time).** I lean pragmatic.

Not a proposal for a specific API surface yet — this is the scope-boundary and invariant discussion. A follow-up epic would split into small issues: dictionary collection + `dictKey` type, `i18nText` type, locale-resolving read path, translator hook contract, per-dictionary permissions, export/exportStream integration, ledger metadata extension.


> _Comments are not archived here — see the URL for the full thread._
