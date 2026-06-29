# Field-metadata Plan 2 — fieldMeta channel + collection.describe() (#483) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a collection a consumer-neutral field-metadata layer (`fieldMeta`) and a single normalized `collection.describe()` that merges existing config (refs/money/dict/computed) + the channel + (async) zod-4 registry metadata, so every renderer/exporter reads one source instead of re-deriving facts.

**Architecture:** A new `fieldMeta` entry in collection options stores per-field `FieldMeta` (canonical, validator-agnostic). A pure merge module under `introspection/` combines: channel (highest) → zod-4 `.meta()` (async only) → inferred-from-config (money/refs/format). `collection.describe()` is sync and config-only (type tags inferred from config); an async overload `describe(opts)` derives exact validator types, merges zod-4 `.meta()`, and resolves dynamic-dict labels.

**Tech Stack:** TypeScript, Vitest, Standard Schema v1, zod 4 (devDependency, lazy).

## Global Constraints

- **Depends on Plan 1 (#482)** — `derivePersistedSchema` must already support zod 4, and `isZod4Schema` must be exported from `persisted-schemas/derive.ts`.
- hub stays validator-agnostic: **no static `import 'zod'`** in `packages/hub/src`. The async path uses the existing lazy derivation only.
- **Descriptive, never prescriptive** (copied from spec): metadata may carry label/semanticType/unit/sensitivity/aggregate/aliases/displayFor; it must NOT carry column order, widths, breakpoints, sort/filter defaults, routing, styling, or active-locale selection.
- **Litmus test invariant:** a field-metadata key is admissible only if *"a second, unrelated consumer would want this fact."*
- Merge precedence (highest wins): `fieldMeta` channel → zod-4 `.meta()` registry → inferred-from-config.
- `describe()` (sync) does **zero store I/O** (no decryption). Only the async overload touches `_dict_*`.
- **Test file location:** ALL test files go under `packages/hub/__tests__/introspection/` — NOT `src/`. Vitest's include glob is `__tests__/**/*.test.ts`, so a `.test.ts` placed under `src/` is **silently ignored** (won't run → false green). Import the module under test via `../../src/introspection/<file>.js`. The `Test:` paths in the tasks below say `src/introspection/...` for locality — place them under `__tests__/introspection/...` and adjust import depth.
- **Package manager is pnpm** (not npm) for installs; `npm test -w @noy-db/hub` works for running tests.
- New public symbols require re-export from `src/index.ts` (a recurring gap: local tsc passes because tests import `../src/`; only the showcase + CI cross-package typecheck against `dist/` catch a missing barrel export — so verify by building + showcase typecheck). Do **not** add to `src/kernel/index.ts` (per-collection introspection is not orchestration surface).
- Every feature change must touch `features.yaml` or CI "Spec coverage" fails.
- No Claude attribution in commits.
- Spec: `docs/superpowers/specs/2026-06-25-field-metadata-foundation-design.md`.

---

### Task 1: `FieldMeta` type, `fieldMeta` collection option, storage + fail-loud validation

**Files:**
- Create: `packages/hub/src/introspection/field-meta.ts` (the `FieldMeta` type + helpers)
- Modify: `packages/hub/src/vault.ts` — add `fieldMeta?` to the `CollectionOptions<T>` interface (the interface defining `schema`/`refs`/`moneyFields`/`dictKeyFields`, ~`vault.ts:672-767`) and register it in the collection-construction block (~`vault.ts:801-971`, where `refs`/`dictKeyFields` are registered and threaded into `new Collection(...)`)
- Modify: `packages/hub/src/collection.ts` — accept + store `fieldMeta` on the Collection (mirror the `dictKeyFields` private field at ~`collection.ts:360`/assignment ~`collection.ts:970`) and add a getter
- Test: `packages/hub/__tests__/introspection/field-meta.test.ts`

**Interfaces:**
- Produces:
  - `interface FieldMeta { label: string; description?: string; semanticType?: string; unit?: string; sensitivity?: 'public'|'pii'|'secret'; aggregate?: 'sum'|'count'|'distinct'|'none'; aliases?: readonly string[]; displayFor?: string }`
  - `CollectionOptions.fieldMeta?: Record<string, FieldMeta>`
  - `Collection` stores it; later tasks read it via a getter `getFieldMeta(): Record<string, FieldMeta> | undefined`
  - Unknown-key validation throws `FieldMetaUnknownFieldError` at `vault.collection()` time.

