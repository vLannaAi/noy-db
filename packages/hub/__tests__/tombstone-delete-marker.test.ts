import { describe, it, expect } from 'vitest'
import { isDeleteMarker, buildDeleteMarker, isTombstoneShape, isTombstone } from '../src/kernel/enclave/record-keys/tombstone.js'

describe('delete marker predicate (#589)', () => {
  it('isDeleteMarker recognises _del:true and nothing else', () => {
    expect(isDeleteMarker({ _noydb: 1, _v: 6, _ts: 'x', _iv: '', _data: '', _del: true })).toBe(true)
    expect(isDeleteMarker({ _noydb: 1, _v: 1, _ts: 'x', _iv: 'iv', _data: 'ct' })).toBe(false)
    expect(isDeleteMarker({ _noydb: 1, _v: 1, _ts: 'x', _iv: '', _data: '' })).toBe(false) // forget tombstone
  })
  it('a delete marker is NOT a forget tombstone (predicates never overlap)', () => {
    const marker = buildDeleteMarker(6, 'alice')
    expect(isDeleteMarker(marker)).toBe(true)
    expect(isTombstoneShape(marker)).toBe(false)             // guarded by _del !== true
    expect(isTombstone(marker, true)).toBe(false)
  })
  it('buildDeleteMarker mints the marker shape at the given version', () => {
    const m = buildDeleteMarker(6, 'alice')
    expect(m).toMatchObject({ _noydb: 1, _v: 6, _iv: '', _data: '', _del: true, _by: 'alice' })
    expect(typeof m._ts).toBe('string')
    expect(m._cek).toBeUndefined()
  })
  it('a forget tombstone is still a tombstone (unchanged)', () => {
    expect(isTombstoneShape({ _noydb: 1, _v: 3, _ts: 'x', _iv: '', _data: '' })).toBe(true)
  })
})
