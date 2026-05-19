import { describe, it, expect } from 'vitest'
import {
  NoydbError,
  RecordLockedError,
  FieldFrozenError,
  InvariantError,
  AmendmentForbiddenError,
} from '../../src/errors.js'

describe('guard errors', () => {
  it('RecordLockedError carries collection + id + reason', () => {
    const e = new RecordLockedError('disbursements', 'd1', 'invoice issued')
    expect(e).toBeInstanceOf(NoydbError)
    expect(e.code).toBe('RECORD_LOCKED')
    expect(e.collection).toBe('disbursements')
    expect(e.id).toBe('d1')
    expect(e.reason).toBe('invoice issued')
    expect(e.message).toContain('disbursements')
    expect(e.message).toContain('d1')
    expect(e.message).toContain('invoice issued')
  })

  it('FieldFrozenError lists changed fields', () => {
    const e = new FieldFrozenError('invoices', 'inv1', ['total', 'vatAmount'])
    expect(e).toBeInstanceOf(NoydbError)
    expect(e.code).toBe('FIELD_FROZEN')
    expect(e.fields).toEqual(['total', 'vatAmount'])
    expect(e.message).toContain('total')
    expect(e.message).toContain('vatAmount')
  })

  it('InvariantError carries a message', () => {
    const e = new InvariantError('sum must be preserved')
    expect(e).toBeInstanceOf(NoydbError)
    expect(e.code).toBe('INVARIANT_VIOLATED')
    expect(e.message).toContain('sum must be preserved')
  })

  it('AmendmentForbiddenError carries userId + role', () => {
    const e = new AmendmentForbiddenError('alice', 'viewer')
    expect(e).toBeInstanceOf(NoydbError)
    expect(e.code).toBe('AMENDMENT_FORBIDDEN')
    expect(e.userId).toBe('alice')
    expect(e.role).toBe('viewer')
    expect(e.message).toContain('alice')
    expect(e.message).toContain('viewer')
  })
})
