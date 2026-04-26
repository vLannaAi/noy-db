import { describe, it, expect } from 'vitest'
import { IndexRequiredError, IndexWriteFailureError, NoydbError } from '../src/errors.js'
import { encodeIdxId, decodeIdxId, isIdxId } from '../src/indexing/persisted-indexes.js'

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

import { PersistedCollectionIndex } from '../src/indexing/persisted-indexes.js'

describe('PersistedCollectionIndex — declare / has / fields', () => {
  it('declare is idempotent', () => {
    const idx = new PersistedCollectionIndex()
    idx.declare('clientId')
    idx.declare('clientId')
    expect(idx.has('clientId')).toBe(true)
    expect(idx.fields()).toEqual(['clientId'])
  })

  it('preserves declaration order', () => {
    const idx = new PersistedCollectionIndex()
    idx.declare('clientId')
    idx.declare('period')
    idx.declare('status')
    expect(idx.fields()).toEqual(['clientId', 'period', 'status'])
  })

  it('has is false for undeclared fields', () => {
    const idx = new PersistedCollectionIndex()
    expect(idx.has('anything')).toBe(false)
  })
})

describe('PersistedCollectionIndex — upsert / remove / lookupEqual', () => {
  it('lookupEqual returns matching record ids', () => {
    const idx = new PersistedCollectionIndex()
    idx.declare('clientId')
    idx.upsert('rec-1', 'clientId', 'c-42', null)
    idx.upsert('rec-2', 'clientId', 'c-42', null)
    idx.upsert('rec-3', 'clientId', 'c-17', null)

    const c42 = idx.lookupEqual('clientId', 'c-42')
    expect(c42).not.toBeNull()
    expect([...c42!]).toEqual(expect.arrayContaining(['rec-1', 'rec-2']))
    expect(c42!.size).toBe(2)

    const c17 = idx.lookupEqual('clientId', 'c-17')
    expect(c17!.size).toBe(1)
  })

  it('lookupEqual returns null when the field is not indexed', () => {
    const idx = new PersistedCollectionIndex()
    expect(idx.lookupEqual('notDeclared', 'anything')).toBeNull()
  })

  it('lookupEqual returns an empty set for an indexed field with no matches', () => {
    const idx = new PersistedCollectionIndex()
    idx.declare('clientId')
    const result = idx.lookupEqual('clientId', 'c-missing')
    expect(result).not.toBeNull()
    expect(result!.size).toBe(0)
  })

  it('upsert with a previous value moves the record between buckets', () => {
    const idx = new PersistedCollectionIndex()
    idx.declare('status')
    idx.upsert('rec-1', 'status', 'open', null)
    expect(idx.lookupEqual('status', 'open')!.size).toBe(1)
    idx.upsert('rec-1', 'status', 'closed', 'open')
    expect(idx.lookupEqual('status', 'open')!.size).toBe(0)
    expect(idx.lookupEqual('status', 'closed')!.size).toBe(1)
  })

  it('remove drops the record from the given field only', () => {
    const idx = new PersistedCollectionIndex()
    idx.declare('clientId')
    idx.declare('status')
    idx.upsert('rec-1', 'clientId', 'c-42', null)
    idx.upsert('rec-1', 'status', 'open', null)
    idx.remove('rec-1', 'status', 'open')
    expect(idx.lookupEqual('status', 'open')!.size).toBe(0)
    expect(idx.lookupEqual('clientId', 'c-42')!.size).toBe(1)
  })

  it('clear drops every bucket across every field', () => {
    const idx = new PersistedCollectionIndex()
    idx.declare('clientId')
    idx.upsert('rec-1', 'clientId', 'c-42', null)
    idx.clear()
    expect(idx.lookupEqual('clientId', 'c-42')!.size).toBe(0)
  })
})

describe('PersistedCollectionIndex — lookupIn', () => {
  it('returns the union of matching buckets', () => {
    const idx = new PersistedCollectionIndex()
    idx.declare('status')
    idx.upsert('rec-1', 'status', 'open', null)
    idx.upsert('rec-2', 'status', 'pending', null)
    idx.upsert('rec-3', 'status', 'closed', null)
    const result = idx.lookupIn('status', ['open', 'pending'])
    expect(result).not.toBeNull()
    expect([...result!].sort()).toEqual(['rec-1', 'rec-2'])
  })

  it('returns null for undeclared fields', () => {
    const idx = new PersistedCollectionIndex()
    expect(idx.lookupIn('nope', ['a', 'b'])).toBeNull()
  })
})

describe('PersistedCollectionIndex — orderedBy', () => {
  it('returns ascending sorted {recordId, value} by default', () => {
    const idx = new PersistedCollectionIndex()
    idx.declare('filedAt')
    idx.upsert('rec-a', 'filedAt', '2026-03-01', null)
    idx.upsert('rec-b', 'filedAt', '2026-01-01', null)
    idx.upsert('rec-c', 'filedAt', '2026-02-01', null)
    const asc = idx.orderedBy('filedAt', 'asc')
    expect(asc!.map(e => e.recordId)).toEqual(['rec-b', 'rec-c', 'rec-a'])
  })

  it('returns descending when requested', () => {
    const idx = new PersistedCollectionIndex()
    idx.declare('filedAt')
    idx.upsert('rec-a', 'filedAt', 3, null)
    idx.upsert('rec-b', 'filedAt', 1, null)
    idx.upsert('rec-c', 'filedAt', 2, null)
    const desc = idx.orderedBy('filedAt', 'desc')
    expect(desc!.map(e => e.recordId)).toEqual(['rec-a', 'rec-c', 'rec-b'])
  })

  it('returns null for undeclared fields', () => {
    const idx = new PersistedCollectionIndex()
    expect(idx.orderedBy('nope', 'asc')).toBeNull()
  })

  it('coerces Date values via toISOString for consistent ordering', () => {
    const idx = new PersistedCollectionIndex()
    idx.declare('at')
    idx.upsert('rec-a', 'at', new Date('2026-03-01T00:00:00Z'), null)
    idx.upsert('rec-b', 'at', new Date('2026-01-01T00:00:00Z'), null)
    const asc = idx.orderedBy('at', 'asc')
    expect(asc!.map(e => e.recordId)).toEqual(['rec-b', 'rec-a'])
  })
})

describe('PersistedCollectionIndex — ingest from decrypted bodies', () => {
  it('ingest populates buckets from bulk-load bodies', () => {
    const idx = new PersistedCollectionIndex()
    idx.declare('clientId')
    idx.ingest('clientId', [
      { recordId: 'rec-1', value: 'c-42' },
      { recordId: 'rec-2', value: 'c-42' },
      { recordId: 'rec-3', value: 'c-17' },
    ])
    expect(idx.lookupEqual('clientId', 'c-42')!.size).toBe(2)
    expect(idx.lookupEqual('clientId', 'c-17')!.size).toBe(1)
  })

  it('ingest is idempotent (safe to call twice with the same data)', () => {
    const idx = new PersistedCollectionIndex()
    idx.declare('clientId')
    const rows = [{ recordId: 'rec-1', value: 'c-42' }]
    idx.ingest('clientId', rows)
    idx.ingest('clientId', rows)
    expect(idx.lookupEqual('clientId', 'c-42')!.size).toBe(1)
  })

  it('ingest on undeclared field is a no-op (tolerant — bulk-load may run before all declares land)', () => {
    const idx = new PersistedCollectionIndex()
    expect(() => idx.ingest('not-declared', [{ recordId: 'r', value: 'v' }])).not.toThrow()
    expect(idx.has('not-declared')).toBe(false)
  })
})
