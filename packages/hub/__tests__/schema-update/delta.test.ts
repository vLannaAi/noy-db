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
})
