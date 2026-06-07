/**
 * Runtime tests for isDiscriminant() — type-guard helper for discriminated-union
 * Collection<T> results.
 *
 * These are pure runtime assertions (boolean returns, field values).
 * Type-level narrowing assertions live in discriminant.test-d.ts
 * (validated by `pnpm --filter @noy-db/hub run typecheck`).
 */
import { describe, it, expect } from 'vitest'
import { isDiscriminant } from '../src/util/discriminant.js'

// ─── Fixture ─────────────────────────────────────────────────────────────────

type IV = { kind: 'IV'; invoiceNo: string; amount: number }
type RE = { kind: 'RE'; receiptNo: string; paidAt: string }
type DP = { kind: 'DP'; depositRef: string }
type RD = { kind: 'RD'; refundOf: string }
type Receipt = IV | RE | DP | RD

const receipts: Receipt[] = [
  { kind: 'IV', invoiceNo: 'INV-001', amount: 1200 },
  { kind: 'RE', receiptNo: 'RCP-001', paidAt: '2026-01-01' },
  { kind: 'IV', invoiceNo: 'INV-002', amount: 800 },
  { kind: 'DP', depositRef: 'DEP-001' },
  { kind: 'RD', refundOf: 'INV-001' },
]

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('isDiscriminant()', () => {
  it('returns true when the record matches the discriminant value', () => {
    expect(isDiscriminant(receipts[0], 'kind', 'IV')).toBe(true)
    expect(isDiscriminant(receipts[1], 'kind', 'RE')).toBe(true)
    expect(isDiscriminant(receipts[3], 'kind', 'DP')).toBe(true)
    expect(isDiscriminant(receipts[4], 'kind', 'RD')).toBe(true)
  })

  it('returns false when the record does not match the discriminant value', () => {
    expect(isDiscriminant(receipts[0], 'kind', 'RE')).toBe(false)
    expect(isDiscriminant(receipts[1], 'kind', 'IV')).toBe(false)
    expect(isDiscriminant(receipts[3], 'kind', 'IV')).toBe(false)
  })

  it('filters a union array to a single member type and field is accessible', () => {
    const ivs = receipts.filter(r => isDiscriminant(r, 'kind', 'IV'))
    expect(ivs).toHaveLength(2)
    // Runtime field-value assertion (type-level assertion is in .test-d.ts)
    expect(ivs[0].invoiceNo).toBe('INV-001')
    expect(ivs[1].invoiceNo).toBe('INV-002')
    expect(ivs[0].amount).toBe(1200)
  })

  it('returns empty array when no records match', () => {
    const result = receipts.filter(r => isDiscriminant(r, 'kind', 'IV' as never))
    // This checks runtime — all receipts do have 'kind', so we filter a non-existent value
    const noMatch = receipts.filter(r => isDiscriminant(r, 'kind', 'XX' as Receipt['kind']))
    expect(noMatch).toHaveLength(0)
  })

  it('works with a non-"kind" discriminant key', () => {
    type DocA = { type: 'A'; aField: string }
    type DocB = { type: 'B'; bField: number }
    type Doc = DocA | DocB

    const docs: Doc[] = [
      { type: 'A', aField: 'hello' },
      { type: 'B', bField: 42 },
      { type: 'A', aField: 'world' },
    ]

    const aOnly = docs.filter(d => isDiscriminant(d, 'type', 'A'))
    expect(aOnly).toHaveLength(2)
    expect(aOnly[0].aField).toBe('hello')
    expect(aOnly[1].aField).toBe('world')
  })

  it('works as a standalone if-branch (not just filter)', () => {
    const r = receipts[0]
    if (isDiscriminant(r, 'kind', 'IV')) {
      expect(r.invoiceNo).toBe('INV-001')
    } else {
      throw new Error('should have matched IV')
    }
  })
})