- [ ] **Step 1: Write the `FieldMeta` type and a validation helper (failing test first)**

In `packages/hub/__tests__/introspection/field-meta.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { validateFieldMetaKeys } from './field-meta.js'

describe('FieldMeta key validation', () => {
  it('passes when every fieldMeta key is a known field', () => {
    expect(() => validateFieldMetaKeys('sales', { total: { label: 'Amount' } }, new Set(['total', 'saleDate']))).not.toThrow()
  })
  it('throws fail-loud on an unknown field key (typo)', () => {
    expect(() => validateFieldMetaKeys('sales', { totl: { label: 'Amount' } }, new Set(['total'])))
      .toThrowError(/totl/)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -w @noy-db/hub -- field-meta`
Expected: FAIL — module/`validateFieldMetaKeys` not found.

- [ ] **Step 3: Implement the type + helper + error**

Create `packages/hub/src/introspection/field-meta.ts`:
```ts
/**
 * Consumer-neutral, data-relatable field descriptors — the canonical,
 * validator-agnostic authoring channel. Merged by `collection.describe()`.
 *
 * Descriptive, never prescriptive: label/semanticType/unit/sensitivity/
 * aggregate/aliases/displayFor only. Layout, styling, and active-locale
 * selection stay app-side.
 *
 * @module
 */

/** Known semantic types; the union is open — unknown strings pass through. */
export type SemanticType =
  | 'date' | 'datetime' | 'email' | 'url' | 'currency' | 'percent'
  | 'country' | 'vat' | 'iban' | 'entity'
  | (string & {})

export interface FieldMeta {
  /** Human label for any displayable field. Required. */
  label: string
  description?: string
  semanticType?: SemanticType
  /** Display unit, e.g. '€', '%', 'kg'. */
  unit?: string
  /** Data classification driving redaction/inspector masking. */
  sensitivity?: 'public' | 'pii' | 'secret'
  /** Default aggregation for this field. */
  aggregate?: 'sum' | 'count' | 'distinct' | 'none'
  /** Canonical search synonyms (data vocabulary, not UI). */
  aliases?: readonly string[]
  /** Entity pairing: the field holding the human label for this id (buyerId → buyerName). */
  displayFor?: string
}

export class FieldMetaUnknownFieldError extends Error {
  constructor(public readonly collection: string, public readonly key: string) {
    super(`fieldMeta for collection "${collection}" references unknown field "${key}". `
      + `Declare it in the schema/config or remove the fieldMeta entry.`)
    this.name = 'FieldMetaUnknownFieldError'
  }
}

/** Reject fieldMeta keys that are not known fields (typo guard), fail-loud. */
export function validateFieldMetaKeys(
  collection: string,
  fieldMeta: Record<string, FieldMeta>,
  knownFields: ReadonlySet<string>,
): void {
  for (const key of Object.keys(fieldMeta)) {
    if (!knownFields.has(key)) throw new FieldMetaUnknownFieldError(collection, key)
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -w @noy-db/hub -- field-meta`
Expected: PASS.

- [ ] **Step 5: Thread `fieldMeta` through collection options + storage**

In `packages/hub/src/vault.ts`:
- Add to the `CollectionOptions<T>` interface (next to `dictKeyFields`/`moneyFields`):
  ```ts
  /** Consumer-neutral per-field descriptors (label/unit/semanticType/sensitivity…). See collection.describe(). */
  readonly fieldMeta?: Record<string, import('./introspection/field-meta.js').FieldMeta>
  ```
