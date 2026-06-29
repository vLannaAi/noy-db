# Metadata ladder + schema surfacing — design

> Milestone #20 (field-metadata epic), continuation. Builds on the
> `fieldMeta`/`describe()` foundation
> ([2026-06-25-field-metadata-foundation-design.md](2026-06-25-field-metadata-foundation-design.md),
> PR #490). **Stacks on `feat/field-metadata-foundation`** → one PR, one
> pre-release (#482 + #483 + this).

**Status:** design approved 2026-06-25, pre-implementation.

---

## Problem

The field-metadata epic gave noy-db a per-**field** descriptive layer
(`fieldMeta` + `collection.describe()`). Two gaps remain before any
viewer/editor can present a noy-db deployment well:

1. **The metadata ladder is incomplete.** A UI that browses a deployment
   needs friendly labels/descriptions at every level — *field → collection →
   vault → federation*. Today only the field level exists. A nav sidebar, the
   future editor, an API doc, and an export filename all want a collection's
   "Sales Invoices" and a vault's "Acme Books 2026", not raw identifiers.
2. **The display tools show almost nothing of recent features.** The devtools
   (Nuxt `SchemaPane`, the TUI) render `in-devtools` `snapshot()`, which calls
   `vault.dumpSchema()` and shows only field `type`/`indexed`/`stats` — none
   of the `describe()` richness (label/money/dict/sensitivity) and none of the
   collection-level config (i18n, embeddings, retrieve, CEK, provenance,
   archive, tiers, crdt). All of it is surfaced **nowhere**.

This spec completes the ladder (collection + vault meta) and makes the **live
devtools** surface the full schema picture. (CLI/offline-bundle richness is
deliberately **deferred** — collection options live in code, not the bundle;
revisited only if a serializable persisted description is added later.)

## Goals

- Add `collectionMeta` + `vaultMeta` descriptor layers, consistent with
  `fieldMeta`; export the meta types as a shared contract (klum-db's
  federation meta reuses `VaultMeta`).
- Enhance `describe()` with the data-editor read-side: `i18n`, `widget`,
  `editable`, and collection-level `meta`.
- Add a collection-level `config` block to `dumpSchema()` (the structural
  half of the hybrid read-model).
- Wire all of it into the **live devtools** (`in-devtools` `snapshot()` →
  Nuxt `SchemaPane` + TUI).

## Non-goals

- **No CLI/bundle richness** this cycle (deferred decision).
- **No persistence** of the meta/config (code options only, like `fieldMeta`;
  not written to `_schemas`).
- **No editor** (separate design:
  [2026-06-25-interactive-editor-design.md](2026-06-25-interactive-editor-design.md)).
- **No federation meta** in noy-db (federation lives in klum-db; noy-db only
  exports the `VaultMeta` shape — klum-db implements `groupMeta` separately).
- `fieldMeta.group`/section is **deferred** (see Boundary note).

## Binding invariants (carried from the foundation)

- **Descriptive, never prescriptive.** Meta carries label/description/icon
  (a friendly identity), never layout/order/styling. Litmus: "would a second,
  unrelated consumer want this fact?" — a friendly collection name: yes.
- hub stays **validator-agnostic**; no static `import 'zod'` in `hub/src`.
- `describe()` (sync) stays **zero store I/O**.
- New public symbols re-export from `src/index.ts`; meta **types** also from
  `kernel/index.ts` (klum contract). Tests live under
  `packages/hub/__tests__/**`. DTS build (`exactOptionalPropertyTypes`) is
  stricter than vitest tsc — run the build.

---

## Component 1 — the meta types

New file `packages/hub/src/introspection/meta.ts` (or extend
`field-meta.ts`):

```ts
/** A collection's own descriptive metadata (its identity, not its fields). */
export interface CollectionMeta {
  label?: string          // friendly name; falls back to humanized collection name
  description?: string
  icon?: string           // semantic icon NAME (e.g. a Lucide key), not styling
  pluralLabel?: string    // "Invoice" → "Invoices" for list headers
}

/** A vault's own descriptive metadata. */
export interface VaultMeta {
  label?: string          // friendly name; falls back to the vault name
  description?: string
  icon?: string
}
```

Note the ladder asymmetry: `FieldMeta.label` is **required** (a field has no
human name otherwise), but `CollectionMeta`/`VaultMeta.label` are **optional**
— the collection/vault name is the fallback identity.

**Exports:** `CollectionMeta`, `VaultMeta` from `src/index.ts` AND
`kernel/index.ts` (klum-db's `groupMeta` reuses `VaultMeta`).

## Component 2 — `collectionMeta`

- Add `meta?: CollectionMeta` to `CollectionOptions` (`vault.ts`), beside
  `fieldMeta`.
- Store on `Collection` (private `meta` + `getMeta(): CollectionMeta |
  undefined`); add a first-wins reconciler `_applyMeta(meta)` and call it in
  the cached-collection branch in `vault.ts` (mirror `_applyFieldMeta` exactly
  — same MV-pre-created-collection fix).
- Surface in `describe()`: `CollectionDescription` gains
  `meta?: CollectionMeta` (with `label` defaulting to the humanized collection
  name when absent).
- Surface in `dumpSchema()`: `CollectionDescriptor` gains `meta?:
  CollectionMeta`.

## Component 3 — `vaultMeta`

- Add `meta?: VaultMeta` to `openVault(name, { locale?, create?, meta? })`
  (`noydb.ts`). **First-wins**: applied on first open; a cached vault keeps its
  meta (consistent with the collection reconciler semantics).
- Store on `Vault` (`this.meta` + `getMeta(): VaultMeta | undefined`).
- Surface in `dumpSchema()`: `VaultSchemaSnapshot` gains `meta?: VaultMeta`
  (label defaulting to the vault name).

## Component 4 — `describe()` per-field enhancements

Add to `DescribedField` (and compute in `buildDescription`):

- `i18n?: { locales?: readonly string[]; densify?: boolean }` — surfaced from
  the `i18nFields` registry (currently NOT merged by `describe()`). Pass the
  collection's `i18nFields` into `buildDescription`; for an i18n field set the
  block and `type: 'string'`.
- `widget?: string` — **derived** from `semanticType` + `type`, overridable
  via a new optional `FieldMeta.widget`:
  | source | widget |
  |---|---|
  | semanticType `date`/`datetime` | `date` |
  | semanticType `currency` (money) | `money` |
  | semanticType `entity` (ref) | `ref-select` |
  | `dict` present | `select` |
  | type `boolean` | `checkbox` |
  | semanticType `percent`/`url`/`email` | `number`/`url`/`email` |
  | else | `text` |
  `FieldMeta.widget` (new optional member) overrides the derivation.
- `editable: boolean` — `false` for `computed` fields, the `id` field, and
  `provenance`-stamped fields; `true` otherwise. Drives read-only rendering.

## Component 5 — `dumpSchema()` collection-level `config`

Add `config?` to `CollectionDescriptor`, populated from the **live**
collection's getters/registries (omitted when reconstructed from a bundle,
where options aren't available):

```ts
config?: {
  i18nFields?: readonly string[]
  embeddings?: { source: string; dim: number; model?: string }
  textIndexes?: readonly string[]
  textIndexPersist?: boolean
  perRecordKeys?: boolean
  provenance?: boolean
  archive?: boolean            // presence (the predicate is code)
  tiers?: readonly number[]
  tierMode?: string
  crdt?: string
  conflictPolicy?: boolean     // presence (the resolver is code)
  history?: boolean            // presence
  schemaUpdate?: readonly string[]   // strategy names (already available)
}
```

`dumpVaultSchema` (`introspection/walk.ts`) reads these from the live
`Collection` when present. Add minimal getters on `Collection` for the options
not already reachable. Function-valued options surface as booleans (presence),
never the function.

## Component 6 — devtools wiring (the payoff)

- **`in-devtools` `snapshot()`** (`snapshot.ts`): for each collection, in
  addition to the `dumpSchema` descriptor, call
  `vault.collection(name).describe()` (rich per-field) and include `config` +
  `meta`. Extend `InspectorCollection`:
  ```ts
  interface InspectorCollection {
    name: string
    meta?: CollectionMeta
    fields: CollectionDescriptor['fields']        // keep (back-compat)
    described?: readonly DescribedField[]          // NEW: rich per-field
    indexes: CollectionDescriptor['indexes']
    refs: CollectionDescriptor['refs']
    config?: CollectionDescriptor['config']        // NEW
    stats?: CollectionStats
  }
  ```
  and `InspectorSnapshot` gains `meta?: VaultMeta`.
- **Nuxt `SchemaPane.vue`**: render the rich fields — label, type,
  `semanticType` badge, money currency, dict values, **sensitivity** & **i18n**
  badges, ref target, `editable` flag — plus a collection **meta header**
  (label/description) and a collapsible **config strip** (embeddings / retrieve
  / CEK / provenance / archive badges). `DevtoolsPanel.vue` vault sidebar shows
  the `vaultMeta` label.
- **`in-devtools-tui`**: mirror the same rich rendering in the terminal views.

## Boundary note — `fieldMeta.group`

A per-field `group`/section ("Tax info", "Address") is **deferred**. It sits
on the descriptive/prescriptive line: a *logical grouping* is arguably a
semantic category a second consumer wants (data), but it can also encode form
layout (app-side). Decision deferred to the editor's Phase-1 form-sectioning
work, where the real requirement appears. Not built this cycle.

---

## Testing

- **Meta ladder:** `collectionMeta`/`vaultMeta` surface in `describe()` /
  `dumpSchema()`; label falls back to humanized collection / vault name when
  absent; `_applyMeta` first-wins for a re-declared (MV-pre-created)
  collection (mirror the `_applyFieldMeta` test).
- **describe() enhancements:** an i18n field yields the `i18n` block; `widget`
  derives correctly per `semanticType` and is overridden by `fieldMeta.widget`;
  `computed`/`id`/`provenance` fields report `editable:false`, others `true`.
- **config block:** a collection declared with embeddings/textIndexes/crdt/etc.
  surfaces them in `dumpSchema().collections[x].config`; a bundle-reconstructed
  collection omits `config`; function-valued options surface as booleans.
- **Validator-agnostic / zero-IO** invariants still hold (re-assert for the
  enhanced `describe()`).
- **Devtools:** an `in-devtools` `snapshot()` test asserts `described`/`config`
  /`meta` are populated for a live vault; Nuxt/TUI component rendering tests if
  the packages have them (else a snapshot-shape test).
- **DTS build** + `check-architecture` clean; new public symbols verified via
  showcase typecheck (build hub first).

## Public exports & kernel

- `src/index.ts`: `CollectionMeta`, `VaultMeta`, and the new `DescribedField`
  members are covered by the existing `CollectionDescription`/`DescribedField`
  re-export; add `FieldMeta.widget` (same `FieldMeta` export).
- `kernel/index.ts`: add `CollectionMeta`, `VaultMeta` types (klum-db
  contract). `describe()`-level types stay out of kernel (per-collection
  introspection, per the foundation spec).

## features.yaml

Extend the `field-metadata` node (or add a sibling `metadata-ladder` node)
referencing this spec + the devtools surfacing; CI "Spec coverage" must stay
green.

## Release

Stacks on `feat/field-metadata-foundation` (PR #490). One pre-release bundles
#482 + #483 + this metadata ladder + devtools surfacing.

## Follow-up (separate)

- **klum-db issue:** `federationMeta`/`groupMeta` on `VaultGroup`, reusing
  noy-db's `VaultMeta` shape (this repo exports the type; klum-db wires it).
- The **interactive editor** (Phases 1–2) — see the editor design doc; its
  Phase-0 dependencies (`describe()` enhancements + meta ladder) are satisfied
  by this spec.
