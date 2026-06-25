# Metadata Ladder + Schema Surfacing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the descriptive metadata ladder (`collectionMeta` + `vaultMeta` atop the existing `fieldMeta`) and make the live devtools surface the full schema picture (rich per-field `describe()` + collection-level config + the meta ladder).

**Architecture:** Extends the just-built `fieldMeta`/`describe()`/`buildDescription` foundation on branch `feat/field-metadata-foundation`. Hub gains two new descriptor layers (collection + vault meta), three per-field `describe()` enhancements (i18n/widget/editable), and a collection-level `config` block on `dumpSchema()`. Then `in-devtools` `snapshot()` merges `describe()`+config+meta and the Nuxt/TUI viewers render it. Descriptive-only; code options, not persisted; live-devtools path only (CLI deferred).

**Tech Stack:** TypeScript, Vitest, Standard Schema v1, Vue (Nuxt devtools), Ink/React (TUI).

## Global Constraints

- **Builds on `feat/field-metadata-foundation`** (PR #490): `fieldMeta`, `collection.describe()` (sync + async), `buildDescription` in `introspection/describe.ts`, `FieldMeta`/`DescribedField`/`CollectionDescription` types, `getFieldMeta()`/`_applyFieldMeta()` on Collection. Do NOT switch branches.
- **Descriptive, never prescriptive.** Meta = label/description/icon/pluralLabel only. No layout/order/styling/active-locale.
- hub stays **validator-agnostic**: no static `import 'zod'` in `packages/hub/src`.
- `describe()` (sync, zero-arg) does **zero store I/O**.
- **Test files live under `packages/hub/__tests__/**`** (and each package's `__tests__`/test dir) — a `.test.ts` under `src/` is silently ignored by vitest. Import the module under test via the correct relative depth.
- **Package manager is pnpm**; `npm test --prefix packages/<pkg> -- <pattern>` runs focused tests. The DTS **build** (`npm run build --prefix packages/hub`) is stricter than vitest tsc under `exactOptionalPropertyTypes` — run it. Use conditional spreads for optional props; never assign `undefined`.
- New public symbols re-export from `src/index.ts`; the meta **types** (`CollectionMeta`, `VaultMeta`) ALSO export from `src/kernel/index.ts` (klum-db contract). Verify barrels via `npm run build --prefix packages/hub` + showcase typecheck.
- Kernel-surface ceilings (collection.ts, vault.ts, noydb.ts) enforced by `scripts/check-architecture.mjs` — raise minimally with a justification comment if needed.
- No `Co-Authored-By: Claude` / "Generated with Claude Code" in commits.
- Spec: `docs/superpowers/specs/2026-06-25-metadata-ladder-and-schema-surfacing-design.md`.

---

### Task 1: Meta types + `collectionMeta`

**Files:**
- Create: `packages/hub/src/introspection/meta.ts`
- Modify: `packages/hub/src/vault.ts` (CollectionOptions ~672-770; cached-collection reconcile branch ~805-822 next to `_applyFieldMeta`)
- Modify: `packages/hub/src/collection.ts` (store + getter + reconciler, mirror `getFieldMeta`@1173 / `_applyFieldMeta`@1264)
- Modify: `packages/hub/src/introspection/describe.ts` (CollectionDescription + buildDescription)
- Modify: `packages/hub/src/introspection/types.ts` (CollectionDescriptor)
- Modify: `packages/hub/src/introspection/walk.ts` (populate descriptor.meta)
- Modify: `packages/hub/src/index.ts` + `packages/hub/src/kernel/index.ts` (exports)
- Test: `packages/hub/__tests__/introspection/meta.test.ts`

**Interfaces:**
- Produces: `CollectionMeta { label?: string; description?: string; icon?: string; pluralLabel?: string }`; `CollectionOptions.meta?: CollectionMeta`; `Collection.getMeta(): CollectionMeta | undefined`; `Collection._applyMeta(meta: CollectionMeta): void` (first-wins); `CollectionDescription.meta?: CollectionMeta` (label defaults to humanized collection name); `CollectionDescriptor.meta?: CollectionMeta`.

- [ ] **Step 1: Write the failing test**

In `packages/hub/__tests__/introspection/meta.test.ts` (real harness: `createNoydb({store: memory(), user, secret})` → `await db.openVault('v')` → `v.collection(name, {meta})`):
```ts
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../../src/index.js'
import { memory } from '@noy-db/to-memory'

describe('collectionMeta', () => {
  it('surfaces collection meta in describe() with label fallback', async () => {
    const db = createNoydb({ store: memory(), user: 'u', secret: 's' })
    const v = await db.openVault('v')
    const sales = v.collection('sales', { meta: { label: 'Sales', description: 'Invoices', icon: 'receipt' } })
    expect(sales.describe().meta).toMatchObject({ label: 'Sales', description: 'Invoices', icon: 'receipt' })
    const plain = v.collection('line_items', {})
    expect(plain.describe().meta?.label).toBe('Line Items')   // humanized fallback
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test --prefix packages/hub -- meta`
Expected: FAIL — `meta` not on options / not on describe output.

- [ ] **Step 3: Create the meta types**

`packages/hub/src/introspection/meta.ts`:
```ts
/**
 * Descriptive metadata for the collection and vault levels of the metadata
 * ladder (field level = FieldMeta). Identity, not structure: label /
 * description / icon only. Descriptive, never prescriptive.
 * @module
 */

/** A collection's own descriptive metadata. */
export interface CollectionMeta {
  /** Friendly name; falls back to the humanized collection name. */
  label?: string
  description?: string
  /** Semantic icon NAME (e.g. a Lucide key), not styling. */
  icon?: string
  /** Plural form for list headers ("Invoice" → "Invoices"). */
  pluralLabel?: string
}

/** A vault's own descriptive metadata. */
export interface VaultMeta {
  label?: string
  description?: string
  icon?: string
}
```

- [ ] **Step 4: Thread `meta` through collection options + storage + reconciler**

In `vault.ts` CollectionOptions add (next to `fieldMeta`):
```ts
/** The collection's own descriptive metadata (label/description/icon). See collection.describe(). */
meta?: import('./introspection/meta.js').CollectionMeta
```
Thread `meta: options.meta` into the `new Collection(...)` opts (mirror `fieldMeta`). In the cached-collection branch where `coll._applyFieldMeta(options.fieldMeta)` is called, add `if (options?.meta) coll._applyMeta(options.meta)`.

In `collection.ts`: add `private readonly meta: CollectionMeta | undefined` assigned from `opts.meta`; mirror the getter + reconciler:
```ts
import type { CollectionMeta } from './introspection/meta.js'
// ...
/** The collection's declared descriptive metadata. */
getMeta(): CollectionMeta | undefined { return this.meta }
/** First-wins reconcile for MV-pre-created collections (mirrors _applyFieldMeta). */
_applyMeta(meta: CollectionMeta): void { if (this.meta === undefined) (this as { meta: CollectionMeta | undefined }).meta = meta }
```
(Match how `_applyFieldMeta` mutates a `readonly` field — copy its exact technique.)

- [ ] **Step 5: Surface in describe() + dumpSchema + humanize fallback**

In `describe.ts`: add `meta?: CollectionMeta` to `CollectionDescription`; in the `describe()`/`describeAsync()` callers pass `meta: this.getMeta()` into `buildDescription`; in `buildDescription` set `meta` with a label fallback: `{ ...meta, label: meta?.label ?? humanizeFieldKey(collection) }` (reuse `humanizeFieldKey` for the collection name). Use a conditional spread so an all-undefined meta still yields `{ label: humanized }`.

In `introspection/types.ts`: add `readonly meta?: CollectionMeta` to `CollectionDescriptor`.
In `introspection/walk.ts`: where each `CollectionDescriptor` is built, set `meta` from the live collection's `getMeta()` when available (the live `Collection` is reachable via the vault; mirror however `walk.ts` already reaches collection instances — if it only has names, add the meta from `vault.collection(name).getMeta()` guarded by existence).

- [ ] **Step 6: Exports**

`src/index.ts`: `export type { CollectionMeta, VaultMeta } from './introspection/meta.js'`.
`src/kernel/index.ts`: `export type { CollectionMeta, VaultMeta } from '../introspection/meta.js'`.
(VaultMeta is exported now though used in Task 2 — one export edit.)

- [ ] **Step 7: Run tests + build + arch**

Run: `npm test --prefix packages/hub -- meta describe` → PASS.
Run: `npm run build --prefix packages/hub` → DTS clean.
Run: `node scripts/check-architecture.mjs` → OK.

- [ ] **Step 8: Commit**

```bash
git add packages/hub/src/introspection/meta.ts packages/hub/src/vault.ts packages/hub/src/collection.ts packages/hub/src/introspection/describe.ts packages/hub/src/introspection/types.ts packages/hub/src/introspection/walk.ts packages/hub/src/index.ts packages/hub/src/kernel/index.ts packages/hub/__tests__/introspection/meta.test.ts
git commit -m "feat(hub): collectionMeta + meta types (CollectionMeta/VaultMeta) (#483)"
```

---

### Task 2: `vaultMeta`

**Files:**
- Modify: `packages/hub/src/noydb.ts` (openVault opts ~501-504)
- Modify: `packages/hub/src/vault.ts` (store + getter)
- Modify: `packages/hub/src/introspection/types.ts` (VaultSchemaSnapshot)
- Modify: `packages/hub/src/introspection/walk.ts` (populate snapshot.meta)
- Test: `packages/hub/__tests__/introspection/meta.test.ts` (append)

**Interfaces:**
- Consumes: `VaultMeta` (Task 1).
- Produces: `openVault(name, { locale?, create?, meta? })`; `Vault.getMeta(): VaultMeta | undefined`; `VaultSchemaSnapshot.meta?: VaultMeta`.

- [ ] **Step 1: Write the failing test**

Append to `meta.test.ts`:
```ts
it('surfaces vaultMeta on dumpSchema, first-wins', async () => {
  const db = createNoydb({ store: memory(), user: 'u', secret: 's' })
  const v = await db.openVault('books', { meta: { label: 'Acme Books', description: '2026' } })
  v.collection('sales', {})
  const dump = await v.dumpSchema()
  expect(dump.meta).toMatchObject({ label: 'Acme Books', description: '2026' })
  // re-open with different meta → first-wins keeps original
  const v2 = await db.openVault('books', { meta: { label: 'OTHER' } })
  expect(v2.getMeta()?.label).toBe('Acme Books')
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test --prefix packages/hub -- meta`
Expected: FAIL — `meta` not accepted/surfaced.

- [ ] **Step 3: Add `meta` to openVault + store first-wins on Vault**

In `noydb.ts` openVault: widen `opts?: { locale?: string; create?: boolean; meta?: VaultMeta }` (import `VaultMeta` type-only). On the cache-hit path, do NOT overwrite (first-wins): only when constructing a fresh `Vault`, pass `meta: opts?.meta`. On cache hit, leave existing meta untouched (mirror how `locale` is handled but WITHOUT the update — meta is first-wins).

In `vault.ts`: add `private readonly meta: VaultMeta | undefined` from `opts.meta`; add `getMeta(): VaultMeta | undefined { return this.meta }`.

- [ ] **Step 4: Surface on the snapshot**

In `introspection/types.ts`: add `readonly meta?: VaultMeta` to `VaultSchemaSnapshot`.
In `walk.ts` `dumpVaultSchema`: set `meta` from the vault's `getMeta()` when present.

- [ ] **Step 5: Run tests + build + arch**

Run: `npm test --prefix packages/hub -- meta` → PASS.
Run: `npm run build --prefix packages/hub` → clean. `node scripts/check-architecture.mjs` → OK.

- [ ] **Step 6: Commit**

```bash
git add packages/hub/src/noydb.ts packages/hub/src/vault.ts packages/hub/src/introspection/types.ts packages/hub/src/introspection/walk.ts packages/hub/__tests__/introspection/meta.test.ts
git commit -m "feat(hub): vaultMeta via openVault({meta}), first-wins (#483)"
```

---

### Task 3: `describe()` per-field enhancements — i18n / widget / editable

**Files:**
- Modify: `packages/hub/src/introspection/field-meta.ts` (FieldMeta gains `widget?`)
- Modify: `packages/hub/src/introspection/describe.ts` (DescribedField + buildDescription)
- Modify: `packages/hub/src/collection.ts` (pass i18nFields into buildDescription)
- Test: `packages/hub/__tests__/introspection/describe.test.ts` (append)

**Interfaces:**
- Produces: `FieldMeta.widget?: string`; `DescribedField` gains `i18n?: { locales?: readonly string[]; densify?: boolean }`, `widget?: string`, `editable: boolean`.

- [ ] **Step 1: Write the failing test**

Append to `describe.test.ts` (build a collection with an `i18nFields` text field, a money field, a computed field, an `id`):
```ts
it('surfaces i18n, derived widget, and editable', async () => {
  // sales: total (money), saleDate (z.iso.date), name (i18nText), subtotal (computed)
  const d = sales.describe()
  const by = Object.fromEntries(d.fields.map(f => [f.key, f]))
  expect(by.total.widget).toBe('money')
  expect(by.saleDate.widget).toBe('date')
  expect(by.name.i18n).toBeDefined()            // i18n block present
  expect(by.subtotal.editable).toBe(false)      // computed → read-only
  expect(by.total.editable).toBe(true)
})
it('fieldMeta.widget overrides the derived widget', async () => {
  const f = withWidgetOverride.describe().fields.find(x => x.key === 'note')!
  expect(f.widget).toBe('textarea')             // fieldMeta:{ note:{ widget:'textarea' } }
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test --prefix packages/hub -- describe`
Expected: FAIL — i18n/widget/editable absent.

- [ ] **Step 3: Implement**

In `field-meta.ts`: add `widget?: string` to `FieldMeta`.

In `describe.ts`:
- Add to `DescribedField`: `readonly i18n?: { locales?: readonly string[]; densify?: boolean }`, `readonly widget?: string`, `readonly editable: boolean`.
- `buildDescription` accepts a new `i18nFields?: Record<string, I18nTextDescriptor>` input (passed from the collection). For a field present in `i18nFields`, set `type:'string'` and an `i18n` block (`locales` from the descriptor's declared locales if available, `densify` from `densifyOnWrite`). Read the `I18nTextDescriptor` shape from `packages/hub/src/i18n/` to fill these (use only fields that exist; omit `locales` if the descriptor doesn't enumerate them).
- Compute `widget` per the spec table (override with `fieldMeta.widget` / `zodMeta.widget` first):
  ```ts
  function deriveWidget(f: { semanticType?: string; type: string; dict?: unknown; widget?: string }): string {
    if (f.widget) return f.widget
    switch (f.semanticType) {
      case 'date': case 'datetime': return 'date'
      case 'currency': return 'money'
      case 'entity': return 'ref-select'
      case 'url': return 'url'
      case 'email': return 'email'
      case 'percent': return 'number'
    }
    if (f.dict) return 'select'
    if (f.type === 'boolean') return 'checkbox'
    if (f.type === 'number') return 'number'
    return 'text'
  }
  ```
  (Thread `fieldMeta.widget` into the resolved meta so it reaches here; `resolveFieldMeta` should carry `widget` through — add it to the picked keys.)
- Compute `editable`: `false` if `computed`, if `key === 'id'`, or if the field is provenance-stamped (the collection's `provenance` option + the provenance field names); else `true`.

In `collection.ts`: pass `i18nFields: this.i18nFields` (private field @323) into both `buildDescription` call-sites (sync + async).

- [ ] **Step 4: Run tests + build**

Run: `npm test --prefix packages/hub -- describe` → PASS.
Run: `npm run build --prefix packages/hub` → clean (watch `exactOptionalPropertyTypes` on the new optional members; conditional spreads).

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/introspection/field-meta.ts packages/hub/src/introspection/describe.ts packages/hub/src/collection.ts packages/hub/__tests__/introspection/describe.test.ts
git commit -m "feat(hub): describe() i18n/widget/editable per-field enhancements (#483)"
```

---

### Task 4: `dumpSchema()` collection-level `config` block

**Files:**
- Modify: `packages/hub/src/introspection/types.ts` (CollectionDescriptor.config)
- Modify: `packages/hub/src/collection.ts` (a `getConfig()` aggregator)
- Modify: `packages/hub/src/introspection/walk.ts` (populate descriptor.config)
- Test: `packages/hub/__tests__/introspection/dump-schema.test.ts` (or the existing introspection dump test — check `__tests__/introspection/`)

**Interfaces:**
- Produces: `CollectionDescriptor.config?` (shape per spec Component 5); `Collection.getConfig(): CollectionConfig | undefined`.

- [ ] **Step 1: Write the failing test**

Append to the existing `__tests__/introspection/dump-schema.test.ts`:
```ts
it('surfaces collection-level config (embeddings/textIndexes/crdt/provenance/tiers)', async () => {
  // declare a collection with embeddings + textIndexes + provenance:true + tiers:[1,2]
  const dump = await v.dumpSchema()
  const cfg = dump.collections['docs'].config!
  expect(cfg.textIndexes).toContain('body')
  expect(cfg.provenance).toBe(true)
  expect(cfg.tiers).toEqual([1, 2])
  expect(cfg.embeddings?.dim).toBeGreaterThan(0)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test --prefix packages/hub -- dump-schema`
Expected: FAIL — `config` undefined.

- [ ] **Step 3: Implement**

In `types.ts` add to `CollectionDescriptor`:
```ts
readonly config?: {
  readonly i18nFields?: readonly string[]
  readonly embeddings?: { source: string; dim: number; model?: string }
  readonly textIndexes?: readonly string[]
  readonly textIndexPersist?: boolean
  readonly perRecordKeys?: boolean
  readonly provenance?: boolean
  readonly archive?: boolean
  readonly tiers?: readonly number[]
  readonly tierMode?: string
  readonly crdt?: string
  readonly conflictPolicy?: boolean
  readonly history?: boolean
  readonly schemaUpdate?: readonly string[]
}
```
Export this object type as `CollectionConfig` for reuse.

In `collection.ts` add `getConfig(): CollectionConfig | undefined` reading the existing private fields: `i18nFields`@323 (keys), `embeddings`@349 (source/dim/model), `textIndexes`@329, `provenance`@444, `tiers`@461 (Array.from), `tierMode`@462, `crdtMode`@496, `historyConfig`@183 (presence). For the fields without a private getter (textIndexPersist, perRecordKeys, conflictPolicy, schemaUpdate names) read the corresponding private fields — grep their declarations; surface function-valued ones (`conflictPolicy`) as a boolean presence. Return `undefined` when every entry would be empty.

In `walk.ts`: set `descriptor.config` from the live `collection.getConfig()` when the live instance is available; omit for bundle-reconstructed collections.

- [ ] **Step 4: Run tests + build + arch**

Run: `npm test --prefix packages/hub -- dump-schema` → PASS.
Run: `npm run build --prefix packages/hub` → clean. `node scripts/check-architecture.mjs` → OK.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/introspection/types.ts packages/hub/src/collection.ts packages/hub/src/introspection/walk.ts packages/hub/__tests__/introspection/dump-schema.test.ts
git commit -m "feat(hub): dumpSchema collection-level config block (#483)"
```

---

### Task 5: `in-devtools` snapshot enrichment

**Files:**
- Modify: `packages/in-devtools/src/types.ts` (InspectorCollection + InspectorSnapshot)
- Modify: `packages/in-devtools/src/snapshot.ts`
- Test: `packages/in-devtools/__tests__/snapshot.test.ts` (or the package's test dir — check)

**Interfaces:**
- Consumes: `collection.describe()`, `CollectionDescriptor.config`/`.meta`, `VaultSchemaSnapshot.meta`.
- Produces: `InspectorCollection` gains `described?: readonly DescribedField[]`, `config?`, `meta?`; `InspectorSnapshot` gains `meta?: VaultMeta`.

- [ ] **Step 1: Write the failing test**

In the in-devtools test dir:
```ts
it('snapshot includes describe() per-field + config + meta', async () => {
  // build a live vault with vaultMeta + a collection with meta + money + textIndexes
  const snap = await snapshot(vault)
  expect(snap.meta?.label).toBeDefined()
  const c = snap.collections.find(x => x.name === 'sales')!
  expect(c.meta?.label).toBe('Sales')
  expect(c.described?.some(f => f.widget === 'money')).toBe(true)
  expect(c.config).toBeDefined()
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test --prefix packages/in-devtools -- snapshot`
Expected: FAIL — `described`/`config`/`meta` absent.

- [ ] **Step 3: Implement**

In `types.ts` extend `InspectorCollection` with `meta?`, `described?: readonly DescribedField[]`, `config?` (import the hub types from `@noy-db/hub`); extend `InspectorSnapshot` with `meta?: VaultMeta`.

In `snapshot.ts`: keep the existing `dumpSchema({withStats:true})` call (for `fields`/`indexes`/`refs`/`stats`/`config`/`meta`), AND for each collection call `vault.collection(name).describe()` (sync) to get `described`; set `meta` from the descriptor's `meta`; set `config` from the descriptor's `config`; set the snapshot `meta` from `dump.meta`. Guard `vault.collection(name)` for collections that may not be live-declared (skip `described` if the call throws/returns no schema).

- [ ] **Step 4: Run tests + build**

Run: `npm test --prefix packages/in-devtools -- snapshot` → PASS.
Run: `npm run build --prefix packages/in-devtools` → clean.

- [ ] **Step 5: Commit**

```bash
git add packages/in-devtools/src/types.ts packages/in-devtools/src/snapshot.ts packages/in-devtools/__tests__
git commit -m "feat(in-devtools): enrich snapshot with describe() + config + meta (#483)"
```

---

### Task 6: Nuxt devtools rendering

**Files:**
- Modify: `packages/in-nuxt/src/runtime/devtools/SchemaPane.vue`
- Modify: `packages/in-nuxt/src/runtime/devtools/DevtoolsPanel.vue` (vault meta label)
- Test: a shape/snapshot test if the package tests components; else verify typecheck + manual render notes

**Interfaces:**
- Consumes: the enriched `InspectorCollection` (`described`/`config`/`meta`) + `InspectorSnapshot.meta`.

- [ ] **Step 1: Render the meta header + rich fields + config strip in SchemaPane.vue**

Replace the minimal field rows with rows driven by `collection.described` when present (fall back to `collection.fields` for back-compat): show `label` (from described) + `type` + a `semanticType`/`widget` badge, money currency (`field.money?.currency`), dict value count, and **badges** for `sensitivity` (`pii`/`secret`) and `i18n`. Add a collection **meta header** (`collection.meta?.label ?? collection.name` + description) above the rows, and a collapsible **config strip** rendering `collection.config` (embeddings / textIndexes / crdt / provenance / archive / tiers as small badges). Keep the existing stats line.

- [ ] **Step 2: Show vault meta label in DevtoolsPanel.vue**

In the vault sidebar/header, render `snapshot.meta?.label ?? vaultName` (+ description tooltip if present).

- [ ] **Step 3: Verify**

Run: `npm run build --prefix packages/in-nuxt` (or the package typecheck) → clean. If the package has a component test harness, add a render test asserting the sensitivity badge + meta header appear; otherwise note the manual-verification steps in the report.

- [ ] **Step 4: Commit**

```bash
git add packages/in-nuxt/src/runtime/devtools/SchemaPane.vue packages/in-nuxt/src/runtime/devtools/DevtoolsPanel.vue
git commit -m "feat(in-nuxt): rich schema pane — meta header, field badges, config strip (#483)"
```

---

### Task 7: TUI rendering + features.yaml + docs

**Files:**
- Modify: `packages/in-devtools-tui/src/**` (the structure/schema view)
- Modify: `features.yaml`
- Modify: `docs/subsystems/field-metadata.md` (extend) or a new `docs/subsystems/schema-introspection.md`
- Test: existing TUI tests / snapshot

**Interfaces:**
- Consumes: the enriched `InspectorSnapshot`.

- [ ] **Step 1: Mirror the rich rendering in the TUI**

In the TUI structure view, render the collection `meta.label`, the rich fields (label/type/widget + sensitivity/i18n markers), and a compact config line. Reuse the same `InspectorCollection` fields as Nuxt.

- [ ] **Step 2: Run TUI tests**

Run: `npm test --prefix packages/in-devtools-tui` → PASS (update snapshot tests if the rendered output changed intentionally).

- [ ] **Step 3: features.yaml + docs**

Extend the `field-metadata` node (or add a `metadata-ladder` node) in `features.yaml` with `spec: docs/superpowers/specs/2026-06-25-metadata-ladder-and-schema-surfacing-design.md`, the new public surface (`collectionMeta`/`vaultMeta`/`describe().widget`), and the devtools surfacing; ensure no dangling refs. Document the metadata ladder + the devtools schema view in the subsystem doc.

- [ ] **Step 4: Verify spec-coverage + arch**

Run the features validator (`grep -rn "validate-features" scripts package.json`) → 0 dangling refs. `node scripts/check-architecture.mjs` → OK.

- [ ] **Step 5: Commit**

```bash
git add packages/in-devtools-tui features.yaml docs
git commit -m "feat(in-devtools-tui): rich schema view + features.yaml + docs (#483)"
```

---

## Self-Review

**Spec coverage:**
- Meta types (CollectionMeta/VaultMeta) + kernel export → Task 1/2. ✓
- collectionMeta (option/storage/reconciler/describe/dumpSchema) → Task 1. ✓
- vaultMeta (openVault option/first-wins/snapshot) → Task 2. ✓
- describe() i18n/widget/editable + fieldMeta.widget → Task 3. ✓
- dumpSchema config block (live-only, presence for fn-valued) → Task 4. ✓
- in-devtools snapshot enrichment → Task 5. ✓
- Nuxt SchemaPane + vault meta → Task 6. ✓
- TUI + features.yaml + docs → Task 7. ✓
- fieldMeta.group DEFERRED (spec Boundary note) — intentionally no task. ✓
- CLI richness DEFERRED — intentionally no task. ✓

**Placeholder scan:** code steps carry concrete code; plumbing steps cite exact line numbers to mirror (`getFieldMeta`@1173/`_applyFieldMeta`@1264, private fields @183/323/329/349/444/461/462/496). The few "read the I18nTextDescriptor shape / grep the private field" notes are empirical-verification instructions with a concrete fallback (omit a sub-field if absent), not placeholders.

**Type consistency:** `CollectionMeta`/`VaultMeta`/`CollectionConfig`/`DescribedField`(+i18n/widget/editable)/`getMeta`/`_applyMeta`/`getConfig` used consistently across tasks; `meta` is the option key at both collection and vault level; `described`/`config`/`meta` consistent on `InspectorCollection` across Tasks 5–7.