- In the collection-construction block (mirror how `dictKeyFields` is captured and passed into `new Collection(...)`), pass `fieldMeta: options.fieldMeta` into the constructor opts.
- The known-field set for validation: combine the keys of `options.moneyFields`, `options.dictKeyFields`, `options.refs`, `options.computed`, plus fields derivable from the schema. Since exact schema fields need async derivation, validate against the **union of all declared config keys plus the fieldMeta keys already covered by schema** — to keep this sync, validate that each `fieldMeta` key is either (a) a declared config key, or (b) accept it otherwise but defer strict schema-field validation. **Decision (YAGNI + fail-loud where cheap):** validate `fieldMeta` keys against the union of config keys; do not reject keys that may be plain schema fields. Call:
  ```ts
  if (options.fieldMeta) {
    const known = new Set<string>([
      ...Object.keys(options.moneyFields ?? {}),
      ...Object.keys(options.dictKeyFields ?? {}),
      ...Object.keys(options.refs ?? {}),
      ...Object.keys(options.computed ?? {}),
      ...Object.keys(options.fieldMeta), // schema fields: accepted (not strictly checkable sync)
    ])
    validateFieldMetaKeys(name, options.fieldMeta, known)
  }
  ```
  > Note: this catches typos against config-derived fields. A stricter schema-field check belongs to the async path (Task 4) where the derived JSON Schema is available; do not add it here.

In `packages/hub/src/collection.ts`:
- Add a private field mirroring `dictKeyFields`: `private readonly fieldMeta: Record<string, FieldMeta> | undefined` and assign from `opts.fieldMeta` in the constructor.
- Add a getter:
  ```ts
  /** The declared consumer-neutral field metadata channel (canonical). */
  getFieldMeta(): Record<string, FieldMeta> | undefined { return this.fieldMeta }
  ```
- Import `FieldMeta` (type-only) from `./introspection/field-meta.js`.

- [ ] **Step 6: Run the hub suite + arch check**

Run: `npm test -w @noy-db/hub`
Expected: PASS.
Run: `node scripts/check-architecture.mjs`
Expected: PASS (collection.ts/vault.ts edits are tiny — getter + option threading — well under ceilings 5285/4610).

- [ ] **Step 7: Commit**

```bash
git add packages/hub/src/introspection/field-meta.ts packages/hub/__tests__/introspection/field-meta.test.ts packages/hub/src/vault.ts packages/hub/src/collection.ts
git commit -m "feat(hub): fieldMeta collection option + storage + fail-loud key check (#483)"
```

---

### Task 2: Pure merge + inference

**Files:**
- Modify: `packages/hub/src/introspection/field-meta.ts` (add `mergeFieldMeta`)
- Test: `packages/hub/__tests__/introspection/field-meta.test.ts`

**Interfaces:**
- Consumes: `FieldMeta`.
- Produces:
  ```ts
  interface MergeInputs {
    channel?: FieldMeta                 // from fieldMeta option (highest)
    zodMeta?: Partial<FieldMeta>        // from zod-4 .meta() (async path only)
    inferred?: Partial<FieldMeta>       // from money/refs/format
  }
  function resolveFieldMeta(key: string, inputs: MergeInputs): ResolvedMeta
  ```
  where `ResolvedMeta` has `label: string` (always — falls back to humanized key) plus the optional members.
- `humanizeFieldKey(key: string): string` (e.g. `saleDate` → `Sale Date`, `numberT` → `Number T`).

- [ ] **Step 1: Write failing tests for precedence + inference + humanize**

Append to `field-meta.test.ts`:
```ts
import { resolveFieldMeta, humanizeFieldKey } from './field-meta.js'

describe('humanizeFieldKey', () => {
  it('splits camelCase and title-cases', () => {
    expect(humanizeFieldKey('saleDate')).toBe('Sale Date')
    expect(humanizeFieldKey('buyerId')).toBe('Buyer Id')
  })
})

describe('resolveFieldMeta precedence', () => {
  it('channel label overrides inferred and zod', () => {
    const r = resolveFieldMeta('total', {
      channel: { label: 'Amount' },
      zodMeta: { label: 'ZL', unit: '€' },
      inferred: { label: 'Total', semanticType: 'currency', aggregate: 'sum' },
    })
    expect(r.label).toBe('Amount')        // channel wins
    expect(r.unit).toBe('€')              // filled from zod (channel silent)
    expect(r.semanticType).toBe('currency') // filled from inferred
    expect(r.aggregate).toBe('sum')
  })
  it('falls back to humanized key when no label anywhere', () => {
    expect(resolveFieldMeta('saleDate', { inferred: { semanticType: 'date' } }).label).toBe('Sale Date')
  })
  it('zod beats inferred when channel is silent', () => {
    expect(resolveFieldMeta('x', { zodMeta: { label: 'FromZod' }, inferred: { label: 'FromInfer' } }).label)
      .toBe('FromZod')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -w @noy-db/hub -- field-meta`
