import { describe, it, expect } from 'vitest'
import { validateFieldMetaKeys, resolveFieldMeta, humanizeFieldKey } from '../../src/introspection/field-meta.js'

describe('FieldMeta key validation', () => {
  it('passes when every fieldMeta key is a known field', () => {
    expect(() => validateFieldMetaKeys('sales', { total: { label: 'Amount' } }, new Set(['total', 'saleDate']))).not.toThrow()
  })
  it('throws fail-loud on an unknown field key (typo)', () => {
    expect(() => validateFieldMetaKeys('sales', { totl: { label: 'Amount' } }, new Set(['total'])))
      .toThrowError(/totl/)
  })
})

describe('humanizeFieldKey', () => {
  it('splits camelCase and title-cases', () => {
    expect(humanizeFieldKey('saleDate')).toBe('Sale Date')
    expect(humanizeFieldKey('buyerId')).toBe('Buyer Id')
  })
})

describe('resolveFieldMeta precedence', () => {
  it('channel label overrides inferred and zod', () => {
    const r = resolveFieldMeta('total', {
      channel: { label: 'Amount' },
      zodMeta: { label: 'ZL', unit: '€' },
      inferred: { label: 'Total', semanticType: 'currency', aggregate: 'sum' },
    })
    expect(r.label).toBe('Amount')        // channel wins
    expect(r.unit).toBe('€')              // filled from zod (channel silent)
    expect(r.semanticType).toBe('currency') // filled from inferred
    expect(r.aggregate).toBe('sum')
  })
  it('falls back to humanized key when no label anywhere', () => {
    expect(resolveFieldMeta('saleDate', { inferred: { semanticType: 'date' } }).label).toBe('Sale Date')
  })
  it('zod beats inferred when channel is silent', () => {
    expect(resolveFieldMeta('x', { zodMeta: { label: 'FromZod' }, inferred: { label: 'FromInfer' } }).label)
      .toBe('FromZod')
  })
})
