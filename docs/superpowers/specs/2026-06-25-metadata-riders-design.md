# Milestone-#20 riders — design (#484 toJSONSchema + devtools PII masking + #485 dictKey labels)

> Three riders on the shipped field-metadata foundation
> ([field-metadata-foundation](2026-06-25-field-metadata-foundation-design.md) +
> [metadata-ladder-and-schema-surfacing](2026-06-25-metadata-ladder-and-schema-surfacing-design.md)).
> **Stacks on `feat/field-metadata-foundation`** (PR #490) → one PR, one
> pre-release.

**Status:** design approved 2026-06-25, pre-implementation.

---

## Problem

The field-metadata epic shipped `describe()` + `fieldMeta` + the zod-4
substrate + the metadata ladder + live-devtools surfacing. Three small,
high-leverage riders now compose on top of that and round out milestone #20:

1. **#484 `collection.toJSONSchema()`** — the read-model's third consumer.
   `describe()` serves JS; a JSON-Schema export serves *everything else*
   (OpenAPI, cross-language, form builders, doc tooling). Mostly plumbing now
   that the zod-4 `z.toJSONSchema()` path exists.
2. **Devtools PII masking** — the devtools already *display* a field's
   sensitivity (pii/secret badges) but the RecordsPane still shows raw PII
   values. The classification should actually protect something on a
   screen-shared dev tool.
3. **#485 dictKey inline labels** — `dictKey` carries only codes today; labels
   live in the dynamic `_dict_` collection. Let `dictKey` carry inline
   code-provided labels as a display fallback, surfaced through `describe()`.

## Goals / non-goals

- Build the three riders; ship with #490's bundle.
- Stay **descriptive, never prescriptive**; hub **validator-agnostic** (no
  static `import 'zod'`); `describe()` sync stays **zero store I/O**.
- **Non-goal:** #486 redacting *export* (#489, as-* family) — separate. The
  hub `sensitivity` flag already shipped; this spec only *consumes* it (in the
  devtools). `fieldMeta.group`, ref-option-source, the editor — all still out.

## Binding conventions (carried)

Tests under `__tests__/**`; pnpm; the DTS build (`exactOptionalPropertyTypes`)
is stricter than vitest tsc — and **`npm run typecheck` + `eslint src/` per
changed package** before push (the tsup build enforces neither — a CI lesson
from this branch). New public symbols re-export from `src/index.ts`. No Claude
attribution in commits.

---

## Rider ① — `collection.toJSONSchema()`  (#484)

**Async** (needs the lazy zod-4 derivation). New method on `Collection`:

```ts
async toJSONSchema(): Promise<object>
```

Pipeline:
1. `derivePersistedSchema(this.schema)` → the base JSON Schema (the zod-4
   `z.toJSONSchema()` path #482 wired; zod-3 via `zod-to-json-schema`).
2. `await this.describe({})` → the normalized per-field metadata.
3. Overlay `describe()` metadata onto each property as **`x-` extension keys**
   (keeps the output a valid JSON Schema):
   | describe() field | JSON-Schema key |
   |---|---|
   | `label` | `x-label` |
   | `unit` | `x-unit` |
   | `semanticType` | `x-semanticType` |
   | `sensitivity` | `x-sensitivity` |
   | `widget` | `x-widget` |
   | `editable` (when false) | `x-readonly: true` |
   | `money` | `x-money` (currency/scale) |
   | `ref` | `x-ref` (target) |
   | `dict.values[].label` | `x-enumLabels` (value→label map) |

**Validator-agnostic fallback:** when `derivePersistedSchema` yields no
`jsonSchema` (non-zod validator), build a **minimal** JSON Schema —
`{ type:'object', properties }` with each property's `type` mapped from
`describe()`'s field `type` — so `toJSONSchema()` still returns a useful,
metadata-bearing schema for any validator (and even for schema-less
collections, from the config-inferred field types).

**Placement/exports:** a focused `introspection/json-schema.ts`
(`buildJsonSchema(describeResult, baseJsonSchema?)` pure overlay) + the thin
async `Collection.toJSONSchema()` delegator. Export nothing new beyond the
method (it returns a plain object). No kernel export.

## Rider ② — Devtools PII masking

The `in-devtools` snapshot already carries `described` (with `sensitivity`)
per collection. The **RecordsPane** (Nuxt `panes/RecordsPane.vue` + TUI
`panes/RecordsPane.tsx`) masks values for fields where
`sensitivity !== 'public'`.

**UX (decided): mask-by-default, reveal-on-demand.**
- pii **and** secret values render as `••••••` by default.
- per-field **reveal** (click in Nuxt / a key-toggle in the TUI) un-masks that
  field; a header **"reveal all"** toggle un-masks the whole pane.
- public fields (and unclassified fields) always show.
- This is shoulder-surfing / screen-share safety over already-decrypted local
  data — **not** access control (the data is already in the trusted tier).

**Data flow:** the pane derives a `Set<fieldKey>` of sensitive fields from the
collection's `described` (`sensitivity !== 'public'`). Reveal state is local
component state (a revealed-field set + a reveal-all boolean). No hub change —
pure consumer of the metadata already in the snapshot.

**Back-compat:** a collection without `described` (pre-enrichment / non-live)
has an empty sensitive-set → nothing masked → identical to today.

## Rider ③ — `dictKey` inline labels  (#485)

`dictKey` gains an optional inline label map (back-compat preserved):

```ts
// today (still valid):
dictKey('saleStatus', ['draft', 'to_verify', 'paid'] as const)
// new — value→label map (keys inferred from the map):
dictKey('saleStatus', { draft: 'Draft', to_verify: 'To Verify', paid: 'Paid' })
// or array + labels option (preserves explicit order):
dictKey('saleStatus', VALUES, { labels: { to_verify: 'To Verify' } })
```

- `DictKeyDescriptor` gains `readonly labels?: Record<string, string>`.
- `dictKey()` overload: if the 2nd arg is a **plain object**, treat it as the
  value→label map (`keys = Object.keys`, `labels = map`); if an **array**,
  keep current behavior + read `opts.labels`. Declared key order stays the
  canonical display/sort order.

**Semantics — display fallback (the YAGNI delta vs `staticDict`):** the inline
labels are code-provided **defaults**. `dictKey` stays dynamic/runtime-editable
against `_dict_`; the inline label is used when the dynamic dictionary has no
label for a key. So:
- `describe()` (**sync**) now surfaces inline-dictKey labels into
  `dict.values[].label` (code-provided → no store read needed, like
  `staticDict`).
- `describe({ resolveDictLabels: true })` (**async**) overrides/fills from the
  `_dict_` collection where present, falling back to the inline label
  otherwise.
- `toJSONSchema()` `x-enumLabels` picks them up via `describe()`.

This keeps `staticDict` (closed code labels, no `_dict_`) and `dictKey`+labels
(dynamic dict *with* code defaults) as distinct, non-overlapping tools.

---

## Testing

- **#484:** a zod-4 collection with money/ref/dict/sensitivity/i18n →
  `toJSONSchema()` is valid JSON Schema with the right `x-` keys per property
  (`x-money`, `x-enumLabels`, `x-sensitivity`, …); a **non-zod**
  Standard-Schema collection → minimal schema from field types + `x-` metadata,
  no throw, no zod required (agnostic invariant); enum field → `x-enumLabels`
  matches the dict labels.
- **masking:** RecordsPane renders `••••` for a pii and a secret field by
  default; reveal un-masks that field; reveal-all un-masks all; a public field
  is never masked; a collection without `described` masks nothing
  (back-compat). Nuxt component test + TUI snapshot test.
- **#485:** map form and array+`labels` form both produce labels; bare-array
  form unchanged; inline labels surface in **sync** `describe().dict.values`;
  `resolveDictLabels:true` overrides from `_dict_` and falls back to inline;
  `toJSONSchema` `x-enumLabels` reflects them.

## features.yaml / docs

Extend the `field-metadata` / `metadata-ladder` nodes (or a `metadata-riders`
node) referencing this spec, the `toJSONSchema` public surface, and the
devtools masking; keep CI Spec-coverage green. Note `toJSONSchema` + masking in
the subsystem doc.

## Decomposition

Three independent units, one spec, one plan (grouped tasks):
- **A. hub** — `dictKey` labels + `describe()` sync surfacing (#485), then
  `toJSONSchema()` (#484, consumes #485's labels for `x-enumLabels`).
- **B. devtools** — RecordsPane masking (Nuxt + TUI), independent of A.

Order A before B is not required (B reads only `sensitivity`, already shipped),
but #484's `x-enumLabels` test wants #485's labels, so do #485 → #484 within A.

## Release

Stacks on PR #490; ships with the same next additive pre-release
(#482 + #483 + metadata ladder + devtools + these three riders).
