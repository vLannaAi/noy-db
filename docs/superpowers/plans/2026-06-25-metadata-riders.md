# Milestone-#20 Riders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship three riders on the field-metadata foundation — `dictKey` inline labels (#485), `collection.toJSONSchema()` (#484), and devtools PII masking — stacked on PR #490.

**Architecture:** #485 adds code-provided display-fallback labels to `dictKey`, surfaced **synchronously** through `describe()`. #484 adds an async `collection.toJSONSchema()` that overlays `describe()` metadata as `x-` extensions onto the zod-4-derived JSON Schema (or a minimal field-type schema for non-zod validators). Masking is a pure devtools consumer of the `sensitivity` already in the snapshot — RecordsPane (Nuxt + TUI) masks pii/secret values by default with reveal-on-demand.

**Tech Stack:** TypeScript, Vitest, Standard Schema v1, zod 4 (devDep, lazy), Vue (Nuxt), Ink/React (TUI).

## Global Constraints

- **Builds on `feat/field-metadata-foundation`** (PR #490): `describe()`/`fieldMeta`, `buildDescription` (`introspection/describe.ts`), `derivePersistedSchema`/`isZod4Schema` (`persisted-schemas/derive.js`), the `dictKey`/`DictKeyDescriptor` in `i18n/dictionary.ts`, and `InspectorCollection.described` (with `sensitivity`) in the in-devtools snapshot. Do NOT switch branches.
- Descriptive, never prescriptive; hub **validator-agnostic** — no static `import 'zod'` in `hub/src`.
- `describe()` (sync) stays **zero store I/O**.
- **Masking UX (decided): mask-by-default, reveal-on-demand** — pii AND secret render `••••••` by default; per-field reveal + a header "reveal all" toggle; public/unclassified always shown; a collection without `described` masks nothing (back-compat).
- **#485 labels are a display FALLBACK** — code-provided defaults used when the dynamic `_dict_` has no label; `describe()` sync surfaces them; `resolveDictLabels:true` async overrides from `_dict_`, falling back to inline.
- **#484 `x-` keys** (keeps output valid JSON Schema): `x-label`, `x-unit`, `x-semanticType`, `x-sensitivity`, `x-widget`, `x-readonly` (when `editable:false`), `x-money`, `x-ref`, `x-enumLabels`.
- **Tests under `__tests__/**`** (vitest ignores `src/*.test.ts`). pnpm. The DTS build (`exactOptionalPropertyTypes`) is stricter than vitest tsc; **run `npm run typecheck` + `eslint src/` per changed package before declaring done** (the tsup build enforces neither — a CI lesson from this branch). Conditional spreads for optional props.
- **No inline `import()` type annotations** (`consistent-type-imports`) — use top-level `import type`.
- New public symbols re-export from `src/index.ts`. No Claude attribution in commits.
- Spec: `docs/superpowers/specs/2026-06-25-metadata-riders-design.md`.

---

### Task 1: `dictKey` inline labels (#485) + sync `describe()` surfacing

**Files:**
- Modify: `packages/hub/src/i18n/dictionary.ts` (`DictKeyDescriptor` + `dictKey()` overload)
- Modify: `packages/hub/src/introspection/describe.ts` (dynamic-dict block ~lines 308-318)
- Test: `packages/hub/__tests__/introspection/describe.test.ts` (append) + a dictKey unit test in the dictionary test file (find it under `__tests__/`)

**Interfaces:**
- Produces: `DictKeyDescriptor.labels?: Record<string, string>`; `dictKey(name, mapOrArray, opts?)` — a plain-object 2nd arg is the value→label map (`keys = Object.keys`, `labels = map`); an array keeps current behavior + reads `opts.labels`. `describe().dict.values[].label` populated **synchronously** from inline labels.

- [ ] **Step 1: Write the failing tests**

In the dictionary unit test file:
```ts
import { dictKey, isDictKeyDescriptor } from '../src/i18n/dictionary.js' // adjust path to the test's location
import { describe, it, expect } from 'vitest'

describe('dictKey inline labels (#485)', () => {
  it('map form: keys inferred, labels captured', () => {
    const d = dictKey('saleStatus', { draft: 'Draft', to_verify: 'To Verify' })
    expect(d.keys).toEqual(['draft', 'to_verify'])
    expect(d.labels).toEqual({ draft: 'Draft', to_verify: 'To Verify' })
  })
  it('array + opts.labels', () => {
    const d = dictKey('saleStatus', ['draft', 'to_verify'] as const, { labels: { to_verify: 'To Verify' } })
    expect(d.keys).toEqual(['draft', 'to_verify'])
    expect(d.labels).toEqual({ to_verify: 'To Verify' })
  })
  it('bare array unchanged (no labels)', () => {
    const d = dictKey('saleStatus', ['draft', 'paid'] as const)
    expect(d.keys).toEqual(['draft', 'paid'])
    expect(d.labels).toBeUndefined()
  })
})
```
In `describe.test.ts` (append) — a collection with a `dictKey` carrying inline labels:
```ts
it('sync describe surfaces inline dictKey labels (#485)', () => {
  // dictKeyFields: { status: dictKey('saleStatus', { draft:'Draft', to_verify:'To Verify' }) }
  const f = orders.describe().fields.find((x) => x.key === 'status')!
  expect(f.dict?.values).toEqual(expect.arrayContaining([
    { value: 'draft', label: 'Draft' }, { value: 'to_verify', label: 'To Verify' },
  ]))
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test --prefix packages/hub -- dictionary describe`
Expected: FAIL — `labels` absent; map form not handled.

- [ ] **Step 3: Implement `labels` + the overload**

In `dictionary.ts`, add `readonly labels?: Record<string, string>` to `DictKeyDescriptor`, and rewrite `dictKey`:
```ts
export function dictKey<Keys extends string>(
  name: string,
  keysOrMap?: readonly Keys[] | Record<Keys, string>,
  opts?: { onMissing?: OnMissingPolicy; substitute?: readonly string[]; labels?: Record<string, string> },
): DictKeyDescriptor<Keys> {
  let keys: readonly Keys[] | undefined
  let labels: Record<string, string> | undefined
  if (Array.isArray(keysOrMap)) {
    keys = keysOrMap as readonly Keys[]
    labels = opts?.labels
  } else if (keysOrMap && typeof keysOrMap === 'object') {
    keys = Object.keys(keysOrMap) as Keys[]
    labels = keysOrMap as Record<string, string>
  } else {
    keys = undefined
    labels = opts?.labels
  }
  return {
    _noydbDictKey: true,
    name,
    keys,
    ...(opts?.onMissing !== undefined ? { onMissing: opts.onMissing } : {}),
    ...(opts?.substitute !== undefined ? { substitute: opts.substitute } : {}),
    ...(labels !== undefined ? { labels } : {}),
  }
}
```

In `describe.ts`, the dynamic-dict branch (~line 308) currently uses `dictLabels?.[dict.name]` (async) else `dict.keys.map(k => ({value:k}))`. Change the no-async-labels fallback to use `dict.labels` (inline) when present:
```ts
} else if (dict.keys !== undefined) {
  const values = dict.keys.map((k) => {
    const label = (dict as { labels?: Record<string, string> }).labels?.[k]
    return label !== undefined ? { value: k, label } : { value: k }
  })
  dictBlock = { name: dict.name, static: false, values }
}
```
(The async `dictLabels` branch already wins when resolved — inline is the fallback, per spec.)

- [ ] **Step 4: Run tests + build + typecheck**

Run: `npm test --prefix packages/hub -- dictionary describe` → PASS.
Run: `npm run build --prefix packages/hub && npm run typecheck --prefix packages/hub` → clean.
Run: `node scripts/check-architecture.mjs` → OK.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/i18n/dictionary.ts packages/hub/src/introspection/describe.ts packages/hub/__tests__
git commit -m "feat(hub): dictKey inline labels (display fallback) + sync describe surfacing (#485)"
```

---

### Task 2: `collection.toJSONSchema()` (#484)

**Files:**
- Create: `packages/hub/src/introspection/json-schema.ts` (`buildJsonSchema` pure overlay)
- Modify: `packages/hub/src/collection.ts` (async `toJSONSchema()` method)
- Test: `packages/hub/__tests__/introspection/json-schema.test.ts`

**Interfaces:**
- Consumes: `derivePersistedSchema` (returns `{ jsonSchema }`), `this.describe({})` (async → `CollectionDescription`), the `dict.values[].label` from Task 1.
- Produces: `Collection.toJSONSchema(): Promise<object>` — valid JSON Schema with `x-` extension keys per property; minimal field-type schema when no zod-derived JSON Schema.

- [ ] **Step 1: Write the failing test**

In `json-schema.test.ts` (real harness; a zod-4 collection with money `total` EUR, ref `buyerId`, dictKey `status` with inline labels, a `pii` fieldMeta):
```ts
it('emits JSON Schema with x- metadata extensions', async () => {
  const js = await orders.toJSONSchema() as { properties: Record<string, Record<string, unknown>> }
  expect(js.properties.total['x-semanticType']).toBe('currency')
  expect(js.properties.total['x-money']).toMatchObject({ currency: 'EUR' })
  expect(js.properties.status['x-enumLabels']).toMatchObject({ to_verify: 'To Verify' })
  expect(js.properties.buyerVat['x-sensitivity']).toBe('pii')
})
it('non-zod validator → minimal schema from field types, no throw', async () => {
  // a collection with a hand-rolled Standard-Schema stub validator + moneyFields
  const js = await stubColl.toJSONSchema() as { type: string; properties: Record<string, Record<string, unknown>> }
  expect(js.type).toBe('object')
  expect(js.properties.total['x-semanticType']).toBe('currency')
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test --prefix packages/hub -- json-schema`
Expected: FAIL — `toJSONSchema` not a function.

- [ ] **Step 3: Implement `buildJsonSchema` (pure overlay)**

`packages/hub/src/introspection/json-schema.ts`:
```ts
import type { CollectionDescription, DescribedField } from './describe.js'

/** Map a DescribedField's type tag to a JSON-Schema `type`. */
function jsonType(t: string): string {
  switch (t) {
    case 'number': return 'number'
    case 'boolean': return 'boolean'
    case 'array': return 'array'
    case 'object': return 'object'
    default: return 'string'
  }
}

/** Overlay describe() metadata onto a base JSON Schema (or build a minimal one). */
export function buildJsonSchema(desc: CollectionDescription, base?: Record<string, unknown> | null): object {
  const baseProps = (base?.['properties'] as Record<string, Record<string, unknown>> | undefined) ?? {}
  const properties: Record<string, Record<string, unknown>> = {}
  for (const f of desc.fields) {
    const prop: Record<string, unknown> = { ...(baseProps[f.key] ?? { type: jsonType(f.type) }) }
    prop['x-label'] = f.label
    if (f.unit !== undefined) prop['x-unit'] = f.unit
    if (f.semanticType !== undefined) prop['x-semanticType'] = f.semanticType
    if (f.sensitivity !== undefined) prop['x-sensitivity'] = f.sensitivity
    if (f.widget !== undefined) prop['x-widget'] = f.widget
    if (f.editable === false) prop['x-readonly'] = true
    if (f.money !== undefined) prop['x-money'] = f.money
    if (f.ref !== undefined) prop['x-ref'] = f.ref.target
    if (f.dict?.values) {
      const labels: Record<string, string> = {}
      for (const v of f.dict.values) if (v.label !== undefined) labels[v.value] = v.label
      if (Object.keys(labels).length) prop['x-enumLabels'] = labels
    }
    properties[f.key] = prop
  }
  return base && typeof base === 'object'
    ? { ...base, properties }
    : { type: 'object', properties }
}
```

- [ ] **Step 4: Add `toJSONSchema()` to `Collection`**

In `collection.ts` (import `buildJsonSchema` + `derivePersistedSchema`, both lazy-safe — `derivePersistedSchema` already lazy-imports zod):
```ts
/** JSON Schema for this collection with describe() metadata as x- extensions. */
async toJSONSchema(): Promise<object> {
  const desc = await this.describe({})
  let base: Record<string, unknown> | null = null
  if (this.schema !== undefined) {
    const env = await derivePersistedSchema(this.schema)
    base = (env.jsonSchema as Record<string, unknown> | null) ?? null
  }
  return buildJsonSchema(desc, base)
}
```
Keep it a thin delegator (logic lives in `json-schema.ts`) so collection.ts stays near its ceiling; raise the ceiling minimally + justify if needed.

- [ ] **Step 5: Run tests + build + typecheck + eslint**

Run: `npm test --prefix packages/hub -- json-schema` → PASS.
Run: `npm run build --prefix packages/hub && npm run typecheck --prefix packages/hub` → clean.
Run: `(cd packages/hub && npx eslint src/)` → clean (no inline `import()` annotations).
Run: `node scripts/check-architecture.mjs` → OK.

- [ ] **Step 6: Commit**

```bash
git add packages/hub/src/introspection/json-schema.ts packages/hub/src/collection.ts packages/hub/__tests__/introspection/json-schema.test.ts
git commit -m "feat(hub): collection.toJSONSchema() with x- metadata extensions (#484)"
```

---

### Task 3: Nuxt RecordsPane PII masking

**Files:**
- Modify: `packages/in-nuxt/src/runtime/devtools/panes/RecordsPane.vue`
- Test: `packages/in-nuxt/__tests__/` (extend `devtools-panel.test.ts` or add `records-mask.test.ts`)

**Interfaces:**
- Consumes: `collection.described` (each `DescribedField` has `key` + `sensitivity`) from the enriched `InspectorCollection`.

- [ ] **Step 1: Write the failing test**

A RecordsPane mounted with a collection whose `described` marks `vat` as `pii` and a record `{ vat: 'IT123', total: '10.00' }`:
```ts
it('masks pii/secret values by default; reveal unmasks', async () => {
  // mount panel, drill into the collection's records
  expect(wrapper.text()).toContain('••••••')      // vat masked
  expect(wrapper.text()).toContain('10.00')        // public total shown
  expect(wrapper.text()).not.toContain('IT123')    // pii hidden
  await wrapper.find('[data-reveal="vat"]').trigger('click')
  expect(wrapper.text()).toContain('IT123')        // revealed
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test --prefix packages/in-nuxt -- records`
Expected: FAIL — values shown unmasked.

- [ ] **Step 3: Implement masking**

In `RecordsPane.vue`: derive a sensitive-field set from `collection.described` (`sensitivity !== 'public'` and defined); local refs `revealed = ref(new Set<string>())` + `revealAll = ref(false)`. For each cell, render the value when the field is not sensitive OR `revealAll` OR `revealed.has(field)`, else `••••••` with a reveal control (`data-reveal="<field>"` → adds the field to `revealed`). Add a header "reveal all" toggle bound to `revealAll`. Keep the existing pagination/columns. A field not in `described` (or `described` absent) is treated as not-sensitive (back-compat).

- [ ] **Step 4: Run tests + typecheck**

Run: `npm test --prefix packages/in-nuxt -- records` → PASS.
Run: `npm run build --prefix packages/in-nuxt && npm run typecheck --prefix packages/in-nuxt` → clean.

- [ ] **Step 5: Commit**

```bash
git add packages/in-nuxt/src/runtime/devtools/panes/RecordsPane.vue packages/in-nuxt/__tests__
git commit -m "feat(in-nuxt): RecordsPane masks pii/secret values by default, reveal-on-demand (#483)"
```

---

### Task 4: TUI RecordsPane masking + features.yaml + docs

**Files:**
- Modify: `packages/in-devtools-tui/src/panes/RecordsPane.tsx`
- Modify: `features.yaml`
- Modify: `docs/subsystems/field-metadata.md`
- Test: `packages/in-devtools-tui/__tests__/` (snapshot/render test)

**Interfaces:**
- Consumes: `collection.described` `sensitivity`.

- [ ] **Step 1: Write the failing test**

A TUI RecordsPane render with a `pii` field → output shows `••••` for it, not the raw value, by default; a reveal key-toggle un-masks. Assert via the Ink test renderer the package already uses (mirror an existing TUI test).

- [ ] **Step 2: Run to verify failure**

Run: `npm test --prefix packages/in-devtools-tui -- records`
Expected: FAIL — raw value shown.

- [ ] **Step 3: Implement TUI masking**

In `RecordsPane.tsx`: derive the sensitive-field set from `collection.described`; mask pii/secret cells with `••••` unless a reveal flag is set; add a key binding (e.g. `r`) to toggle reveal-all for the pane (terminal-appropriate — a single reveal-all toggle is fine for the TUI rather than per-field click). Guard: no `described` → mask nothing. Keep `exactOptionalPropertyTypes`/`noUncheckedIndexedAccess` clean (use `Object.entries`, conditional spreads).

- [ ] **Step 4: features.yaml + docs**

Add this milestone's riders to the `field-metadata`/`metadata-ladder` node (or a `metadata-riders` node): reference `docs/superpowers/specs/2026-06-25-metadata-riders-design.md`, the `collection.toJSONSchema` surface, and the devtools masking. Document `toJSONSchema()` (with the `x-` key table), the dictKey inline-label form, and the masking behavior in `docs/subsystems/field-metadata.md`. Every referenced path must exist.

- [ ] **Step 5: Verify all gates**

Run: `npm test --prefix packages/in-devtools-tui` → PASS (regenerate snapshots intentionally if the render changed).
Run: `npm run build --prefix packages/in-devtools-tui && npm run typecheck --prefix packages/in-devtools-tui` → clean.
Run: the features validator (`grep -rn "validate-features" scripts package.json`) → 0 dangling refs. `node scripts/check-architecture.mjs` → OK.

- [ ] **Step 6: Commit**

```bash
git add packages/in-devtools-tui features.yaml docs
git commit -m "feat(in-devtools-tui): RecordsPane PII masking + features.yaml + docs (#483, #484, #485)"
```

---

## Self-Review

**Spec coverage:**
- #485 dictKey inline labels (map + array+labels forms, back-compat) + sync describe surfacing → Task 1. ✓
- #484 toJSONSchema (x- overlay incl x-enumLabels from #485, non-zod minimal fallback, agnostic) → Task 2. ✓
- Masking mask-by-default + reveal (Nuxt) → Task 3; (TUI) → Task 4. ✓
- features.yaml + docs → Task 4. ✓
- Non-goals (#489 export, fieldMeta.group, editor) → no tasks. ✓

**Placeholder scan:** code steps carry concrete code; the few "find the test file / mirror an existing TUI test" notes are locate-the-harness instructions with the pattern named, not placeholders.

**Type consistency:** `DictKeyDescriptor.labels`, `dictKey` overload, `buildJsonSchema`, `Collection.toJSONSchema`, the `x-` key set, and `collection.described.sensitivity` are used consistently across tasks. #484's `x-enumLabels` reads the `dict.values[].label` produced by #485 (Task 1 before Task 2).
