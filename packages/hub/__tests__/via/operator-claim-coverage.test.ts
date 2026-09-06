/**
 * #1402 — a Via binding that claims only SOME operators lets the sorted
 * index answer the rest.
 *
 * ## The mechanism, in one paragraph
 *
 * `candidateRecords()` (`kernel/query/builder.ts`) reads an UNSET
 * `clause.via` as *"a secondary index may serve this clause"*, and it
 * probes that index with the RAW operand. The index's buckets are keyed by
 * `ViaPipeline.canonicalizeIndexKey` — a hook a binding may implement to
 * rewrite the stored value into some other key space (geo: a geohash
 * string derived from `{ lat, lng }`; money: a canonical scaled-int
 * string). The fallback scan, meanwhile, compares the operand against the
 * RAW STORED VALUE. So for any operator a key-rewriting binding leaves
 * unclaimed, the index answers in key space and the scan answers in value
 * space, and the two disagree — silently, and only where an index happens
 * to exist. Measured on the geo work before PR #1400 fixed it:
 * `where('at','startsWith','gc')` returned 41 rows from the index against 0
 * from the scan.
 *
 * ## The invariant this file pins, and why it is NOT "unset fails closed"
 *
 * ⛔ Do NOT read this as *"an unset `clause.via` must never take the
 * index"*. For an ordinary field with no Via descriptor at all, unset is
 * CORRECT and the index must serve it — that is the whole secondary-index
 * fast path. It is equally correct for a Via-covered field whose binding
 * does NOT rewrite the index key (i18n, lookup, computed, blob,
 * classified): index key and stored value live in the same space, so the
 * two paths agree by construction and giving those fields the index costs
 * nothing and breaks nothing.
 *
 * The invariant is narrower and exact:
 *
 *   **A binding that implements `canonicalizeIndexKey` MUST claim every
 *   operator** — `buildClause` must return a payload (or refuse by
 *   throwing) for every member of the `Operator` union on a field it
 *   covers. Never `undefined`.
 *
 * Claiming with no `indexProbe` is what routes the clause to the scan;
 * `evaluateOperator` (split out of `evaluateFieldClause` for exactly this)
 * is where a binding delegates the operators it does not specialise.
 *
 * ## Three properties, and they are not interchangeable
 *
 *  1. **Completeness of the audit.** Every directory under `src/via/` is in
 *     the table below or on the stated exclusion list. A new Via feature
 *     that does not decide this question fails here — the convention alone
 *     already failed once, on the first binding written after it.
 *  2. **The measured audit.** What each shipped binding actually does,
 *     measured rather than asserted. Pinned so a change is deliberate.
 *  3. **The implication** — measured `rewritesIndexKey` ⇒ measured
 *     `claimsEveryOperator` — asserted over the MEASUREMENTS, not over the
 *     table, so editing the table cannot make a real regression pass.
 *
 * Index-vs-scan equivalence itself — the property the bug violated — is
 * end-to-end in `via/index-scan-equivalence.test.ts`. This file is the
 * cheap structural guard that says which bindings that property must hold
 * for; that file is the one that proves it does.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { NoydbVia } from '../../src/kernel/via/index.js'
import type { Operator } from '../../src/kernel/query/predicate.js'
import { moneyVia } from '../../src/via/money/binding.js'
import { money } from '../../src/via/money/descriptor.js'
import { geoVia } from '../../src/via/geo/binding.js'
import { geo } from '../../src/via/geo/descriptor.js'
import { i18nVia } from '../../src/via/i18n/binding.js'
import { i18nText } from '../../src/via/i18n/core.js'
import { lookupVia } from '../../src/via/lookup/binding.js'
import { enumOf } from '../../src/via/lookup/descriptor.js'
import { computedVia } from '../../src/via/computed/binding.js'
import { blobVia } from '../../src/via/blob/binding.js'
import { classifiedVia } from '../../src/via/classified/binding.js'
import { classified } from '../../src/via/classified/presets.js'
import type { ClassifiedGuardCtx } from '../../src/via/classified/guards.js'
import type { I18nStrategy } from '../../src/port/with/i18n-strategy.js'
import type { ComputedDescriptor } from '../../src/port/with/computed-strategy.js'
// #1458 — the query DSL ships in four groups; these side-effect imports
// attach the extension methods this file exercises. A consumer on the root
// barrel needs none of them (it imports all three); this file builds its
// Query from `kernel/query` directly, so it takes what it uses.
import '../../src/kernel/query/relate/index.js'

/**
 * The whole `Operator` union, as VALUES. `satisfies` is the mechanical
 * half: adding a member to the union without adding it here is a
 * TYPECHECK failure, not a silently narrower sweep.
 */
