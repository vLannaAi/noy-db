import { describe, it, expect } from 'vitest'
import { validateFieldMetaKeys } from '../../src/introspection/field-meta.js'

describe('FieldMeta key validation', () => {
  it('passes when every fieldMeta key is a known field', () => {
    expect(() => validateFieldMetaKeys('sales', { total: { label: 'Amount' } }, new Set(['total', 'saleDate']))).not.toThrow()
  })
  it('throws fail-loud on an unknown field key (typo)', () => {
    expect(() => validateFieldMetaKeys('sales', { totl: { label: 'Amount' } }, new Set(['total'])))
      .toThrowError(/totl/)
  })
})
