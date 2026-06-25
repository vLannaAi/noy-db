# Field metadata — `collection.describe()` + `fieldMeta` + metadata ladder

> Status: **preview** (#483). Specs:
> `docs/superpowers/specs/2026-06-25-field-metadata-foundation-design.md`
> · `docs/superpowers/specs/2026-06-25-metadata-ladder-and-schema-surfacing-design.md`

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

---

## Metadata ladder — collection + vault level

The field-level descriptors (`fieldMeta` / `DescribedField`) are the bottom rung
of a **three-rung metadata ladder**:

```
field  →  collection  →  vault
```

Each rung adds a friendly identity layer that viewers (devtools, editor, export
filename, API doc) consume without duplicating their own label logic.

### `collectionMeta`

Declare via the `meta` collection option:

```ts
const invoices = vault.collection<Invoice>('invoices', {
  meta: {
    label: 'Sales Invoices',
    description: 'Outbound sales invoices billed to clients.',
    pluralLabel: 'Sales Invoices',  // for list headers
    icon: 'receipt',                // semantic icon name (Lucide etc.)
  },
  fieldMeta: { … },
})
```

`CollectionMeta` members:

| Field | Type | Purpose |
|---|---|---|
| `label` | `string?` | Friendly collection name; falls back to the humanized collection name |
| `description` | `string?` | Longer tooltip / context |
| `icon` | `string?` | Semantic icon name (e.g. a Lucide key), not styling |
| `pluralLabel` | `string?` | Plural form for list headers ("Invoice" → "Invoices") |

Unlike `FieldMeta.label`, `CollectionMeta.label` is **optional** — the
collection name is already a reasonable fallback identity.

**First-wins reconciler.** When a collection is pre-created by an MV before the
app's own `vault.collection()` call, the first declared `meta` wins (mirrors
`_applyFieldMeta`).

**Surfaces in:**
- `collection.describe()` → `CollectionDescription.meta`
- `vault.dumpSchema()` → `CollectionDescriptor.meta`
- `in-devtools` `snapshot()` → `InspectorCollection.meta`

### `vaultMeta`

Declare via the `meta` vault option:

```ts
const vault = await db.openVault('ledger', {
  meta: { label: 'Acme Ledger 2026', description: 'Main accounting vault.' },
})
```

`VaultMeta` members:

| Field | Type | Purpose |
|---|---|---|
| `label` | `string?` | Friendly vault name; falls back to the vault name |
| `description` | `string?` | Longer context |
| `icon` | `string?` | Semantic icon name |

**First-wins.** Re-opening an already-cached vault keeps its `meta`.

**Surfaces in:**
- `vault.dumpSchema()` → `VaultSchemaSnapshot.meta`
- `in-devtools` `snapshot()` → `InspectorSnapshot.meta`

**Kernel export.** `CollectionMeta` and `VaultMeta` are also exported from
`@noy-db/hub/kernel` so that klum-db's federation layer can reuse `VaultMeta`
for `groupMeta` without taking a full hub dep.

---

## `describe()` enhancements — `i18n`, `widget`, `editable`

The metadata ladder build added three fields to `DescribedField`:

### `i18n?: { locales?: readonly string[]; densify?: boolean }`

Present on fields declared with `i18nText()`. Exposes the configured locale set
and the `densifyOnWrite` flag so consumers know the field is multi-locale.

### `widget?: string`

Derived from `semanticType` + `type`, overridable via `fieldMeta.widget`:

| Condition | Derived `widget` |
|---|---|
| `semanticType: 'date'` or `'datetime'` | `'date'` |
| `semanticType: 'currency'` (money) | `'money'` |
| `semanticType: 'entity'` (ref) | `'ref-select'` |
| `dict` block present | `'select'` |
| `type: 'boolean'` | `'checkbox'` |
| `semanticType: 'percent'` | `'number'` |
| `semanticType: 'url'` | `'url'` |
| `semanticType: 'email'` | `'email'` |
| else | `'text'` |

Override: `fieldMeta: { amount: { label: 'Amount', widget: 'currency-input' } }`.

### `editable: boolean`

`false` for computed fields, the `id` field, and provenance-stamped fields;
`true` otherwise. Data editors use this to render read-only cells without
knowing the collection's internals.

---

## `dumpSchema()` collection-level `config` block

`CollectionDescriptor.config` surfaces the **live** collection's configuration
options for structural-audit tooling. It is populated by `dumpSchema()` when the
collection is live-declared; omitted for bundle-reconstructed collections where
options aren't available.

```ts
config?: {
  textIndexes?: readonly string[]
  textIndexPersist?: boolean
  embeddings?: { source: string | readonly string[]; dim: number; model?: string }
  i18nFields?: readonly string[]
  crdt?: string
  provenance?: boolean
  archive?: boolean          // presence flag (the predicate is code)
  tiers?: readonly number[]
  tierMode?: string
  perRecordKeys?: boolean
  history?: boolean          // presence flag
  schemaUpdate?: readonly string[]  // strategy names
}
```

**Function-valued options surface as booleans (presence).** `conflictPolicy` is
consumed at construction and has no retained state to surface.

---

## Devtools schema view

### `in-devtools` `snapshot()`

`InspectorCollection` carries all three rung outputs:
- `meta?: CollectionMeta` — collection-level label/description
- `described?: readonly DescribedField[]` — rich field list (label/type/widget/sensitivity/i18n/editable)
- `config?: CollectionConfig` — structural config strip

