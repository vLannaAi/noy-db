# Composite `triggerBy` Implementation Plan (#1249)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generalise `withDerivation`'s `triggerBy` from single-FK-vs-parent-id to a conjunction of `source[to] === written[from]` equality pairs, with union fan-out on updates and delete fan-out for both forms.

**Architecture:** All new logic lives in `with-formula/derivations/` (no ceiling) — a new pure module `trigger-match.ts` plus dispatch changes. The two kernel files at their line ceilings (`collection.ts` 4317/4318, `vault.ts` 3741/3742) get only thin call-sites, and Task 4 **banks slack** in `collection.ts` (net-negative) before Tasks 6–8 spend it.

**Tech Stack:** TypeScript (strict), vitest, existing derivations registry/dispatch/executor. No new dependencies, no persisted state.

**Spec:** `docs/superpowers/specs/2026-08-29-composite-triggerby-design.md` — read it first; every semantic question (coercion, `from:'id'`, any-component-changed, silent-guard posture) is decided there.

## Global Constraints

- `pnpm check:architecture` must stay green — `collection.ts` ceiling **4318**, `vault.ts` ceiling **3742** (ratchets; do not bump).
- Hub stays portable: no Node built-ins in `hub/src/**`.
- Scalar-only match comparison, verbatim from `_findMatchingIds`: both sides `string | number`, compared as `String(a) === String(b)`; anything else fails the pair.
- "Any single component changing constitutes a tuple difference" (pilot requirement, spec §7) — never weaken to all-components.
- The typo guard is **silent when the field set is not enumerable** (spec §5) — a TS-generic collection must never be rejected.
- Changeset at the end: `@noy-db/hub` **minor**.
- Run single test files as `pnpm vitest run packages/hub/__tests__/derivations/<file>.test.ts` from the repo root.
- Commit after every green task. Never add AI attribution to commits.

---

### Task 1: `trigger-match.ts` — pure normalize/tuple/match helpers

**Files:**
- Create: `packages/hub/src/with-formula/derivations/trigger-match.ts`
- Test: `packages/hub/__tests__/derivations/trigger-match.test.ts`

**Interfaces:**
- Consumes: nothing (pure module).
- Produces (used by Tasks 3, 4, 5, 6, 7):
  - `type MatchPair = { readonly from: string; readonly to: string }`
  - `type NormalizedTrigger = { readonly collection: string; readonly match: ReadonlyArray<MatchPair>; readonly maxFanout?: number }`
  - `normalizeTriggerBy(triggerBy: ReadonlyArray<{ collection: string; on?: string; match?: ReadonlyArray<MatchPair>; maxFanout?: number }> | undefined): NormalizedTrigger[]`
  - `tupleFromWritten(match: ReadonlyArray<MatchPair>, writtenId: string, record: Record<string, unknown> | null): Array<{ field: string; value: string }> | null` — `null` when any `from` value is absent/non-scalar (the tuple matches nothing).
  - `sameTuple(a: Array<{ field: string; value: string }> | null, b: Array<{ field: string; value: string }> | null): boolean`
  - `recordMatchesPairs(rec: Record<string, unknown>, pairs: ReadonlyArray<{ field: string; value: string }>): boolean`

- [ ] **Step 1: Write the failing test**

```ts
// packages/hub/__tests__/derivations/trigger-match.test.ts
// Pure helpers behind composite triggerBy (#1249). Semantics: spec
// docs/superpowers/specs/2026-08-29-composite-triggerby-design.md §4-§5.
import { describe, it, expect } from 'vitest'
import { normalizeTriggerBy, tupleFromWritten, sameTuple, recordMatchesPairs } from '../../src/with-formula/derivations/trigger-match.js'

describe('normalizeTriggerBy', () => {
  it('normalizes the on-form to match [{from:"id"}]', () => {
    expect(normalizeTriggerBy([{ collection: 'buyers', on: 'buyerId', maxFanout: 5 }])).toEqual([
      { collection: 'buyers', match: [{ from: 'id', to: 'buyerId' }], maxFanout: 5 },
    ])
  })
  it('passes the match-form through', () => {
    expect(normalizeTriggerBy([{ collection: 'disbursements', match: [{ from: 'clientId', to: 'clientId' }, { from: 'cycle', to: 'cycle' }] }])).toEqual([
      { collection: 'disbursements', match: [{ from: 'clientId', to: 'clientId' }, { from: 'cycle', to: 'cycle' }] },
    ])
  })
  it('returns [] for undefined', () => {
    expect(normalizeTriggerBy(undefined)).toEqual([])
  })
})

describe('tupleFromWritten', () => {
  const m = [{ from: 'clientId', to: 'clientId' }, { from: 'cycle', to: 'cycle' }]
  it('extracts values, String-coerced', () => {
    expect(tupleFromWritten(m, 'd1', { clientId: 'c1', cycle: 2026 })).toEqual([
      { field: 'clientId', value: 'c1' }, { field: 'cycle', value: '2026' },
    ])
  })
  it("from:'id' reads the written id, winning over a stored id field", () => {
    expect(tupleFromWritten([{ from: 'id', to: 'buyerId' }], 'b9', { id: 'WRONG' })).toEqual([
      { field: 'buyerId', value: 'b9' },
    ])
  })
  it('absent from-field -> null (matches nothing)', () => {
    expect(tupleFromWritten(m, 'd1', { clientId: 'c1' })).toBeNull()
  })
  it('non-scalar from-field -> null', () => {
    expect(tupleFromWritten(m, 'd1', { clientId: 'c1', cycle: { q: 1 } })).toBeNull()
  })
  it('null record with only id pairs still works', () => {
    expect(tupleFromWritten([{ from: 'id', to: 'buyerId' }], 'b1', null)).toEqual([{ field: 'buyerId', value: 'b1' }])
  })
  it('null record with a field pair -> null', () => {
    expect(tupleFromWritten(m, 'd1', null)).toBeNull()
  })
})

describe('sameTuple / recordMatchesPairs', () => {
  it('any single component differing means not-same (pilot requirement)', () => {
    const a = [{ field: 'clientId', value: 'c1' }, { field: 'cycle', value: 'Q1' }]
    const b = [{ field: 'clientId', value: 'c1' }, { field: 'cycle', value: 'Q2' }]
    expect(sameTuple(a, b)).toBe(false)
    expect(sameTuple(a, [...a])).toBe(true)
    expect(sameTuple(null, a)).toBe(false)
    expect(sameTuple(null, null)).toBe(true)
  })
  it('recordMatchesPairs is a conjunction with scalar coercion', () => {
    const pairs = [{ field: 'clientId', value: 'c1' }, { field: 'cycle', value: '2026' }]
    expect(recordMatchesPairs({ clientId: 'c1', cycle: 2026 }, pairs)).toBe(true)   // number 2026 == '2026'
    expect(recordMatchesPairs({ clientId: 'c1', cycle: '2027' }, pairs)).toBe(false)
    expect(recordMatchesPairs({ clientId: 'c1' }, pairs)).toBe(false)               // absent
    expect(recordMatchesPairs({ clientId: 'c1', cycle: ['2026'] }, pairs)).toBe(false) // non-scalar
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/hub/__tests__/derivations/trigger-match.test.ts`
Expected: FAIL — cannot resolve `../../src/with-formula/derivations/trigger-match.js`

- [ ] **Step 3: Write the implementation**

```ts
// packages/hub/src/with-formula/derivations/trigger-match.ts
/**
 * Pure helpers behind composite `triggerBy` (#1249).
 *
 * A trigger entry is a CONJUNCTION of equality pairs: a source record
 * matches when EVERY pair satisfies String(source[to]) === String(written[from]).
 * `from: 'id'` reads the written record's id (winning over any stored field
 * named `id`, matching dispatch's `{ ...incoming, id }` convention). The
 * legacy `on` form normalizes to `[{ from: 'id', to: on }]` so everything
 * downstream has ONE shape.
 *
 * Scalar coercion is verbatim from `_findMatchingIds`: both sides must be
 * string | number; anything else fails the pair (never throws).
 * Spec: docs/superpowers/specs/2026-08-29-composite-triggerby-design.md §4-§5.
 * @module
 */

export interface MatchPair { readonly from: string; readonly to: string }

export interface NormalizedTrigger {
  readonly collection: string
  readonly match: ReadonlyArray<MatchPair>
  readonly maxFanout?: number
}

interface RawTrigger {
  readonly collection: string
  readonly on?: string
  readonly match?: ReadonlyArray<MatchPair>
  readonly maxFanout?: number
}

export function normalizeTriggerBy(triggerBy: ReadonlyArray<RawTrigger> | undefined): NormalizedTrigger[] {
  if (triggerBy === undefined) return []
  return triggerBy.map((t) => ({
    collection: t.collection,
    match: t.match ?? [{ from: 'id', to: t.on! }],
    ...(t.maxFanout !== undefined ? { maxFanout: t.maxFanout } : {}),
  }))
}

const scalar = (v: unknown): string | null =>
  (typeof v === 'string' || typeof v === 'number') ? String(v) : null

/**
 * The value tuple a written record presents to one trigger entry.
 * `null` means "this record cannot address any source" (a from-field is
 * absent or non-scalar) — a legitimate no-match, not an error.
 */
export function tupleFromWritten(
  match: ReadonlyArray<MatchPair>,
  writtenId: string,
  record: Record<string, unknown> | null,
): Array<{ field: string; value: string }> | null {
  const out: Array<{ field: string; value: string }> = []
  for (const pair of match) {
    const v = pair.from === 'id' ? writtenId : scalar(record?.[pair.from])
    if (v === null) return null
    out.push({ field: pair.to, value: v })
  }
  return out
}

/** Any single component differing means NOT the same tuple (spec §7). */
export function sameTuple(
  a: Array<{ field: string; value: string }> | null,
  b: Array<{ field: string; value: string }> | null,
): boolean {
  if (a === null || b === null) return a === b
  return a.length === b.length && a.every((p, i) => p.field === b[i]!.field && p.value === b[i]!.value)
}

/** Conjunction over one candidate record, same coercion as tupleFromWritten. */
export function recordMatchesPairs(
  rec: Record<string, unknown>,
  pairs: ReadonlyArray<{ field: string; value: string }>,
): boolean {
  return pairs.every((p) => scalar(rec[p.field]) === p.value)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/hub/__tests__/derivations/trigger-match.test.ts`
