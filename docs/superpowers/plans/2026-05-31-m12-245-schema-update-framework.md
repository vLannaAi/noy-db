# M12 #245 — Schema-Update Strategy Framework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the always-on schema-change detection + dispatch seam plus the three light update strategies (`blindUpdate`/`lockSchema`/`additiveOnly`), enforced at the write path, so a non-additive schema change is caught instead of silently corrupting data.

**Architecture:** At `collection()` registration, when a persisted JSON-Schema baseline already exists and differs from the freshly-derived schema, compute a `SchemaDelta` and run it through the collection's ordered strategy list (first non-`allow` wins). The decision **gates whether the new baseline is persisted** (reject ⇒ keep the old schema) and is cached in a per-collection `SchemaUpdateGate`; `Collection.put`/`delete` await that gate and throw the strategy's rejection error before writing. Detection happens at registration (before the baseline is overwritten); enforcement happens at the write path (the same model `coordinatedCutover`/#232 uses).

**Tech Stack:** TypeScript, Vitest (`vitest run`), `@noy-db/to-memory`, Zod (the only validator with real JSON-Schema derivation today). Hub package at `packages/hub`. Builds on the existing `persisted-json-schema` feature.

**Spec:** `docs/superpowers/specs/2026-05-31-m12-schema-migration-epic-design.md` §3a + §4. Issue #245. Depends on #227 (`hub.writeQueue`, already merged — write paths already wrapped there, which is where the gate await goes).

---

## Spec amendment (apply as Task 0)

The advisor identified that the spec's success criterion #6 wording ("refused **at registration**") is architecturally impossible: `vault.collection()` is synchronous and returns `Collection<T>`, and the persisted-schema work is fire-and-forget with swallowed errors (`vault.ts:719–746`). Detection runs at registration, but **enforcement is at the write path**. Task 0 amends the spec to match before coding.

Also: this plan implements `SchemaDelta` as `{ collection, kind, added, removed, changed }` (no version fields — those belong to #232's `coordinatedCutover`), and ships strategies from `@noy-db/hub` (main entry), not a `@noy-db/hub/update` subpath (deferred to #232 for the heavy strategy + to avoid the cross-entry `instanceof` hazard documented in `tsup.config.ts`).

---

## Scope

**In scope (the framework + reject enforcement):**
- `SchemaDelta` classifier (`computeSchemaDelta`) — additive vs non-additive, top-level object properties + `required` diff.
- `SchemaUpdateStrategy` interface + `UpdateDecision` type + `evaluateStrategies` dispatch (ordered, first non-`allow` wins, short-circuit).
- Light strategies: `blindUpdate()`, `lockSchema({ fields? })`, `additiveOnly()`.
- Errors: `SchemaUpdateError` base, `NonAdditiveSchemaChangeError`, `SchemaLockedError`.
- Wiring: `persistSchemaIfNeeded` runs detection + dispatch, gates the baseline save; per-collection `schemaUpdate` option; `SchemaUpdateGate` enforced in `Collection.put`/`delete`.

**Out of scope (separate issues):**
- `coordinatedCutover` strategy / the `{ action: 'cutover' }` write-gating + drain barrier → **#232**. This plan's dispatch returns/handles `allow` and `reject` only; a `cutover` action is typed but unreachable until #232.
- The `@noy-db/hub/update` subpath + build config → **#232**.
- Deep classification rules (union widening, nested-object diffs, type narrowing) → v1 is top-level-property + required-ness; deeper rules deferred (noted in §8 of the spec).
- Non-Zod validators (whose `jsonSchema` is `null`): no baseline to diff ⇒ strategies never fire ⇒ change accepted. Documented limitation.

---

## File structure

- **Create** `packages/hub/src/schema-update/types.ts` — `SchemaDelta`, `FieldChange`, `UpdateDecision`, `UpdateContext`, `SchemaUpdateStrategy`, `TransformFn`.
- **Create** `packages/hub/src/schema-update/delta.ts` — `computeSchemaDelta(stored, fresh, collection)`.
- **Create** `packages/hub/src/schema-update/dispatch.ts` — `evaluateStrategies(delta, strategies, ctx)`.
- **Create** `packages/hub/src/schema-update/strategies.ts` — `blindUpdate`, `lockSchema`, `additiveOnly`.
- **Create** `packages/hub/src/schema-update/gate.ts` — `SchemaUpdateGate`.
- **Create** `packages/hub/src/schema-update/index.ts` — barrel for the above.
- **Modify** `packages/hub/src/errors.ts` — add the three error classes.
- **Modify** `packages/hub/src/index.ts` — re-export the public schema-update surface.
- **Modify** `packages/hub/src/persisted-schemas/register.ts` — `persistSchemaIfNeeded` accepts `strategies`, detects, gates the save, returns the decision.
- **Modify** `packages/hub/src/vault.ts` — `schemaUpdate` per-collection option; build the gate; thread into `collOpts`.
- **Modify** `packages/hub/src/collection.ts` — accept `schemaUpdateGate`; await it in `put`/`delete`.
- **Create** `packages/hub/__tests__/schema-update/{delta,strategies,dispatch}.test.ts` and `packages/hub/__tests__/schema-update-integration.test.ts`.

---

## Task 0: Amend spec criterion #6

**Files:**
- Modify: `docs/superpowers/specs/2026-05-31-m12-schema-migration-epic-design.md`

- [ ] **Step 1: Replace criterion #6**

Find:
```
6. With `persistJsonSchema: true` and `schemaUpdate: [additiveOnly()]`, a non-additive change is refused at registration with `NonAdditiveSchemaChangeError`; an additive change passes.
```
Replace with:
```
6. With `persistJsonSchema: true` and `schemaUpdate: [additiveOnly()]`, a non-additive change is detected at registration (the baseline is NOT overwritten) and **refused on the next `put`/`delete`** with `NonAdditiveSchemaChangeError`; an additive change passes. (`collection()` is synchronous, so the rejection surfaces at the write path; tests can also await the schema-check drain for eager feedback.)
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/2026-05-31-m12-schema-migration-epic-design.md
git commit -m "docs(m12): correct criterion #6 — enforcement at write path, not registration (#245)"
```

---

## Task 1: Types

**Files:**
- Create: `packages/hub/src/schema-update/types.ts`

- [ ] **Step 1: Write the file** (no test — pure type declarations, exercised by later tasks)

```ts
/**
 * Schema-update strategy framework types (#245, M12 §3a).
 *
 * The hub core detects a schema change (SchemaDelta) and dispatches it
 * through a collection's ordered strategy list. Strategies decide what
 * happens; the core only knows this interface.
 */

/** A single changed top-level property in a schema delta. */
export interface FieldChange {
  readonly field: string
  /** True when the field's required-ness flipped. */
  readonly requiredChanged: boolean
  /** True when the field's subschema shape changed. */
  readonly shapeChanged: boolean
}

/** The classified difference between a stored and a freshly-derived schema. */
export interface SchemaDelta {
  readonly collection: string
  readonly kind: 'none' | 'additive' | 'non-additive'
  /** Top-level properties present in the new schema but not the old. */
  readonly added: readonly string[]
  /** Top-level properties present in the old schema but not the new. */
  readonly removed: readonly string[]
  /** Top-level properties present in both but altered. */
  readonly changed: readonly FieldChange[]
}

/** Context handed to a strategy alongside the delta. */
export interface UpdateContext {
  readonly collection: string
}

/** Bulk transform run by the coordinatedCutover strategy (#232). */
export type TransformFn = (doc: Record<string, unknown>) => Record<string, unknown>

/**
 * A strategy's verdict on a detected schema change.
 * - `allow`   — no objection; the dispatcher falls through to the next strategy.
 * - `reject`  — terminal: refuse the change; `error` is thrown at the write path.
 * - `cutover` — terminal: run a coordinated drain-barrier (handled by #232).
 * New terminal actions may be added without breaking existing strategies.
 */
export type UpdateDecision =
  | { readonly action: 'allow' }
  | { readonly action: 'reject'; readonly error: Error }
  | { readonly action: 'cutover'; readonly transform: TransformFn }

/** A pluggable schema-evolution policy. */
export interface SchemaUpdateStrategy {
  readonly name: string
  onSchemaDelta(
    delta: SchemaDelta,
    ctx: UpdateContext,
  ): UpdateDecision | Promise<UpdateDecision>
}
```

- [ ] **Step 2: Verify it type-checks**

Run: `cd packages/hub && npx tsc --noEmit`
Expected: PASS (no consumers yet, so no errors from this file).

- [ ] **Step 3: Commit**

```bash
git add packages/hub/src/schema-update/types.ts
git commit -m "feat(hub): schema-update framework types (#245)"
```

---

## Task 2: `computeSchemaDelta` classifier

**Files:**
- Create: `packages/hub/src/schema-update/delta.ts`
- Test: `packages/hub/__tests__/schema-update/delta.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { computeSchemaDelta } from '../../src/schema-update/delta.js'

const obj = (props: Record<string, unknown>, required: string[] = []) =>
  ({ type: 'object', properties: props, required })

describe('computeSchemaDelta', () => {
  it('identical schemas → none', () => {
    const s = obj({ id: { type: 'string' }, amount: { type: 'number' } }, ['id'])
    expect(computeSchemaDelta(s, s, 'invoices').kind).toBe('none')
  })

  it('new optional field → additive', () => {
    const before = obj({ id: { type: 'string' } }, ['id'])
    const after = obj({ id: { type: 'string' }, note: { type: 'string' } }, ['id'])
    const d = computeSchemaDelta(before, after, 'invoices')
    expect(d.kind).toBe('additive')
    expect(d.added).toEqual(['note'])
  })

  it('new REQUIRED field → non-additive', () => {
    const before = obj({ id: { type: 'string' } }, ['id'])
    const after = obj({ id: { type: 'string' }, note: { type: 'string' } }, ['id', 'note'])
    expect(computeSchemaDelta(before, after, 'invoices').kind).toBe('non-additive')
  })

  it('removed field → non-additive', () => {
    const before = obj({ id: { type: 'string' }, amount: { type: 'number' } })
    const after = obj({ id: { type: 'string' } })
    const d = computeSchemaDelta(before, after, 'invoices')
    expect(d.kind).toBe('non-additive')
    expect(d.removed).toEqual(['amount'])
  })

  it('changed field type → non-additive', () => {
    const before = obj({ amount: { type: 'number' } })
    const after = obj({ amount: { type: 'string' } })
    const d = computeSchemaDelta(before, after, 'invoices')
    expect(d.kind).toBe('non-additive')
    expect(d.changed.map(c => c.field)).toEqual(['amount'])
    expect(d.changed[0]?.shapeChanged).toBe(true)
  })

  it('field made required (no shape change) → non-additive via requiredChanged', () => {
    const before = obj({ amount: { type: 'number' } }, [])
    const after = obj({ amount: { type: 'number' } }, ['amount'])
    const d = computeSchemaDelta(before, after, 'invoices')
    expect(d.kind).toBe('non-additive')
    expect(d.changed[0]).toMatchObject({ field: 'amount', requiredChanged: true, shapeChanged: false })
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/hub && npx vitest run __tests__/schema-update/delta.test.ts`
Expected: FAIL — `Cannot find module '../../src/schema-update/delta.js'`.

- [ ] **Step 3: Write the implementation**

```ts
/**
 * Classify the difference between two derived JSON Schemas (#245).
 *
 * v1 ruleset — top-level object properties + required-ness:
 *   - additive  ⇔ only new OPTIONAL properties (no removals, no changed
 *                 properties, no new required field, no required-ness flip)
 *   - non-additive ⇔ any removal, any shape/type change, any required-ness
 *                 flip, or a new REQUIRED property
 * Deeper rules (nested objects, union widening, type narrowing) are
 * deferred (spec §8). Callers only invoke this with two object schemas.
 */
import { canonicalize } from '../persisted-schemas/canonicalize.js'
import type { SchemaDelta, FieldChange } from './types.js'

interface ObjectSchema {
  readonly properties?: Record<string, unknown>
  readonly required?: readonly string[]
}

export function computeSchemaDelta(
  stored: object,
  fresh: object,
  collection: string,
): SchemaDelta {
  const a = stored as ObjectSchema
  const b = fresh as ObjectSchema
  const aProps = a.properties ?? {}
  const bProps = b.properties ?? {}
  const aReq = new Set(a.required ?? [])
  const bReq = new Set(b.required ?? [])

  const aKeys = Object.keys(aProps)
  const bKeys = Object.keys(bProps)

  const added = bKeys.filter(k => !(k in aProps))
  const removed = aKeys.filter(k => !(k in bProps))

  const changed: FieldChange[] = []
  for (const k of bKeys) {
    if (!(k in aProps)) continue
    const shapeChanged = canonicalize(aProps[k]) !== canonicalize(bProps[k])
    const requiredChanged = aReq.has(k) !== bReq.has(k)
    if (shapeChanged || requiredChanged) {
      changed.push({ field: k, requiredChanged, shapeChanged })
    }
  }

  let kind: SchemaDelta['kind']
  if (added.length === 0 && removed.length === 0 && changed.length === 0) {
    kind = 'none'
  } else if (
    removed.length === 0 &&
    changed.length === 0 &&
    added.every(k => !bReq.has(k))
  ) {
    kind = 'additive'
  } else {
    kind = 'non-additive'
  }

  return { collection, kind, added, removed, changed }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/hub && npx vitest run __tests__/schema-update/delta.test.ts`
Expected: PASS — all 6 tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/schema-update/delta.ts packages/hub/__tests__/schema-update/delta.test.ts
git commit -m "feat(hub): computeSchemaDelta additive/non-additive classifier (#245)"
```

---

## Task 3: Error classes

**Files:**
- Modify: `packages/hub/src/errors.ts`

- [ ] **Step 1: Find the insertion point**

Run: `grep -n "export class SchemaValidationError" packages/hub/src/errors.ts`
Note the line; insert the new classes after that class's closing brace (the Data-errors cluster is the natural home).

- [ ] **Step 2: Add the classes**

Add after `SchemaValidationError`'s closing `}`:

```ts
/** Base for schema-evolution strategy rejections (#245). */
export class SchemaUpdateError extends NoydbError {
  constructor(code: string, message: string) {
    super(code, message)
    this.name = 'SchemaUpdateError'
  }
}

/** A non-additive schema change was rejected by the `additiveOnly()` strategy. */
export class NonAdditiveSchemaChangeError extends SchemaUpdateError {
  constructor(message: string) {
    super('NON_ADDITIVE_SCHEMA_CHANGE', message)
    this.name = 'NonAdditiveSchemaChangeError'
  }
}

/** A schema change was rejected by the `lockSchema()` strategy. */
export class SchemaLockedError extends SchemaUpdateError {
  constructor(message: string) {
    super('SCHEMA_LOCKED', message)
    this.name = 'SchemaLockedError'
  }
}
```

- [ ] **Step 3: Verify it type-checks**

Run: `cd packages/hub && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/hub/src/errors.ts
git commit -m "feat(hub): SchemaUpdateError + NonAdditive/Locked subclasses (#245)"
```

---

## Task 4: Light strategies

**Files:**
- Create: `packages/hub/src/schema-update/strategies.ts`
- Test: `packages/hub/__tests__/schema-update/strategies.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { blindUpdate, lockSchema, additiveOnly } from '../../src/schema-update/strategies.js'
import { NonAdditiveSchemaChangeError, SchemaLockedError } from '../../src/errors.js'
import type { SchemaDelta } from '../../src/schema-update/types.js'

const delta = (over: Partial<SchemaDelta>): SchemaDelta => ({
  collection: 'invoices', kind: 'additive', added: [], removed: [], changed: [], ...over,
})
const ctx = { collection: 'invoices' }

describe('blindUpdate', () => {
  it('always allows', async () => {
    expect(await blindUpdate().onSchemaDelta(delta({ kind: 'non-additive' }), ctx)).toEqual({ action: 'allow' })
  })
})

describe('additiveOnly', () => {
  it('allows additive', async () => {
    expect(await additiveOnly().onSchemaDelta(delta({ kind: 'additive' }), ctx)).toEqual({ action: 'allow' })
  })
  it('allows none', async () => {
    expect(await additiveOnly().onSchemaDelta(delta({ kind: 'none' }), ctx)).toEqual({ action: 'allow' })
  })
  it('rejects non-additive with NonAdditiveSchemaChangeError', async () => {
    const d = await additiveOnly().onSchemaDelta(delta({ kind: 'non-additive', removed: ['amount'] }), ctx)
    expect(d.action).toBe('reject')
    if (d.action === 'reject') expect(d.error).toBeInstanceOf(NonAdditiveSchemaChangeError)
  })
})

describe('lockSchema', () => {
  it('rejects any change when no fields given', async () => {
    const d = await lockSchema().onSchemaDelta(delta({ kind: 'additive', added: ['note'] }), ctx)
    expect(d.action).toBe('reject')
    if (d.action === 'reject') expect(d.error).toBeInstanceOf(SchemaLockedError)
  })
  it('allows none even when locked', async () => {
    expect(await lockSchema().onSchemaDelta(delta({ kind: 'none' }), ctx)).toEqual({ action: 'allow' })
  })
  it('with fields: rejects only when a listed field changes', async () => {
    const onlyId = lockSchema({ fields: ['id'] })
    expect(await onlyId.onSchemaDelta(delta({ kind: 'additive', added: ['note'] }), ctx)).toEqual({ action: 'allow' })
    const hit = await onlyId.onSchemaDelta(delta({ kind: 'non-additive', removed: ['id'] }), ctx)
    expect(hit.action).toBe('reject')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/hub && npx vitest run __tests__/schema-update/strategies.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
/** Bundled light update strategies (#245). */
import { NonAdditiveSchemaChangeError, SchemaLockedError } from '../errors.js'
import type { SchemaUpdateStrategy, SchemaDelta } from './types.js'

/** Allow any schema change. Explicit blind / back-compat. */
export function blindUpdate(): SchemaUpdateStrategy {
  return { name: 'blindUpdate', onSchemaDelta: () => ({ action: 'allow' }) }
}

/** Allow additive changes; reject non-additive ones. The safety backstop. */
export function additiveOnly(): SchemaUpdateStrategy {
  return {
    name: 'additiveOnly',
    onSchemaDelta(delta: SchemaDelta) {
      if (delta.kind === 'non-additive') {
        return {
          action: 'reject' as const,
          error: new NonAdditiveSchemaChangeError(
            `Non-additive schema change to "${delta.collection}" ` +
              `(added: [${delta.added.join(', ')}], removed: [${delta.removed.join(', ')}], ` +
              `changed: [${delta.changed.map(c => c.field).join(', ')}]). ` +
              `Register a coordinatedCutover() strategy to migrate, or revert the change.`,
          ),
        }
      }
      return { action: 'allow' as const }
    },
  }
}

/**
 * Reject schema changes. With `fields`, reject only when one of those
 * fields is added/removed/changed; otherwise reject any non-`none` delta.
 */
export function lockSchema(opts?: { readonly fields?: readonly string[] }): SchemaUpdateStrategy {
  const fields = opts?.fields
  return {
    name: 'lockSchema',
    onSchemaDelta(delta: SchemaDelta) {
      if (delta.kind === 'none') return { action: 'allow' as const }
      const touched = fields
        ? [...delta.added, ...delta.removed, ...delta.changed.map(c => c.field)].filter(f => fields.includes(f))
        : ['<any>']
      if (touched.length === 0) return { action: 'allow' as const }
      return {
        action: 'reject' as const,
        error: new SchemaLockedError(
          `Schema for "${delta.collection}" is locked` +
            (fields ? ` on fields [${fields.join(', ')}] (touched: [${touched.join(', ')}])` : '') +
            `; the change was refused.`,
        ),
      }
    },
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/hub && npx vitest run __tests__/schema-update/strategies.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/schema-update/strategies.ts packages/hub/__tests__/schema-update/strategies.test.ts
git commit -m "feat(hub): blindUpdate / additiveOnly / lockSchema strategies (#245)"
```

---

## Task 5: Dispatch

**Files:**
- Create: `packages/hub/src/schema-update/dispatch.ts`
- Test: `packages/hub/__tests__/schema-update/dispatch.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { evaluateStrategies } from '../../src/schema-update/dispatch.js'
import { additiveOnly, lockSchema, blindUpdate } from '../../src/schema-update/strategies.js'
import type { SchemaDelta } from '../../src/schema-update/types.js'

const ctx = { collection: 'invoices' }
const nonAdditive: SchemaDelta = { collection: 'invoices', kind: 'non-additive', added: [], removed: ['amount'], changed: [] }
const additive: SchemaDelta = { collection: 'invoices', kind: 'additive', added: ['note'], removed: [], changed: [] }

describe('evaluateStrategies', () => {
  it('empty list → allow', async () => {
    expect(await evaluateStrategies(additive, [], ctx)).toEqual({ action: 'allow' })
  })
  it('all allow → allow', async () => {
    expect(await evaluateStrategies(additive, [blindUpdate(), additiveOnly()], ctx)).toEqual({ action: 'allow' })
  })
  it('first non-allow wins and short-circuits', async () => {
    let secondRan = false
    const spy = { name: 'spy', onSchemaDelta: () => { secondRan = true; return { action: 'allow' as const } } }
    const d = await evaluateStrategies(nonAdditive, [additiveOnly(), spy], ctx)
    expect(d.action).toBe('reject')
    expect(secondRan).toBe(false)
  })
  it('order is the only precedence: lockSchema first beats additiveOnly', async () => {
    const d = await evaluateStrategies(nonAdditive, [lockSchema(), additiveOnly()], ctx)
    expect(d.action).toBe('reject')
    if (d.action === 'reject') expect(d.error.name).toBe('SchemaLockedError')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/hub && npx vitest run __tests__/schema-update/dispatch.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
/** Ordered strategy evaluation (#245): first non-`allow` decision wins. */
import type { SchemaDelta, SchemaUpdateStrategy, UpdateContext, UpdateDecision } from './types.js'

export async function evaluateStrategies(
  delta: SchemaDelta,
  strategies: readonly SchemaUpdateStrategy[],
  ctx: UpdateContext,
): Promise<UpdateDecision> {
  for (const strategy of strategies) {
    const decision = await strategy.onSchemaDelta(delta, ctx)
    if (decision.action !== 'allow') return decision
  }
  return { action: 'allow' }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/hub && npx vitest run __tests__/schema-update/dispatch.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/schema-update/dispatch.ts packages/hub/__tests__/schema-update/dispatch.test.ts
git commit -m "feat(hub): evaluateStrategies ordered dispatch (#245)"
```

---

## Task 6: `SchemaUpdateGate` + barrel + public exports

**Files:**
- Create: `packages/hub/src/schema-update/gate.ts`
- Create: `packages/hub/src/schema-update/index.ts`
- Modify: `packages/hub/src/index.ts`
- Test: `packages/hub/__tests__/schema-update/gate.test.ts`

- [ ] **Step 1: Write the failing gate test**

```ts
import { describe, expect, it } from 'vitest'
import { SchemaUpdateGate } from '../../src/schema-update/gate.js'

describe('SchemaUpdateGate', () => {
  it('assertWritable resolves when the decision is allow', async () => {
    const gate = new SchemaUpdateGate(Promise.resolve({ action: 'allow' }))
    await expect(gate.assertWritable()).resolves.toBeUndefined()
  })
  it('assertWritable throws the strategy error when the decision is reject', async () => {
    const err = new Error('nope')
    const gate = new SchemaUpdateGate(Promise.resolve({ action: 'reject', error: err }))
    await expect(gate.assertWritable()).rejects.toBe(err)
  })
  it('re-asserts the same rejection on repeated writes (cached decision)', async () => {
    const err = new Error('still nope')
    const gate = new SchemaUpdateGate(Promise.resolve({ action: 'reject', error: err }))
    await expect(gate.assertWritable()).rejects.toBe(err)
    await expect(gate.assertWritable()).rejects.toBe(err)
  })
  it('a rejected detection promise does not block writes (detection failure ≠ schema rejection)', async () => {
    const gate = new SchemaUpdateGate(Promise.reject(new Error('detection crashed')))
    await expect(gate.assertWritable()).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/hub && npx vitest run __tests__/schema-update/gate.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the gate**

```ts
/**
 * Per-collection write gate (#245). Holds the (async) update decision
 * computed at registration; `Collection.put`/`delete` await it before
 * writing and throw the strategy's rejection error.
 *
 * Detection FAILURE (the promise rejecting) is deliberately NOT a write
 * block — schema detection is a fingerprint safety net, not a correctness
 * invariant (matches how persisted-schema write failures are swallowed).
 * Only an explicit `reject` decision blocks writes.
 */
import type { UpdateDecision } from './types.js'

export class SchemaUpdateGate {
  readonly #decision: Promise<UpdateDecision | null>

  constructor(decision: Promise<UpdateDecision>) {
    // Swallow detection failures into a non-blocking null.
    this.#decision = decision.catch(() => null)
  }

  async assertWritable(): Promise<void> {
    const decision = await this.#decision
    if (decision && decision.action === 'reject') {
      throw decision.error
    }
    // 'cutover' write-gating is handled by #232's coordinatedCutover.
  }
}
```

- [ ] **Step 4: Write the barrel** `packages/hub/src/schema-update/index.ts`

```ts
export type {
  SchemaDelta,
  FieldChange,
  UpdateContext,
  UpdateDecision,
  TransformFn,
  SchemaUpdateStrategy,
} from './types.js'
export { computeSchemaDelta } from './delta.js'
export { evaluateStrategies } from './dispatch.js'
export { blindUpdate, additiveOnly, lockSchema } from './strategies.js'
export { SchemaUpdateGate } from './gate.js'
```

- [ ] **Step 5: Re-export the public surface from the main entry**

In `packages/hub/src/index.ts`, alongside the other re-exports (near the `WriteQueue` export added in #227), add:

```ts
// Schema-update strategies (#245)
export type {
  SchemaDelta,
  FieldChange,
  UpdateContext,
  UpdateDecision,
  SchemaUpdateStrategy,
} from './schema-update/index.js'
export { blindUpdate, additiveOnly, lockSchema } from './schema-update/index.js'
```

`computeSchemaDelta`, `evaluateStrategies`, and `SchemaUpdateGate` stay internal (not re-exported from the public barrel). The error classes are already public via the existing `errors.js` re-export.

- [ ] **Step 6: Run gate test + full typecheck**

Run: `cd packages/hub && npx vitest run __tests__/schema-update/gate.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add packages/hub/src/schema-update/gate.ts packages/hub/src/schema-update/index.ts packages/hub/src/index.ts packages/hub/__tests__/schema-update/gate.test.ts
git commit -m "feat(hub): SchemaUpdateGate + public schema-update exports (#245)"
```

---

## Task 7: Detection in `persistSchemaIfNeeded` (gates the baseline save)

**Files:**
- Modify: `packages/hub/src/persisted-schemas/register.ts`
- Test: `packages/hub/__tests__/schema-update/register-detection.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, beforeEach } from 'vitest'
import { z } from 'zod'
import { memory } from '../../../to-memory/src/index.js'
import { persistSchemaIfNeeded } from '../../src/persisted-schemas/register.js'
import { SCHEMAS_COLLECTION } from '../../src/persisted-schemas/storage.js'
import { additiveOnly } from '../../src/schema-update/strategies.js'
import { NonAdditiveSchemaChangeError } from '../../src/errors.js'
import { deriveDek } from './_dek-helper.js' // see Step 2

const VAULT = 'v1'
const COL = 'invoices'

describe('persistSchemaIfNeeded + update strategies', () => {
  let store: ReturnType<typeof memory>
  let dek: CryptoKey
  beforeEach(async () => {
    store = memory()
    dek = await deriveDek()
  })

  it('additive change with additiveOnly → allow + baseline written', async () => {
    await persistSchemaIfNeeded({ store, vault: VAULT, collectionName: COL, validator: z.object({ id: z.string() }), dek })
    const before = (await store.get(VAULT, SCHEMAS_COLLECTION, COL))!._v
    const result = await persistSchemaIfNeeded({
      store, vault: VAULT, collectionName: COL,
      validator: z.object({ id: z.string(), note: z.string().optional() }),
      dek, strategies: [additiveOnly()],
    })
    expect(result.decision).toEqual({ action: 'allow' })
    expect((await store.get(VAULT, SCHEMAS_COLLECTION, COL))!._v).toBe(before + 1)
  })

  it('non-additive change with additiveOnly → reject + baseline NOT overwritten', async () => {
    await persistSchemaIfNeeded({ store, vault: VAULT, collectionName: COL, validator: z.object({ id: z.string(), amount: z.number() }), dek })
    const before = (await store.get(VAULT, SCHEMAS_COLLECTION, COL))!._v
    const result = await persistSchemaIfNeeded({
      store, vault: VAULT, collectionName: COL,
      validator: z.object({ id: z.string() }), // removed 'amount' — non-additive
      dek, strategies: [additiveOnly()],
    })
    expect(result.decision?.action).toBe('reject')
    if (result.decision?.action === 'reject') expect(result.decision.error).toBeInstanceOf(NonAdditiveSchemaChangeError)
    expect(result.written).toBe(false)
    expect((await store.get(VAULT, SCHEMAS_COLLECTION, COL))!._v).toBe(before) // unchanged
  })

  it('first registration (no baseline) never rejects', async () => {
    const result = await persistSchemaIfNeeded({
      store, vault: VAULT, collectionName: COL,
      validator: z.object({ id: z.string() }), dek, strategies: [additiveOnly()],
    })
    expect(result.decision).toEqual({ action: 'allow' })
    expect(result.written).toBe(true)
  })
})
```

- [ ] **Step 2: Add the DEK helper** `packages/hub/__tests__/schema-update/_dek-helper.ts`

```ts
/** A throwaway AES-GCM key for persisted-schema tests. */
export async function deriveDek(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}
```

(If `packages/hub/__tests__/persisted-schemas/` already exposes a DEK helper, import that instead — check with `grep -rn "generateKey\|deriveDek\|AES-GCM" packages/hub/__tests__/persisted-schemas/` and reuse it to stay DRY.)

- [ ] **Step 3: Run to verify it fails**

Run: `cd packages/hub && npx vitest run __tests__/schema-update/register-detection.test.ts`
Expected: FAIL — `strategies` not accepted / `result.decision` undefined.

- [ ] **Step 4: Extend `persistSchemaIfNeeded`**

In `packages/hub/src/persisted-schemas/register.ts`:

Add imports at the top:
```ts
import { computeSchemaDelta } from '../schema-update/delta.js'
import { evaluateStrategies } from '../schema-update/dispatch.js'
import type { SchemaUpdateStrategy, UpdateDecision } from '../schema-update/types.js'
```

Add `decision` to the result interface:
```ts
export interface PersistSchemaResult {
  readonly written: boolean
  readonly skipped: boolean
  readonly envelope: PersistedSchemaEnvelope
  readonly decision?: UpdateDecision   // present when strategies ran
}
```

Replace the body of `persistSchemaIfNeeded` (keep the signature, add `strategies`):
```ts
export async function persistSchemaIfNeeded(opts: {
  readonly store: NoydbStore
  readonly vault: string
  readonly collectionName: string
  readonly validator: unknown
  readonly dek: CryptoKey
  readonly strategies?: readonly SchemaUpdateStrategy[]
}): Promise<PersistSchemaResult> {
  const fresh = await derivePersistedSchema(opts.validator)
  const stored = await loadPersistedSchema(opts.store, opts.vault, opts.collectionName, opts.dek)

  if (stored && isEquivalent(stored, fresh)) {
    return { written: false, skipped: true, envelope: stored, decision: { action: 'allow' } }
  }

  // Changed (or first registration). Run update strategies only when we
  // have a comparable JSON-Schema baseline and strategies were registered.
  let decision: UpdateDecision = { action: 'allow' }
  const strategies = opts.strategies ?? []
  if (
    stored &&
    strategies.length > 0 &&
    stored.kind === fresh.kind &&
    isPlainObject(stored.jsonSchema) &&
    isPlainObject(fresh.jsonSchema)
  ) {
    const delta = computeSchemaDelta(stored.jsonSchema, fresh.jsonSchema, opts.collectionName)
    decision = await evaluateStrategies(delta, strategies, { collection: opts.collectionName })
  }

  if (decision.action !== 'allow') {
    // reject (or, in #232, cutover): do NOT overwrite the baseline — the
    // old schema stays the source of truth until the change is resolved.
    return { written: false, skipped: false, envelope: stored ?? fresh, decision }
  }

  await savePersistedSchema(opts.store, opts.vault, opts.collectionName, opts.dek, fresh)
  return { written: true, skipped: false, envelope: fresh, decision }
}

function isPlainObject(v: unknown): v is object {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd packages/hub && npx vitest run __tests__/schema-update/register-detection.test.ts`
Expected: PASS — all 3 tests green.

- [ ] **Step 6: Confirm no regression in existing persisted-schema tests**

Run: `cd packages/hub && npx vitest run __tests__/persisted-schemas/`
Expected: PASS (back-compat — `strategies` is optional; `decision` is additive on the result).

- [ ] **Step 7: Commit**

```bash
git add packages/hub/src/persisted-schemas/register.ts packages/hub/__tests__/schema-update/register-detection.test.ts packages/hub/__tests__/schema-update/_dek-helper.ts
git commit -m "feat(hub): detect schema delta + dispatch strategies in persistSchemaIfNeeded (#245)"
```

---

## Task 8: Wire the `schemaUpdate` option + gate into `vault.collection()`

**Files:**
- Modify: `packages/hub/src/vault.ts`

- [ ] **Step 1: Read the current registration block**

Run: `sed -n '500,560p;715,760p' packages/hub/src/vault.ts`
Confirm: the `options` type (~504–553), the `collOpts` object (~613), `new Collection` (~715), the fire-and-forget persist block (~719–746), and `_pendingSchemaWrites` (~261).

- [ ] **Step 2: Add the option to the `collection()` signature**

In the `options?: { ... }` parameter type, beside `persistJsonSchema?: boolean`, add:

```ts
    /**
     * Ordered schema-update strategies (#245). On a detected schema
     * change, evaluated in order; the first non-`allow` decision wins.
     * A `reject` is enforced at the write path (`put`/`delete` throw).
     * Requires `persistJsonSchema: true` (detection needs the baseline).
     */
    schemaUpdate?: readonly import('./schema-update/types.js').SchemaUpdateStrategy[]
```

- [ ] **Step 3: Build the gate and start detection before constructing the Collection**

Add the import at the top of `vault.ts`:
```ts
import { SchemaUpdateGate } from './schema-update/gate.js'
```

Immediately BEFORE the `const collOpts = { ... }` object (~line 613), insert:

```ts
    // #245 — schema-update gate. Only when persistence + strategies are on.
    let schemaUpdateGate: SchemaUpdateGate | undefined
    if (options?.persistJsonSchema === true && options.schema !== undefined && (options.schemaUpdate?.length ?? 0) > 0) {
      const validator: unknown = options.schema
      const strategies = options.schemaUpdate ?? []
      const work = (async () => {
        const dek = await this.getDEK(collectionName)
        const result = await persistSchemaIfNeeded({
          store: this.adapter, vault: this.name, collectionName, validator, dek, strategies,
        })
        return result.decision ?? { action: 'allow' as const }
      })()
      // Surface for the existing drain; swallow so collection() never rejects.
      this._pendingSchemaWrites.push(work.then(() => {}, () => {}))
      schemaUpdateGate = new SchemaUpdateGate(work)
    }
```

- [ ] **Step 4: Thread the gate into `collOpts`**

In the `collOpts` object, beside `writeQueue: this.noydb._writeQueueTracker,` (added in #227), add:

```ts
        schemaUpdateGate,
```

- [ ] **Step 5: Avoid double-persisting**

The existing fire-and-forget block (~719–746) also calls `persistSchemaIfNeeded` (without strategies). When a `schemaUpdate` list is present, Step 3 already ran persistence — so guard the old block to skip when the gate handled it. Change its condition from:
```ts
if (options?.persistJsonSchema === true && options.schema !== undefined) {
```
to:
```ts
if (options?.persistJsonSchema === true && options.schema !== undefined && (options.schemaUpdate?.length ?? 0) === 0) {
```

- [ ] **Step 6: Typecheck**

Run: `cd packages/hub && npx tsc --noEmit`
Expected: errors that `schemaUpdateGate` is not a known Collection opt — resolved in Task 9. Do NOT commit yet; proceed to Task 9.

---

## Task 9: Enforce the gate in `Collection.put`/`delete`

**Files:**
- Modify: `packages/hub/src/collection.ts`

- [ ] **Step 1: Add the constructor opt + field**

Add the import:
```ts
import type { SchemaUpdateGate } from './schema-update/gate.js'
```

In the constructor opts type, beside the `writeQueue?` opt (added in #227):
```ts
    /** #245 — per-collection schema-update gate; `put`/`delete` await it. */
    schemaUpdateGate?: SchemaUpdateGate | undefined
```

In the class field block beside `private readonly writeQueue`:
```ts
  private readonly schemaUpdateGate: SchemaUpdateGate | undefined
```

In the constructor assignments beside `this.writeQueue = opts.writeQueue`:
```ts
    this.schemaUpdateGate = opts.schemaUpdateGate
```

- [ ] **Step 2: Await the gate at the top of the tracked write wrappers**

In the public `put` wrapper (added in #227), make it await the gate before tracking:
```ts
  async put(id: string, record: T, options?: { readonly reason?: string }): Promise<void> {
    await this.schemaUpdateGate?.assertWritable()
    if (!this.writeQueue) return this.putInternal(id, record, options)
    return this.writeQueue.track(() => this.putInternal(id, record, options))
  }
```

In the public `delete` wrapper:
```ts
  async delete(id: string): Promise<void> {
    await this.schemaUpdateGate?.assertWritable()
    if (!this.writeQueue) return this.deleteInternal(id)
    return this.writeQueue.track(() => this.deleteInternal(id))
  }
```

(The gate await is OUTSIDE `track()` so a rejected write never counts toward `writeQueue.depth`.)

- [ ] **Step 3: Typecheck (resolves Task 8 errors)**

Run: `cd packages/hub && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit Tasks 8 + 9 together**

```bash
git add packages/hub/src/vault.ts packages/hub/src/collection.ts
git commit -m "feat(hub): wire schemaUpdate option + write-path gate enforcement (#245)"
```

---

## Task 10: End-to-end integration test

**Files:**
- Create: `packages/hub/__tests__/schema-update-integration.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
/**
 * E2E for the schema-update framework (#245): a non-additive change with
 * additiveOnly() is rejected on the next write; additive passes; a
 * coordinatedCutover-less break falls through to the backstop.
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createNoydb } from '../src/noydb.js'
import { memory } from '../../to-memory/src/index.js'
import { additiveOnly, lockSchema } from '../src/schema-update/index.js'
import { NonAdditiveSchemaChangeError, SchemaLockedError } from '../src/errors.js'

interface Invoice extends Record<string, unknown> { id: string; amount?: number }

async function reopen(store: ReturnType<typeof memory>) {
  const db = await createNoydb({ store, user: 'alice', secret: 'schema-update-test-pass-1234' })
  return db.openVault('demo')
}

describe('schema-update framework (#245)', () => {
  it('additive change → write succeeds', async () => {
    const store = memory()
    let v = await reopen(store)
    v.collection<Invoice>('invoices', { schema: z.object({ id: z.string() }), persistJsonSchema: true, schemaUpdate: [additiveOnly()] })
    await v._drainPendingSchemaWrites()

    v = await reopen(store)
    const invoices = v.collection<Invoice>('invoices', {
      schema: z.object({ id: z.string(), amount: z.number().optional() }), // additive
      persistJsonSchema: true, schemaUpdate: [additiveOnly()],
    })
    await v._drainPendingSchemaWrites()
    await expect(invoices.put('i1', { id: 'i1', amount: 10 })).resolves.toBeUndefined()
  })

  it('non-additive change → next put throws NonAdditiveSchemaChangeError', async () => {
    const store = memory()
    let v = await reopen(store)
    v.collection<Invoice>('invoices', { schema: z.object({ id: z.string(), amount: z.number() }), persistJsonSchema: true, schemaUpdate: [additiveOnly()] })
    await v._drainPendingSchemaWrites()

    v = await reopen(store)
    const invoices = v.collection<Invoice>('invoices', {
      schema: z.object({ id: z.string() }), // removed 'amount' — non-additive
      persistJsonSchema: true, schemaUpdate: [additiveOnly()],
    })
    await v._drainPendingSchemaWrites()
    await expect(invoices.put('i1', { id: 'i1' })).rejects.toBeInstanceOf(NonAdditiveSchemaChangeError)
  })

  it('lockSchema first → SchemaLockedError wins over additiveOnly', async () => {
    const store = memory()
    let v = await reopen(store)
    v.collection<Invoice>('invoices', { schema: z.object({ id: z.string() }), persistJsonSchema: true, schemaUpdate: [lockSchema(), additiveOnly()] })
    await v._drainPendingSchemaWrites()

    v = await reopen(store)
    const invoices = v.collection<Invoice>('invoices', {
      schema: z.object({ id: z.string(), note: z.string().optional() }), // additive, but locked
      persistJsonSchema: true, schemaUpdate: [lockSchema(), additiveOnly()],
    })
    await v._drainPendingSchemaWrites()
    await expect(invoices.put('i1', { id: 'i1' })).rejects.toBeInstanceOf(SchemaLockedError)
  })

  it('no schemaUpdate strategy → non-additive change is accepted (blind, back-compat)', async () => {
    const store = memory()
    let v = await reopen(store)
    v.collection<Invoice>('invoices', { schema: z.object({ id: z.string(), amount: z.number() }), persistJsonSchema: true })
    await v._drainPendingSchemaWrites()

    v = await reopen(store)
    const invoices = v.collection<Invoice>('invoices', { schema: z.object({ id: z.string() }), persistJsonSchema: true })
    await v._drainPendingSchemaWrites()
    await expect(invoices.put('i1', { id: 'i1' })).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 2: Run to verify it passes**

Run: `cd packages/hub && npx vitest run __tests__/schema-update-integration.test.ts`
Expected: PASS — all 4 tests green.

If the rejection tests flake because the write runs before detection settles: the gate awaits the *same* `work` promise pushed to `_pendingSchemaWrites`, and the test calls `_drainPendingSchemaWrites()` before writing, so detection is guaranteed complete. If a test omits the drain, the gate still awaits detection inside `put` — so no race either way.

- [ ] **Step 3: Commit**

```bash
git add packages/hub/__tests__/schema-update-integration.test.ts
git commit -m "test(hub): E2E schema-update framework enforcement (#245)"
```

---

## Task 11: Register the feature + final verification

**Files:**
- Modify: `features.yaml`

- [ ] **Step 1: Add the feature entry**

In `features.yaml`, after the `observable-write-queue` entry, add:

```yaml
  - id: schema-update-strategies
    name: Schema-update strategy framework
    cluster: core
    spec: docs/superpowers/specs/2026-05-31-m12-schema-migration-epic-design.md#3a-open-update-strategy-model-mechanism-not-policy
    subsystem_doc: docs/superpowers/specs/2026-05-31-m12-schema-migration-epic-design.md
    package: '@noy-db/hub'
    factory: null
    status: preview
    showcases: []
    recipes: []
    playground_pages: []
    diagrams: []
    invariants:
      - 'detection runs before the persisted-schema baseline is overwritten'
      - 'a reject decision is enforced at the write path (put/delete throw); the baseline is not overwritten'
      - 'ordered strategy list: first non-allow decision wins and short-circuits'
    related: [persisted-json-schema, observable-write-queue]
```

Verify the spec anchor: run `grep -n "^### 3a" docs/superpowers/specs/2026-05-31-m12-schema-migration-epic-design.md` and confirm the GitHub-slug of that heading matches the `spec:` anchor above; adjust the anchor if the validator (next step) reports a mismatch.

- [ ] **Step 2: Run the validator**

Run: `node scripts/validate-features.mjs`
Expected: PASS. If it reports the spec anchor doesn't resolve, fix the `#...` slug to match the actual `### 3a …` heading slug and re-run.

- [ ] **Step 3: Full suite + typecheck + lint**

Run: `cd packages/hub && npx vitest run && npx tsc --noEmit && npm run lint`
Expected: entire suite PASS, no type errors, no lint errors.

- [ ] **Step 4: Commit**

```bash
git add features.yaml
git commit -m "chore(features): register schema-update-strategies (#245)"
```

- [ ] **Step 5: Confirm clean tree**

Run: `git status`
Expected: clean working tree.

---

## Self-review checklist (already applied)

- **Spec coverage:** §3a detection → Task 2 (`computeSchemaDelta`); strategy interface + dispatch → Tasks 1, 5; light strategies → Task 4; errors → Task 3; per-collection stackable `schemaUpdate` + ordered evaluation → Tasks 5, 8; detect-before-overwrite + gate-the-save → Task 7; write-path enforcement → Tasks 6, 9; back-compat blind default → Task 10 test 4; criterion #6 corrected → Task 0; `features.yaml` → Task 11.
- **Out-of-scope honesty:** `cutover` action typed but unreachable (no strategy returns it until #232); `@noy-db/hub/update` subpath deferred to #232; non-Zod (`jsonSchema: null`) validators get no safety net (documented).
- **Type consistency:** `SchemaUpdateStrategy.onSchemaDelta` / `UpdateDecision` / `SchemaDelta` / `evaluateStrategies` / `computeSchemaDelta` / `SchemaUpdateGate.assertWritable` names match across tasks; `persistSchemaIfNeeded` gains `strategies?` + `decision?` used consistently in Tasks 7–8; `schemaUpdateGate` opt name matches between vault.ts (Task 8) and collection.ts (Task 9).
- **Race + ordering (advisor's verify items):** detection runs before `savePersistedSchema` (Task 7); the gate awaits the same detection promise the write path consumes (Tasks 6, 9); first registration (no baseline) never rejects (Task 7 test 3); a `reject` that doesn't persist re-detects and re-rejects on next load (idempotent, by construction).
- **No placeholders:** every code step shows complete code; every run step states the command + expected result.
