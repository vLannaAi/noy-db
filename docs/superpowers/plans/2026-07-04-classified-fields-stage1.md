# Classified Fields — Stage 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship stage 1 of the classified-fields design (spec: `docs/superpowers/specs/2026-07-04-classified-fields-design.md`): behavioral sensitive-field descriptors + presets, write-time riders/validation/`storage:'never'` rejection, sealed-backed storage, `withClassified()`-gated `reveal`, `x-classified` in describe()/toJSONSchema, and a shared `applyListProjection()` consumed by as-csv/as-xlsx (closes #489). **No new cryptography.**

**Architecture:** `classifiedFields` is a new ③ schema-declared collection option threaded exactly like `moneyFields`/`dictKeyFields`; recoverable classified fields merge into the existing `sensitive` set (sealed via #306 machinery — `SealedHandle`, `dualReadSealedSlot`); riders become entries in the existing `computed` pipeline; the only ② gate is `withClassified()` guarding `collection.reveal()`, mirroring the withAttestation exemplar.

**Tech Stack:** TypeScript ESM, vitest, tsup; hub-portable (no Node built-ins in `hub/src/**`); `crypto.subtle` only (not needed in stage 1).

**Working branch:** the `design/classified-fields` worktree at `/Users/vicio/lanna-db/.worktrees/classified-fields` (spec committed as b5268bf9). All paths below are relative to the repo root there.

## Global Constraints

- NO npm crypto packages, ever (`no-crypto-deps` guard); hub src imports no Node-only modules (`hub-portable`).
- Never add Claude attribution to commits; grep every diff for the private pilot-client name before committing.
- Before EVERY push: `pnpm --filter @noy-db/hub lint` AND `pnpm --filter @noy-db/hub typecheck` (CI's "Lint + typecheck" runs both; typecheck includes the `.test.ts` ratchet — new tests must compile).
- Any hub public-API change ⇒ full cross-package suite `pnpm turbo test --concurrency=1` before declaring done (the diffVault lesson).
- `kernel-surface` line ceilings (`scripts/check-architecture.mjs` `KERNEL_SURFACE_BUDGET`): vault.ts 3855 (line ~766), noydb.ts 2325 (line ~851), collection.ts has its own entry — bump each by the measured delta with a dated comment (precedent: "S4 Task 1" comments at lines 726-731/812-815).
- Public method additions to Noydb/Vault/Collection fail `__tests__/kernel-api-surface-golden.test.ts` until `__tests__/kernel-api.golden.json` is updated (alphabetical order).
- Run `pnpm check:architecture` after any structural change.
- Riders/computed run BEFORE schema validation — a strict zod schema must declare rider companion fields; tests here use schema-less collections and a doc note records the constraint.

**Spec deviations (approved rationale, record in changeset):** `expiresSoon` and `ageBand` riders are dropped — riders materialize at WRITE time, so date-relative values go stale; `birthDate` ships a stable `yob` (year-of-birth) rider instead, and expiry ships no rider. Exporters beyond as-csv/as-xlsx (json/ndjson/sql/xml) follow in a mechanical follow-up issue (Task 11) — they share the exportStream style, one recipe.

---

### Task 1: Descriptor core + resolver

**Files:**
- Create: `packages/hub/src/with-shape/classified/descriptor.ts`
- Create: `packages/hub/src/with-shape/classified/errors.ts`
- Create: `packages/hub/src/with-shape/classified/resolve.ts`
- Test: `packages/hub/__tests__/classified/resolve.test.ts`

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces: `ClassifiedFieldSpec`, `ClassifiedGroup`, `ClassifiedEntry`, `ClassifiedList`, `isClassifiedFieldSpec`, `isClassifiedGroup`, `ClassifiedConfigError`, and `resolveClassifiedFields(collection: string, config: Record<string, ClassifiedEntry>): ResolvedClassified` where `ResolvedClassified = { byField: Record<string, ClassifiedFieldSpec>; riderComputed: Record<string, (record: Record<string, unknown>) => unknown> }`. Rider companion naming law: `` `${field}_${riderName}` ``.

- [ ] **Step 1: Write the failing test**

```ts
// packages/hub/__tests__/classified/resolve.test.ts
import { describe, it, expect } from 'vitest'
import {
  resolveClassifiedFields, ClassifiedConfigError,
  type ClassifiedFieldSpec, type ClassifiedGroup,
} from '../../src/with-shape/classified/resolve.js'

const spec = (over: Partial<ClassifiedFieldSpec> = {}): ClassifiedFieldSpec => ({
  _noydbClassified: true, preset: 'test', storage: 'recoverable',
  list: { kind: 'omit' }, sensitivity: 'pii', ...over,
})

describe('resolveClassifiedFields', () => {
  it('simple entry: key is the field name', () => {
    const r = resolveClassifiedFields('c', { dob: spec() })
    expect(Object.keys(r.byField)).toEqual(['dob'])
    expect(r.byField.dob!.preset).toBe('test')
  })

  it('group entry: members flatten under their own field names', () => {
    const g: ClassifiedGroup = {
      _noydbClassifiedGroup: true, preset: 'grp',
      members: { pan: spec({ storage: 'recoverable' }), cvc: spec({ storage: 'never' }) },
    }
    const r = resolveClassifiedFields('c', { card: g })
    expect(Object.keys(r.byField).sort()).toEqual(['cvc', 'pan'])
  })

  it('riders become <field>_<rider> computed entries reading the source field', () => {
    const r = resolveClassifiedFields('c', {
      pan: spec({ riders: { last4: (v) => String(v).slice(-4) } }),
    })
    expect(r.riderComputed['pan_last4']!({ pan: '4242424242424242' })).toBe('4242')
    expect(r.riderComputed['pan_last4']!({})).toBeUndefined()
  })

  it('throws on duplicate field claims and rider/field collisions', () => {
    const g: ClassifiedGroup = { _noydbClassifiedGroup: true, preset: 'g', members: { dob: spec() } }
    expect(() => resolveClassifiedFields('c', { dob: spec(), g })).toThrow(ClassifiedConfigError)
    expect(() => resolveClassifiedFields('c', {
      a: spec({ riders: { x: (v) => v } }), a_x: spec(),
    })).toThrow(ClassifiedConfigError)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/vicio/lanna-db/.worktrees/classified-fields && pnpm vitest run packages/hub/__tests__/classified/resolve.test.ts`
Expected: FAIL — cannot resolve `../../src/with-shape/classified/resolve.js`

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/hub/src/with-shape/classified/descriptor.ts
/**
 * Classified fields — behavioral sensitive-field descriptors (stage 1).
 * Design: docs/superpowers/specs/2026-07-04-classified-fields-design.md
 * Law: open on write, declarative on read — read-side behavior is this
 * closed vocabulary; there are no read-side callbacks.
 * @module
 */

export type ClassifiedStorage = 'recoverable' | 'never'

export type ClassifiedList =
  | { readonly kind: 'omit' }
  | { readonly kind: 'mask'; readonly pattern: string }
  | { readonly kind: 'rider'; readonly rider: string }

export type ClassifiedRider = (value: unknown) => unknown

export interface ClassifiedFieldSpec {
  readonly _noydbClassified: true
  readonly preset: string
  readonly storage: ClassifiedStorage
  readonly list: ClassifiedList
  readonly sensitivity: 'pii' | 'secret'
  /** Write-time safe projections; companion field name is `<field>_<rider>`. */
  readonly riders?: Record<string, ClassifiedRider>
  /** Write-time validator: error message, or null when valid. */
  readonly validate?: (value: unknown) => string | null
}

export interface ClassifiedGroup {
  readonly _noydbClassifiedGroup: true
  readonly preset: string
  /** member record-field name -> spec (differential per-member policy). */
  readonly members: Record<string, ClassifiedFieldSpec>
}

export type ClassifiedEntry = ClassifiedFieldSpec | ClassifiedGroup

export function isClassifiedFieldSpec(x: unknown): x is ClassifiedFieldSpec {
  return typeof x === 'object' && x !== null
    && (x as { _noydbClassified?: unknown })._noydbClassified === true
}

export function isClassifiedGroup(x: unknown): x is ClassifiedGroup {
  return typeof x === 'object' && x !== null
    && (x as { _noydbClassifiedGroup?: unknown })._noydbClassifiedGroup === true
}
```

```ts
// packages/hub/src/with-shape/classified/errors.ts
/** Configuration/write errors for classified fields. @module */

export class ClassifiedConfigError extends Error {
  constructor(public readonly collection: string, message: string) {
    super(`classifiedFields for collection "${collection}": ${message}`)
    this.name = 'ClassifiedConfigError'
  }
}

export class ClassifiedNeverStoredError extends Error {
  constructor(public readonly collection: string, public readonly field: string) {
    super(`Field "${field}" in collection "${collection}" is classified storage:'never' `
      + `(e.g. a CVC) and must not be persisted. Validate it at capture and drop it before put().`)
    this.name = 'ClassifiedNeverStoredError'
  }
}

export class ClassifiedValidationError extends Error {
  constructor(public readonly collection: string, public readonly field: string, detail: string) {
    super(`Classified field "${field}" in collection "${collection}" failed validation: ${detail}`)
    this.name = 'ClassifiedValidationError'
  }
}
```

```ts
// packages/hub/src/with-shape/classified/resolve.ts
/** Flatten a classifiedFields config into a per-field map + rider computed entries. @module */

import { isClassifiedGroup, type ClassifiedEntry, type ClassifiedFieldSpec } from './descriptor.js'
import { ClassifiedConfigError } from './errors.js'

export type { ClassifiedEntry, ClassifiedFieldSpec, ClassifiedGroup, ClassifiedList } from './descriptor.js'
export { ClassifiedConfigError } from './errors.js'

export interface ResolvedClassified {
  readonly byField: Record<string, ClassifiedFieldSpec>
  readonly riderComputed: Record<string, (record: Record<string, unknown>) => unknown>
}

export function resolveClassifiedFields(
  collection: string,
  config: Record<string, ClassifiedEntry>,
): ResolvedClassified {
  const byField: Record<string, ClassifiedFieldSpec> = {}
  const claim = (field: string, spec: ClassifiedFieldSpec): void => {
    if (byField[field] !== undefined) {
      throw new ClassifiedConfigError(collection, `field "${field}" is claimed twice`)
    }
    byField[field] = spec
  }
  for (const [key, entry] of Object.entries(config)) {
    if (isClassifiedGroup(entry)) {
      for (const [field, spec] of Object.entries(entry.members)) claim(field, spec)
    } else {
      claim(key, entry)
    }
  }
  const riderComputed: Record<string, (record: Record<string, unknown>) => unknown> = {}
  for (const [field, spec] of Object.entries(byField)) {
    for (const [name, rider] of Object.entries(spec.riders ?? {})) {
      const companion = `${field}_${name}`
      if (byField[companion] !== undefined || riderComputed[companion] !== undefined) {
        throw new ClassifiedConfigError(collection, `rider companion "${companion}" collides with a declared field`)
      }
      riderComputed[companion] = (record) =>
        record[field] === undefined ? undefined : rider(record[field])
    }
  }
  return { byField, riderComputed }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/hub/__tests__/classified/resolve.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/with-shape/classified packages/hub/__tests__/classified
git commit -m "feat(classified): descriptor core + resolver — the classified-fields foundation"
```

---

### Task 2: Presets (creditCard/birthDate/email/phone) + validators + barrel + root export

**Files:**
- Create: `packages/hub/src/with-shape/classified/validators.ts`
- Create: `packages/hub/src/with-shape/classified/presets.ts`
- Create: `packages/hub/src/with-shape/classified/index.ts`
- Modify: `packages/hub/src/index.ts` (add export block near the money block, ~line 854)
- Test: `packages/hub/__tests__/classified/presets.test.ts`

**Interfaces:**
- Consumes: Task 1 types.
- Produces: `classified` namespace object with `creditCard(fields: { pan: string; expiry?: string; cvc?: string }): ClassifiedGroup`, `birthDate(): ClassifiedFieldSpec`, `email(): ClassifiedFieldSpec`, `phone(): ClassifiedFieldSpec`; `luhnCheck(pan: string): boolean`. Riders shipped: pan→`last4`,`bin`; birthDate→`yob`; email→`domain`; phone→`last2`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/hub/__tests__/classified/presets.test.ts
import { describe, it, expect } from 'vitest'
import { classified, luhnCheck } from '../../src/with-shape/classified/index.js'
import { resolveClassifiedFields } from '../../src/with-shape/classified/resolve.js'

describe('classified presets', () => {
  it('luhnCheck accepts a valid PAN and rejects a corrupted one', () => {
    expect(luhnCheck('4242424242424242')).toBe(true)
    expect(luhnCheck('4242424242424241')).toBe(false)
  })

  it('creditCard maps roles to fields with differential policy', () => {
    const g = classified.creditCard({ pan: 'cardNumber', expiry: 'cardExpiry', cvc: 'cardCvc' })
    const r = resolveClassifiedFields('c', { card: g })
    expect(r.byField.cardNumber!.storage).toBe('recoverable')
    expect(r.byField.cardNumber!.sensitivity).toBe('secret')
    expect(r.byField.cardCvc!.storage).toBe('never')
    expect(r.byField.cardExpiry!.storage).toBe('recoverable')
    expect(r.riderComputed['cardNumber_last4']!({ cardNumber: '4242 4242 4242 4242' })).toBe('4242')
    expect(r.riderComputed['cardNumber_bin']!({ cardNumber: '4242 4242 4242 4242' })).toBe('424242')
  })

  it('pan validator refuses a Luhn-invalid number; cvc validator wants 3-4 digits', () => {
    const g = classified.creditCard({ pan: 'pan', cvc: 'cvc' })
    const r = resolveClassifiedFields('c', { card: g })
    expect(r.byField.pan!.validate!('4242424242424241')).toMatch(/Luhn/)
    expect(r.byField.pan!.validate!('4242424242424242')).toBeNull()
    expect(r.byField.cvc!.validate!('12')).toMatch(/3-4 digits/)
    expect(r.byField.cvc!.validate!('123')).toBeNull()
  })

  it('birthDate: ISO validation, yob rider, mask pattern references yob', () => {
    const s = classified.birthDate()
    expect(s.validate!('1990-04-01')).toBeNull()
    expect(s.validate!('01/04/1990')).toMatch(/ISO/)
    expect(s.riders!.yob!('1990-04-01')).toBe('1990')
    expect(s.list).toEqual({ kind: 'mask', pattern: '${yob}-••-••' })
  })

  it('email/phone: pii, domain/last2 riders', () => {
    expect(classified.email().riders!.domain!('a@b.co')).toBe('b.co')
    expect(classified.phone().riders!.last2!('+66 81 234 5678')).toBe('78')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/hub/__tests__/classified/presets.test.ts`
Expected: FAIL — cannot resolve `../../src/with-shape/classified/index.js`

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/hub/src/with-shape/classified/validators.ts
/** Pure write-time validators. Exported so userland can validate storage:'never'
 *  fields (e.g. CVC) at capture, before dropping them. @module */

export function luhnCheck(pan: string): boolean {
  const digits = pan.replace(/[\s-]/g, '')
  if (!/^\d{12,19}$/.test(digits)) return false
  let sum = 0
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i])
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9 }
    sum += d
  }
  return sum % 10 === 0
}
```

```ts
// packages/hub/src/with-shape/classified/presets.ts
/** The preset catalog (stage 1). Presets are hub-owned; devs get declarative
 *  knobs, not read-side callbacks (design law D2/D3). @module */