Expected: PASS (all)

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/with-formula/derivations/trigger-match.ts packages/hub/__tests__/derivations/trigger-match.test.ts
git commit -m "feat(hub): trigger-match — pure normalize/tuple/match helpers for composite triggerBy (#1249)"
```

---

### Task 2: Public type + construction validation

**Files:**
- Modify: `packages/hub/src/with-formula/derivations/types.ts:191` (the `triggerBy` declaration and its JSDoc block starting ~line 165)
- Modify: `packages/hub/src/with-formula/derivations/with-derivation.ts` (the `if (spec.triggerBy !== undefined)` block, lines 47-69)
- Test: `packages/hub/__tests__/derivations/composite-triggerby.test.ts` (new file, construction section)

**Interfaces:**
- Consumes: nothing from Task 1 at runtime (validation is on the raw shape).
- Produces: the public union type consumers write —
  `triggerBy?: ReadonlyArray<{ collection: string; on: string; maxFanout?: number } | { collection: string; match: ReadonlyArray<{ from: string; to: string }>; maxFanout?: number }>`

- [ ] **Step 1: Write the failing construction tests**

Create the new test file. Copy the `toMemory()` helper verbatim from `packages/hub/__tests__/derivations/trigger-by.test.ts:13-39` (each test file carries its own; that is the local convention).

```ts
// packages/hub/__tests__/derivations/composite-triggerby.test.ts
// Composite (multi-field) triggerBy — #1249.
// Spec: docs/superpowers/specs/2026-08-29-composite-triggerby-design.md
import { describe, it, expect } from 'vitest'
import { createNoydb, withDerivation, ValidationError, DerivationCapExceededError } from '../../src/index.js'
import type { NoydbStore, EncryptedEnvelope } from '../../src/kernel/types.js'

// [toMemory() copied verbatim from trigger-by.test.ts]

interface Bill extends Record<string, unknown> { id: string; clientId: string; cycle: string; status?: string }
interface Disbursement extends Record<string, unknown> { id: string; clientId: string; cycle: string; amount: number }

function billStatusStrategy(extra: { maxFanout?: number } = {}) {
  return withDerivation<Bill, { self: Bill }>({
    source: 'bills',
    deterministic: true,
    triggerBy: [{
      collection: 'disbursements',
      match: [{ from: 'clientId', to: 'clientId' }, { from: 'cycle', to: 'cycle' }],
      ...(extra.maxFanout !== undefined ? { maxFanout: extra.maxFanout } : {}),
    }],
    outputs: { self: { shape: 'record', collection: 'bills', denorm: ['status'] } },
    derive: async (bill, ctx) => {
      const all = await ctx.vault.collection<Disbursement>('disbursements').query()
        .where('clientId', '==', bill.clientId).where('cycle', '==', bill.cycle).toArray()
      const covered = all.reduce((s, d) => s + d.amount, 0) > 0
      return { self: { ...bill, status: covered ? 'covered' : 'uncovered' } as Bill }
    },
    lifecycle: 'eager',
  })
}

describe('composite triggerBy — factory validation (#1249)', () => {
  const base = {
    source: 'bills', deterministic: true as const, lifecycle: 'eager' as const,
    outputs: { self: { shape: 'record' as const, collection: 'bills', denorm: ['status'] } },
    derive: (b: Bill) => ({ self: b }),
  }
  it('rejects an entry with BOTH on and match', () => {
    expect(() => withDerivation<Bill, { self: Bill }>({
      ...base,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      triggerBy: [{ collection: 'disbursements', on: 'clientId', match: [{ from: 'id', to: 'clientId' }] } as any],
    })).toThrow(ValidationError)
  })
  it('rejects an entry with NEITHER on nor match', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => withDerivation<Bill, { self: Bill }>({ ...base, triggerBy: [{ collection: 'disbursements' } as any] }))
      .toThrow(ValidationError)
  })
  it('rejects empty match array', () => {
    expect(() => withDerivation<Bill, { self: Bill }>({ ...base, triggerBy: [{ collection: 'disbursements', match: [] }] }))
      .toThrow(ValidationError)
  })
  it('rejects an empty from or to', () => {
    expect(() => withDerivation<Bill, { self: Bill }>({ ...base, triggerBy: [{ collection: 'disbursements', match: [{ from: '', to: 'clientId' }] }] }))
      .toThrow(ValidationError)
    expect(() => withDerivation<Bill, { self: Bill }>({ ...base, triggerBy: [{ collection: 'disbursements', match: [{ from: 'clientId', to: '' }] }] }))
      .toThrow(ValidationError)
  })
  it('rejects duplicate `to` within one entry', () => {
    expect(() => withDerivation<Bill, { self: Bill }>({
      ...base,
      triggerBy: [{ collection: 'disbursements', match: [{ from: 'clientId', to: 'clientId' }, { from: 'cycle', to: 'clientId' }] }],
    })).toThrow(ValidationError)
  })
  it('accepts a valid composite entry (and the existing on-form untouched)', () => {
    expect(() => billStatusStrategy()).not.toThrow()
    expect(() => withDerivation<Bill, { self: Bill }>({ ...base, triggerBy: [{ collection: 'clients', on: 'clientId' }] })).not.toThrow()
  })
})
```

- [ ] **Step 2: Run to verify the right failures**

Run: `pnpm vitest run packages/hub/__tests__/derivations/composite-triggerby.test.ts`
Expected: the both/neither/empty/dup cases FAIL (no error thrown yet — the current validator only knows `on`); the accepts-valid case may already pass typewise. (`match` entries currently fail the `on` check — so "rejects NEITHER" may pass for the wrong reason; that is fine, the suite goes fully green only after Step 3.)

- [ ] **Step 3: Update the type and the validator**

In `types.ts`, replace line 191 and extend the JSDoc above it (keep every existing sentence about fan-out, indexing, maxFanout, cycle detection; add the new semantics):

```ts
  triggerBy?: ReadonlyArray<
    | { collection: string; on: string; maxFanout?: number }
    | {
        /**
         * Multi-field trigger (#1249): a source record matches when EVERY
         * pair satisfies `String(source[to]) === String(written[from])`.
         * `from: 'id'` reads the written record's id; any other `from`
         * reads the written record's field. Exactly one of `on` | `match`
         * per entry. On an UPDATE that changes any matched `from` field,
         * fan-out runs on old-match ∪ new-match (any single component
         * changing counts). Parent DELETES fan out using the tombstoned
         * record's values — for BOTH forms. A missing/non-scalar `from`
         * value matches nothing. Match fields are validated against the
         * collections' enumerable field sets where possible (silent for
         * TS-generic collections — see the registration guard).
         */
        collection: string
        match: ReadonlyArray<{ from: string; to: string }>
        maxFanout?: number
      }
  >
```

In `with-derivation.ts`, replace the body of the `for (const t of spec.triggerBy)` loop (keep the `collection` and `maxFanout` checks verbatim; replace the `on` check):

```ts
      const hasOn = typeof (t as { on?: unknown }).on === 'string'
      const hasMatch = Array.isArray((t as { match?: unknown }).match)
      if (hasOn === hasMatch) {
        throw new ValidationError(
          `withDerivation: triggerBy on "${t.collection}" needs exactly one of \`on\` or \`match\``,
        )
      }
      if (hasOn && (t as { on: string }).on.length === 0) {
        throw new ValidationError(
          `withDerivation: triggerBy on "${t.collection}" needs a non-empty \`on\` (the FK field on the source)`,
        )
      }
      if (hasMatch) {
        const match = (t as { match: ReadonlyArray<{ from: string; to: string }> }).match
        if (match.length === 0) {
          throw new ValidationError(`withDerivation: triggerBy match on "${t.collection}" must be non-empty`)
        }
        const seen = new Set<string>()
        for (const p of match) {
          if (typeof p?.from !== 'string' || p.from.length === 0 || typeof p?.to !== 'string' || p.to.length === 0) {
            throw new ValidationError(`withDerivation: triggerBy match on "${t.collection}" needs non-empty \`from\` and \`to\` in every pair`)
          }
          if (seen.has(p.to)) {
            throw new ValidationError(`withDerivation: triggerBy match on "${t.collection}" repeats \`to: "${p.to}"\` — two pairs constraining one source field is a contradiction, not a wider match`)
          }
          seen.add(p.to)
        }
      }