const OPERATOR_TABLE = {
  '==': true, '!=': true, '<': true, '<=': true, '>': true, '>=': true,
  in: true, '!in': true, contains: true, startsWith: true, between: true,
  matches: true, near: true,
} satisfies Record<Operator, true>

const OPERATORS = Object.keys(OPERATOR_TABLE) as readonly Operator[]

/** A structurally plausible operand for each operator — enough to reach a binding's dispatch. */
function operand(op: Operator): unknown {
  if (op === 'in' || op === '!in') return [1, 2]
  if (op === 'between') return [1, 2]
  if (op === 'near') return { lat: 0, lng: 0, radiusKm: 1 }
  if (op === 'contains' || op === 'startsWith' || op === 'matches') return 'x'
  return 1
}

function stubI18nStrategy(): I18nStrategy {
  return {
    applyI18nLocale: (record) => record,
    validateI18nTextValue() {},
    enforceScript: (value) => ({ value, warnings: [] }),
    computeExemptFills: () => new Map(),
    densify() {},
    buildDictionaryHandle() { throw new Error('not used') },
  }
}

function classifiedGuardCtx(): ClassifiedGuardCtx {
  return {
    perRecordKeys: true,
    crdt: false,
    hasConflictPolicy: false,
    storeCiphertext: true,
    deterministicFields: null,
    indexedFields: new Set(),
    textIndexFields: new Set(),
    vectorSourceFields: new Set(),
    subjectKeyField: undefined,
    bareSensitiveFields: new Set(),
    acknowledgeEquatableRisk: false,
  }
}

/** One binding under audit, plus a field it demonstrably covers. */
interface Subject { readonly binding: NoydbVia; readonly field: string }

const virtual: ComputedDescriptor = { _viaBrand: 'computed', fn: () => 1, deps: [], mode: 'virtual' } as unknown as ComputedDescriptor

/**
 * Every `src/via/**` binding, constructed with a minimal real config.
 * Keyed by DIRECTORY name — that is what property 1 compares against.
 */
const SUBJECTS: Record<string, Subject> = {
  blob: { binding: blobVia({ fields: { receipt: {} }, collectionName: 'c' }), field: 'receipt' },
  classified: {
    binding: classifiedVia({ entries: { secret: classified.password() }, collectionName: 'c', guardCtx: classifiedGuardCtx() }),
    field: 'secret',
  },
  computed: { binding: computedVia({ virtualFields: new Map([['total', virtual]]) }), field: 'total' },
  geo: { binding: geoVia({ at: geo() }), field: 'at' },
  i18n: {
    binding: i18nVia({ i18nFields: { title: i18nText({ languages: ['en'], required: 'all' }) }, strategy: stubI18nStrategy(), collectionName: 'c' }),
    field: 'title',
  },
  lookup: { binding: lookupVia({ lookupFields: { status: enumOf(['draft', 'paid']) }, collectionName: 'c' }), field: 'status' },
  money: { binding: moneyVia({ total: money({ currency: 'EUR' }) }), field: 'total' },
}

/**
 * A `src/via/` directory holding no `NoydbVia` at all belongs here, with
 * the reason. Empty today — all seven ship a binding.
 */
const EXCLUDED_DIRECTORIES: Record<string, string> = {}

/** Does this binding rewrite the key an eager/lazy index buckets under? */
function rewritesIndexKey(s: Subject): boolean {
  return s.binding.canonicalizeIndexKey !== undefined
}

/**
 * Does `buildClause` account for EVERY operator on a covered field?
 * A throw counts: refusing an operator at the `where()` call site is a
 * decision, and it never leaves `clause.via` unset. Returning `undefined`
 * is the unsafe answer — that is the one that hands the clause to the raw
 * index.
 */
