// packages/hub/__tests__/derivations/trigger-match.test.ts
// Pure helpers behind composite triggerBy (#1249). Semantics: spec
// docs/superpowers/specs/2026-08-29-composite-triggerby-design.md §4-§5.
import { describe, it, expect } from 'vitest'
import { normalizeTriggerBy, resolveTuple, tupleFromIntermediate, sameTuple, recordMatchesPairs } from '../../src/with-formula/derivations/trigger-match.js'

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

// #1294 — these were `tupleFromWritten`'s tests. That sync builder was DELETED
// rather than kept alongside `resolveTuple`: two tuple builders that had to
// agree is exactly how the delete path drifted (it called the unhopped one, so
// a mapped pair compared the wrong side and matched nothing, silently). The
// cases are unchanged; `resolveTuple` with no `via` does what it did.
const noLookup = async (): Promise<Record<string, unknown> | null> => null

describe('resolveTuple (no hop — the former tupleFromWritten semantics)', () => {
  const m = [{ from: 'clientId', to: 'clientId' }, { from: 'cycle', to: 'cycle' }]
  it('extracts values, String-coerced', async () => {
    expect(await resolveTuple(m, 'd1', { clientId: 'c1', cycle: 2026 }, noLookup)).toEqual([
      { field: 'clientId', value: 'c1' }, { field: 'cycle', value: '2026' },
    ])
  })
  it("from:'id' reads the written id, winning over a stored id field", async () => {
    expect(await resolveTuple([{ from: 'id', to: 'buyerId' }], 'b9', { id: 'WRONG' }, noLookup)).toEqual([
      { field: 'buyerId', value: 'b9' },
    ])
  })
  it('absent from-field -> null (matches nothing)', async () => {
    expect(await resolveTuple(m, 'd1', { clientId: 'c1' }, noLookup)).toBeNull()
  })
  it('non-scalar from-field -> null', async () => {
    expect(await resolveTuple(m, 'd1', { clientId: 'c1', cycle: { q: 1 } }, noLookup)).toBeNull()
  })
  it('null record with only id pairs still works', async () => {
    expect(await resolveTuple([{ from: 'id', to: 'buyerId' }], 'b1', null, noLookup)).toEqual([{ field: 'buyerId', value: 'b1' }])
  })
  it('null record with a field pair -> null', async () => {
    expect(await resolveTuple(m, 'd1', null, noLookup)).toBeNull()
  })
})
describe('resolveTuple — through a hop (#1277)', () => {
  const m = [{ from: 'clientId', to: 'entityId', via: { collection: 'clients', take: 'id', on: 'entityId' } }]
  const lookup = async (c: string, f: string, v: string): Promise<Record<string, unknown> | null> =>
    (c === 'clients' && f === 'id' && v === 'C1') ? { id: 'C1', entityId: 'E1' } : null

  it('substitutes the intermediate value, so downstream compares a flat tuple', async () => {
    expect(await resolveTuple(m, 'd1', { clientId: 'C1' }, lookup)).toEqual([{ field: 'entityId', value: 'E1' }])
  })
  it('an unresolvable intermediate -> null, not a throw', async () => {
    expect(await resolveTuple(m, 'd1', { clientId: 'NOPE' }, lookup)).toBeNull()
  })
  it('an intermediate lacking the on-field -> null', async () => {
    const l = async (): Promise<Record<string, unknown> | null> => ({ id: 'C1' })
    expect(await resolveTuple(m, 'd1', { clientId: 'C1' }, l)).toBeNull()
  })
})

describe('tupleFromIntermediate (#1277 option 2)', () => {
  const m = [{ from: 'clientId', to: 'entityId', via: { collection: 'clients', take: 'id', on: 'entityId' } }]
  it('reads the intermediate\'s own value — it IS the written record', () => {
    expect(tupleFromIntermediate(m, 'clients', { id: 'C1', entityId: 'E1' })).toEqual([{ field: 'entityId', value: 'E1' }])
  })
  it('returns null when no pair hops through that collection', () => {
    expect(tupleFromIntermediate([{ from: 'a', to: 'b' }], 'clients', { a: 1 })).toBeNull()
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