Expected: FAIL — `resolveFieldMeta`/`humanizeFieldKey` not exported.

- [ ] **Step 3: Implement merge + humanize**

Append to `field-meta.ts`:
```ts
export interface MergeInputs {
  channel?: FieldMeta
  zodMeta?: Partial<FieldMeta>
  inferred?: Partial<FieldMeta>
}
export interface ResolvedMeta extends Partial<FieldMeta> { label: string }

/** camelCase / snake_case → Title Case words. */
export function humanizeFieldKey(key: string): string {
  return key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim()
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

/** Merge one field's metadata: channel > zodMeta > inferred; label always present. */
export function resolveFieldMeta(key: string, inputs: MergeInputs): ResolvedMeta {
  const { channel, zodMeta, inferred } = inputs
  const pick = <K extends keyof FieldMeta>(k: K): FieldMeta[K] | undefined =>
    channel?.[k] ?? zodMeta?.[k] ?? inferred?.[k]
  return {
    label: pick('label') ?? humanizeFieldKey(key),
    ...(pick('description') !== undefined ? { description: pick('description') } : {}),
    ...(pick('semanticType') !== undefined ? { semanticType: pick('semanticType') } : {}),
    ...(pick('unit') !== undefined ? { unit: pick('unit') } : {}),
    ...(pick('sensitivity') !== undefined ? { sensitivity: pick('sensitivity') } : {}),
    ...(pick('aggregate') !== undefined ? { aggregate: pick('aggregate') } : {}),
    ...(pick('aliases') !== undefined ? { aliases: pick('aliases') } : {}),
    ...(pick('displayFor') !== undefined ? { displayFor: pick('displayFor') } : {}),
  }
}
```
> The conditional spreads respect `exactOptionalPropertyTypes` (a known gotcha in this repo) — never assign `undefined` to an optional prop.

- [ ] **Step 4: Run to verify passing**

Run: `npm test -w @noy-db/hub -- field-meta`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/introspection/field-meta.ts packages/hub/__tests__/introspection/field-meta.test.ts
git commit -m "feat(hub): fieldMeta merge precedence + humanize (#483)"
```

---

### Task 3: `collection.describe()` (sync) + exports

**Files:**
- Create: `packages/hub/src/introspection/describe.ts` (`buildDescription` pure assembler + `DescribedField`/`CollectionDescription` types)
- Modify: `packages/hub/src/collection.ts` (add the sync `describe()` method)
- Modify: `packages/hub/src/index.ts` (re-export the new public types + `FieldMeta`)
- Test: `packages/hub/__tests__/introspection/describe.test.ts`

**Interfaces:**
- Consumes: `Collection.getFieldMeta()`, the collection's `moneyFields`/`dictKeyFields`/`refs`/`computed` (add internal getters mirroring `getFieldMeta` if not already reachable), `resolveFieldMeta`, the vault `refRegistry.getOutbound(name)`.
- Produces:
  ```ts
  interface CollectionDescription { readonly collection: string; readonly fields: readonly DescribedField[] }
  interface DescribedField {
    readonly key: string
    readonly type: string            // sync: inferred from config; async: validator-derived
    readonly optional: boolean
    readonly constraints?: Record<string, unknown>
    readonly label: string
    readonly description?: string
    readonly semanticType?: string
    readonly unit?: string
    readonly sensitivity?: 'public'|'pii'|'secret'
    readonly aggregate?: 'sum'|'count'|'distinct'|'none'
    readonly aliases?: readonly string[]
    readonly ref?: { target: string; mode: string; isArray?: true }
    readonly displayFor?: string
    readonly money?: { mode: 'fixed'|'multi'; currency?: string; scale?: number; rounding?: string }
    readonly dict?: { name: string; static: boolean; values?: readonly { value: string; label?: string }[] }
    readonly computed?: true
  }
  Collection.describe(): CollectionDescription   // sync overload
  ```

- [ ] **Step 1: Write failing test (sync describe over a config-only collection)**

In `describe.test.ts`, use the **real** harness: `createNoydb({ store: memory(), user, secret })` → `await db.openVault('v')` → `v.collection(name, { schema, moneyFields, dictKeyFields, refs, fieldMeta })`. Build a `sales` collection with a money field, a `staticDict` status, a `buyerId` ref, and a `fieldMeta` for `saleDate`/`total`/`buyerId`. Assert the merged output:
```ts
const d = sales.describe()
const byKey = Object.fromEntries(d.fields.map((f) => [f.key, f]))
expect(byKey.total.semanticType).toBe('currency')         // inferred from money
expect(byKey.total.aggregate).toBe('sum')                 // inferred from money
expect(byKey.total.unit).toBe('€')                        // from fieldMeta
expect(byKey.total.money).toMatchObject({ mode: 'fixed', currency: 'EUR' })
expect(byKey.buyerId.semanticType).toBe('entity')         // inferred from ref
expect(byKey.buyerId.ref).toMatchObject({ target: 'buyers' })
expect(byKey.buyerId.displayFor).toBe('buyerName')        // from fieldMeta
expect(byKey.status.dict).toMatchObject({ name: 'saleStatus', static: true })
expect(byKey.status.dict.values).toEqual(
  expect.arrayContaining([{ value: 'to_verify', label: 'To Verify' }]))  // staticDict labels surface sync
