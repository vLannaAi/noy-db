import { describe, it, expect } from 'vitest'
import { IndexRequiredError, IndexWriteFailureError, NoydbError } from '../src/errors.js'

describe('IndexRequiredError', () => {
  it('extends NoydbError with code INDEX_REQUIRED', () => {
    const e = new IndexRequiredError({
      collection: 'disbursements',
      touchedFields: ['clientId', 'period'],
      missingFields: ['period'],
    })
    expect(e).toBeInstanceOf(NoydbError)
    expect(e.name).toBe('IndexRequiredError')
    expect(e.code).toBe('INDEX_REQUIRED')
    expect(e.collection).toBe('disbursements')
    expect(e.touchedFields).toEqual(['clientId', 'period'])
    expect(e.missingFields).toEqual(['period'])
    expect(e.message).toContain('period')
    expect(e.message).toContain('scan()')
  })

  it('copies input arrays defensively (both touchedFields and missingFields independently)', () => {
    const touched = ['clientId']
    const missing = ['clientId']
    const e = new IndexRequiredError({
      collection: 'x',
      touchedFields: touched,
      missingFields: missing,
    })
    touched.push('injected-touched')
    missing.push('injected-missing')
    expect(e.touchedFields).toEqual(['clientId'])
    expect(e.missingFields).toEqual(['clientId'])
  })
})

describe('IndexWriteFailureError', () => {
  it('carries recordId, field, op, and cause', () => {
    const cause = new Error('disk full')
    const e = new IndexWriteFailureError({ recordId: 'rec-1', field: 'clientId', op: 'put', cause })
    expect(e).toBeInstanceOf(NoydbError)
    expect(e.name).toBe('IndexWriteFailureError')
    expect(e.code).toBe('INDEX_WRITE_FAILURE')
    expect(e.recordId).toBe('rec-1')
    expect(e.field).toBe('clientId')
    expect(e.op).toBe('put')
    expect(e.cause).toBe(cause)
  })

  it('supports delete op', () => {
    const e = new IndexWriteFailureError({ recordId: 'rec-1', field: 'clientId', op: 'delete', cause: null })
    expect(e.op).toBe('delete')
  })
})
