import { describe, it, expect } from 'vitest'
import { IndexRequiredError, IndexWriteFailureError, NoydbError } from '../src/errors.js'
import { encodeIdxId, decodeIdxId, isIdxId } from '../src/query/persisted-indexes.js'

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

describe('encodeIdxId / decodeIdxId', () => {
  it('round-trips field + recordId', () => {
    const id = encodeIdxId('clientId', '01HK3MABC')
    expect(id).toBe('_idx/clientId/01HK3MABC')
    expect(decodeIdxId(id)).toEqual({ field: 'clientId', recordId: '01HK3MABC' })
  })

  it('decodes record ids that contain slashes', () => {
    const id = encodeIdxId('period', 'nested/id/with/slashes')
    const decoded = decodeIdxId(id)
    expect(decoded).toEqual({ field: 'period', recordId: 'nested/id/with/slashes' })
  })

  it('decodes field names that contain dotted paths', () => {
    const id = encodeIdxId('client.id', 'rec-1')
    expect(id).toBe('_idx/client.id/rec-1')
    expect(decodeIdxId(id)).toEqual({ field: 'client.id', recordId: 'rec-1' })
  })

  it('returns null when decoding a non-idx id', () => {
    expect(decodeIdxId('rec-1')).toBeNull()
    expect(decodeIdxId('_idx/')).toBeNull()
    expect(decodeIdxId('_idx/field-only')).toBeNull()
    expect(decodeIdxId('_keyring/alice')).toBeNull()
  })
})

describe('isIdxId', () => {
  it('is true for well-formed idx ids', () => {
    expect(isIdxId('_idx/clientId/rec-1')).toBe(true)
    expect(isIdxId('_idx/nested.field/rec-1/with/slashes')).toBe(true)
  })

  it('is false for record ids and other reserved namespaces', () => {
    expect(isIdxId('rec-1')).toBe(false)
    expect(isIdxId('_keyring/alice')).toBe(false)
    expect(isIdxId('_ledger_deltas/00000042')).toBe(false)
    expect(isIdxId('_idx')).toBe(false)
    expect(isIdxId('_idx/')).toBe(false)
    expect(isIdxId('_idx/field')).toBe(false)
  })
})
