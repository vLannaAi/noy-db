# Interactive schema & data editor — design (forward-looking)

> **Design only. Not implemented this cycle.** Captures the target so the
> read-model (`describe()` / `dumpSchema()` / the metadata ladder) is shaped to
> serve it. Consumes
> [2026-06-25-metadata-ladder-and-schema-surfacing-design.md](2026-06-25-metadata-ladder-and-schema-surfacing-design.md).

**Status:** design recorded 2026-06-25. No implementation scheduled.

---

## Vision

A user-friendly, interactive UI for noy-db with two halves:

- **Data editor** — non-technical users create/edit *records* in a friendly
  UI (forms + tables), with full awareness of the schema: money inputs,
  ref dropdowns, enum selects, multi-locale fields, validation, PII masking.
- **Schema editor** — a developer/admin defines/changes *collections*
  visually; the tool **emits code** (Zod + collection-options) the developer
  commits. Low-code, not no-code.

## The unifying principle

`describe()` is the **read-model** the whole UI renders. The data editor reads
it to build forms; the schema editor *reverses* it into code. Every tool
(CLI, devtools, editor) is a consumer of the same description — the editor is
just the most demanding one, which is why its needs drive the
`describe()`/`fieldMeta` roadmap.

## Key decisions (from brainstorming, 2026-06-25)

1. **Schema editing = codegen** (low-code, dev-facing), NOT a runtime
   serializable schema IR. The UI edits a `describe()`-shaped model and emits
   TypeScript (Zod schema + the collection-options object). Rationale: no new
   noy-db core primitive, and no entanglement with the live schema-update /
   Transform / Cutover migration machinery — schema changes are code the dev
   commits and deploys, migration handled in code as today.
2. **Read-model = hybrid** `describe()` (per-field render-model) +
   `dumpSchema()` (structural + collection-level config), merged by consumers.
3. **Framework:** a framework-agnostic **editor core** (`describe()` +
   `toJSONSchema()` → render-ready view-model + validation) with thin bindings
   — mirroring noy-db's "core + `in-*`" pattern. First binding in Vue/Nuxt.
   Package home/naming TBD (follows the `in-*` convention for framework
   integration).

---

## Phase 1 — Data editor (the high-value, low-risk half)

**Forms and tables generated from `describe()`.** Per field, `widget` selects
the input:

| describe() signal | editor input |
|---|---|
| `widget:'money'` (+ `money.currency`) | currency input, scaled correctly |
| `widget:'ref-select'` (+ `ref.target`, `displayFor`) | dropdown sourced from the target collection, showing the `displayFor` label |
| `widget:'select'` (+ `dict.values[].label`) | labelled enum select |
| `i18n` block | per-locale tabbed input |
| `widget:'date'` | date picker |
| `editable:false` (computed/id/provenance) | read-only display (computed shown live) |
| `sensitivity` `pii`/`secret` | masked with reveal-on-demand |

**Validation & save:**
- `toJSONSchema()` (**#484**, build at Phase-1 start) drives a standard form
  library (JSON-Schema-form / JSONForms) for field validation + error display.
- `validateInput(record)` is the pre-save gate (validate without writing —
  already exists, FR-8).
- `put(id, record)` saves; money canonicalize→quantize, ref/i18n/dict
  enforcement all already run inside `put()`.

**Dependencies beyond the metadata-ladder spec:**
- **#484 `collection.toJSONSchema()`** — the form engine.
- **ref option-source** — the editor queries `target.describe()` + lists the
  target collection; optionally a small `collection.refOptions(field, {q?})`
  convenience.
- **#485 dict labels** (already shipping) — the selects.
- **#486 sensitivity** (hub flag shipped) — the masking.

## Phase 2 — Schema editor (codegen)

**Edits a `describe()`-shaped model** — add/rename/retype fields; set
money/dict/refs/`fieldMeta`/`collectionMeta`; pick the collection's
validator-level constraints — and **emits code**:

```ts
// generated: collections/sales.ts
export const SaleSchema = z.object({
  saleDate: z.iso.date().meta({ label: 'Date' }),
  total:    z.number(),
  buyerId:  z.string(),
})
export const salesOptions = {
  meta: { label: 'Sales', icon: 'receipt' },
  refs: { buyerId: ref('buyers') },
  moneyFields: { total: money({ currency: 'EUR' }) },
  fieldMeta: { total: { label: 'Amount', unit: '€' }, buyerId: { displayFor: 'buyerName' } },
}
```

**Escape-hatches** — the non-serializable, function-valued options are emitted
as `// TODO` stubs the developer completes:
- `computed` field functions
- custom guards / `conflictPolicy` / `archive` predicates
- custom validator refinements beyond the basic field types

This bounds the codegen: it expresses the declarative ~90% and hands off the
imperative ~10% explicitly, rather than pretending to round-trip code it
cannot serialize.

## Phase 0 — already covered

The CLI/devtools schema viewers and the `describe()`/`dumpSchema()`/metadata
enhancements the editor's read-model depends on are the
metadata-ladder-and-schema-surfacing spec — built first, independently
valuable, and the editor's foundation.

---

## Enhancement roadmap this design implies

| Enhancement | Editor need | Status |
|---|---|---|
| `describe()` `i18n`/`widget`/`editable` | input selection, read-only, multi-locale | metadata-ladder spec (Phase 0) |
| `collectionMeta` / `vaultMeta` | friendly names in nav + collection list | metadata-ladder spec (Phase 0) |
| `fieldMeta.widget` override | input override | metadata-ladder spec (Phase 0) |
| **#484 `toJSONSchema()`** | form generation + validation | Phase 1 |
| ref option-source helper | populate ref dropdowns | Phase 1 |
| `fieldMeta.group`/section | form sections | Phase 1 — boundary decision (deferred until here) |
| `federationMeta` (klum-db) | group-level nav | klum-db, reuses `VaultMeta` |

## Open questions for when implementation is scheduled

- Editor package home + naming (a single `in-editor` core + per-framework
  bindings, vs a Nuxt playground app).
- Whether the codegen schema editor needs the **persisted serializable
  description** (deferred in Phase 0) to read existing collections from a
  bundle, or always operates against a live, code-declared deployment.
- Multi-record table editing, bulk operations, and undo — out of scope for the
  initial data-editor design.

## Non-goals (this design)

- No implementation.
- No runtime schema IR / no-code schema definition (explicitly rejected in
  favor of codegen).
- No new migration mechanism (schema changes ride the existing code +
  schema-update path).