import type { ClassifiedFieldSpec, ClassifiedGroup } from './descriptor.js'
import { luhnCheck } from './validators.js'

const digitsOf = (v: unknown): string => String(v).replace(/\D/g, '')

function panSpec(): ClassifiedFieldSpec {
  return {
    _noydbClassified: true, preset: 'creditCard.pan', storage: 'recoverable',
    sensitivity: 'secret', list: { kind: 'mask', pattern: '•••• ${last4}' },
    riders: { last4: (v) => digitsOf(v).slice(-4), bin: (v) => digitsOf(v).slice(0, 6) },
    validate: (v) => (typeof v === 'string' && luhnCheck(v) ? null : 'not a Luhn-valid card number'),
  }
}

function expirySpec(): ClassifiedFieldSpec {
  return {
    _noydbClassified: true, preset: 'creditCard.expiry', storage: 'recoverable',
    sensitivity: 'pii', list: { kind: 'mask', pattern: '••/••' },
    validate: (v) => (typeof v === 'string' && /^(0[1-9]|1[0-2])\/\d{2}$/.test(v) ? null : 'expected MM/YY'),
  }
}

function cvcSpec(): ClassifiedFieldSpec {
  return {
    _noydbClassified: true, preset: 'creditCard.cvc', storage: 'never',
    sensitivity: 'secret', list: { kind: 'omit' },
    validate: (v) => (typeof v === 'string' && /^\d{3,4}$/.test(v) ? null : 'expected 3-4 digits'),
  }
}

