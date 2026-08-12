/**
 * Unit tests for the pure tombstone helpers extracted into src/record-keys/.
 *
 * These are the collection-independent core of the crypto-shred contract
 * (#304): {@link buildTombstone} mints the residue shape, {@link isTombstone}
 * recognises it on the read path. End-to-end shred behaviour (history, ledger,
 * subject index) is covered by forget.test.ts — here we pin the primitives.
 *
 * Also covers delete markers (#589) which are a distinct envelope predicate.
 */
import { describe, it, expect } from 'vitest'
import { isTombstone, buildTombstone } from '../../src/kernel/enclave/index.js'
import { isDeleteMarker, buildDeleteMarker, isTombstoneShape } from '../../src/kernel/enclave/record-keys/tombstone.js'
import { NOYDB_FORMAT_VERSION, type EncryptedEnvelope } from '../../src/kernel/types.js'

const live: EncryptedEnvelope = {
  _noydb: NOYDB_FORMAT_VERSION,
  _v: 3,
  _ts: '2026-06-13T00:00:00.000Z',
  _iv: 'aXY=',
  _data: 'Y2lwaGVy',
  _cek: 'd3JhcHBlZA==',
}

describe('buildTombstone', () => {
  it('keeps _v, stamps _ts, drops body/_cek/_det, records actor', () => {
    const t = buildTombstone({ collection: 'c', id: 'r' }, 3, 'alice')
    expect(t._v).toBe(3)
    expect(t._iv).toBe('')
    expect(t._data).toBe('')
    expect(t._cek).toBeUndefined()
    expect(t._det).toBeUndefined()
    expect(t._by).toBe('alice')
    expect(t._noydb).toBe(NOYDB_FORMAT_VERSION)
    expect(typeof t._ts).toBe('string')
  })

  it('omits _by entirely when actor is empty', () => {
    const t = buildTombstone({ collection: 'c', id: 'r' }, 1, '')
    expect('_by' in t).toBe(false)
  })

  it('round-trips through isTombstone', () => {
    expect(isTombstone(buildTombstone({ collection: 'c', id: 'r' }, 7, 'bob'), true)).toBe(true)
  })
})

describe('isTombstone', () => {
  it('is true for a no-body, no-_cek envelope on an encrypted collection', () => {
    const { _cek, ...liveNoCek } = { ...live, _iv: '', _data: '' }
    expect(isTombstone(liveNoCek, true)).toBe(true)
  })

  it('is false for a live encrypted record (has _data + _cek)', () => {
    expect(isTombstone(live, true)).toBe(false)
  })

  it('is false for a legacy migration envelope (body present, no _cek)', () => {
    const { _cek, ...legacy } = live
    expect(isTombstone(legacy, true)).toBe(false)
  })

  it('is always false on an unencrypted collection', () => {
    const { _cek, ...liveNoCek2 } = { ...live, _iv: '', _data: '' }
    expect(isTombstone(liveNoCek2, false)).toBe(false)
  })
})

describe('delete marker predicate (#589)', () => {
  it('isDeleteMarker recognises _del:true and nothing else', () => {
    expect(isDeleteMarker({ _noydb: 1, _v: 6, _ts: 'x', _iv: '', _data: '', _del: true })).toBe(true)
    expect(isDeleteMarker({ _noydb: 1, _v: 1, _ts: 'x', _iv: 'iv', _data: 'ct' })).toBe(false)
    expect(isDeleteMarker({ _noydb: 1, _v: 1, _ts: 'x', _iv: '', _data: '' })).toBe(false) // forget tombstone
  })
  it('a delete marker is NOT a forget tombstone (predicates never overlap)', () => {
    const marker = buildDeleteMarker({ collection: 'c', id: 'r' }, 6, 'alice')
    expect(isDeleteMarker(marker)).toBe(true)
    expect(isTombstoneShape(marker)).toBe(false)             // guarded by _del !== true
    expect(isTombstone(marker, true)).toBe(false)
  })
  it('buildDeleteMarker mints the marker shape at the given version', () => {
    const m = buildDeleteMarker({ collection: 'c', id: 'r' }, 6, 'alice')
    expect(m).toMatchObject({ _noydb: 1, _v: 6, _iv: '', _data: '', _del: true, _by: 'alice' })
    expect(typeof m._ts).toBe('string')
    expect(m._cek).toBeUndefined()
  })
  it('a forget tombstone is still a tombstone (unchanged)', () => {
    expect(isTombstoneShape({ _noydb: 1, _v: 3, _ts: 'x', _iv: '', _data: '' })).toBe(true)
  })
})
