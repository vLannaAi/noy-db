/**
 * Type-level tests for isDiscriminant() — validated by
 * `pnpm --filter @noy-db/hub run typecheck` (tsc -p tsconfig.typetest.json).
 *
 * These assertions prove that the type-guard actually narrows the union member
 * type so that member-specific fields are accessible without any cast.
 */
import { describe, it, expectTypeOf } from 'vitest'
import { isDiscriminant } from '../src/kernel/util/discriminant.js'

// ─── Fixture ─────────────────────────────────────────────────────────────────

type IV = { kind: 'IV'; invoiceNo: string; amount: number }
type RE = { kind: 'RE'; receiptNo: string; paidAt: string }
type DP = { kind: 'DP'; depositRef: string }
type RD = { kind: 'RD'; refundOf: string }
type Receipt = IV | RE | DP | RD

const receipts: Receipt[] = [
  { kind: 'IV', invoiceNo: 'INV-001', amount: 1200 },
  { kind: 'RE', receiptNo: 'RCP-001', paidAt: '2026-01-01' },
  { kind: 'DP', depositRef: 'DEP-001' },
  { kind: 'RD', refundOf: 'INV-001' },
]

describe('isDiscriminant() — type narrowing', () => {
  it('filter result is narrowed to the matched member type (IV[])', () => {
    const ivs = receipts.filter(r => isDiscriminant(r, 'kind', 'IV'))
    expectTypeOf(ivs).toEqualTypeOf<IV[]>()
  })

  it('element type of filtered array is exactly IV', () => {
    const ivs = receipts.filter(r => isDiscriminant(r, 'kind', 'IV'))
    type Elem = (typeof ivs)[number]
    expectTypeOf<Elem>().toEqualTypeOf<IV>()
  })

  it('narrowed element gives access to member-specific fields without cast', () => {
    const ivs = receipts.filter(r => isDiscriminant(r, 'kind', 'IV'))
    // noUncheckedIndexedAccess: use the known-present element via non-null assertion
    const first = ivs[0]!
    // Direct field assignment: if this compiled without `as`, narrowing works
    const no: string = first.invoiceNo
    const amt: number = first.amount
    void no
    void amt
  })

  it('accessing a field from a *different* member on the narrowed type is a type error', () => {
    const ivs = receipts.filter(r => isDiscriminant(r, 'kind', 'IV'))
    const first = ivs[0]!
    // receiptNo only exists on RE, not IV — this must be a compile error
    // @ts-expect-error Property 'receiptNo' does not exist on type 'IV'
    void first.receiptNo
  })

  it('if-branch narrows to IV and member fields are accessible', () => {
    const r = receipts[0]!
    if (isDiscriminant(r, 'kind', 'IV')) {
      // r must be IV here — direct field access without cast
      const no: string = r.invoiceNo
      const amt: number = r.amount
      void no; void amt
      // @ts-expect-error Property 'receiptNo' does not exist on type 'IV'
      void r.receiptNo
    }
  })

  it('if-branch for RE narrows to RE', () => {
    const r = receipts[0]!
    if (isDiscriminant(r, 'kind', 'RE')) {
      const paid: string = r.paidAt
      void paid
      // @ts-expect-error Property 'invoiceNo' does not exist on type 'RE'
      void r.invoiceNo
    }
  })

  it('works with non-"kind" discriminant key', () => {
    type DocA = { type: 'A'; aField: string }
    type DocB = { type: 'B'; bField: number }
    type Doc = DocA | DocB

    const docs: Doc[] = [
      { type: 'A', aField: 'hello' },
      { type: 'B', bField: 42 },
    ]

    const aOnly = docs.filter(d => isDiscriminant(d, 'type', 'A'))
    expectTypeOf(aOnly).toEqualTypeOf<DocA[]>()
    const first = aOnly[0]!
    const val: string = first.aField
    void val
    // @ts-expect-error bField does not exist on DocA
    void first.bField
  })

  it('if-branch with non-"kind" key narrows correctly', () => {
    type DocA = { type: 'A'; aField: string }
    type DocB = { type: 'B'; bField: number }
    type Doc = DocA | DocB

    const d: Doc = { type: 'A', aField: 'hello' }
    if (isDiscriminant(d, 'type', 'A')) {
      const val: string = d.aField
      void val
      // @ts-expect-error bField does not exist on DocA
      void d.bField
    }
  })
})