export const classified = {
  /** Composite card type. PAN sealed + last4/bin riders; CVC is storage:'never' (PCI-aware). */
  creditCard(fields: { pan: string; expiry?: string; cvc?: string }): ClassifiedGroup {
    const members: Record<string, ClassifiedFieldSpec> = { [fields.pan]: panSpec() }
    if (fields.expiry !== undefined) members[fields.expiry] = expirySpec()
    if (fields.cvc !== undefined) members[fields.cvc] = cvcSpec()
    return { _noydbClassifiedGroup: true, preset: 'creditCard', members }
  },

  birthDate(): ClassifiedFieldSpec {
    return {
      _noydbClassified: true, preset: 'birthDate', storage: 'recoverable',
      sensitivity: 'pii', list: { kind: 'mask', pattern: '${yob}-••-••' },
      riders: { yob: (v) => String(v).slice(0, 4) },
      validate: (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? null : 'expected ISO yyyy-mm-dd'),
    }
  },

  email(): ClassifiedFieldSpec {
    return {
      _noydbClassified: true, preset: 'email', storage: 'recoverable',
      sensitivity: 'pii', list: { kind: 'mask', pattern: '•••@${domain}' },
      riders: { domain: (v) => String(v).split('@')[1] ?? '' },
      validate: (v) => (typeof v === 'string' && v.includes('@') ? null : 'expected an email address'),
    }
  },

  phone(): ClassifiedFieldSpec {
    return {
      _noydbClassified: true, preset: 'phone', storage: 'recoverable',
      sensitivity: 'pii', list: { kind: 'mask', pattern: '•••••${last2}' },
      riders: { last2: (v) => digitsOf(v).slice(-2) },
      validate: (v) => (digitsOf(v).length >= 5 ? null : 'expected at least 5 digits'),
    }
  },
}
```

```ts
// packages/hub/src/with-shape/classified/index.ts
/** Classified fields barrel — descriptors, presets, resolver, errors (stage 1). @module */
export type {
  ClassifiedStorage, ClassifiedList, ClassifiedRider,
  ClassifiedFieldSpec, ClassifiedGroup, ClassifiedEntry,
} from './descriptor.js'
export { isClassifiedFieldSpec, isClassifiedGroup } from './descriptor.js'
export { resolveClassifiedFields, type ResolvedClassified } from './resolve.js'
export { classified } from './presets.js'
export { luhnCheck } from './validators.js'
export { ClassifiedConfigError, ClassifiedNeverStoredError, ClassifiedValidationError } from './errors.js'
```

In `packages/hub/src/index.ts`, directly after the money export block (ends ~line 854), add:

```ts
export { classified, luhnCheck, isClassifiedFieldSpec, isClassifiedGroup, resolveClassifiedFields, ClassifiedConfigError, ClassifiedNeverStoredError, ClassifiedValidationError } from './with-shape/classified/index.js'
export type { ClassifiedFieldSpec, ClassifiedGroup, ClassifiedEntry, ClassifiedList, ClassifiedStorage } from './with-shape/classified/index.js'
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/hub/__tests__/classified/`
Expected: PASS (both files)

- [ ] **Step 5: Lint + typecheck + commit**

```bash
pnpm --filter @noy-db/hub lint && pnpm --filter @noy-db/hub typecheck
git add -A packages/hub
git commit -m "feat(classified): preset catalog — creditCard composite, birthDate, email, phone"
```

---

### Task 3: Config threading + sealed merge

**Files:**
- Modify: `packages/hub/src/kernel/collection-config.ts` (imports ~line 50; `CollectionOpts` member ~line 228; resolver ~lines 444-455 and 484-485; return block ~lines 529-534)
- Modify: `packages/hub/src/kernel/collection.ts` (private field ~line 420; ctor assignment ~line 706; `_applyClassifiedFields` after `_applyMeta` ~line 1103)
- Modify: `packages/hub/src/kernel/vault.ts` (public options literal ~line 737; `_apply` reconcile branch ~line 879; fresh-construction branch ~line 1090)
- Test: `packages/hub/__tests__/classified/threading.test.ts`

**Interfaces:**
- Consumes: `resolveClassifiedFields`, `ClassifiedEntry`, `ResolvedClassified` (Tasks 1-2).
- Produces: public option `classifiedFields?: Record<string, ClassifiedEntry>` on `vault.collection()`; `Collection` private `classified: ResolvedClassified | undefined` (later tasks read `this.classified.byField` / rely on riders being merged into `cfg.computed`); recoverable classified fields are ADDED to the `sensitiveFields` set the resolver already builds (collection-config.ts:484-485), so they seal via #306 with zero new code.

- [ ] **Step 1: Write the failing test**

```ts
// packages/hub/__tests__/classified/threading.test.ts
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../../src/kernel/noydb.js'
import { classified } from '../../src/with-shape/classified/index.js'

// Reuse the canonical inline memory store from the introspection suite.
// Copy the inlineMemory() helper verbatim from __tests__/introspection/json-schema.test.ts (lines 19-58).

describe('classifiedFields threading', () => {
  it('recoverable classified fields come back sealed; riders are plain fields', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'a', secret: 'pw-cls-1' })
    const v = await db.openVault('v1')
    const c = v.collection('cards', {
      classifiedFields: { card: classified.creditCard({ pan: 'cardNumber' }) },
    })
    await c.put('r1', { cardNumber: '4242424242424242' })
    const rec = await c.get('r1') as Record<string, unknown>
    expect((rec.cardNumber as { sealed?: boolean }).sealed).toBe(true)   // SealedHandle
    expect(rec.cardNumber_last4).toBe('4242')                            // rider materialized
    expect(rec.cardNumber_bin).toBe('424242')
  })

  it('reconciles declarations arriving after auto-creation (first-wins _apply)', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'a', secret: 'pw-cls-2' })
    const v = await db.openVault('v2')
    v.collection('people')                                               // bare auto-open
    const c = v.collection('people', { classifiedFields: { dob: classified.birthDate() } })
    await c.put('p1', { dob: '1990-04-01' })
    const rec = await c.get('p1') as Record<string, unknown>
    expect(rec.dob_yob).toBe('1990')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/hub/__tests__/classified/threading.test.ts`
Expected: FAIL — `classifiedFields` is not a known option (TS error via the tests ratchet, or riders undefined at runtime)

- [ ] **Step 3: Implement the threading**

`collection-config.ts` — add the import next to the FieldMeta import (~line 49):

```ts
import { resolveClassifiedFields, type ClassifiedEntry, type ResolvedClassified } from '../with-shape/classified/resolve.js'
```

Add to `CollectionOpts<T>` after `computed` (~line 228):

```ts
  /** — declare classified() sensitive-field descriptors (sealed + riders + projections). */
  classifiedFields?: Record<string, ClassifiedEntry> | undefined
