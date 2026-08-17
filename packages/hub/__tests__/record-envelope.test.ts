import { describe, it, expect } from 'vitest'
import { buildRecordEnvelope } from '../src/kernel/enclave/record-envelope.js'
import type { RecordIdentity } from '../src/kernel/enclave/record-aad.js'
import { NOYDB_FORMAT_VERSION } from '../src/kernel/types.js'

const id: RecordIdentity = { collection: 'invoices', id: 'inv-1', version: 1 }

describe('buildRecordEnvelope (#1051)', () => {
  it('1. produces exactly what the hand-written literals produced', () => {
    // The migration is only safe if this is byte-identical to what the 49
    // producers wrote by hand. This is that contract.
    // #1041: `by` moved onto the IDENTITY — it is the single source for `_by`
    // and for the AAD, so the two cannot disagree.
    const env = buildRecordEnvelope({ ...id, by: 'alice' }, { iv: 'IV', data: 'DATA', ts: 'T' })
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
    const env = buildRecordEnvelope({ ...id, version: 2 }, { iv: '', data: '{}', ts: 'T' })
    expect(Object.keys(env).sort()).toEqual(['_data', '_iv', '_noydb', '_ts', '_v'])
    expect('_by' in env).toBe(false)
    expect('_cek' in env).toBe(false)
  })

  it('3. carries the per-record CEK and provenance when given', () => {
    const env = buildRecordEnvelope(id, {
      iv: 'IV', data: 'D', ts: 'T',
      cek: 'WRAPPED', provenance: { source: 'reg', sourceTs: 'TS' },
    })
    expect(env).toMatchObject({ _cek: 'WRAPPED', _source: 'reg', _sourceTs: 'TS' })
  })

  it('4. passes extra slots through untouched', () => {
    const env = buildRecordEnvelope(id, {
      iv: 'IV', data: 'D', ts: 'T',
      extra: { _det: { field: 'x' } as never },
    })
    expect(env._det).toEqual({ field: 'x' })
  })

  it('4b. `_tier` comes from the IDENTITY, never from `extra` (#1041)', () => {
    // Single source: the caller seals under AAD derived from `identity`, and a
    // reader recomputes it from `_tier` read off the envelope. If `extra` could
    // also set `_tier`, the two could disagree and the record would be sealed
    // under AAD nothing can reproduce. The type forbids it; this pins the
    // behaviour so a future widening of `extra` has to fail here first.
    const env = buildRecordEnvelope({ ...id, tier: 2 }, { iv: 'IV', data: 'D', ts: 'T' })
    expect(env._tier).toBe(2)
  })

  it('4c. tier 0 is OMITTED, not stamped — absent and 0 are one record', () => {
    // `buildRecordAad` folds `undefined` and 0 together for exactly this reason;
    // stamping `_tier: 0` would change stored bytes for no gain.
    const env = buildRecordEnvelope({ ...id, tier: 0 }, { iv: 'IV', data: 'D', ts: 'T' })
    expect('_tier' in env).toBe(false)
  })

  it('5. defaults `_ts` to now when the caller has no real timestamp', () => {
    const env = buildRecordEnvelope(id, { iv: '', data: '{}' })
    expect(() => new Date(env._ts).toISOString()).not.toThrow()
    expect(new Date(env._ts).getTime()).toBeGreaterThan(0)
  })

  it('6. stamps the current format version, never a literal', () => {
    // #1048 single-sourced this; a producer hardcoding 1 is the bug class that
    // becomes a runtime failure the moment the version bumps.
    expect(buildRecordEnvelope(id, { iv: '', data: '{}' })._noydb)
      .toBe(NOYDB_FORMAT_VERSION)
  })

  it('7. requires identity — the whole point of the constructor', () => {
    // Compile-time contract, asserted here so the intent survives a refactor
    // that might otherwise "clean up" the unused parameter.
    // @ts-expect-error identity is required even though it is not yet read
    expect(() => buildRecordEnvelope({ iv: '', data: '{}' })).toThrow
  })
})
