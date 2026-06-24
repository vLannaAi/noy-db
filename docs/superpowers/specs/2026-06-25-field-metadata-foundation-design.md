# Field-metadata foundation — design (#482 + #483)

> Milestone #20 "Field metadata & describe() (pilot-3)". This spec covers the
> **substrate** (#482) and the **keystone** (#483). The riders #484
> (`toJSONSchema()`), #485 (dictKey labels), #486 (sensitivity classification)
> get short plans that reference this document.

**Status:** design approved 2026-06-25, pre-implementation.

---

## Problem

A noy-db collection already owns almost everything needed to *describe* its
data: field names + types (the Standard-Schema validator), money semantics
(`moneyFields`), foreign keys (`refs`), enum value sets (`dictKeyFields`),
i18n text, and computed fields. The missing last 10% — **consumer-neutral,
data-relatable descriptors** (label, semantic format, unit, enum value
labels, entity display pairing, aggregation default, sensitivity) — has
nowhere to live. The pilot (i3speedex) maintains these facts **three times**
(Zod schema, a search `FieldDef` registry, each table's `Column[]`) and they
drift.

By the litmus test *"would a second, unrelated consumer want this fact?"*
these descriptors belong to the data — in noy-db — because a table, an
Excel/CSV export, a PDF report, a form generator, an API doc, and the
devtools inspector all want the same facts.

## Two findings that reframe the original issues

The original issues (#482, #483) were written assuming hub uses Zod directly.
It does not. Two verified facts from the code change the design:

1. **hub is validator-agnostic.** hub never imports `zod` in `src/`. It
   validates through the **Standard Schema v1** protocol
   (`schema['~standard'].validate()` — `schema.ts:55-149`), so it works with
   any conforming validator (Zod, Valibot, ArkType, Effect). `zod` is a
   **devDependency** (`^3.23.0`) used only by hub's own tests. There is
   therefore **no "hub runs against the consumer's zod" hazard** and **no
   peer-dependency break is required**. #482 is *additive*, not breaking.

2. **`describe()` is an extension, not greenfield.** `vault.dumpSchema()` +
   `vault.introspect()` + a `FieldDescriptor` type already exist
   (`introspection/`), exposing field types + refs but **omitting**
   money/dict/i18n/computed. A JSON-Schema derivation path already exists
   (`persisted-schemas/derive.ts` → `derivePersistedSchema`, used by #484).

## Goals

- Add a **consumer-neutral field-metadata layer** that merges existing
  config + a new authoring channel + (optionally) zod-4 registry metadata.
- Add **`collection.describe()`**: a normalized, synchronous, config-only
  descriptor list — the single interface every renderer/exporter consumes.
- Keep hub **validator-agnostic** and **portable** (no static `import 'zod'`).
- Make the riders #484/#485/#486 thin additions on top.

## Non-goals (scope boundary — descriptive, never prescriptive)

noy-db may say *"this field means money in €, sums, is PII."* It must **not**
say *"put it in column 3 at 60px on the sales page."* Out of scope, app-side:

- column order, widths, responsive breakpoints, default-visible columns
- per-page default sort/filter, route placement, styling
- **active locale selection** (noy-db carries label text incl. multi-locale
  maps; the app chooses the active locale)
- logging/telemetry redaction enforcement (app-side)

This litmus test — *"would a second, unrelated consumer want this fact?"* —
is a binding invariant: it governs what may be added to the metadata layer.

---

## Architecture

```
                    collection.describe()   ← cheap, sync, config-only
                            │  merges
        ┌───────────────────┼───────────────────────────────┐
   existing config      fieldMeta channel          optional zod-4 reader
   (refs, money,        (canonical, agnostic,      (.meta()/registry,
    dictKey, i18n,       collection options)        merged when present,
    computed)                                       channel wins on conflict)
                            │
                  extends existing FieldDescriptor
                  (introspection/types.ts) — NOT a new parallel type
```

The **zod-4 reader reuses the #484 derivation path**: zod-4's
`z.toJSONSchema()` already folds `.meta()`/registry metadata into its output,
so "read the zod registry" and "emit JSON Schema" are the *same* zod-4 call —
no separate reach into zod internals, no static import (lazy/duck-typed,
exactly like `derivePersistedSchema` does today). This unifies #483's
reader-half with #484.

---

## Component 1 — `#482` substrate (additive)

1. **Bump hub devDependency `zod` 3 → 4** so hub's tests exercise the zod-4
   Standard-Schema + registry shape. (`zod` stays a devDependency; it is
   **not** promoted to a direct or peer dependency.)
2. **Make `derivePersistedSchema` zod-version-aware**
   (`persisted-schemas/derive.ts`): prefer the schema's native
   `z.toJSONSchema()` (zod 4) when present; fall back to the optional
   `zod-to-json-schema` peer-dep (zod 3). Both majors stay supported; hub
   keeps a hard dependency on neither.
3. **Document** that hub accepts any Standard-Schema validator (zod 3 or 4,
   Valibot, …). The zod-4 registry-read path is a *bonus* available only to
   zod-4 schemas; the `fieldMeta` channel is the always-available path.

No peer-dependency change. No breaking change.

---

## Component 2 — `#483` the `fieldMeta` channel

A new `fieldMeta` entry in collection options, alongside the descriptors
noy-db already owns:

```ts
vault.collection<Sale>('sales', {
  schema: SaleSchema,                          // any Standard-Schema validator
  refs:        { buyerId: ref('buyers') },
  moneyFields: { total: money({ currency: 'EUR' }) },
  dictKeyFields: { status: staticDict('saleStatus', { draft:'Draft', to_verify:'To Verify' }) },
  fieldMeta: {                                 // ← new, agnostic channel
    saleDate:  { label: 'Date',  semanticType: 'date', aggregate: 'none' },
    total:     { label: 'Amount', semanticType: 'currency', unit: '€', aggregate: 'sum' },
    buyerId:   { label: 'Buyer', displayFor: 'buyerName' },
  },
})
```

The meta shape (mandates `label`; rest optional):

```ts
interface FieldMeta {
  label: string
  description?: string
  semanticType?: 'date'|'datetime'|'email'|'url'|'currency'|'percent'
               | 'country'|'vat'|'iban'|'entity' | (string & {})  // open union
  unit?: string                                // '€', '%', 'kg'
  sensitivity?: 'public'|'pii'|'secret'        // #486 rides here
  aggregate?: 'sum'|'count'|'distinct'|'none'
  aliases?: string[]                           // search synonyms
  displayFor?: string                          // entity pairing: buyerId ⇄ buyerName
}
```

**Validation:** `fieldMeta` keys that are not fields in the schema/config are
rejected **fail-loud at `collection()` time** (mirrors how an unknown
`moneyFields` key would be caught), to catch typos. `semanticType` is an
**open** string union — unknown values pass through (consumers may define
their own); it is not a closed enum that rejects.

**Storage:** stored on the Collection like the sibling descriptor maps;
registered into a vault-level registry consistent with the existing
`refRegistry`/`dictKeyFieldRegistry` pattern so introspection can reach it.

### The optional zod-4 reader

When the schema is zod-4, fields authored co-located via `.meta()` are read
through the shared `z.toJSONSchema()` derivation and merged:

```ts
const SaleSchema = z.object({
  total: z.number().meta({ label: 'Amount', semanticType: 'currency', unit: '€' }),
})
```

The reader is **lazy/duck-typed** — it reads metadata out of the derived
JSON Schema (which zod-4 populates from the registry), never via a static
`import 'zod'`. For non-zod validators it is simply a no-op.

### Merge precedence (highest wins)

1. `fieldMeta` channel (canonical, agnostic — works for every validator)
2. zod-4 `.meta()` registry (when present)
3. **inferred** from existing config:
   - `moneyFields` → `semanticType:'currency'`, `aggregate:'sum'`
   - `refs` → `semanticType:'entity'`
   - `z.iso.date()` / JSON-Schema `format:'date'` → `semanticType:'date'`
   - humanized field name → fallback `label`

The channel is authoritative because it is the *only* source available for
every validator; making the always-available source win avoids a consumer's
behavior silently depending on which validator they chose. Inference under
the explicit sources means `describe()` is useful on existing collections
that never declare `fieldMeta`.

---

## Component 3 — `collection.describe()`

**Synchronous, cheap, config-only** — no decryption, no store I/O (distinct
from the async `dumpSchema()` which samples data). Returns one normalized
list, **extending** the existing `FieldDescriptor` rather than a parallel
type:

```ts
collection.describe(): CollectionDescription

interface CollectionDescription {
  readonly collection: string
  readonly fields: readonly DescribedField[]
}

interface DescribedField {
  // ── from existing introspection (validator-derived) ──
  readonly key: string
  readonly type: string                 // 'string'|'number'|'boolean'|'enum'|'object'|'array'|'null'
  readonly optional: boolean
  readonly constraints?: Record<string, unknown>
  // ── merged metadata ──
  readonly label: string                // explicit → registry → humanized(key)
  readonly description?: string
  readonly semanticType?: string
  readonly unit?: string
  readonly sensitivity?: 'public'|'pii'|'secret'
  readonly aggregate?: 'sum'|'count'|'distinct'|'none'
  readonly aliases?: readonly string[]
  // ── from config noy-db already owns ──
  readonly ref?: { target: string; mode: string; isArray?: true }
  readonly displayFor?: string
  readonly money?: { mode: 'fixed'|'multi'; currency?: string; scale?: number; rounding?: string }
  readonly dict?: { name: string; static: boolean
                    values?: readonly { value: string; label?: string }[] }  // #485 labels
  readonly computed?: true
}
```

Example (the `sales` collection above):

```ts
[
  { key:'saleDate', type:'string', optional:false, semanticType:'date',   label:'Date',  aggregate:'none' },
  { key:'buyerId',  type:'string', optional:false, semanticType:'entity', label:'Buyer',
      ref:{target:'buyers',mode:'strict'}, displayFor:'buyerName' },
  { key:'status',   type:'enum',   optional:false, label:'Status',
      dict:{ name:'saleStatus', static:true,
             values:[{value:'draft',label:'Draft'},{value:'to_verify',label:'To Verify'}] } },
  { key:'total',    type:'number', optional:false, semanticType:'currency', label:'Amount', unit:'€',
      money:{ mode:'fixed', currency:'EUR', scale:2 }, aggregate:'sum' },
]
```

### The one async boundary — dynamic dict labels

`staticDict` labels are in-code → surface synchronously (covers the pilot's
"To Verify" case and most of #485). **Dynamic `dictKey`** labels live in
encrypted `_dict_*` collections → require an async read. To keep `describe()`
sync by default:

- `describe()` (sync) returns dynamic-dict fields as
  `dict:{ name, static:false }` with declared `keys` but **no resolved
  labels**.
- `await collection.describe({ resolveDictLabels: true })` returns the same
  shape with `values[].label` filled, reading `_dict_*`. Async cost is
  visible at the call site and opt-in only.

---

## Component placement & exports

- New files under `introspection/` (e.g. `field-meta.ts` for the `FieldMeta`
  type + merge logic; extend the existing field/describe code). `describe()`
  is a thin delegating method on `Collection`.
- Export `FieldMeta`, `CollectionDescription`, `DescribedField` from
  `src/index.ts`. **Not** from `kernel/index.ts` — per-collection
  introspection is not orchestration surface.
- Merge logic lives in `introspection/`, **not** `collection.ts`/`vault.ts`,
  so the kernel-surface ceilings (collection.ts 5285, vault.ts 4610) are
  untouched.

---

## How the riders attach (separate short plans)

| Issue | How it rides | Net-new work |
|---|---|---|
| **#485** dictKey labels | `staticDict` already carries per-value labels; this design **surfaces** them via `dict.values[].label`. The only gap is an inline-map form for **dynamic** `dictKey('saleStatus', {draft:'Draft',…})`. | Accept a map form in `dictKey()` (back-compat with the bare array) + the async label resolution above. |
| **#484** toJSONSchema | Reuses the **same** zod-4 `z.toJSONSchema()` path as the reader. Walks `describe()` output and stamps `x-label`/`x-unit`/`x-semanticType`/`x-sensitivity`/`x-money`/`x-enumLabels` extension keys. | One emitter over `describe()`. |
| **#486** sensitivity | `sensitivity` is already in `FieldMeta` + `DescribedField`. hub side is done by this spec. | Only the redacting *export* (#489, as-* family) remains; it reads `describe().fields[].sensitivity`. |

---

## Testing

- **Merge precedence** — channel > zod-registry > inferred, per source: a
  money field with no `fieldMeta`; a `fieldMeta` label overriding an inferred
  one; a zod-4 `.meta()` read; a conflict where the channel wins.
- **Validator-agnostic** — run the `describe()` suite against **two
  validators**: a zod-4 schema (reader path) and a hand-rolled
  Standard-Schema stub / Valibot (channel-only, proves no zod dependency).
  This test guards the agnostic invariant.
- **zod 3 ↔ 4** — `derivePersistedSchema` produces equivalent field types
  under both majors (native `z.toJSONSchema()` vs `zod-to-json-schema`).
- **Sync/async** — `describe()` does zero store reads (assert via a wrapped
  store that throws on `list`/`get`); `describe({resolveDictLabels:true})`
  reads `_dict_*` and fills labels.
- **#485 back-compat** — bare-array `dictKey` still works; map form produces
  labels.
- **Showcase** — next number after 125: `describe()` → a table + an export
  reading one source.

## Portability (hard invariants)

- No static `import 'zod'` anywhere in `hub/src`; the reader is
  lazy/duck-typed like `derivePersistedSchema`. Enforced by a test (the
  arch-check Node-ban does not grep for zod) + documented invariant.
- `scripts/check-architecture.mjs` Node-only-module ban continues to hold.
- Kernel ceilings unchanged (no write-path changes).

## `features.yaml`

New `field-metadata` node pointing at this spec; riders #484/#485/#486
reference it. (CI "Spec coverage" fails on dangling refs, so this is
mandatory.)

## Release sequencing

Because #482 is **additive, not breaking**, every step is a normal
pre-release bump (no major/breaking ceremony, no peer-dep coordination):

- **Release N**: #482 substrate (devDep zod-4 bump + zod-4-aware derivation).
- **Release N+1**: #483 `fieldMeta` + `describe()`.
- **Release N+2**: #484 / #485 / #486 riders.

One spec (this document) covers #482 + #483; #484/#485/#486 get short plans
referencing it.