```

In `resolveCollectionConfig` (~line 454, next to the moneyFields validation), resolve once and merge:

```ts
  const resolvedClassified: ResolvedClassified | undefined =
    opts.classifiedFields !== undefined
      ? resolveClassifiedFields(opts.name, opts.classifiedFields)
      : undefined
```

Amend the `sensitiveFields` normalization (currently ~lines 484-485) to union recoverable classified fields:

```ts
  const classifiedSensitive = resolvedClassified === undefined ? [] :
    Object.entries(resolvedClassified.byField)
      .filter(([, s]) => s.storage === 'recoverable')
      .map(([f]) => f)
  const sensitiveList = [...(opts.sensitive ?? []), ...classifiedSensitive]
  const sensitiveFields: ReadonlySet<string> = sensitiveList.length > 0
    ? Object.freeze(new Set(sensitiveList))
    : EMPTY_SET   // keep whatever empty-set constant the current code uses on its else-branch
```

In the returned config object (~line 534), thread both, merging riders ahead of user computed (riders run first; user fns may read companions):

```ts
    classified: resolvedClassified,
    computed: resolvedClassified !== undefined
      ? { ...resolvedClassified.riderComputed, ...(opts.computed ?? {}) }
      : opts.computed,
```

(Replace the existing `computed: opts.computed,` line. If a user `computed` key collides with a rider companion, throw `ClassifiedConfigError` here — one `for` loop over `Object.keys(opts.computed ?? {})`.)

`collection.ts` — private field after `computed` (~line 420):

```ts
  private classified: ResolvedClassified | undefined
```

ctor assignment (~line 706): `this.classified = cfg.classified` — and the `_apply` method after `_applyMeta` (~line 1103):

```ts
  /** @internal — attach classified fields post-construction. See {@link _applyMoneyFields}. First-wins. */
  _applyClassifiedFields(classifiedFields: Record<string, ClassifiedEntry>): void {
    if (this.classified !== undefined) return
    const resolved = resolveClassifiedFields(this.name, classifiedFields)
    this.classified = resolved
    this.computed = { ...resolved.riderComputed, ...(this.computed ?? {}) }
  }
```

(Note: the `_apply` path cannot retro-seal an already-constructed bare collection — `sensitiveFields` is ctor-frozen. Mirror of the moneyFields first-wins semantics; the reconcile test above only asserts riders. Add one line to the `_applyClassifiedFields` doc comment stating sealing requires declaration at first open.)

`vault.ts` — public options literal after `computed` (~line 737):

```ts
    /** — declare classified() sensitive-field descriptors. See the classified-fields spec. */
    classifiedFields?: Record<string, ClassifiedEntry>
```

Reconcile branch (~line 879):

```ts
    if (coll && options?.classifiedFields) {
      coll._applyClassifiedFields(options.classifiedFields)
    }
```

Fresh-construction branch (~line 1090):

```ts
      if (options?.classifiedFields !== undefined) collOpts.classifiedFields = options.classifiedFields
```

- [ ] **Step 4: Run tests, architecture check**

Run: `pnpm vitest run packages/hub/__tests__/classified/ && pnpm check:architecture`
Expected: tests PASS. If `kernel-surface` trips on collection.ts/vault.ts, bump the `KERNEL_SURFACE_BUDGET` entries by the measured delta with comment `// Bumped +N — classified-fields stage 1 Task 3 (threading)`.

- [ ] **Step 5: Lint + typecheck + commit**

```bash
pnpm --filter @noy-db/hub lint && pnpm --filter @noy-db/hub typecheck
git add -A packages/hub scripts/check-architecture.mjs
git commit -m "feat(classified): thread classifiedFields through collection config — sealed merge + rider computed"
```

---

### Task 4: Write-path enforcement — storage:'never' rejection + validators

**Files:**
- Create: `packages/hub/src/with-shape/classified/write.ts`
- Modify: `packages/hub/src/kernel/collection.ts` (`_putInternal`, immediately BEFORE the computed stage at ~lines 1451-1456)
- Modify: `packages/hub/src/with-shape/classified/index.ts` (re-export `enforceClassifiedWrite`)
- Test: `packages/hub/__tests__/classified/write-enforcement.test.ts`

**Interfaces:**
- Consumes: `this.classified.byField` (Task 3), `ClassifiedNeverStoredError`/`ClassifiedValidationError` (Task 1).
- Produces: `enforceClassifiedWrite(record: Record<string, unknown>, byField: Record<string, ClassifiedFieldSpec>, collection: string): void` — throws, never mutates.

- [ ] **Step 1: Write the failing test**

```ts
// packages/hub/__tests__/classified/write-enforcement.test.ts
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../../src/kernel/noydb.js'
import { classified, ClassifiedNeverStoredError, ClassifiedValidationError } from '../../src/with-shape/classified/index.js'
// inlineMemory(): copy verbatim from __tests__/introspection/json-schema.test.ts lines 19-58.

describe('classified write enforcement', () => {
  it('put() throws ClassifiedNeverStoredError when a storage:never field is present', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'a', secret: 'pw-wr-1' })
    const v = await db.openVault('v1')
    const c = v.collection('cards', {
      classifiedFields: { card: classified.creditCard({ pan: 'pan', cvc: 'cvc' }) },
    })
    await expect(c.put('r1', { pan: '4242424242424242', cvc: '123' }))
      .rejects.toBeInstanceOf(ClassifiedNeverStoredError)
    expect(await c.get('r1')).toBeNull()          // nothing persisted
  })

  it('put() throws ClassifiedValidationError on a Luhn-invalid PAN', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'a', secret: 'pw-wr-2' })
    const v = await db.openVault('v2')
    const c = v.collection('cards', {
      classifiedFields: { card: classified.creditCard({ pan: 'pan' }) },
    })
    await expect(c.put('r1', { pan: '4242424242424241' }))
      .rejects.toBeInstanceOf(ClassifiedValidationError)
  })

  it('absent classified fields are fine (partial records)', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'a', secret: 'pw-wr-3' })
    const v = await db.openVault('v3')
    const c = v.collection('people', { classifiedFields: { dob: classified.birthDate() } })
    await c.put('p1', { name: 'x' })
    expect(((await c.get('p1')) as Record<string, unknown>).name).toBe('x')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/hub/__tests__/classified/write-enforcement.test.ts`
Expected: FAIL — put succeeds where a throw is expected

- [ ] **Step 3: Implement**

```ts
// packages/hub/src/with-shape/classified/write.ts
/** Write-path enforcement: storage:'never' rejection + preset validators.
 *  Runs BEFORE riders/computed and BEFORE schema validation. Pure. @module */

import type { ClassifiedFieldSpec } from './descriptor.js'
import { ClassifiedNeverStoredError, ClassifiedValidationError } from './errors.js'

export function enforceClassifiedWrite(
  record: Record<string, unknown>,
  byField: Record<string, ClassifiedFieldSpec>,
  collection: string,
): void {
  for (const [field, spec] of Object.entries(byField)) {
    const value = record[field]
    if (value === undefined) continue
    if (spec.storage === 'never') throw new ClassifiedNeverStoredError(collection, field)
    const problem = spec.validate?.(value) ?? null
    if (problem !== null) throw new ClassifiedValidationError(collection, field, problem)
  }
}
```

`collection.ts` — in `_putInternal`, insert immediately BEFORE the computed stage (~line 1451):

```ts
    // Classified enforcement — storage:'never' rejection + validators run
    // before riders derive and before the schema sees the record.
    if (this.classified !== undefined) {
      enforceClassifiedWrite(record as Record<string, unknown>, this.classified.byField, this.name)
    }
```

with the import added next to the evalComputedFields import (~line 14):

