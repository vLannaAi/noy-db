import { describe, it, expect } from 'vitest'
import { moneyVia } from '../../src/via/money/binding.js'
import { money } from '../../src/via/money/descriptor.js'
import { sum } from '../../src/with-lookup/reduce/reducers.js'
import { ValidationError } from '../../src/kernel/errors.js'

const moneyFields = { total: money({ currency: 'EUR', scale: 2 }) }

describe('moneyVia (#623 Task 5)', () => {
  it('declares the money brand + posture', () => {
    const b = moneyVia(moneyFields)
    expect(b.brand).toBe('money')
    expect(b.posture).toEqual({
      encryptedAtRest: 'envelope',
      queryable: 'ordered',
      exportable: true,
      forgettable: true,
    })
  })

  it('validates field paths at construction, mirroring the old declaration-time check', () => {
    expect(() => moneyVia({ 'bad[': money({ currency: 'EUR' }) })).toThrow(ValidationError)
  })

  it('ingest canonicalizes raw put() input to the decoded decimal shape', () => {
    const b = moneyVia(moneyFields)
    const out = b.ingest!({ total: 123.45 })
    expect(out.total).toBe('123.45')
  })

  it('encodeWrite quantizes the canonical decimal to the stored scaled-int string', async () => {
    const b = moneyVia(moneyFields)
    const ingested = b.ingest!({ total: 123.45 })
    const written = await b.encodeWrite!(ingested, { id: 'x', vault: 'test-vault', prior: async () => null, emit: () => {} })
    expect(written.total).toBe('12345')
  })

  it('present decodes the stored form back to the canonical decimal (round-trip)', async () => {
    const b = moneyVia(moneyFields)
    const presented = await b.present!({ total: '12345' }, { locale: 'raw', layer: 'read' })
    expect(presented.total).toBe('123.45')
    expect(presented.totalFormatted).toBeUndefined()
  })

  it('present adds Formatted/Number virtuals for a real locale', async () => {
    const b = moneyVia(moneyFields)
    const presented = await b.present!({ total: '12345' }, { locale: 'de-DE', layer: 'read' })
    expect(presented.total).toBe('123.45')
    expect(String(presented.totalFormatted)).toContain('123,45')
    expect(presented.totalNumber).toBe(123.45)
  })

  it('canonicalizeStored decodes a raw stored record with no virtuals', () => {
    const b = moneyVia(moneyFields)
    const out = b.canonicalizeStored!({ total: '12345' })
    expect(out.total).toBe('123.45')
    expect(out.totalFormatted).toBeUndefined()
  })

  it('decodeResults always decodes raw regardless of locale', () => {
    const b = moneyVia(moneyFields)
    const out = b.decodeResults!({ total: '12345' }) as Record<string, unknown>
    expect(out.total).toBe('123.45')
    expect(out.totalFormatted).toBeUndefined()
  })

  it('buildClause + evaluateClause: >= comparison in scaled space', () => {
    const b = moneyVia(moneyFields)
    const payload = b.buildClause!('total', '>=', 100)
    expect(payload).toBeDefined()
    expect(b.evaluateClause!('12345', '>=', payload)).toBe(true) // 123.45 >= 100.00
    expect(b.evaluateClause!('5000', '>=', payload)).toBe(false) // 50.00 >= 100.00
  })

  it('buildClause returns undefined for a field the binding does not cover', () => {
    const b = moneyVia(moneyFields)
    expect(b.buildClause!('other', '==', 1)).toBeUndefined()
  })

  it('compareForOrder orders stored scaled amounts exactly', () => {
    const b = moneyVia(moneyFields)
    expect(b.compareForOrder!('total', '900', '1000')).toBe(-1)
    expect(b.compareForOrder!('total', '1000', '900')).toBe(1)
    expect(b.compareForOrder!('total', '1000', '1000')).toBe(0)
  })

  it('compareForOrder returns undefined for a field the binding does not cover', () => {
    const b = moneyVia(moneyFields)
    expect(b.compareForOrder!('other', 1, 2)).toBeUndefined()
  })

  it('wrapReducers rewrites sum() into an exact BigInt money reducer', () => {
    const b = moneyVia(moneyFields)
    const wrapped = b.wrapReducers!({ total: sum('total') }) as Record<
      string,
      { init(): unknown; step(s: unknown, r: unknown): unknown; finalize(s: unknown): unknown }
    >
    let state = wrapped.total!.init()
    state = wrapped.total!.step(state, { total: '1000' }) // 10.00
    state = wrapped.total!.step(state, { total: '500' }) // 5.00
    expect(wrapped.total!.finalize(state)).toBe('15.00')
  })
})
