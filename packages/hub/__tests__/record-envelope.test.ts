import { describe, it, expect } from 'vitest'
import { buildRecordEnvelope } from '../src/kernel/enclave/record-envelope.js'
import type { RecordIdentity } from '../src/kernel/enclave/record-aad.js'
import { NOYDB_FORMAT_VERSION } from '../src/kernel/types.js'

const id: RecordIdentity = { collection: 'invoices', id: 'inv-1' }

describe('buildRecordEnvelope (#1051)', () => {
  it('1. produces exactly what the hand-written literals produced', () => {
    // The migration is only safe if this is byte-identical to what the 49
    // producers wrote by hand. This is that contract.
    const env = buildRecordEnvelope(id, { version: 1, iv: 'IV', data: 'DATA', ts: 'T', by: 'alice' })
    expect(env).toEqual({
      _noydb: NOYDB_FORMAT_VERSION,
      _v: 1,
      _ts: 'T',
      _iv: 'IV',
      _data: 'DATA',
      _by: 'alice',
    })
  })

  it('2. omits every optional slot rather than writing undefined', () => {
    // `{_by: undefined}` is NOT the same envelope as `{}` — it changes JSON
    // output and would alter stored bytes for plaintext collections.
    const env = buildRecordEnvelope(id, { version: 2, iv: '', data: '{}', ts: 'T' })
    expect(Object.keys(env).sort()).toEqual(['_data', '_iv', '_noydb', '_ts', '_v'])
    expect('_by' in env).toBe(false)
    expect('_cek' in env).toBe(false)
  })

  it('3. carries the per-record CEK and provenance when given', () => {
    const env = buildRecordEnvelope(id, {
      version: 3, iv: 'IV', data: 'D', ts: 'T',
      cek: 'WRAPPED', provenance: { source: 'reg', sourceTs: 'TS' },
    })
    expect(env).toMatchObject({ _cek: 'WRAPPED', _source: 'reg', _sourceTs: 'TS' })
  })

  it('4. passes extra slots through untouched', () => {
    const env = buildRecordEnvelope(id, {
      version: 1, iv: 'IV', data: 'D', ts: 'T',
      extra: { _tier: 1, _det: { field: 'x' } as never },
    })
    expect(env._tier).toBe(1)
  })

  it('5. defaults `_ts` to now when the caller has no real timestamp', () => {
    const env = buildRecordEnvelope(id, { version: 1, iv: '', data: '{}' })
    expect(() => new Date(env._ts).toISOString()).not.toThrow()
    expect(new Date(env._ts).getTime()).toBeGreaterThan(0)
  })

  it('6. stamps the current format version, never a literal', () => {
    // #1048 single-sourced this; a producer hardcoding 1 is the bug class that
    // becomes a runtime failure the moment the version bumps.
    expect(buildRecordEnvelope(id, { version: 1, iv: '', data: '{}' })._noydb)
      .toBe(NOYDB_FORMAT_VERSION)
  })

  it('7. requires identity — the whole point of the constructor', () => {
    // Compile-time contract, asserted here so the intent survives a refactor
    // that might otherwise "clean up" the unused parameter.
    // @ts-expect-error identity is required even though it is not yet read
    expect(() => buildRecordEnvelope({ version: 1, iv: '', data: '{}' })).toThrow
  })
})