```ts
import { enforceClassifiedWrite } from '../with-shape/classified/write.js'
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/hub/__tests__/classified/`
Expected: PASS (all classified files)

- [ ] **Step 5: Lint + typecheck + commit**

```bash
pnpm --filter @noy-db/hub lint && pnpm --filter @noy-db/hub typecheck
git add -A packages/hub
git commit -m "feat(classified): write-path enforcement — never-storage rejection + preset validators"
```

---

### Task 5: describe() + toJSONSchema() emission

**Files:**
- Modify: `packages/hub/src/with-shape/introspection/describe.ts` (`DescribedField` ~line 49; `BuildDescriptionInput` ~line 178; destructure line 227; `allKeys` union ~line 253; field assembly ~line 390)
- Modify: `packages/hub/src/kernel/collection.ts` (both `buildDescription` call sites: sync ~lines 1009-1019, async ~lines 1053-1060 — add `classified: this.classified?.byField`)
- Modify: `packages/hub/src/with-shape/introspection/json-schema.ts` (after the `x-order` line from commit 64cdfa4a)
- Test: `packages/hub/__tests__/classified/describe-emission.test.ts`

**Interfaces:**
- Consumes: `ClassifiedFieldSpec` (Task 1), `this.classified` (Task 3).
- Produces: `DescribedField.classified?: { preset: string; storage: 'recoverable' | 'never'; list: 'omit' | { mask: string } | { rider: string } }`; classified sensitivity feeds the existing merge as the lowest-precedence `inferred` input (channel fieldMeta and zod .meta() still win); JSON Schema gains `x-classified`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/hub/__tests__/classified/describe-emission.test.ts
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../../src/kernel/noydb.js'
import { classified } from '../../src/with-shape/classified/index.js'
// inlineMemory(): copy verbatim from __tests__/introspection/json-schema.test.ts lines 19-58.

describe('classified in describe()/toJSONSchema()', () => {
  it('describe() emits the classified block and inferred sensitivity', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'a', secret: 'pw-de-1' })
    const v = await db.openVault('v1')
    const c = v.collection('cards', {
      classifiedFields: { card: classified.creditCard({ pan: 'pan', cvc: 'cvc' }) },
    })
    const desc = c.describe()
    const pan = desc.fields.find((f) => f.key === 'pan')!
    expect(pan.classified).toEqual({
      preset: 'creditCard.pan', storage: 'recoverable', list: { mask: '•••• ${last4}' },
    })
    expect(pan.sensitivity).toBe('secret')
    const cvc = desc.fields.find((f) => f.key === 'cvc')!
    expect(cvc.classified).toEqual({ preset: 'creditCard.cvc', storage: 'never', list: 'omit' })
  })

  it('toJSONSchema() emits x-classified', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'a', secret: 'pw-de-2' })
    const v = await db.openVault('v2')
    const c = v.collection('people', { classifiedFields: { dob: classified.birthDate() } })
    const js = await c.toJSONSchema() as { properties: Record<string, Record<string, unknown>> }
    expect(js.properties.dob!['x-classified']).toEqual({
      preset: 'birthDate', storage: 'recoverable', list: { mask: '${yob}-••-••' },
    })
    expect(js.properties.dob!['x-sensitivity']).toBe('pii')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/hub/__tests__/classified/describe-emission.test.ts`
Expected: FAIL — `pan.classified` undefined

- [ ] **Step 3: Implement**

`describe.ts` — `DescribedField` gains (after `order`, ~line 49):

```ts
  /** Present when the field is classified. Serialized read-projection contract. */
  readonly classified?: {
    readonly preset: string
    readonly storage: 'recoverable' | 'never'
    readonly list: 'omit' | { readonly mask: string } | { readonly rider: string }
  }
```

`BuildDescriptionInput` gains (after `i18nFields`, ~line 178):

```ts
  /** Per-field classified specs (already resolved/flattened). */
  readonly classified?: Record<string, ClassifiedFieldSpec> | undefined
```

with `import type { ClassifiedFieldSpec } from '../classified/descriptor.js'` at the top. Destructure `classified` at line 227; add `...Object.keys(classified ?? {})` to the `allKeys` union (~line 253). In the per-field assembly, before `resolveFieldMeta` is applied, feed sensitivity as inferred metadata and serialize the block:

```ts
    const cls = classified?.[key]
    // inside the inferred-meta object passed to resolveFieldMeta, add:
    //   ...(cls !== undefined ? { sensitivity: cls.sensitivity } : {})
    // and in the assembled field spread (~line 390):
    ...(cls !== undefined ? {
      classified: {
        preset: cls.preset,
        storage: cls.storage,
        list: cls.list.kind === 'omit' ? 'omit' as const
          : cls.list.kind === 'mask' ? { mask: cls.list.pattern }
          : { rider: cls.list.rider },
      },
    } : {}),
```

`collection.ts` — add to BOTH `buildDescription` call sites:

```ts
      ...(this.classified !== undefined ? { classified: this.classified.byField } : {}),
```

`json-schema.ts` — after the `x-order` line added in 64cdfa4a:

```ts
    if (f.classified !== undefined) prop['x-classified'] = f.classified
```

- [ ] **Step 4: Run the introspection + classified suites**

Run: `pnpm vitest run packages/hub/__tests__/classified/ packages/hub/__tests__/introspection/`
Expected: ALL PASS (no regression in describe/json-schema/field-group-order suites)

- [ ] **Step 5: Lint + typecheck + commit**

```bash
pnpm --filter @noy-db/hub lint && pnpm --filter @noy-db/hub typecheck
git add -A packages/hub
git commit -m "feat(classified): describe()/toJSONSchema() emit the classified read-projection contract"
```

---

### Task 6: withClassified() gate + collection.reveal() + audit hook

**Files:**
- Create: `packages/hub/src/with-shape/classified/strategy.ts`
- Create: `packages/hub/src/with-shape/classified/active.ts`
- Create: `packages/hub/src/with-shape/classified/reveal.ts`
- Modify: `packages/hub/src/kernel/errors.ts` (`ClassifiedNotEnabledError` next to `AttestationNotEnabledError`, ~line 1684)
- Modify: `packages/hub/src/kernel/types.ts` (`classifiedStrategy?: ClassifiedStrategy` next to `attestationStrategy`, ~line 2210)
- Modify: `packages/hub/src/kernel/noydb.ts` (both Vault-construction spreads, lines ~602 and ~685)
- Modify: `packages/hub/src/kernel/vault.ts` (ctor option ~line 533; pass into `collOpts` in the fresh-construction branch)
- Modify: `packages/hub/src/kernel/collection-config.ts` + `collection.ts` (thread `classifiedStrategy`, default `NO_CLASSIFIED`; public `reveal` method near `toJSONSchema` ~line 1068)
- Modify: consent op union — `collection.ts:551` (`onAccess` type), `vault.ts:1011`/`_logConsent` (~line 2948), and the entry `op` type in `packages/hub/src/with-audit/consent/strategy.ts` — each union gains `'reveal'`
- Modify: `packages/hub/src/with-shape/classified/index.ts` (export `withClassified`, `NO_CLASSIFIED`, `ClassifiedStrategy`)
- Modify: `packages/hub/package.json` (exports map: `./classified`, next to `./attestation` ~line 118) + `packages/hub/tsup.config.ts` (`'classified/index': 'src/with-shape/classified/index.ts'` in ENTRIES ~line 47)
- Test: `packages/hub/__tests__/classified/reveal-gate.test.ts`

**Interfaces:**
- Consumes: Tasks 1-5; `SealedHandle` semantics (a sealed value is `{ sealed: true, reveal(): Promise<V> }`).
- Produces: `ClassifiedStrategy { reveal(ctx: ClassifiedRevealCtx, id: string, field: string): Promise<unknown> }`; `ClassifiedRevealCtx { collection: string; spec: ClassifiedFieldSpec; getView(id: string): Promise<Record<string, unknown> | null>; onAccess?: (op: 'reveal', id: string) => Promise<void> }`; `withClassified(): ClassifiedStrategy`; `NO_CLASSIFIED` (throws `ClassifiedNotEnabledError`); public `Collection.reveal(id: string, field: string): Promise<unknown>`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/hub/__tests__/classified/reveal-gate.test.ts
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../../src/kernel/noydb.js'
import { classified, withClassified } from '../../src/with-shape/classified/index.js'
import { ClassifiedNotEnabledError } from '../../src/kernel/errors.js'
// inlineMemory(): copy verbatim from __tests__/introspection/json-schema.test.ts lines 19-58.

describe('withClassified gate + reveal', () => {
  it('reveal throws ClassifiedNotEnabledError without the strategy', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'a', secret: 'pw-rv-1' })
    const v = await db.openVault('v1')
    const c = v.collection('cards', { classifiedFields: { card: classified.creditCard({ pan: 'pan' }) } })
    await c.put('r1', { pan: '4242424242424242' })
    await expect(c.reveal('r1', 'pan')).rejects.toBeInstanceOf(ClassifiedNotEnabledError)
  })

  it('reveal returns the plaintext with withClassified(), and refuses unknown/never fields', async () => {
    const db = await createNoydb({
      store: inlineMemory(), user: 'a', secret: 'pw-rv-2',
      classifiedStrategy: withClassified(),
    })
    const v = await db.openVault('v2')
    const c = v.collection('cards', {
      classifiedFields: { card: classified.creditCard({ pan: 'pan', cvc: 'cvc' }) },
    })
    await c.put('r1', { pan: '4242424242424242' })
    expect(await c.reveal('r1', 'pan')).toBe('4242424242424242')
    await expect(c.reveal('r1', 'cvc')).rejects.toThrow(/never/)     // nothing stored to reveal
    await expect(c.reveal('r1', 'nope')).rejects.toThrow(/not classified/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/hub/__tests__/classified/reveal-gate.test.ts`
