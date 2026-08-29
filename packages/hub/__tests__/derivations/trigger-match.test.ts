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
