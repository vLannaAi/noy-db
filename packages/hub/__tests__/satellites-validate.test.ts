import { describe, it, expect } from 'vitest'
import { validateSatelliteDeclaration, hashFields } from '../src/with-shape/satellites/validate.js'
import { SatelliteConfigError } from '../src/kernel/errors.js'

describe('validateSatelliteDeclaration', () => {
  const ok = { satellite: 'msgs_text', satelliteOf: 'msgs', fields: ['subject', 'body'], joined: 'msgs_full' }

  it('accepts a well-formed declaration and returns a frozen SatelliteSpec', () => {
    const spec = validateSatelliteDeclaration({ ...ok, baseIsSatellite: false, crdtMode: false })
    expect(spec).toEqual({ base: 'msgs', satellite: 'msgs_text', fields: ['subject', 'body'], joined: 'msgs_full' })
    expect(Object.isFrozen(spec)).toBe(true)
  })

  it('R-S3: refuses when the base is itself a satellite (no chains)', () => {
    expect(() => validateSatelliteDeclaration({ ...ok, baseIsSatellite: true, crdtMode: false }))
      .toThrowError(/R-S3/)
  })

  it('R-S5: refuses omitted, empty, or id-bearing fields', () => {
    for (const fields of [undefined, [], ['id', 'body']]) {
      expect(() => validateSatelliteDeclaration({ ...ok, fields: fields as never, baseIsSatellite: false, crdtMode: false }))
        .toThrowError(SatelliteConfigError)
    }
    expect(() => validateSatelliteDeclaration({ ...ok, fields: ['id'], baseIsSatellite: false, crdtMode: false }))
      .toThrowError(/R-S5/)
  })

  it('R-S5: refuses a joined name equal to base or satellite name', () => {
    expect(() => validateSatelliteDeclaration({ ...ok, joined: 'msgs', baseIsSatellite: false, crdtMode: false }))
      .toThrowError(/R-S5/)
  })

  it('R-S8: refuses crdtMode on the satellite member', () => {
    expect(() => validateSatelliteDeclaration({ ...ok, baseIsSatellite: false, crdtMode: true }))
      .toThrowError(/R-S8/)
  })

  it('hashFields is order-insensitive and stable', () => {
    expect(hashFields(['b', 'a'])).toBe(hashFields(['a', 'b']))
    expect(hashFields(['a', 'b'])).not.toBe(hashFields(['a']))
  })
})
