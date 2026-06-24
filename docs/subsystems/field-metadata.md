# Field metadata — `collection.describe()` + `fieldMeta`

> Status: **preview** (#483). Spec:
> `docs/superpowers/specs/2026-06-25-field-metadata-foundation-design.md`

---

## What it is

`collection.describe()` returns a normalised `CollectionDescription` whose
`fields: DescribedField[]` array merges every per-field config channel into a
single consumer-neutral record. Any consumer — table header, export pipeline,
API serialiser, AI agent context — reads from this one source instead of
duplicating its own label/unit/sensitivity logic.

**Descriptive, never prescriptive.** `DescribedField` carries meaning
(`label`, `semanticType`, `unit`, `sensitivity`, `aggregate`, `aliases`,
`displayFor`) — not layout, not styling, not locale selection. Those stay
app-side.

---

## Sync vs async

| Call | What it returns | When to use |
|---|---|---|
| `collection.describe()` | `CollectionDescription` (sync, immediate) | Table headers, export spec, any render-time use |
| `collection.describe(opts)` | `Promise<CollectionDescription>` | Need validator-derived exact types, zod-4 `.meta()`, or dynamic-dict label resolution |

The sync path is zero-store-I/O: no `await`, no store reads, no decryption.
It derives field types from the in-memory config (money→`'number'`,
ref→`'string'`/`'array'`, dictKey→`'enum'`, others→`'unknown'`).

The async path adds:
- Validator-derived `type`/`optional`/`constraints` via `deriveZodFields`
  (lazy `import('zod')` — never a static dep).
- Zod-4 `.meta()` key extraction (label, description, semanticType, …).
- Dynamic-dict label resolution: `{ resolveDictLabels: true }` calls
  `vault.dictionary(name).list()` for each dynamic dictKey field and populates
  `dict.values[].label`.

---

## The `fieldMeta` channel

`fieldMeta` is the primary, validator-agnostic authoring surface. It is
declared as a collection option:

```ts
const sales = vault.collection<Sale>('sales', {
  moneyFields:   { total: money({ currency: 'EUR' }) },
  dictKeyFields: { status: saleStatus },
  refs:          { buyerId: ref('buyers') },
  fieldMeta: {
    saleDate: { label: 'Date' },
    total:    { label: 'Total (€)', unit: '€' },
    buyerId:  { label: 'Buyer', sensitivity: 'pii', displayFor: 'buyerName' },
    notes:    { label: 'Internal notes', sensitivity: 'secret' },
  },
})
```

`FieldMeta` members:

| Field | Type | Purpose |
|---|---|---|
| `label` | `string` (required) | Human display name |
| `description` | `string?` | Longer tooltip / context |
| `semanticType` | `SemanticType?` | Domain hint: `'date'`, `'currency'`, `'email'`, `'vat'`, … |
| `unit` | `string?` | Display unit: `'€'`, `'%'`, `'kg'`, … |
| `sensitivity` | `'public' \| 'pii' \| 'secret'` | Data-classification for redaction/masking |
| `aggregate` | `'sum' \| 'count' \| 'distinct' \| 'none'` | Default aggregation |
| `aliases` | `readonly string[]?` | Canonical search synonyms |
| `displayFor` | `string?` | Entity pairing: `'buyerId'` → `displayFor: 'buyerName'` |

---

## Merge precedence

For each field, three tiers of metadata are merged in priority order:

```
channel (fieldMeta) > zod-4 .meta() (async path) > inferred-from-config
```

1. **channel** — values from `collection({ fieldMeta: { … } })`. Wins over
   everything. This is where the app author declares intent.
2. **zod-4 `.meta()`** — async path only. Keys recognized:
   `label`, `description`, `unit`, `semanticType`, `sensitivity`, `aggregate`,
   `aliases`, `displayFor`. Unknown `.meta()` keys are silently ignored.
3. **inferred-from-config** — automatically derived from the collection's other
   config:
   - `moneyFields` → `semanticType:'currency'`, `aggregate:'sum'`, `type:'number'`
   - `refs` → `semanticType:'entity'`, `type:'string'` (or `'array'` for `refArray`)
   - `dictKeyFields` → `type:'enum'`, `dict: { name, static, values[] }`

Structural extras (`money`, `dict`, `ref` blocks) always come from config, not
from the channel.

---

## Two-consumer pattern

Call `describe()` once; hand the result to every consumer:

```ts
const d = sales.describe()

// Consumer A — table header row
const headers = d.fields.map((f) => f.label)

// Consumer B — export column spec (flag PII/secret for redaction)
const exportSpec = d.fields.map((f) => ({
  key:      f.key,
  label:    f.label,
  redacted: f.sensitivity !== undefined && f.sensitivity !== 'public',
}))

// Consumer C — AI agent context (structured field list, no raw records)
const agentContext = d.fields.map((f) => ({
  key:  f.key,
  type: f.type,
  ...(f.sensitivity === 'secret' ? { omit: true } : {}),
}))
```

`CollectionDescription` is a frozen plain object — pass it freely.

---

## Scope boundary

`describe()` is **descriptive, not prescriptive**:

- Layout order → app-side (describe() returns alphabetical by key)
- Locale selection → app-side (staticDict can surface one locale via
  `displayLocale`; the choice belongs to the caller)
- Rendering / formatting → app-side
- Validation / write enforcement → schema / guards, not describe()

---

## Key invariants

- **Sync = zero store I/O.** The sync overload reads only in-memory config
  assembled at collection registration time. It never calls any store method.
- **Descriptive not prescriptive.** No layout, styling, or active-locale
  selection in `DescribedField`.
- **Merge precedence is fixed**: channel > zod-4 `.meta()` > inferred.
  Application code can rely on `fieldMeta` always winning.
- **Validator-agnostic.** Works without zod; non-zod validators get structural
  type inference from config only (sync path) or an empty `zodFields` map
  (async path) — no error.
- **fieldMeta key guard (async path).** When `zodFields` is non-empty, unknown
  `fieldMeta` keys throw `FieldMetaUnknownFieldError` — typo protection.
  Sync path skips this check because schema fields aren't knowable without
  async derivation.

---

## Public API surface (`@noy-db/hub`)

```ts
import { createNoydb, money, staticDict, ref } from '@noy-db/hub'
import type { FieldMeta, SemanticType, CollectionDescription, DescribedField, DescribeOptions } from '@noy-db/hub'

// collection option
const coll = vault.collection('name', {
  fieldMeta: Record<string, FieldMeta>
})

// sync
const d: CollectionDescription = coll.describe()

// async (validator types + dynamic dict labels)
const d2: CollectionDescription = await coll.describe({ resolveDictLabels: true })
```

See also: Showcase 126 (`showcases/src/126-describe-field-metadata.showcase.test.ts`).