Expected: FAIL — `withClassified` not exported / `reveal` not a function

- [ ] **Step 3: Implement**

`kernel/errors.ts` (copy the AttestationNotEnabledError shape at 1674-1683):

```ts
export class ClassifiedNotEnabledError extends NoydbError {
  constructor(
    message = 'reveal() requires the classified capability. Pass ' +
      '`classifiedStrategy: withClassified()` from "@noy-db/hub/classified" ' +
      'to createNoydb().',
  ) {
    super('CLASSIFIED_NOT_ENABLED', message)
    this.name = 'ClassifiedNotEnabledError'
  }
}
```

```ts
// packages/hub/src/with-shape/classified/strategy.ts
/** The ② capability seam for classified read-egress ops (stage 1: reveal). @module */
import type { ClassifiedFieldSpec } from './descriptor.js'
import { ClassifiedNotEnabledError } from '../../kernel/errors.js'

export interface ClassifiedRevealCtx {
  readonly collection: string
  readonly spec: ClassifiedFieldSpec
  getView(id: string): Promise<Record<string, unknown> | null>
  readonly onAccess?: ((op: 'reveal', id: string) => Promise<void>) | undefined
}

export interface ClassifiedStrategy {
  reveal(ctx: ClassifiedRevealCtx, id: string, field: string): Promise<unknown>
}

export const NO_CLASSIFIED: ClassifiedStrategy = {
  async reveal() { throw new ClassifiedNotEnabledError() },
}
```

```ts
// packages/hub/src/with-shape/classified/active.ts
import type { ClassifiedStrategy } from './strategy.js'

/** Opt-in factory: enables reveal (and, in stage 2, verify/matchGroup). */
export function withClassified(): ClassifiedStrategy {
  return {
    async reveal(ctx, id, field) {
      const { revealField } = await import('./reveal.js')
      return revealField(ctx, id, field)
    },
  }
}
```

```ts
// packages/hub/src/with-shape/classified/reveal.ts
/** Single-point audited reveal — one field of one record, decrypted once. @module */
import type { ClassifiedRevealCtx } from './strategy.js'

export async function revealField(ctx: ClassifiedRevealCtx, id: string, field: string): Promise<unknown> {
  const view = await ctx.getView(id)
  if (view === null) throw new Error(`reveal: record "${id}" not found in "${ctx.collection}"`)
  const slot = view[field] as { sealed?: boolean; reveal?: () => Promise<unknown> } | undefined
  const value = slot !== undefined && slot.sealed === true && typeof slot.reveal === 'function'
    ? await slot.reveal()
    : slot
  await ctx.onAccess?.('reveal', id)
  return value
}
```

Threading: `types.ts` gains `readonly classifiedStrategy?: ClassifiedStrategy` (import type from `../with-shape/classified/strategy.js`) beside `attestationStrategy`; `noydb.ts` adds the conditional spread `...(this.options.classifiedStrategy !== undefined ? { classifiedStrategy: this.options.classifiedStrategy } : {})` at BOTH Vault-construction sites (~602, ~685); `vault.ts` ctor options gain `classifiedStrategy?: ClassifiedStrategy | undefined`, and the fresh-construction branch sets `collOpts.classifiedStrategy = this.classifiedStrategy ?? NO_CLASSIFIED`; `collection-config.ts` `CollectionOpts` gains `classifiedStrategy?: ClassifiedStrategy | undefined` threaded through the resolver return; `collection.ts` stores `private readonly classifiedStrategy: ClassifiedStrategy` (`cfg.classifiedStrategy ?? NO_CLASSIFIED`) and adds the public method near `toJSONSchema()` (~line 1068):

```ts
  /** Single-point audited reveal of one classified field. Requires withClassified(). */
  async reveal(id: string, field: string): Promise<unknown> {
    const spec = this.classified?.byField[field]
    if (spec === undefined) throw new Error(`Field "${field}" in "${this.name}" is not classified`)
    if (spec.storage === 'never') {
      throw new Error(`Field "${field}" in "${this.name}" is storage:'never' — nothing is stored to reveal`)
    }
    return this.classifiedStrategy.reveal({
      collection: this.name,
      spec,
      getView: async (rid) => (await this.get(rid)) as Record<string, unknown> | null,
      ...(this.onAccess !== undefined
        ? { onAccess: async (_op: 'reveal', rid: string) => { await this.onAccess!('reveal', rid) } }
        : {}),
    }, id, field)
  }
```

Consent op union: change `'get' | 'put' | 'delete'` to `'get' | 'put' | 'delete' | 'reveal'` at `collection.ts:551` (`onAccess` field type), in `vault.ts` `_logConsent`'s op parameter (~2948) and the `onAccess` wiring (~1011), and in the consent entry `op` type in `with-audit/consent/strategy.ts` (grep `'get' | 'put' | 'delete'` in that file). The `NO_CONSENT` default means reveal-audit silently no-ops unless consent auditing is configured — that IS the stage-1 audit story (ledger-chained reveal events are a stage-2 question).

`package.json` exports (next to `./attestation`):

```json
"./classified": {
  "types": "./dist/classified/index.d.ts",
  "default": "./dist/classified/index.js"
},
```

`tsup.config.ts` ENTRIES: `'classified/index': 'src/with-shape/classified/index.ts',`

- [ ] **Step 4: Run tests + build**

Run: `pnpm vitest run packages/hub/__tests__/classified/ && pnpm --filter @noy-db/hub build`
Expected: tests PASS; build emits `dist/classified/index.js` (DTS may need `NODE_OPTIONS=--max-old-space-size=8192`)

- [ ] **Step 5: Lint + typecheck + commit**

```bash
pnpm --filter @noy-db/hub lint && pnpm --filter @noy-db/hub typecheck
git add -A packages/hub
git commit -m "feat(classified): withClassified() gate + audited collection.reveal()"
```

---

### Task 7: Governance mechanics — goldens, ceilings, bundle gate, SERVICES.md