`InspectorSnapshot` gains `meta?: VaultMeta` for the vault-level label.

### Terminal UI (`@noy-db/in-devtools-tui`)

The structure view renders the metadata ladder compactly:

**VaultList** — shows `meta.label (vaultId)` for the active vault when a label
is declared; falls back to the vault id.

**CollectionList** — shows `meta.label (name)` for each collection when a label
is declared; falls back to the collection name.

**DetailPane** (drilled schema tab):
- Heading: `meta.label (name)` or just `name`
- If `described` is present: one line per field — `Label  (key: type)  [pii]  [i18n]  [ro]  <widget>`
- If `described` is absent (no live describe): raw `key: type` from `fields`
- Config strip (dimmed): `config: idx:2  emb:1536d  i18n:3  crdt:lww  provenance  archive`

Markers used:
| Marker | Meaning |
|---|---|
| `[pii]` | `sensitivity: 'pii'` |
| `[secret]` | `sensitivity: 'secret'` |
| `[i18n]` | `i18n` block present |
| `[ro]` | `editable: false` |
| `<widget>` | widget hint, e.g. `<money>` or `<ref-select>` |

---

## Metadata riders (#484 #485) — `toJSONSchema()`, dictKey inline labels, devtools PII masking

> Spec: `docs/superpowers/specs/2026-06-25-metadata-riders-design.md`

### `collection.toJSONSchema()`  (#484)

An async method on `Collection` that produces a JSON Schema object annotated
with `describe()` metadata as `x-` extension keys:

```ts
const schema = await myCollection.toJSONSchema()
```

**Pipeline:**
1. `derivePersistedSchema(this.schema)` — produces the base JSON Schema (zod-4
   `z.toJSONSchema()` path; zod-3 via `zod-to-json-schema`).
2. `await this.describe({})` — the normalized per-field metadata.
3. Overlay each property with the `x-` extension keys below.

**`x-` key table:**

| `describe()` field | JSON-Schema key | Notes |
|---|---|---|
| `label` | `x-label` | |
| `unit` | `x-unit` | |
| `semanticType` | `x-semanticType` | |
| `sensitivity` | `x-sensitivity` | `'public'`, `'pii'`, or `'secret'` |
| `widget` | `x-widget` | derived hint, overridable |
| `editable: false` | `x-readonly: true` | only emitted when `false` |
| `money` | `x-money` | `{ currency, scale }` |
| `ref` | `x-ref` | `{ target }` |
| `dict.values[].label` | `x-enumLabels` | `{ [value]: label }` map |

**Validator-agnostic fallback:** when `derivePersistedSchema` yields no JSON
Schema (non-zod validator), `toJSONSchema()` builds a minimal
`{ type: 'object', properties }` from the field types derived by `describe()`,
then overlays the same `x-` metadata. No throw; no zod required.

---

### `dictKey` inline labels  (#485)

`dictKey` gains an optional inline label map alongside the existing array form:

```ts
// Today (still valid — bare array):
dictKey('saleStatus', ['draft', 'to_verify', 'paid'] as const)

// New — value→label map (keys inferred from the map):
dictKey('saleStatus', { draft: 'Draft', to_verify: 'To Verify', paid: 'Paid' })

// Or array + labels option (preserves explicit order):
dictKey('saleStatus', VALUES, { labels: { to_verify: 'To Verify' } })
```

`DictKeyDescriptor` gains `readonly labels?: Record<string, string>`.

**Semantics — display fallback:**
- Inline labels are code-provided *defaults* surfaced when the `_dict_`
  collection has no label for a key.
- `describe()` (**sync**) surfaces inline labels into `dict.values[].label`
  with zero store I/O — equivalent to `staticDict` for display purposes.
- `describe({ resolveDictLabels: true })` (**async**) overrides from `_dict_`
  and falls back to the inline label.
- `toJSONSchema()` `x-enumLabels` picks them up via `describe()`.

This keeps `staticDict` (closed code labels, no `_dict_`) and
`dictKey` + inline labels (dynamic dict *with* code defaults) as distinct,
non-overlapping tools.

---

### Devtools PII masking

The `RecordsPane` in both devtools surfaces masks values for fields where
`sensitivity !== 'public'` (i.e. `pii` and `secret`), protecting data during
screen-sharing or shoulder surfing.

**Behavior:**
- Sensitive cells render as `••••` by default.
- A reveal toggle un-masks the value on demand:
  - **Nuxt** (`@noy-db/in-devtools-nuxt`): per-field reveal (click the masked
    cell); a header "reveal all" toggle un-masks the whole pane.
  - **TUI** (`@noy-db/in-devtools-tui`): press `r` to toggle reveal-all for
    the pane (a single pane-level toggle is terminal-appropriate).
- Public fields (`sensitivity: 'public'`) and unclassified fields (no
  `sensitivity`) always render their raw values — they are never masked.
- **Back-compat:** a collection without `described` (non-live or pre-enrichment)
  has an empty sensitive-field set → nothing is masked → behavior is identical
  to before.

**Collection-change reset (TUI):** the reveal-all flag resets when the selected
collection index changes, so revealed PII does not linger when navigating to
another collection.

This is shoulder-surfing / screen-share safety over already-decrypted local
data — it is **not** access control. The data is already in the trusted tier.
