/**
 * Unit tests for the pure tombstone helpers extracted into src/record-keys/.
 *
 * These are the collection-independent core of the crypto-shred contract
 * (#304): {@link buildTombstone} mints the residue shape, {@link isTombstone}
 * recognises it on the read path. End-to-end shred behaviour (history, ledger,
 * subject index) is covered by forget.test.ts — here we pin the primitives.
 */
import { describe, it, expect } from 'vitest'
import { isTombstone, buildTombstone } from '../../src/kernel/enclave/record-keys/index.js'
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
    const t = buildTombstone(3, 'alice')
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
    const t = buildTombstone(1, '')
    expect('_by' in t).toBe(false)
  })

  it('round-trips through isTombstone', () => {
    expect(isTombstone(buildTombstone(7, 'bob'), true)).toBe(true)
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