expect(byKey.saleDate.label).toBe('Date')                 // from fieldMeta
```
Also assert **zero store I/O**: wrap the store so `list`/`get` throw, build the collection, and confirm `describe()` does not throw.

- [ ] **Step 2: Run to verify failure**

Run: `npm test -w @noy-db/hub -- describe`
Expected: FAIL — `describe` not a function.

- [ ] **Step 3: Implement `buildDescription` (pure) + inference-from-config**

Create `packages/hub/src/introspection/describe.ts`. `buildDescription` takes the collection's config maps + a `refs` map + an optional `zodFields` map (async path supplies it; sync path passes `undefined`) and returns `CollectionDescription`. Inference rules:
- money field → `type:'number'`, `semanticType:'currency'`, `aggregate:'sum'`, `money:{…}` from the `MoneyDescriptor` (`mode`, `soleCurrency()` → currency, `scaleFor(currency)` → scale, `rounding`).
- ref → `type:'string'` (or `'array'` if `isArray`), `semanticType:'entity'`, `ref:{target,mode,isArray?}`.
- dictKey/staticDict → `type:'enum'`, `dict:{ name, static, values? }`. For `staticDict`, fill `values` from its in-code `table`/`keys` (the `displayLocale` label, else humanized key). For dynamic `dictKey`, `values` = declared `keys` mapped to `{value}` with **no label** (labels are async — Task 4).
- computed → `computed:true`, `type` from `zodFields` if available else `'unknown'`.
- plain schema field → `type` from `zodFields` if available else `'unknown'`.
- `optional` from `zodFields` if available else `false`.
Then `resolveFieldMeta(key, { channel: fieldMeta[key], zodMeta: zodFields?.[key]?.meta, inferred })` to fold in label/semanticType/unit/etc.

The full field set (sync) = union of config keys (money/dict/ref/computed/fieldMeta) ∪ (zodFields keys when provided).

- [ ] **Step 4: Add the sync `describe()` overload on `Collection`**

In `collection.ts`:
```ts
describe(): CollectionDescription
describe(opts: DescribeOptions): Promise<CollectionDescription>
describe(opts?: DescribeOptions): CollectionDescription | Promise<CollectionDescription> {
  if (opts) return this.describeAsync(opts)   // implemented in Task 4
  return buildDescription({
    collection: this.name,
    fieldMeta: this.fieldMeta,
    moneyFields: this.moneyFields,
    dictKeyFields: this.dictKeyFields,
    computed: this.computed,
    refs: this.refRegistryOutbound(),   // small helper returning refRegistry.getOutbound(this.name)
    zodFields: undefined,
  })
}
```
(If `describeAsync` doesn't exist yet, have the sync path only this task; add the `opts` overload signature but throw `new Error('async describe lands in Task 4')` for the opts branch, then wire it in Task 4. Prefer: implement sync now, leave a clearly-commented stub for the async branch.)

- [ ] **Step 5: Re-export public types from `src/index.ts`**

Add to `packages/hub/src/index.ts`:
```ts
// field metadata (#483)
export type { FieldMeta, SemanticType } from './introspection/field-meta.js'
export type { CollectionDescription, DescribedField, DescribeOptions } from './introspection/describe.js'
```
Do NOT add to `kernel/index.ts`.

- [ ] **Step 6: Run tests + build + showcase typecheck (catches barrel gaps)**

Run: `npm test -w @noy-db/hub -- describe`
Expected: PASS.
Run: `npm run build -w @noy-db/hub`
Expected: build succeeds (showcase resolves `@noy-db/hub` from `dist/`).
Run: `npm run typecheck -w showcases` (or the repo's showcase typecheck script — check `package.json`)
Expected: PASS — proves the new public types are actually re-exported from the package entry, not just `../src`.

- [ ] **Step 7: Commit**

```bash
git add packages/hub/src/introspection/describe.ts packages/hub/__tests__/introspection/describe.test.ts packages/hub/src/collection.ts packages/hub/src/index.ts
git commit -m "feat(hub): collection.describe() sync config-merge + public exports (#483)"
```

---

### Task 4: async `describe(opts)` — exact types, zod-4 meta merge, dynamic dict labels

**Files:**
- Modify: `packages/hub/src/introspection/describe.ts` (a `deriveZodFields` helper + `DescribeOptions`)
- Modify: `packages/hub/src/collection.ts` (`describeAsync`)
- Test: `packages/hub/__tests__/introspection/describe.test.ts`

**Interfaces:**
- Consumes: `derivePersistedSchema` + `isZod4Schema` (Plan 1), the existing JSON-Schema→field mapper in `introspection/fields.ts`, `vault.dictionary(name).list()` for dynamic dict labels.
- Produces:
  ```ts
  interface DescribeOptions { readonly resolveDictLabels?: boolean }
  Collection.describe(opts: DescribeOptions): Promise<CollectionDescription>
  ```
  The async path ALWAYS derives exact validator types (`type`/`optional`/`constraints`) and merges zod-4 `.meta()` registry metadata; `resolveDictLabels` additionally fills dynamic-dict `values[].label`.

- [ ] **Step 1: Write failing tests**

Append to `describe.test.ts`:
```ts
it('async describe derives exact types from the validator', async () => {
  const d = await sales.describe({})
  const byKey = Object.fromEntries(d.fields.map((f) => [f.key, f]))
  expect(byKey.saleDate.type).toBe('string')   // from schema, not 'unknown'
  expect(byKey.total.type).toBe('number')
})

