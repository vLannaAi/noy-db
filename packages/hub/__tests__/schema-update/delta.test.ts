import { describe, expect, it } from 'vitest'
import { computeSchemaDelta } from '../../src/with-shape/schema-update/delta.js'

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

  // #946 — rename detection
  it('same shape, name change (a→b) → renamed pair, additive-safe (not non-additive)', () => {
    const before = obj({ id: { type: 'string' }, a: { type: 'number' } }, ['id'])
    const after = obj({ id: { type: 'string' }, b: { type: 'number' } }, ['id'])
    const d = computeSchemaDelta(before, after, 'invoices')
    expect(d.kind).toBe('additive')
    expect(d.added).toEqual([])
    expect(d.removed).toEqual([])
    expect(d.changed).toEqual([])
    expect(d.renamed).toEqual([{ from: 'a', to: 'b' }])
  })

  it('drop+add of DIFFERENT shapes is still a plain non-additive change (no rename pairing)', () => {
    const before = obj({ id: { type: 'string' }, a: { type: 'number' } }, ['id'])
    const after = obj({ id: { type: 'string' }, b: { type: 'string' } }, ['id'])
    const d = computeSchemaDelta(before, after, 'invoices')
    expect(d.kind).toBe('non-additive')
    expect(d.added).toEqual(['b'])
    expect(d.removed).toEqual(['a'])
    expect(d.renamed).toBeUndefined()
  })

  it('ambiguous shape collision (2 removed + 2 added, same shape) does not pair — stays non-additive', () => {
    const before = obj({ id: { type: 'string' }, a: { type: 'number' }, c: { type: 'number' } }, ['id'])
    const after = obj({ id: { type: 'string' }, b: { type: 'number' }, d: { type: 'number' } }, ['id'])
    const d = computeSchemaDelta(before, after, 'invoices')
    expect(d.kind).toBe('non-additive')
    expect([...d.added].sort()).toEqual(['b', 'd'])
    expect([...d.removed].sort()).toEqual(['a', 'c'])
    expect(d.renamed).toBeUndefined()
  })

  it('identical schemas with no rename → kind none, no renamed field', () => {
    const s = obj({ id: { type: 'string' } }, ['id'])
    const d = computeSchemaDelta(s, s, 'invoices')
    expect(d.kind).toBe('none')
    expect(d.renamed).toBeUndefined()
  })
})