**Files:**
- Modify: `packages/hub/__tests__/kernel-api.golden.json` (Collection array: insert `"reveal"` in alphabetical order)
- Modify: `scripts/check-architecture.mjs` (`KERNEL_SURFACE_BUDGET`: bump vault.ts/noydb.ts/collection.ts entries by the measured deltas with comment `// classified-fields stage 1 (Task 6-7)`)
- Modify: `packages/hub/scripts/check-bundle.mjs` (SCENARIOS: add a `classified` scenario modeled on the `history` one at lines 107-116, importing `withClassified` from `@noy-db/hub/classified`, `leakCanaries: []`; add the alias `'@noy-db/hub/classified': 'dist/classified/index.js'` in BOTH alias blocks ~185-199 and ~226-240)
- Modify: `packages/hub/bundle-manifest.json` (re-baseline)
- Modify: `SERVICES.md` (add a catalog row for `classified` in the appropriate cluster table; bump the service count at lines 28 and 123)

**Interfaces:**
- Consumes: Task 6's subpath + factory.
- Produces: green `pnpm check:architecture`, `pnpm --filter @noy-db/hub bundle-check`, and the kernel-api golden test.

- [ ] **Step 1: Run the three gates to see the exact failures**

Run: `pnpm vitest run packages/hub/__tests__/kernel-api-surface-golden.test.ts && pnpm check:architecture && pnpm --filter @noy-db/hub bundle-check`
Expected: golden FAILS naming `reveal`; kernel-surface may FAIL with measured line counts; bundle-check FAILS on the missing scenario/baseline

- [ ] **Step 2: Apply each fix listed in Files above** (golden insert, ceiling bumps with comments, scenario + aliases, `BUNDLE_BASELINE_UPDATE=1 pnpm --filter @noy-db/hub bundle-check` to re-baseline, SERVICES.md row + count)

- [ ] **Step 3: Re-run all three gates**

Run: same three commands
Expected: ALL PASS. Verify the floor scenario did NOT grow (the reveal engine must reach the bundle only via the dynamic import in `active.ts`).

- [ ] **Step 4: Commit**

```bash
git add packages/hub/__tests__/kernel-api.golden.json scripts/check-architecture.mjs packages/hub/scripts/check-bundle.mjs packages/hub/bundle-manifest.json SERVICES.md
git commit -m "chore(classified): governance — kernel-api golden, surface ceilings, bundle gate, SERVICES.md row"
```

(External follow-up, NOT in this repo: the service doc page belongs in `noy-db-docs/content/docs/services/classified.md` — note it in the PR description.)

---

### Task 8: applyListProjection() helper

**Files:**
- Create: `packages/hub/src/with-shape/introspection/projection.ts`
- Modify: `packages/hub/src/index.ts` (value export next to the describe types at ~line 206)
- Test: `packages/hub/__tests__/introspection/projection.test.ts`

**Interfaces:**
- Consumes: `CollectionDescription`/`DescribedField.classified` (Task 5), rider naming law `` `${field}_${rider}` `` (Task 1).
- Produces: `applyListProjection(desc: CollectionDescription, record: Record<string, unknown>, opts?: { sensitivity?: 'omit' | 'mask' }): Record<string, unknown>` — pure, non-mutating; classified fields always projected; plain `sensitivity: 'pii' | 'secret'` fields additionally handled when `opts.sensitivity` is given.

- [ ] **Step 1: Write the failing test**

```ts
// packages/hub/__tests__/introspection/projection.test.ts
import { describe, it, expect } from 'vitest'
import { applyListProjection } from '../../src/with-shape/introspection/projection.js'
import type { CollectionDescription } from '../../src/with-shape/introspection/describe.js'

const desc = {
  collection: 'cards', label: 'Cards',
  fields: [
    { key: 'pan', type: 'string', label: 'Pan', sensitivity: 'secret',
      classified: { preset: 'creditCard.pan', storage: 'recoverable', list: { mask: '•••• ${last4}' } } },
    { key: 'cvcNote', type: 'string', label: 'N', sensitivity: 'pii' },
    { key: 'pan_last4', type: 'string', label: 'Last4' },
    { key: 'total', type: 'number', label: 'Total' },
  ],
} as unknown as CollectionDescription

describe('applyListProjection', () => {
  const rec = { pan: { sealed: true }, pan_last4: '4242', cvcNote: 'call bank', total: 9 }

  it('masks classified fields resolving ${rider} from companions; leaves safe fields', () => {
    const out = applyListProjection(desc, rec)
    expect(out.pan).toBe('•••• 4242')
    expect(out.pan_last4).toBe('4242')
    expect(out.total).toBe(9)
    expect(out.cvcNote).toBe('call bank')       // plain pii untouched without opts
    expect(rec.pan).toEqual({ sealed: true })   // non-mutating
  })

  it('opts.sensitivity handles plain-tagged fields: omit drops, mask blots', () => {
    expect(applyListProjection(desc, rec, { sensitivity: 'omit' })).not.toHaveProperty('cvcNote')
    expect(applyListProjection(desc, rec, { sensitivity: 'mask' }).cvcNote).toBe('•••')
  })

  it('classified list:omit drops the field; missing rider companions blot to •', () => {
    const d2 = { ...desc, fields: [
      { key: 'x', type: 'string', label: 'X', classified: { preset: 'p', storage: 'never', list: 'omit' } },
      { key: 'pan', type: 'string', label: 'P', classified: { preset: 'p', storage: 'recoverable', list: { mask: '•••• ${last4}' } } },
    ] } as unknown as CollectionDescription
    const out = applyListProjection(d2, { x: 'boom', pan: 'raw' })
    expect(out).not.toHaveProperty('x')
    expect(out.pan).toBe('•••• •')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/hub/__tests__/introspection/projection.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

```ts
// packages/hub/src/with-shape/introspection/projection.ts
/**
 * `applyListProjection` — the ONE vetted read-projection for lists/exports.
 * Replaces classified field values with their declared projection (omit /
 * mask / rider) so no consumer re-implements redaction. Pure, non-mutating.
 * Consumed by as-* exporters (#489) and available to any list renderer.
 * @module
 */
import type { CollectionDescription } from './describe.js'

export interface ListProjectionOptions {
  /** Also handle fields carrying only a plain sensitivity tag (pii/secret). */
  readonly sensitivity?: 'omit' | 'mask'
}

export function applyListProjection(
  desc: CollectionDescription,
  record: Record<string, unknown>,
  opts?: ListProjectionOptions,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...record }
  for (const f of desc.fields) {
    if (f.classified !== undefined) {
      const list = f.classified.list
      if (list === 'omit') { delete out[f.key]; continue }
      if ('mask' in list) {
        out[f.key] = list.mask.replace(/\$\{(\w+)\}/g, (_m, rider: string) => {
          const v = record[`${f.key}_${rider}`]
          return v === undefined || v === null ? '•' : String(v)
        })
        continue
      }
      out[f.key] = record[`${f.key}_${list.rider}`]
      continue
    }
    if (opts?.sensitivity !== undefined && (f.sensitivity === 'pii' || f.sensitivity === 'secret')) {
      if (opts.sensitivity === 'omit') delete out[f.key]
      else out[f.key] = '•••'
    }
  }
  return out
}
```

`src/index.ts`, next to line 206: `export { applyListProjection, type ListProjectionOptions } from './with-shape/introspection/projection.js'`

- [ ] **Step 4: Run test to verify it passes** — `pnpm vitest run packages/hub/__tests__/introspection/projection.test.ts` → PASS

- [ ] **Step 5: Lint + typecheck + commit**

```bash
pnpm --filter @noy-db/hub lint && pnpm --filter @noy-db/hub typecheck
git add -A packages/hub
git commit -m "feat(classified): applyListProjection — the shared redaction seam for lists and exports"
```

---

### Task 9: as-csv redact option (#489, exportStream style)

**Files:**
- Modify: `packages/as-csv/src/index.ts` (`AsCSVOptions` + `toString()` at lines 67-80)
- Test: create alongside the package's existing test file (locate with `ls packages/as-csv/src packages/as-csv/__tests__ 2>/dev/null`; name the new file `redact.test.ts` in the same directory, reusing that suite's existing vault-setup helpers)

**Interfaces:**
- Consumes: `applyListProjection` + `CollectionDescription` from `@noy-db/hub` (Task 8; as-csv already imports from the main barrel — no new dependency).
- Produces: `AsCSVOptions.redact?: boolean | { sensitivity: 'omit' | 'mask' }` — `true` projects classified fields only; the object form additionally handles plain-tagged fields.

- [ ] **Step 1: Write the failing test** — in the located test directory:

```ts
// packages/as-csv/<test-dir>/redact.test.ts — reuse this package's existing setup helpers
import { describe, it, expect } from 'vitest'
import { classified } from '@noy-db/hub'
import { toString as csvToString } from '../src/index.js'
// build vault exactly the way the neighboring toString tests do, then:

describe('as-csv redact (#489)', () => {
  it('redact: true masks classified fields and keeps riders', async () => {
    const v = await makeVault()                       // this suite's existing helper
    const c = v.collection('cards', {
      classifiedFields: { card: classified.creditCard({ pan: 'pan' }) },
    })
    await c.put('r1', { pan: '4242424242424242', total: 9 })
    const csv = await csvToString(v, { collection: 'cards', redact: true })
    expect(csv).toContain('•••• 4242')
    expect(csv).not.toContain('4242424242424242')
  })

  it('redact: { sensitivity: "omit" } drops plain pii-tagged columns', async () => {
    const v = await makeVault()
    const c = v.collection('people', { fieldMeta: { note: { label: 'N', sensitivity: 'pii' } } })
    await c.put('p1', { name: 'x', note: 'private' })
    const csv = await csvToString(v, { collection: 'people', redact: { sensitivity: 'omit' } })
    expect(csv).not.toContain('private')
    expect(csv).toContain('x')
  })
})
```

- [ ] **Step 2: Run to verify it fails** — `pnpm vitest run packages/as-csv` → FAIL (`redact` unknown / plaintext present)

- [ ] **Step 3: Implement** — in `packages/as-csv/src/index.ts`: extend the options interface with the `redact` member above; extend the hub import to `import { diffVault, applyListProjection, type VaultDiff, type Vault, type CollectionDescription } from '@noy-db/hub'` (merge with the existing import lines 24/183); inside `toString()` after records are collected from `exportStream` (line 75 loop):

```ts
  if (options.redact !== undefined && options.redact !== false) {
    const desc: CollectionDescription = vault.collection(options.collection).describe()
    const opts = options.redact === true ? undefined
      : { sensitivity: options.redact.sensitivity }
    records = records.map((r) => applyListProjection(desc, r as Record<string, unknown>, opts))
  }
```

(Caveat to encode as a doc comment on the option: `describe()` reflects the declarations of the session's collection instance — redaction requires the collection to have been opened with its `classifiedFields`/`fieldMeta` before exporting. Sealed handles never leak regardless: they serialize as `'[sealed]'`.)

- [ ] **Step 4: Run to verify it passes** — `pnpm vitest run packages/as-csv` → ALL PASS (including pre-existing tests)

- [ ] **Step 5: Commit**

```bash
git add packages/as-csv
git commit -m "feat(as-csv): redact option — classified/sensitivity-aware export via applyListProjection (#489)"
```

---

### Task 10: as-xlsx redact option (#489, collection.list() style)

**Files:**
- Modify: `packages/as-xlsx/src/index.ts` (`AsXlsxOptions` + flat path at lines 225-260 + smart path at ~line 545)
- Test: same discovery rule as Task 9 — `redact.test.ts` beside the existing as-xlsx tests, reusing their setup helpers

**Interfaces:**
- Consumes: `applyListProjection` from `@noy-db/hub` (Task 8).
- Produces: `AsXlsxOptions.redact?: boolean | { sensitivity: 'omit' | 'mask' }` applied to every sheet's records in both the flat and smart paths.

- [ ] **Step 1: Write the failing test** — mirror Task 9's two cases against `toBytes(vault, { sheets: [{ collection: 'cards' }], redact: true })`; assert the produced workbook (use this suite's existing read-back helper) contains `•••• 4242` and not the full PAN.

- [ ] **Step 2: Run to verify it fails** — `pnpm vitest run packages/as-xlsx` → FAIL

- [ ] **Step 3: Implement** — add the option; in the flat path after `const list = await collection.list()` (line 241) and in `buildSmartSheets` after its `collection.list()` (~line 545):

```ts
  const projected = options.redact !== undefined && options.redact !== false
    ? (() => {
        const desc = vault.collection(sheetOpt.collection).describe()
        const o = options.redact === true ? undefined : { sensitivity: options.redact.sensitivity }
        return list.map((r) => applyListProjection(desc, r as Record<string, unknown>, o))
      })()
    : list
```

(then use `projected` where `list` was used; repeat per path, including the multi-vault path at line ~387 with `entry.vault`.)

- [ ] **Step 4: Run to verify it passes** — `pnpm vitest run packages/as-xlsx` → ALL PASS

- [ ] **Step 5: Commit**

```bash
git add packages/as-xlsx
git commit -m "feat(as-xlsx): redact option — classified/sensitivity-aware sheets via applyListProjection (#489)"
```

---

### Task 11: Changeset, full-suite validation, follow-ups

**Files:**
- Create: `.changeset/classified-fields-stage1.md`
- No other source changes — this task is validation + bookkeeping.

- [ ] **Step 1: Author the changeset**

```md
---
'@noy-db/hub': minor
'@noy-db/as-csv': minor
'@noy-db/as-xlsx': minor
---

Classified fields (stage 1): behavioral sensitive-field types. `classifiedFields`
collection option with presets (`classified.creditCard()` composite with
storage:'never' CVC, `birthDate`, `email`, `phone`), write-time riders +
validation, sealed-backed storage, `withClassified()`-gated audited
`collection.reveal()`, `x-classified` in describe()/toJSONSchema(), and
`applyListProjection()` — consumed by as-csv/as-xlsx `redact` options (#489).
Note: riders materialize at write time, so date-relative riders (ageBand,
expiresSoon) are deliberately not offered; birthDate ships a stable `yob` rider.
```

- [ ] **Step 2: Full cross-package suite (the diffVault lesson — hub API changed)**

Run: `pnpm turbo test --concurrency=1`
Expected: ALL PASS (~113 tasks; rerun `in-pinia` solo if its known unhandled-rejection flake appears under load)

- [ ] **Step 3: Full guard sweep**

Run: `pnpm check:architecture && pnpm --filter @noy-db/hub bundle-check && pnpm knip && pnpm lint && pnpm typecheck`
Expected: ALL PASS

- [ ] **Step 4: Commit + file follow-up issues**

```bash
git add .changeset
git commit -m "chore(classified): changeset for stage 1"
gh issue comment 489 --body "Stage-1 classified-fields arc implements this via a shared hub helper (applyListProjection) + redact options in as-csv/as-xlsx. Remaining exporters tracked separately."
gh issue create --title "as-json/as-ndjson/as-sql/as-xml: adopt the redact option (applyListProjection)" \
  --body "Mechanical follow-up to the classified-fields stage 1 arc: apply the as-csv recipe (same exportStream style) to the remaining record exporters. See docs/superpowers/plans/2026-07-04-classified-fields-stage1.md Task 9."
gh issue create --title "classified fields stage 2: enclave oracle (digests, verify, k-of-n, rotation)" \
  --body "Own design→security-audit cycle per docs/superpowers/specs/2026-07-04-classified-fields-design.md. Adds keyed digests (HKDF classify index key), verify/verifyText, matchGroup(min k), digest-history ring, enclave-body-only ratchet extension."
```

(Do NOT close #489 until the PR merges; the comment links the work.)