it('async describe merges zod-4 .meta() when channel is silent', async () => {
  // a collection whose schema field carries z.number().meta({ unit: 'kg' }) and no fieldMeta for it
  const d = await weights.describe({})
  const w = d.fields.find((f) => f.key === 'net')!
  expect(w.unit).toBe('kg')
})

it('resolveDictLabels fills dynamic dict labels (async, reads _dict_)', async () => {
  await v.dictionary('priority').putAll([{ key: 'hi', labels: { en: 'High' } }])
  const d = await tickets.describe({ resolveDictLabels: true })
  const p = d.fields.find((f) => f.key === 'priority')!
  expect(p.dict?.values).toEqual(expect.arrayContaining([{ value: 'hi', label: 'High' }]))
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -w @noy-db/hub -- describe`
Expected: FAIL — async overload throws the Task-3 stub / labels not resolved.

- [ ] **Step 3: Implement `deriveZodFields` + zod-meta extraction**

In `describe.ts`, add `async function deriveZodFields(schema): Promise<Record<string, { type: string; optional: boolean; constraints?: Record<string,unknown>; meta?: Partial<FieldMeta> }>>`:
- Call `derivePersistedSchema(schema)`; if `jsonSchema` is null, return `{}`.
- Walk the JSON Schema `properties` using the existing mapper in `introspection/fields.ts` to get `type`/`constraints`/`optional` per field.
- For zod-4 (`isZod4Schema(schema)`), zod's `toJSONSchema` emits registry `.meta()` keys into each property; read recognized keys (`label`, `description`, `unit`, `semanticType`, `sensitivity`, `aggregate`, `aliases`, `displayFor`) into `meta`. (Confirm during implementation which keys zod surfaces; map 1:1, ignore unknown.)

- [ ] **Step 4: Implement `describeAsync` on `Collection`**

```ts
private async describeAsync(opts: DescribeOptions): Promise<CollectionDescription> {
  const zodFields = this.schema ? await deriveZodFields(this.schema) : undefined
  let dictLabels: Record<string, Record<string, string>> | undefined
  if (opts.resolveDictLabels) dictLabels = await this.resolveDynamicDictLabels()  // reads vault.dictionary(name).list()
  return buildDescription({
    collection: this.name,
    fieldMeta: this.fieldMeta,
    moneyFields: this.moneyFields,
    dictKeyFields: this.dictKeyFields,
    computed: this.computed,
    refs: this.refRegistryOutbound(),
    zodFields,
    dictLabels,
  })
}
```
Extend `buildDescription` to accept `zodFields` (exact types + zod meta) and `dictLabels` (dynamic-dict value→label) and fold them in (zod meta enters `resolveFieldMeta` as `zodMeta`; dictLabels populate dynamic `dict.values[].label`). Replace the Task-3 stub branch in `describe()` so `opts` routes to `describeAsync`.

- [ ] **Step 5: Relocate real fieldMeta key-validation here (carry from Task 1)**

Task 1's sync `validateFieldMetaKeys` call in `vault.ts` is a structural **no-op** — the known-field set there includes `fieldMeta`'s own keys, so it can never throw (schema field names aren't knowable synchronously). The async path is where validation becomes meaningful. In `describeAsync` (or `buildDescription` when `zodFields` is present), build the real known set = config keys (`moneyFields`/`dictKeyFields`/`refs`/`computed`) ∪ **`zodFields` keys (the derived schema fields)**, and call `validateFieldMetaKeys(this.name, this.fieldMeta ?? {}, realKnown)` so a typo'd `fieldMeta` key (e.g. `totl` for `total`) throws `FieldMetaUnknownFieldError` at first async `describe()`. Add a test: a collection whose `fieldMeta` references a non-existent field → `await c.describe({})` rejects with `FieldMetaUnknownFieldError`. Also **remove the misleading no-op** from `vault.ts`: delete the `Object.keys(options.fieldMeta)` self-inclusion + the `validateFieldMetaKeys` call there (keep the option threading), since it advertises a guarantee it can't honor. (This resolves the Task-1 review's Important plan-mandated finding.)

- [ ] **Step 6: Run tests + arch check**

Run: `npm test -w @noy-db/hub -- describe`
Expected: PASS.
Run: `node scripts/check-architecture.mjs`
Expected: PASS.

- [ ] **Step 7: Validator-agnostic test (guards the core invariant)**

Add a test building a collection with a **non-zod** Standard-Schema validator (a hand-rolled `{ '~standard': { version:1, vendor:'stub', validate } }`) plus a `fieldMeta` channel; assert `describe()` (sync) and `await describe({})` both return the channel metadata and never throw (no zod required). This proves the channel path is fully validator-agnostic.

- [ ] **Step 8: Commit**

```bash
git add packages/hub/src/introspection/describe.ts packages/hub/__tests__/introspection/describe.test.ts packages/hub/src/collection.ts packages/hub/src/vault.ts
git commit -m "feat(hub): async describe() — exact types, zod-4 meta merge, dynamic dict labels + key validation (#483)"
```

---

### Task 5: Showcase, docs, features.yaml

**Files:**
- Create: `showcases/src/126-describe-field-metadata.showcase.test.ts` (verify the next free number with `ls showcases/src | tail`)
- Modify: `docs/subsystems/` (the introspection/schema doc, or create `field-metadata.md`)
- Modify: `features.yaml`
- Modify: `MEMORY.md` pointer + the relevant memory file (post-merge bookkeeping; optional in-branch)

**Interfaces:**
- Consumes: the public `describe()` API + `FieldMeta`.

- [ ] **Step 1: Write the showcase (acts as the integration test + doc)**

Create `showcases/src/126-describe-field-metadata.showcase.test.ts` importing from `@noy-db/hub` + `@noy-db/to-memory`. Build a `sales` collection with `schema`/`moneyFields`/`dictKeyFields`/`refs`/`fieldMeta`; show two consumers reading ONE source: (a) render a table header row from `describe().fields.map(f => f.label)`; (b) build an export column spec from the same `describe()` (label + which fields are `sensitivity!=='public'`). Assert the rendered headers and that PII fields are flagged.

- [ ] **Step 2: Run the showcase**

Run: `npm test -w showcases -- 126`
Expected: PASS.

- [ ] **Step 3: Add the `field-metadata` node to `features.yaml`**

Add a node keyed to this feature with `spec: docs/superpowers/specs/2026-06-25-field-metadata-foundation-design.md`, the public symbols (`collection.describe`, `fieldMeta`), the showcase path, and invariants (descriptive-not-prescriptive; merge precedence; sync no-store-IO). Mirror the shape of an existing node (e.g. `vector-search`).

- [ ] **Step 4: Verify the spec-coverage gate**

Run: `node scripts/check-architecture.mjs` and the features.yaml coverage check (the script CI runs for "Spec coverage" — find it via `grep -rn "Spec coverage\|features.yaml" .github/workflows scripts`).
Expected: PASS — no dangling refs.

- [ ] **Step 5: Write the subsystem doc**

Document `describe()` (sync vs async), the `fieldMeta` channel, merge precedence, the scope boundary (descriptive not prescriptive), and the two-consumer pattern (table + export). One short page.

- [ ] **Step 6: Commit**

```bash
git add showcases/src/126-describe-field-metadata.showcase.test.ts features.yaml docs
git commit -m "docs(hub): field-metadata showcase + subsystem doc + features.yaml node (#483)"
```

---

## Self-Review

**Spec coverage (#483 portion):**
- `fieldMeta` channel (canonical, agnostic) → Task 1. ✓
- Merge precedence channel > zod-4 .meta() > inferred → Task 2 (pure) + Task 4 (zod tier). ✓
- Inference from money/refs/format → Task 3. ✓
- `collection.describe()` normalized, sync, config-only, zero store I/O → Task 3 (+ I/O-free assertion). ✓
- Extends existing FieldDescriptor vocabulary / reuses fields.ts mapper → Task 4 Step 3. ✓
- Async dynamic-dict labels via `_dict_*` → Task 4. ✓
- staticDict labels surface sync (#485 partial) → Task 3 Step 1/3. ✓
- Validator-agnostic (works without zod) → Task 4 Step 6. ✓
- Public exports from index.ts only, not kernel → Task 3 Step 5. ✓
- Showcase + features.yaml + docs → Task 5. ✓
- Portability / kernel ceilings untouched → arch-check in Tasks 1/3/4. ✓
- displayFor / aliases / sensitivity members → Task 1 type. ✓ (sensitivity here = #486's hub half.)

**Placeholder scan:** Task 3 Step 4 intentionally allows a stubbed async branch wired in Task 4 — this is a sequencing handoff, not a placeholder (the sync deliverable is complete and testable on its own). All code steps carry concrete code. The few "confirm during implementation which keys zod surfaces" notes (Task 4 Step 3) are empirical-verification instructions, like Plan 1 — they have a concrete default (map recognized keys 1:1, ignore unknown).

**Type consistency:** `FieldMeta`, `resolveFieldMeta`, `buildDescription`, `DescribedField`, `CollectionDescription`, `DescribeOptions`, `deriveZodFields`, `getFieldMeta` are used consistently across tasks. `describe()` overload signature identical in Tasks 3 and 4.

**Refinement vs spec (flag to controller):** the spec described `describe()` as sync with `{resolveDictLabels}` async opt-in; this plan keeps that and additionally makes exact validator-derived `type`/`constraints` and the zod-4 `.meta()` merge part of the async path (sync infers `type` from config). Reason: validator type derivation needs the lazy `import('zod')`, which is inherently async; forcing it sync would break the no-store/no-static-import constraints. This is faithful to the spec's intent (cheap sync default, async for the expensive parts).
