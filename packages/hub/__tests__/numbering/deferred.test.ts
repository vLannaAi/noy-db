import { describe, it, expect } from 'vitest'
import { withDeferredNumbering } from '../../src/numbering/descriptor.js'
import { NumberingUncertaintyError } from '../../src/errors.js'

describe('withDeferredNumbering descriptor', () => {
  it('captures the series config with defaults', () => {
    const d = withDeferredNumbering({ series: 'invoices', collection: 'sales', field: 'fiscalNumber' })
    expect(d.series).toBe('invoices')
    expect(d.collection).toBe('sales')
    expect(d.field).toBe('fiscalNumber')
    expect(d.settleWindowMs).toBe(0) // default: interval commit-wait governs settling
  })
})

describe('NumberingUncertaintyError', () => {
  it('carries the series', () => {
    const e = new NumberingUncertaintyError('invoices')
    expect(e).toBeInstanceOf(Error)
    expect(e.name).toBe('NumberingUncertaintyError')
    expect(e.message).toContain('invoices')
  })
})