```

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm vitest run packages/hub/__tests__/derivations/composite-triggerby.test.ts packages/hub/__tests__/derivations/trigger-by.test.ts`
Expected: PASS (new construction cases AND every existing trigger-by test — the on-form's behaviour is untouched).
Run: `cd packages/hub && npx tsc --noEmit -p tsconfig.json && cd ../..`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/with-formula/derivations/types.ts packages/hub/src/with-formula/derivations/with-derivation.ts packages/hub/__tests__/derivations/composite-triggerby.test.ts
git commit -m "feat(hub): triggerBy accepts a multi-field match form — type + construction validation (#1249)"
```

---

### Task 3: Registry — normalized triggers, field-match flag, field validation

**Files:**
- Modify: `packages/hub/src/with-formula/derivations/registry.ts` (the `register()` method ~line 53, the `RegisteredStrategy` type ~line 40, the triggerBy indexing loop line 82)
- Test: `packages/hub/__tests__/derivations/composite-triggerby.test.ts` (registry section — appended)

**Interfaces:**
- Consumes: `normalizeTriggerBy`, `NormalizedTrigger` from `./trigger-match.js` (Task 1).
- Produces (used by Tasks 5-8):
  - `RegisteredStrategy` gains `readonly triggers: ReadonlyArray<NormalizedTrigger>`
  - `DerivationRegistry.hasFieldMatchTriggerFor(collection: string): boolean` — true iff any registered strategy has a normalized entry `{ collection }` with a pair whose `from !== 'id'`.
  - `DerivationRegistry.validateFieldsFor(collectionName: string, keys: ReadonlySet<string> | undefined, denormExempt?: ReadonlySet<string>): void` — no-op when `keys` is `undefined`; else throws `ValidationError` when a strategy with `source === collectionName` has a `to` ∉ keys ∪ denormExempt, or a strategy with a trigger entry `collection === collectionName` has a `from` (≠`'id'`) ∉ keys.

- [ ] **Step 1: Write the failing registry tests** (append to `composite-triggerby.test.ts`)

```ts
import { normalizeTriggerBy } from '../../src/with-formula/derivations/trigger-match.js'
import { DerivationRegistry } from '../../src/with-formula/derivations/registry.js'
// NOTE: check registry.ts for the actual exported class name and constructor
// arity before writing this — if it is not exported for tests, exercise these
// two methods through `createNoydb` + `(vault as any)` instead, keeping the
// SAME assertions.

describe('registry — normalized triggers (#1249)', () => {
  it('hasFieldMatchTriggerFor: true only for field-match entries', async () => {
    const reg = new DerivationRegistry()
    await reg.register(billStatusStrategy().spec)          // match-form on 'disbursements'
    expect(reg.hasFieldMatchTriggerFor('disbursements')).toBe(true)
    expect(reg.hasFieldMatchTriggerFor('bills')).toBe(false)     // source, not trigger
    expect(reg.hasFieldMatchTriggerFor('unrelated')).toBe(false)
    const reg2 = new DerivationRegistry()
    await reg2.register(withDerivation<Bill, { self: Bill }>({
      source: 'bills', deterministic: true, lifecycle: 'eager',
      triggerBy: [{ collection: 'clients', on: 'clientId' }],   // id-form: no prior needed
      outputs: { self: { shape: 'record', collection: 'bills', denorm: ['status'] } },
      derive: (b) => ({ self: b }),
    }).spec)
    expect(reg2.hasFieldMatchTriggerFor('clients')).toBe(false)
  })
  it('validateFieldsFor: throws on unknown to-field for the source; silent when keys undefined', async () => {
    const reg = new DerivationRegistry()
    await reg.register(withDerivation<Bill, { self: Bill }>({
      source: 'bills', deterministic: true, lifecycle: 'eager',
      triggerBy: [{ collection: 'disbursements', match: [{ from: 'clientId', to: 'clientIdd' }] }], // typo
      outputs: { self: { shape: 'record', collection: 'bills', denorm: ['status'] } },
      derive: (b) => ({ self: b }),
    }).spec)
    expect(() => reg.validateFieldsFor('bills', new Set(['id', 'clientId', 'cycle']))).toThrow(ValidationError)
    expect(() => reg.validateFieldsFor('bills', undefined)).not.toThrow()          // unenumerable: silent
    expect(() => reg.validateFieldsFor('bills', new Set(['clientIdd']))).not.toThrow() // field exists: fine
  })
  it('validateFieldsFor: denorm fields are exempt on the source side', async () => {
    const reg = new DerivationRegistry()
    await reg.register(billStatusStrategy().spec)
    // 'status' is denorm-owned, absent from the schema keys — must not fire
    expect(() => reg.validateFieldsFor('bills', new Set(['id', 'clientId', 'cycle']), new Set(['status']))).not.toThrow()
  })
  it('validateFieldsFor: throws on unknown from-field for the TRIGGER collection', async () => {
    const reg = new DerivationRegistry()
    await reg.register(billStatusStrategy().spec)   // from: clientId, cycle on disbursements
    expect(() => reg.validateFieldsFor('disbursements', new Set(['id', 'amount']))).toThrow(ValidationError)
    expect(() => reg.validateFieldsFor('disbursements', new Set(['clientId', 'cycle', 'amount']))).not.toThrow()
  })
})
```

- [ ] **Step 2: Run to verify failures**

Run: `pnpm vitest run packages/hub/__tests__/derivations/composite-triggerby.test.ts`
Expected: FAIL — `hasFieldMatchTriggerFor` / `validateFieldsFor` are not functions.

- [ ] **Step 3: Implement in registry.ts**

Add to the imports: `import { normalizeTriggerBy, type NormalizedTrigger } from './trigger-match.js'`.
Extend `RegisteredStrategy` with `readonly triggers: ReadonlyArray<NormalizedTrigger>`; in `register()` build `const triggers = normalizeTriggerBy(spec.triggerBy)` and put it on `reg`; change the indexing loop at line 82 to iterate `triggers` instead of `spec.triggerBy ?? []` (same `_bySource` writes — the collection names are identical). Then:

```ts
  /** True iff any strategy's normalized trigger on `collection` has a pair with from !== 'id' (#1249 — gates the prior-record capture). */
  hasFieldMatchTriggerFor(collection: string): boolean {
    for (const regs of this._bySource.values()) {
      for (const reg of regs) {
        for (const t of reg.triggers) {
          if (t.collection === collection && t.match.some((p) => p.from !== 'id')) return true
        }
      }
    }
    return false
  }

  /**
   * The #1253-pattern typo guard for match fields (#1249): a misspelt
   * `to`/`from` silently matches nothing forever, so validate against the
   * collection's enumerable field set at the earliest point it exists.
   * `keys === undefined` (TS-generic collection, unreadable validator) is
   * DELIBERATELY silent — those fields are real and unenumerable.
   */
  validateFieldsFor(collectionName: string, keys: ReadonlySet<string> | undefined, denormExempt?: ReadonlySet<string>): void {
    if (keys === undefined) return
    for (const regs of this._bySource.values()) {
      for (const reg of regs) {
        for (const t of reg.triggers) {
          if (reg.spec.source === collectionName) {
            for (const p of t.match) {
              if (!keys.has(p.to) && !(denormExempt?.has(p.to) ?? false)) {
                throw new ValidationError(
                  `derivation "${reg.spec.name ?? reg.spec.source}": triggerBy match names source field "${p.to}", which "${collectionName}" does not declare — a typo here silently matches nothing forever`)
              }
            }
          }
          if (t.collection === collectionName) {
            for (const p of t.match) {
              if (p.from !== 'id' && !keys.has(p.from)) {
                throw new ValidationError(
                  `derivation "${reg.spec.name ?? reg.spec.source}": triggerBy match reads "${p.from}" from written "${collectionName}" records, which that collection does not declare — a typo here silently matches nothing forever`)
              }
            }
          }
        }
      }
    }
  }
```

(Dedupe: `_bySource` indexes one `reg` under several keys, so iterate a `Set` of regs — collect `new Set([...this._bySource.values()].flat())` first in both methods.)
Import `ValidationError` from `'../../kernel/errors.js'` if not already imported.

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run packages/hub/__tests__/derivations/composite-triggerby.test.ts packages/hub/__tests__/derivations/registry.test.ts packages/hub/__tests__/derivations/cycle.test.ts`
Expected: PASS — including the pre-existing registry and cycle suites (indexing writes are unchanged in effect).

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/with-formula/derivations/registry.ts packages/hub/__tests__/derivations/composite-triggerby.test.ts
git commit -m "feat(hub): registry stores normalized triggers; field-match flag + #1253-pattern field validation (#1249)"
```

---

### Task 4: `_findMatchingCompositeIds` — and BANK the collection.ts slack

**Files:**
- Modify: `packages/hub/src/kernel/collection.ts:2206-2231` (`_findMatchingIds` — replace its body with a delegate)
- Modify: `packages/hub/src/with-formula/derivations/trigger-match.ts` (add the scan core, keeping collection.ts thin)
- Test: `packages/hub/__tests__/derivations/composite-triggerby.test.ts` (fan-out query section)

**Interfaces:**
- Consumes: `recordMatchesPairs` (Task 1).
- Produces (used by Tasks 5-7):
  - `Collection._findMatchingCompositeIds(pairs: ReadonlyArray<{ field: string; value: string }>): Promise<string[]>`
  - `_findMatchingIds(field, value)` KEEPS its exact signature and semantics, now delegating: non-scalar `value` returns `[]` (today it String-coerces anything — verify no caller passes non-scalars: `rollup` passes `String(kv)`; dispatch passes an id string; both fine).

**Ceiling arithmetic (why this task is net-NEGATIVE in collection.ts):** the current `_findMatchingIds` body is ~24 lines. The replacement is ~14 lines total for both methods, with the scan loop living in `trigger-match.ts`. Run `wc -l packages/hub/src/kernel/collection.ts` before and after — after must be ≤ 4317 - 8 or better; Tasks 6-7 spend that slack.

- [ ] **Step 1: Write the failing test** (append)

```ts
describe('composite fan-out query (#1249)', () => {
  it('matches on the conjunction; index-vs-scan equivalence', async () => {
    // Two dbs: one with withIndexing on clientId, one without — same matched sets.
    // Build each: 3 bills (c1/Q1, c1/Q2, c2/Q1); pairs [clientId=c1, cycle=Q1] -> exactly ['b1'].
    for (const indexed of [false, true]) {
      const db = await createNoydb({
        store: toMemory(), user: 'alice', secret: 'composite-q-2026',
        derivationStrategies: [billStatusStrategy()],
        // when indexed: also pass the indexing strategy per the existing
        // trigger-by.test.ts `indexed` variant — copy its exact wiring.
      })
      const v = await db.openVault('firm')
      const bills = v.collection<Bill>('bills')
      await bills.put('b1', { id: 'b1', clientId: 'c1', cycle: 'Q1' })
      await bills.put('b2', { id: 'b2', clientId: 'c1', cycle: 'Q2' })
      await bills.put('b3', { id: 'b3', clientId: 'c2', cycle: 'Q1' })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ids = await (bills as any)._findMatchingCompositeIds([
        { field: 'clientId', value: 'c1' }, { field: 'cycle', value: 'Q1' },
      ])
      expect(ids.sort()).toEqual(['b1'])
      await db.close()
    }
  })
  it('single-pair delegate preserves _findMatchingIds behaviour', async () => {
    const db = await createNoydb({ store: toMemory(), user: 'alice', secret: 'composite-q2-2026', derivationStrategies: [billStatusStrategy()] })
    const v = await db.openVault('firm')
    const bills = v.collection<Bill>('bills')
    await bills.put('b1', { id: 'b1', clientId: 'c1', cycle: 'Q1' })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await (bills as any)._findMatchingIds('clientId', 'c1')).toEqual(['b1'])
    await db.close()
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/hub/__tests__/derivations/composite-triggerby.test.ts`
Expected: FAIL — `_findMatchingCompositeIds` is not a function.

- [ ] **Step 3: Implement**

In `trigger-match.ts`, add the scan core (callback-parameterised so it stays pure):

```ts
/** Scan/filter core for composite fan-out. `indexCandidates` is the id set
 *  from an equality index for ONE pair (or null when no pair is indexed);
 *  when present only candidates are read, else every id. */
export async function findMatchingIdsByPairs(
  pairs: ReadonlyArray<{ field: string; value: string }>,
  io: {
    indexCandidates: ReadonlyArray<string> | null
    listIds: () => Promise<ReadonlyArray<string>>
    getRecord: (id: string) => Promise<Record<string, unknown> | null>
  },
): Promise<string[]> {
  const ids = io.indexCandidates ?? await io.listIds()
  const out: string[] = []
  for (const id of ids) {
    const rec = await io.getRecord(id)
    if (rec !== null && recordMatchesPairs(rec, pairs)) out.push(id)
  }
  return out
}
```

In `collection.ts`, REPLACE the whole `_findMatchingIds` body (2206-2231) with:

```ts
  async _findMatchingIds(field: string, value: unknown): Promise<string[]> {
    if (typeof value !== 'string' && typeof value !== 'number') return []
    return this._findMatchingCompositeIds([{ field, value: String(value) }])
  }

  /** @internal — conjunction fan-out for composite triggerBy (#1249). First indexed pair narrows; one scan otherwise. */
  async _findMatchingCompositeIds(pairs: ReadonlyArray<{ field: string; value: string }>): Promise<string[]> {
    const { findMatchingIdsByPairs } = await import('../with-formula/derivations/trigger-match.js')
    let indexCandidates: ReadonlyArray<string> | null = null
    for (const p of pairs) {
      const hit = this.getIndexes()?.lookupEqual(p.field, p.value)
      if (hit) { indexCandidates = [...hit]; break }
    }
    if (!this.lazy) await this.ensureHydrated()
    return findMatchingIdsByPairs(pairs, {
      indexCandidates,
      listIds: async () => this.lazy ? this.adapter.list(this.vault, this.name) : [...this.cache.keys()],
      getRecord: async (id) => this.lazy
        ? (await this._getStoredRecord(id)) as Record<string, unknown> | null
        : ((this.cache.get(id)?.record as Record<string, unknown> | undefined) ?? null),
    })
  }
```

**Behaviour note (deliberate, document in the commit):** the old code compared the *index-less* path against `String(value)` with the same coercion — unchanged. The old non-lazy path read `e.record` from cache — preserved. The old code checked the index for THE field; the new one checks each pair in order and uses the first hit — a superset for single-pair calls.

- [ ] **Step 4: Run tests + line count + full derivations dir**

Run: `pnpm vitest run packages/hub/__tests__/derivations/` — Expected: PASS (all files; rollup + trigger-by exercise `_findMatchingIds` callers).
Run: `wc -l packages/hub/src/kernel/collection.ts` — Expected: **≤ 4309** (slack banked).
Run: `node scripts/check-architecture.mjs` — Expected: green.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/kernel/collection.ts packages/hub/src/with-formula/derivations/trigger-match.ts packages/hub/__tests__/derivations/composite-triggerby.test.ts
git commit -m "feat(hub): _findMatchingCompositeIds — conjunction fan-out, scan core in trigger-match (net-negative in collection.ts) (#1249)"
```

---

### Task 5: Dispatch — composite fan-out on the write path (new tuple only)

**Files:**
- Modify: `packages/hub/src/with-formula/derivations/dispatch.ts:188-224` (the trigger resolution and the `else if (trigger)` branch)
- Test: `packages/hub/__tests__/derivations/composite-triggerby.test.ts` (write-path integration section)

**Interfaces:**
- Consumes: `reg.triggers` (Task 3 — dispatch already iterates `strategies` = `RegisteredStrategy[]`; NOTE: `strategiesForSource` returns `{ spec, strategyHash }`-shaped entries — confirm `triggers` is on the same object and destructure it), `tupleFromWritten` (Task 1), `_findMatchingCompositeIds` (Task 4).
- Produces: multi-entry semantics — ALL entries naming the written collection fire (the old `.find()` took only the first; this is a deliberate fix, tested below).

- [ ] **Step 1: Write the failing integration tests** (append)

```ts
describe('composite triggerBy — write-path fan-out (#1249)', () => {
  async function setup() {
    const db = await createNoydb({ store: toMemory(), user: 'alice', secret: 'composite-w-2026', derivationStrategies: [billStatusStrategy()] })
    const v = await db.openVault('firm')
    const bills = v.collection<Bill>('bills')
    const disb = v.collection<Disbursement>('disbursements')
    await bills.put('b1', { id: 'b1', clientId: 'c1', cycle: 'Q1' })
    await bills.put('b2', { id: 'b2', clientId: 'c1', cycle: 'Q2' })
    await bills.put('b3', { id: 'b3', clientId: 'c2', cycle: 'Q1' })
    return { db, v, bills, disb }
  }
  it("the pilot's case: a disbursement write re-fires ONLY the matching (clientId, cycle) bills", async () => {
    const { db, bills, disb } = await setup()
    await disb.put('d1', { id: 'd1', clientId: 'c1', cycle: 'Q1', amount: 500 })
    expect((await bills.get('b1'))?.status).toBe('covered')     // matched
    expect((await bills.get('b2'))?.status).toBeUndefined()     // same client, other cycle: NOT fired
    expect((await bills.get('b3'))?.status).toBeUndefined()     // other client: NOT fired
    await db.close()
  })
  it('shared-key reverse match: single field-pair, neither side an id', async () => {
    const db = await createNoydb({
      store: toMemory(), user: 'alice', secret: 'composite-rev-2026',
      derivationStrategies: [withDerivation<Bill, { self: Bill }>({
        source: 'bills', deterministic: true, lifecycle: 'eager',
        triggerBy: [{ collection: 'clients', match: [{ from: 'entityId', to: 'entityId' }] }],
        outputs: { self: { shape: 'record', collection: 'bills', denorm: ['status'] } },
        derive: (b) => ({ self: { ...b, status: 'touched' } as Bill }),
      })],
    })
    const v = await db.openVault('firm')
    const bills = v.collection<Bill>('bills')
    await bills.put('b1', { id: 'b1', clientId: 'c1', cycle: 'Q1', entityId: 'ent-1' } as Bill)
    await bills.put('b2', { id: 'b2', clientId: 'c1', cycle: 'Q1', entityId: 'ent-2' } as Bill)
    await v.collection('clients').put('c1', { entityId: 'ent-1', services: ['pnd1'] })
    expect((await bills.get('b1'))?.status).toBe('touched')
    expect((await bills.get('b2'))?.status).toBeUndefined()
    await db.close()
  })
  it('maxFanout caps the matched set', async () => {
    const db = await createNoydb({ store: toMemory(), user: 'alice', secret: 'composite-cap-2026', derivationStrategies: [billStatusStrategy({ maxFanout: 1 })] })
    const v = await db.openVault('firm')
    const bills = v.collection<Bill>('bills')
    await bills.put('b1', { id: 'b1', clientId: 'c1', cycle: 'Q1' })
    await bills.put('b2', { id: 'b2', clientId: 'c1', cycle: 'Q1' })   // two matches, cap 1
    await expect(v.collection('disbursements').put('d1', { clientId: 'c1', cycle: 'Q1', amount: 1 }))
      .rejects.toThrow(DerivationCapExceededError)
    await db.close()
  })
  it('TWO entries naming the same collection BOTH fire (the .find() fix)', async () => {
    // one strategy with two triggers on 'events': match clientId, and match cycle.
    // A write matching only the second must still fan out.
    const db = await createNoydb({
      store: toMemory(), user: 'alice', secret: 'composite-two-2026',
      derivationStrategies: [withDerivation<Bill, { self: Bill }>({
        source: 'bills', deterministic: true, lifecycle: 'eager',
        triggerBy: [
          { collection: 'events', match: [{ from: 'clientId', to: 'clientId' }] },
          { collection: 'events', match: [{ from: 'cycle', to: 'cycle' }] },
        ],
        outputs: { self: { shape: 'record', collection: 'bills', denorm: ['status'] } },
        derive: (b) => ({ self: { ...b, status: 'poked' } as Bill }),
      })],
    })
    const v = await db.openVault('firm')
    const bills = v.collection<Bill>('bills')
    await bills.put('b1', { id: 'b1', clientId: 'cX', cycle: 'Q9' })
    await v.collection('events').put('e1', { cycle: 'Q9' })   // matches ONLY the second entry
    expect((await bills.get('b1'))?.status).toBe('poked')
    await db.close()
  })
})
```

- [ ] **Step 2: Run to verify failures**

Run: `pnpm vitest run packages/hub/__tests__/derivations/composite-triggerby.test.ts`
Expected: composite/reverse/two-entry cases FAIL (the current dispatcher only understands `t.on` and `.find()`s one entry).

- [ ] **Step 3: Implement in dispatch.ts**

Import: `import { tupleFromWritten } from './trigger-match.js'`.
At the strategies loop, destructure `triggers` too: `for (const { spec, strategyHash, triggers } of strategies)` (adjust `strategiesForSource`'s return typing if it strips fields — it returns `RegisteredStrategy[]`, so `triggers` is present after Task 3).
Replace lines 191-193 and the `else if (trigger)` branch (211-224):

```ts
    const isSource = spec.source === collectionName
    const isSibling = !isSource && (spec.sources?.includes(collectionName) ?? false)
    const triggerEntries = !isSource && !isSibling
      ? triggers.filter((t) => t.collection === collectionName)
      : []
```

```ts
    } else if (triggerEntries.length > 0) {
      const srcColl = derivationSource.getCollection(spec.source)
      const matched = new Set<string>()
      for (const trigger of triggerEntries) {
        const tuple = tupleFromWritten(trigger.match, id, incoming as Record<string, unknown>)
        if (tuple === null) continue   // a from-value is absent/non-scalar: matches nothing
        const ids = await srcColl._findMatchingCompositeIds(tuple)
        if (trigger.maxFanout !== undefined && ids.length > trigger.maxFanout) {
          throw new DerivationCapExceededError(
            `triggerBy ${collectionName}→${spec.source} [${trigger.match.map(p => p.to).join(',')}]`,
            ids.length, trigger.maxFanout)
        }
        for (const sid of ids) matched.add(sid)
      }
      for (const sid of matched) {
        const raw = await srcColl._getStoredRecord(sid)
        if (raw === null) continue
        runs.push({ input: { ...raw, id: sid }, base: raw, runId: sid, version: 0 })
      }
    }
```

- [ ] **Step 4: Run the full derivations suite**

Run: `pnpm vitest run packages/hub/__tests__/derivations/`
Expected: PASS — new cases AND every existing trigger-by/rollup/sibling test (the on-form now flows through `match: [{from:'id'}]` and must behave identically).

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/with-formula/derivations/dispatch.ts packages/hub/__tests__/derivations/composite-triggerby.test.ts
git commit -m "feat(hub): dispatch composite triggerBy fan-out; all entries per collection fire (#1249)"
```

---

### Task 6: Union fan-out on update (prior capture)

**Files:**
- Modify: `packages/hub/src/kernel/collection.ts` (`_onRecordMutated` ctx ~line 3582-3612, `dispatchDerivations` wrapper line 2328, the put path where `_onRecordMutated(..., 'local-write')` is invoked)
- Modify: `packages/hub/src/with-formula/derivations/dispatch.ts` (`dispatchDerivations` signature + trigger branch)
- Test: `packages/hub/__tests__/derivations/composite-triggerby.test.ts` (union section)

**Interfaces:**
- Consumes: `hasFieldMatchTriggerFor` (Task 3), `tupleFromWritten`/`sameTuple` (Task 1).
- Produces: `dispatchDerivations(ctx, id, record, version, wave?, prior?)` — `prior: Record<string, unknown> | null | undefined`; `undefined` = not captured (create, or no field-match trigger, or a sync-applied wave), `null` = captured-and-was-absent (create). Only `Record` triggers old-tuple fan-out.

**Timing constraint (from the spec's §2, verified):** dispatch runs AFTER the write lands in cache/store, so the prior MUST be captured in `put()` BEFORE the store write — `#priorForHook(id)` (collection.ts:1613) called post-write would return the new record. Capture site: in `put()`, next to the existing hooks-path prior read (~line 1537) — when `this.derivationSource?.registry().hasFieldMatchTriggerFor(this.name)` is true and the hooks path did NOT already read it, read `(await this.#priorForHook(id)).record`. Thread it through `_onRecordMutated`'s `ctx` as `prior` and from there into `this.dispatchDerivations(id, record, version, undefined, prior)`.

**Ceiling budget:** ≤ 6 net lines in collection.ts, spent from Task 4's bank. Fold declarations onto existing lines where clean; verify with `wc -l` + `check-architecture` at the end.

- [ ] **Step 1: Write the failing tests** (append)

```ts
describe('union fan-out on update (#1249, spec §7)', () => {
  it('a disbursement moving Q1→Q2 re-fires BOTH the old and new bill sets', async () => {
    const db = await createNoydb({ store: toMemory(), user: 'alice', secret: 'composite-u-2026', derivationStrategies: [billStatusStrategy()] })
    const v = await db.openVault('firm')
    const bills = v.collection<Bill>('bills')
    const disb = v.collection<Disbursement>('disbursements')
    await bills.put('b1', { id: 'b1', clientId: 'c1', cycle: 'Q1' })
    await bills.put('b2', { id: 'b2', clientId: 'c1', cycle: 'Q2' })
    await disb.put('d1', { id: 'd1', clientId: 'c1', cycle: 'Q1', amount: 500 })
    expect((await bills.get('b1'))?.status).toBe('covered')
    expect((await bills.get('b2'))?.status).toBeUndefined()
    // MOVE the disbursement to Q2: b1 must become uncovered (old set re-fired),
    // b2 covered (new set fired). Without the union, b1 stays 'covered' — stale.
    await disb.put('d1', { id: 'd1', clientId: 'c1', cycle: 'Q2', amount: 500 })
    expect((await bills.get('b1'))?.status).toBe('uncovered')   // ← THE union assertion
    expect((await bills.get('b2'))?.status).toBe('covered')
    await db.close()
  })
  it('create (no prior) fans out the new tuple only — no error, no double-fire', async () => {
    const db = await createNoydb({ store: toMemory(), user: 'alice', secret: 'composite-u2-2026', derivationStrategies: [billStatusStrategy()] })
    const v = await db.openVault('firm')
    await v.collection<Bill>('bills').put('b1', { id: 'b1', clientId: 'c1', cycle: 'Q1' })
    await v.collection<Disbursement>('disbursements').put('d1', { id: 'd1', clientId: 'c1', cycle: 'Q1', amount: 1 })
    expect((await v.collection<Bill>('bills').get('b1'))?.status).toBe('covered')
    await db.close()
  })
  it('maxFanout caps the UNION', async () => {
    const db = await createNoydb({ store: toMemory(), user: 'alice', secret: 'composite-u3-2026', derivationStrategies: [billStatusStrategy({ maxFanout: 1 })] })
    const v = await db.openVault('firm')
    const bills = v.collection<Bill>('bills')
    await bills.put('b1', { id: 'b1', clientId: 'c1', cycle: 'Q1' })   // old set: 1
    await bills.put('b2', { id: 'b2', clientId: 'c1', cycle: 'Q2' })   // new set: 1 → union 2 > cap 1
    const disb = v.collection<Disbursement>('disbursements')
    await disb.put('d1', { id: 'd1', clientId: 'c1', cycle: 'Q1', amount: 1 })
    await expect(disb.put('d1', { id: 'd1', clientId: 'c1', cycle: 'Q2', amount: 1 }))
      .rejects.toThrow(DerivationCapExceededError)
    await db.close()
  })
})
```

- [ ] **Step 2: Run to verify the union assertion fails**

Run: `pnpm vitest run packages/hub/__tests__/derivations/composite-triggerby.test.ts`
Expected: the Q1→Q2 test FAILS at the `'uncovered'` assertion (b1 stays `'covered'` — exactly the stale bug); the create test may already pass.

- [ ] **Step 3: Implement**

dispatch.ts — extend the signature and the trigger branch:

```ts
export async function dispatchDerivations(
  ctx: DerivationDispatchCtx, id: string, record: Record<string, unknown>,
  version: number, wave?: WaveContext, prior?: Record<string, unknown> | null,
): Promise<void> {
```

In the Task 5 branch, after computing `tuple`, add the old tuple (import `sameTuple`):

```ts
        const tuples = [tupleFromWritten(trigger.match, id, incoming as Record<string, unknown>)]
        if (prior != null && trigger.match.some((p) => p.from !== 'id')) {
          const old = tupleFromWritten(trigger.match, id, prior)
          if (!sameTuple(old, tuples[0]!)) tuples.push(old)   // ANY component changed → union (spec §7)
        }
        const ids = new Set<string>()
        for (const tuple of tuples) {
          if (tuple === null) continue
          for (const sid of await srcColl._findMatchingCompositeIds(tuple)) ids.add(sid)
        }
        if (trigger.maxFanout !== undefined && ids.size > trigger.maxFanout) {
          throw new DerivationCapExceededError(
            `triggerBy ${collectionName}→${spec.source} [${trigger.match.map(p => p.to).join(',')}]`,
            ids.size, trigger.maxFanout)
        }
        for (const sid of ids) matched.add(sid)
```

collection.ts — three thin edits:
1. `dispatchDerivations` wrapper (line 2328): add trailing `prior?: Record<string, unknown> | null` param, pass it through as the 6th argument.
2. `_onRecordMutated` ctx type gains `readonly prior?: Record<string, unknown> | null`; the `'local-write'` case passes `ctx!.prior` into `this.dispatchDerivations(id, record, version, undefined, ctx!.prior)`.
3. In `put()` where `_onRecordMutated(id, 'put', 'local-write', { record, version })` is called: just BEFORE the store write, capture

```ts
    const priorForTrigger = this.derivationSource?.registry().hasFieldMatchTriggerFor(this.name)
      ? (await this.#priorForHook(id)).record as Record<string, unknown> | null : undefined
```

and pass `prior: priorForTrigger` in the ctx. (If the hooks path already computed `prior` at ~1537, reuse that variable instead of a second read — check locally which variable is in scope.)

- [ ] **Step 4: Run + mutation-check + ceiling**

Run: `pnpm vitest run packages/hub/__tests__/derivations/` — Expected: PASS.
**Mutation-check (do not commit the mutant):** comment out the `tuples.push(old)` line, rerun `composite-triggerby.test.ts` — Expected: EXACTLY the Q1→Q2 test and the union-cap test fail, everything else green. Restore the line, rerun, green.
Run: `node scripts/check-architecture.mjs` — Expected: green (collection.ts ≤ 4318).

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/kernel/collection.ts packages/hub/src/with-formula/derivations/dispatch.ts packages/hub/__tests__/derivations/composite-triggerby.test.ts
git commit -m "feat(hub): union fan-out — an update changing any matched component re-fires old AND new sets (#1249)"
```

---

### Task 7: Delete fan-out (both forms)

**Files:**
- Modify: `packages/hub/src/with-formula/derivations/dispatch.ts` (new exported function)
- Modify: `packages/hub/src/kernel/collection.ts:2655-2663` (the `if (!internal)` delete-dispatch block) + a thin wrapper near `dispatchArrayDerivationsOnDelete` (line 2741)
- Test: `packages/hub/__tests__/derivations/composite-triggerby.test.ts` (delete section)

**Interfaces:**
- Consumes: `reg.triggers`, `tupleFromWritten`, `_findMatchingCompositeIds`, and the existing eager/lazy run plumbing in dispatch.ts.
- Produces: `dispatchTriggerDerivationsOnDelete(ctx: DerivationDispatchCtx, id: string, deleted: Record<string, unknown>): Promise<void>` — fires every strategy whose triggers name the deleted record's collection, using the TOMBSTONED record's values (`from: 'id'` → the deleted id).

**Guardrail from spec §8:** the comment at collection.ts:2651 ("record-shape derivations intentionally NOT dispatched on delete") is about deleting a SOURCE record. This task fires on deleting a TRIGGER PARENT — a different event. Do not modify that comment's behaviour; add one sentence to it distinguishing the two.

- [ ] **Step 1: Write the failing tests** (append)

```ts
describe('delete fan-out — both forms (#1249, spec §8)', () => {
  it('deleting a disbursement re-fires the matched bills (field-match form)', async () => {
    const db = await createNoydb({ store: toMemory(), user: 'alice', secret: 'composite-d-2026', derivationStrategies: [billStatusStrategy()] })
    const v = await db.openVault('firm')
    const bills = v.collection<Bill>('bills')
    const disb = v.collection<Disbursement>('disbursements')
    await bills.put('b1', { id: 'b1', clientId: 'c1', cycle: 'Q1' })
    await disb.put('d1', { id: 'd1', clientId: 'c1', cycle: 'Q1', amount: 500 })
    expect((await bills.get('b1'))?.status).toBe('covered')
    await disb.delete('d1')
    expect((await bills.get('b1'))?.status).toBe('uncovered')   // pre-#1249: stayed 'covered', silently stale
    await db.close()
  })
  it('deleting a buyer re-fires their sales (the PRE-EXISTING id-form gap, now closed)', async () => {
    // Reuse the buyerName denorm shape from trigger-by.test.ts: derive falls
    // back to null when the buyer is gone.
    interface Buyer2 extends Record<string, unknown> { id: string; companyName: string }
    interface Sale2 extends Record<string, unknown> { id: string; buyerId: string; buyerName?: string | null }
    const db = await createNoydb({
      store: toMemory(), user: 'alice', secret: 'composite-d2-2026',
      derivationStrategies: [withDerivation<Sale2, { self: Sale2 }>({
        source: 'sales', deterministic: true, lifecycle: 'eager',
        triggerBy: [{ collection: 'buyers', on: 'buyerId' }],
        outputs: { self: { shape: 'record', collection: 'sales', denorm: ['buyerName'] } },
        derive: async (sale, ctx) => {
          const b = await ctx.vault.collection<Buyer2>('buyers').get(sale.buyerId)
          return { self: { ...sale, buyerName: b?.companyName ?? null } as Sale2 }
        },
      })],
    })
    const v = await db.openVault('firm')
    const sales = v.collection<Sale2>('sales')
    await v.collection<Buyer2>('buyers').put('u1', { id: 'u1', companyName: 'ACME' })
    await sales.put('s1', { id: 's1', buyerId: 'u1' })
    await v.collection('buyers').put('u1', { id: 'u1', companyName: 'ACME Ltd' })
    expect((await sales.get('s1'))?.buyerName).toBe('ACME Ltd')
    await v.collection('buyers').delete('u1')
    expect((await sales.get('s1'))?.buyerName).toBeNull()       // re-derived against the absent parent
    await db.close()
  })
})
```

- [ ] **Step 2: Run to verify failures**

Run: `pnpm vitest run packages/hub/__tests__/derivations/composite-triggerby.test.ts`
Expected: both delete tests FAIL (statuses unchanged — deletes fire nothing today).

- [ ] **Step 3: Implement**

dispatch.ts — the delete entry reuses the write path: after Task 6, extract the per-strategy trigger fan-out + run/execute/markStale block into a shared internal helper if that is cleaner, or simplest: implement `dispatchTriggerDerivationsOnDelete` as a thin call into `dispatchDerivations` with a synthetic shape — NO. Deletes must not run source/sibling/rollup branches. Implement directly:

```ts
/**
 * Trigger fan-out for a DELETED parent record (#1249, spec §8). Distinct from
 * the "record-shape derivations not dispatched on delete" rule — that is
 * about deleting a SOURCE record; this fires when a TRIGGER collection's
 * record is deleted, re-deriving source records that still exist. Pairs
 * evaluate against the tombstoned record's values; matched sources re-derive
 * through the normal executor (their derive() reads the now-absent parent
 * and decides what that means — the engine never cascades deletes).
 */
export async function dispatchTriggerDerivationsOnDelete(
  ctx: DerivationDispatchCtx, id: string, deleted: Record<string, unknown>,
): Promise<void> {
  const { derivationSource, collectionName } = ctx
  const registry = derivationSource.registry()
  const strategies = registry.strategiesForSource(collectionName)
  if (strategies.length === 0) return
  let executorClass: typeof DerivationExecutor | null = null
  for (const { spec, strategyHash, triggers } of strategies) {
    if (spec.rollup) continue                                    // rollup-on-delete already exists
    if (spec.source === collectionName) continue                 // source delete: existing rule, untouched
    const entries = triggers.filter((t) => t.collection === collectionName)
    if (entries.length === 0) continue
    const mode = typeof spec.lifecycle === 'string' ? spec.lifecycle : spec.lifecycle.mode
    const srcColl = derivationSource.getCollection(spec.source)
    const matched = new Set<string>()
    for (const trigger of entries) {
      const tuple = tupleFromWritten(trigger.match, id, deleted)
      if (tuple === null) continue
      const ids = await srcColl._findMatchingCompositeIds(tuple)
      if (trigger.maxFanout !== undefined && ids.length > trigger.maxFanout) {
        throw new DerivationCapExceededError(
          `triggerBy ${collectionName}→${spec.source} [${trigger.match.map(p => p.to).join(',')}] (delete)`,
          ids.length, trigger.maxFanout)
      }
      for (const sid of ids) matched.add(sid)
    }
    if (matched.size === 0) continue
    if (mode !== 'eager') { for (const sid of matched) await markStale(registry, spec, sid); continue }
    if (executorClass === null) ({ DerivationExecutor: executorClass } = await import('./executor.js'))
    for (const sid of matched) {
      const raw = await srcColl._getStoredRecord(sid)
      if (raw === null) continue
      // [run the executor + write outputs EXACTLY as the write path does for a
      //  trigger run — copy the loop body from dispatchDerivations' `for (const
      //  run of runs)` block, with input {...raw, id: sid}, version 0. If the
      //  copy exceeds ~20 lines, extract a shared `runOne(...)` helper inside
      //  dispatch.ts and use it from BOTH paths — same file, no ceiling.]
    }
  }
}
```

(The bracketed note is an instruction to extract, not a placeholder: the executor-run block already exists verbatim in this file at the end of `dispatchDerivations`; sharing it is required, not optional, if copying exceeds ~20 lines. Check `markStale`'s actual signature in `stale.ts` before use — the write path calls it as `markStale(registry, spec, run.runId)`.)

collection.ts — wrapper + call, spending banked slack:

```ts
  /** @internal — trigger fan-out for a deleted parent (#1249); see dispatch.ts. */
  async dispatchTriggerDerivationsOnDelete(id: string, deleted: T): Promise<void> {
    if (this.derivationSource === undefined) return
    const { dispatchTriggerDerivationsOnDelete } = await import('../with-formula/derivations/dispatch.js')
    return dispatchTriggerDerivationsOnDelete({
      ...this.#derivationDeleteCtx(this.derivationSource),
      via: this.via,
      recomputeRollup: (spec, parentId, source, w) => this.recomputeRollup(spec, parentId, source, w),
      dispatchCtx: (source) => this.#dispatchCtx(source),
      trackPut: (txCtx, collectionName, rid, prior) => this.#trackPut(txCtx, collectionName, rid, prior),
    }, id, deleted as unknown as Record<string, unknown>)
  }
```

and in the `if (!internal)` block at 2655, extend the existing `existing` guard:

```ts
      if (existing) {
        await this.dispatchRollupsOnDelete(id, existing.record)
        await this.dispatchTriggerDerivationsOnDelete(id, existing.record)
      }
```

Also append one sentence to the comment at 2651: `// (Deleting a TRIGGER parent is a different event and DOES fan out — see dispatchTriggerDerivationsOnDelete, #1249.)`

- [ ] **Step 4: Run + ceiling**

Run: `pnpm vitest run packages/hub/__tests__/derivations/` — Expected: PASS all.
Run: `node scripts/check-architecture.mjs` — Expected: green.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/kernel/collection.ts packages/hub/src/with-formula/derivations/dispatch.ts packages/hub/__tests__/derivations/composite-triggerby.test.ts
git commit -m "feat(hub): parent-delete fan-out for triggerBy, both forms — closes the pre-existing id-form gap too (#1249)"
```

---

### Task 8: Typo guard wiring at collection construction

**Files:**
- Modify: `packages/hub/src/kernel/vault.ts` (inside `collection()`, line 666 — the derivation wiring block around lines 821-825)
- Test: `packages/hub/__tests__/derivations/composite-triggerby.test.ts` (guard section)

**Interfaces:**
- Consumes: `registry.validateFieldsFor` (Task 3), `schemaFieldKeys` from `'../with-shape/introspection/describe.js'` (shipped in #1253).
- Produces: fail-loud at `vault.collection(name, cfg)` when a match field is provably wrong; silent for unenumerable field sets.

**Ceiling budget:** vault.ts has exactly 1 line of slack (3741/3742). The keys computation lives in the REGISTRY (no ceiling): pass raw inputs, let `validateFieldsFor` do the work — vault.ts adds ONE folded line. If the import line would exceed the ceiling, extend an existing import from the same module instead of adding a new statement; if still over, fold two short adjacent lines in the wiring block (shrink-first, note it in the commit).

- [ ] **Step 1: Write the failing tests** (append)

```ts
describe('match-field typo guard at collection construction (#1249, spec §5)', () => {
  const typoStrategy = () => withDerivation<Bill, { self: Bill }>({
    source: 'bills', deterministic: true, lifecycle: 'eager',
    triggerBy: [{ collection: 'disbursements', match: [{ from: 'clientId', to: 'clientIdd' }] }], // typo'd to
    outputs: { self: { shape: 'record', collection: 'bills', denorm: ['status'] } },
    derive: (b) => ({ self: b }),
  })
  it('throws at vault.collection() when the source has an enumerable schema missing the field', async () => {
    const { z } = await import('zod')
    const db = await createNoydb({ store: toMemory(), user: 'alice', secret: 'composite-g-2026', derivationStrategies: [typoStrategy()] })
    const v = await db.openVault('firm')
    expect(() => v.collection('bills', { schema: z.object({ id: z.string(), clientId: z.string(), cycle: z.string() }) }))
      .toThrow(ValidationError)
    await db.close()
  })
  it('SILENT for a TS-generic collection (unenumerable) — the #1253 posture', async () => {
    const db = await createNoydb({ store: toMemory(), user: 'alice', secret: 'composite-g2-2026', derivationStrategies: [typoStrategy()] })
    const v = await db.openVault('firm')
    expect(() => v.collection<Bill>('bills')).not.toThrow()   // no schema: fields unenumerable
    await db.close()
  })
  it('denorm-owned fields do not false-positive', async () => {
    const { z } = await import('zod')
    // billStatusStrategy writes denorm ['status']; schema omits it — must not throw.
    const db = await createNoydb({ store: toMemory(), user: 'alice', secret: 'composite-g3-2026', derivationStrategies: [billStatusStrategy()] })
    const v = await db.openVault('firm')
    expect(() => v.collection('bills', { schema: z.object({ id: z.string(), clientId: z.string(), cycle: z.string() }) }))
      .not.toThrow()
    await db.close()
  })
  it('throws for a typo on the TRIGGER side when that collection is schema-d', async () => {
    const { z } = await import('zod')
    const db = await createNoydb({
      store: toMemory(), user: 'alice', secret: 'composite-g4-2026',
      derivationStrategies: [withDerivation<Bill, { self: Bill }>({
        source: 'bills', deterministic: true, lifecycle: 'eager',
        triggerBy: [{ collection: 'disbursements', match: [{ from: 'clientIdd', to: 'clientId' }] }],  // typo'd from
        outputs: { self: { shape: 'record', collection: 'bills', denorm: ['status'] } },
        derive: (b) => ({ self: b }),
      })],
    })
    const v = await db.openVault('firm')
    expect(() => v.collection('disbursements', { schema: z.object({ id: z.string(), clientId: z.string(), cycle: z.string(), amount: z.number() }) }))
      .toThrow(ValidationError)
    await db.close()
  })
})
```

- [ ] **Step 2: Run to verify failures**

Run: `pnpm vitest run packages/hub/__tests__/derivations/composite-triggerby.test.ts`
Expected: the two `toThrow(ValidationError)` cases FAIL (nothing validates yet); the silent/denorm controls already pass — note they only MEAN something once the throw cases go green.

- [ ] **Step 3: Implement**

Move the keys computation into `validateFieldsFor` — change its signature (Task 3's tests update accordingly — keep them, adapt the call):

```ts
  validateFieldsFor(collectionName: string, schema: unknown, configKeys: ReadonlyArray<string>): void {
    const shapeKeys = schemaFieldKeys(schema)          // import from '../../with-shape/introspection/describe.js'
    if (shapeKeys === undefined) return                 // unenumerable — deliberately silent (#1253 posture)
    const keys = new Set([...shapeKeys, ...configKeys])
    const denormExempt = new Set<string>()
    for (const reg of new Set([...this._bySource.values()].flat())) {
      if (reg.spec.source !== collectionName) continue
      for (const out of Object.values(reg.spec.outputs) as Array<{ collection?: string; denorm?: readonly string[] }>) {
        if (out.collection === collectionName) for (const d of out.denorm ?? []) denormExempt.add(d)
      }
    }
    // [then the two loops from Task 3, using keys/denormExempt]
  }
```

vault.ts — in `collection()`'s derivation wiring block (~821), ONE folded line after the Collection is constructed (the registry variable in scope there is whatever `registry.register` used at 2416 — resolve locally; `cfg` is the collection options param):

```ts
    this.<derivationRegistryField>?.validateFieldsFor(name, cfg?.schema, Object.keys({ ...cfg?.fieldMeta, ...cfg?.moneyFields, ...cfg?.dictKeyFields, ...cfg?.refs, ...cfg?.computed }))
```

(`<derivationRegistryField>` — find the actual private field holding the derivation registry near vault.ts:2416 and use its real name. `cfg`'s real parameter name is in the `collection()` signature at line 666.)

- [ ] **Step 4: Run + ceiling + Task-3 test adaptation**

Update Task 3's `validateFieldsFor` unit tests to the new `(name, schema, configKeys)` signature — assert through a zod schema instead of a hand-built Set, keeping the same throw/silent cases.
Run: `pnpm vitest run packages/hub/__tests__/derivations/` — Expected: PASS.
Run: `node scripts/check-architecture.mjs` — Expected: green (vault.ts ≤ 3742).

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/kernel/vault.ts packages/hub/src/with-formula/derivations/registry.ts packages/hub/__tests__/derivations/composite-triggerby.test.ts
git commit -m "feat(hub): match-field typo guard at collection construction — fail-loud when enumerable, silent otherwise (#1249)"
```

---

### Task 9: Remaining spec-§11 coverage — lazy, cycle, index, sugar-equivalence

**Files:**
- Test: `packages/hub/__tests__/derivations/composite-triggerby.test.ts` (final sections; no production code expected — any failure here is a bug in Tasks 1-8, fix it there)

- [ ] **Step 1: Write the tests**

```ts
describe('remaining spec §11 rows (#1249)', () => {
  it('on-form and its normalized match-form produce identical fan-out', async () => {
    // Same buyers/sales fixture twice: once triggerBy [{collection:'buyers',on:'buyerId'}],
    // once [{collection:'buyers',match:[{from:'id',to:'buyerId'}]}]. Drive the same
    // writes; assert equal final buyerName values on all sales.
  })
  it('lazy lifecycle marks the SAME set stale as eager fires', async () => {
    // billStatusStrategy with lifecycle:'lazy'; write d1 (c1,Q1); then assert via
    // the stale surface the existing lazy.test.ts uses (copy its read pattern)
    // that exactly {b1} is stale — not b2/b3.
  })
  it('cycle detection fires through a match entry', async () => {
    // A strategy whose OUTPUT collection is also a match-trigger collection of
    // another strategy pointing back — expect the same cycle error class
    // cycle.test.ts asserts. Copy its fixture shape, swapping on→match.
  })
  it('scalar coercion: number written value matches string source value', async () => {
    // bill { cycle: '2026' } (string), disbursement { cycle: 2026 } (number) → fires.
  })
})
```

Fill each body by copying the read/assert patterns from `lazy.test.ts` and `cycle.test.ts` — the fixtures above name what to assert; those files show how their surfaces are read. This instruction is to TRANSLATE existing test idioms, not to invent assertions.

- [ ] **Step 2: Run — expect PASS; investigate any failure as a Task 1-8 bug**

Run: `pnpm vitest run packages/hub/__tests__/derivations/`

- [ ] **Step 3: Full hub suite + gates**

Run: `pnpm --filter @noy-db/hub build && pnpm vitest run` (from `packages/hub`) — Expected: all green.
Run: `node scripts/check-architecture.mjs && node scripts/check-prose-examples.mjs && node scripts/check-prose-api.mjs` — Expected: green.

- [ ] **Step 4: Commit**

```bash
git add packages/hub/__tests__/derivations/composite-triggerby.test.ts
git commit -m "test(hub): composite triggerBy — sugar equivalence, lazy parity, cycle, coercion (#1249)"
```

---

### Task 10: Docs, changeset, follow-up issue, PR

**Files:**
- Modify: `SERVICES.md:90` (the `derivations` row — extend the description with the three trigger shapes)
- Create: `.changeset/composite-triggerby.md`
- Test: gates only

- [ ] **Step 1: SERVICES.md row** — extend row 18's description (keep everything, append):
`… triggerBy fans a parent write out to matching source records: single-FK (on), shared-key or composite multi-field (match, #1249) — with old∪new union on updates and delete fan-out.`

- [ ] **Step 2: Changeset**

```md
---
'@noy-db/hub': minor
---

`withDerivation`'s `triggerBy` accepts a multi-field `match` form (#1249):
`{ collection, match: [{ from, to }] }` fans a write out to every source
record where ALL pairs satisfy `String(source[to]) === String(written[from])`.
`from: 'id'` reads the written record's id, making the existing `on` form the
single-pair special case (it is unchanged and stays supported). This makes
shared-key ("reverse") relationships and composite keys like
`(clientId, cycle)` expressible without denormalising a synthetic key.

Also, for BOTH forms:

- an UPDATE that changes any matched field fans out on old-match ∪ new-match,
  so records addressed by the previous value no longer go silently stale;
- a parent DELETE now fans out using the tombstoned record's values —
  previously deletes fired no triggers at all, leaving matched sources stale;
- match fields are validated against the collections' enumerable field sets at
  `vault.collection()` (the #1253 pattern): a provable typo throws instead of
  silently matching nothing forever; TS-generic collections stay unguarded by
  design.

`maxFanout` caps the unioned matched set per written event.
```

- [ ] **Step 3: File the follow-up issue** (spec §10's rejected-but-real adjacent gap)

```bash
gh issue create --title "rollup: a child whose key field changes strands the OLD parent's aggregate" --body "Found during #1249 (spec §10): \`dispatchDerivations\`'s rollup branch reads \`incoming[spec.rollup.key]\` and recomputes only the NEW parent. A child moving from parent A to parent B leaves A's aggregate stale — the same old-value class #1249 fixed for triggerBy with union fan-out (prior-record capture now exists in the put path and can be reused). Not fixed there to keep the surfaces separate." --label bug
```

- [ ] **Step 4: Full verification + PR**

Run: `pnpm build && pnpm vitest run` (hub), `pnpm lint`, `pnpm typecheck`, all three check scripts.
Push the branch, open the PR referencing #1249 and the spec path, wait for CI, merge on green per repo convention (no publish — the changeset rides the next cut).

- [ ] **Step 5: Comment on #1249** — what shipped, the three shapes, the union/delete semantics, the guard posture, and that it lands in the next pre-release.

---

## Self-review record

- **Spec coverage:** §4→Task 2; §5→Tasks 1,3,8; §6→Task 4; §7→Task 6; §8→Task 7; §9→Tasks 5-7 (cap on union); §10 follow-up→Task 10; §11 rows→Tasks 2,4,5,6,7,9; §12→Tasks 2 (JSDoc), 10; §13 ceilings→Tasks 4 (bank), 6-8 (spend).
- **Type consistency:** `NormalizedTrigger`/`tupleFromWritten`/`sameTuple`/`recordMatchesPairs` (Task 1) used with the same signatures in 3,5,6,7; `validateFieldsFor` changes signature ONCE, in Task 8, with the Task 3 test adaptation called out there.
- **Known deviation from spec:** §7 said "lazy thunk"; the implementation captures the prior conditionally PRE-write (gated on `hasFieldMatchTriggerFor`) because dispatch runs post-write and a thunk resolved then would read the NEW record. Same cost profile, recorded here.