function unclaimedOperators(s: Subject): Operator[] {
  const build = s.binding.buildClause
  if (!build) return [...OPERATORS]
  const missing: Operator[] = []
  for (const op of OPERATORS) {
    let claimed: boolean
    try {
      claimed = build.call(s.binding, s.field, op, operand(op)) !== undefined
    } catch {
      claimed = true // an explicit refusal at build time
    }
    if (!claimed) missing.push(op)
  }
  return missing
}

describe('#1402 > property 1: the audit covers every Via binding', () => {
  it('every directory under src/via is audited below or explicitly excluded', () => {
    const dir = fileURLToPath(new URL('../../src/via', import.meta.url))
    const found = readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name)
      .sort()
    const accounted = [...Object.keys(SUBJECTS), ...Object.keys(EXCLUDED_DIRECTORIES)].sort()
    expect(
      found,
      `src/via holds a directory this audit does not account for. A new Via binding has to ` +
      `decide the #1402 question BEFORE it ships: does it implement canonicalizeIndexKey — i.e. ` +
      `does the key the secondary index buckets under differ from the raw stored value? If it ` +
      `does, its buildClause must account for EVERY operator, or the index and the scan will ` +
      `answer the same query differently with no error. Add it to SUBJECTS (with a field it ` +
      `covers) so properties 2 and 3 measure it, or to EXCLUDED_DIRECTORIES with the reason it ` +
      `holds no NoydbVia. The convention alone already failed once — on the first binding ` +
      `written after it was established.`,
    ).toEqual(accounted)
  })

  it('every audited binding really covers the field it is audited on', () => {
    for (const [name, s] of Object.entries(SUBJECTS)) {
      expect(s.binding.covers?.(s.field), `${name}.covers("${s.field}")`).toBe(true)
    }
  })
})

describe('#1402 > property 2: the measured per-binding audit', () => {
  /**
   * Measured on 2026-09-04, not asserted from the source. `money` claims
   * everything by THROWING `MoneyUnsupportedError` on the string operators
   * (scaled space has no `contains`); `geo` claims everything by
   * delegating the non-`near` operators to `evaluateOperator` (PR #1400).
   * The other five implement no `buildClause` at all — which is safe
   * precisely because none of them rewrites the index key.
   */
  it('matches the recorded table', () => {
    const measured = Object.fromEntries(
      Object.entries(SUBJECTS).map(([name, s]) => [
        name,
        { rewritesIndexKey: rewritesIndexKey(s), claimsEveryOperator: unclaimedOperators(s).length === 0 },
      ]),
    )
    expect(measured).toEqual({
      blob: { rewritesIndexKey: false, claimsEveryOperator: false },
      classified: { rewritesIndexKey: false, claimsEveryOperator: false },
      computed: { rewritesIndexKey: false, claimsEveryOperator: false },
      geo: { rewritesIndexKey: true, claimsEveryOperator: true },
      i18n: { rewritesIndexKey: false, claimsEveryOperator: false },
      lookup: { rewritesIndexKey: false, claimsEveryOperator: false },
      money: { rewritesIndexKey: true, claimsEveryOperator: true },
    })
  })
})

describe('#1402 > property 3: key-rewriting implies a full operator claim', () => {
  for (const [name, s] of Object.entries(SUBJECTS)) {
    it(`${name}`, () => {
      if (!rewritesIndexKey(s)) return // no key rewrite, no divergence to prevent
      const missing = unclaimedOperators(s)
      expect(
        missing,
        `via/${name} implements canonicalizeIndexKey — it rewrites the key the secondary ` +
        `index buckets under — but its buildClause returns undefined for ${missing.join(', ')} ` +
        `on the covered field "${s.field}". An unclaimed operator leaves clause.via unset, which ` +
        `candidateRecords() reads as "the index may serve this clause": the index would answer ` +
        `in canonicalized-key space while the scan answers over the raw stored value, and the two ` +
        `would return different rows for the same query with no error (#1402; measured at 41 rows ` +
        `vs 0 for geo's startsWith before PR #1400). Fix it in buildClause: claim the operator and ` +
        `delegate it to evaluateOperator (kernel/query/predicate.ts), as via/geo/where.ts does, or ` +
        `throw to refuse it at the where() call site, as via/money/where.ts does. Do NOT add it to ` +
        `an exclusion list without a soundness argument for why the index and the scan agree on it.`,
      ).toEqual([])
    })
  }
})
