import { describe, it, expect } from 'vitest'
import type { EncryptedEnvelope, VdigFieldPolicy, ClassifiedMarker } from '../../src/kernel/types.js'

describe('slice-2b spine', () => {
  it('EncryptedEnvelope accepts a _bidx tag map beside _vdig', () => {
    const env: EncryptedEnvelope = {
      _noydb: 1, _v: 1, _ts: 't', _iv: 'i', _data: 'd',
      _vdig: { password: 'iv:data' }, _bidx: { password: 'AbCd...==' },
    }
    expect(env._bidx?.password).toBeTypeOf('string')
  })
  it('VdigFieldPolicy gains equatable; ClassifiedMarker shape typechecks', () => {
    const p: VdigFieldPolicy = { normalize: 'password', notLastN: 0, equatable: true }
    const m: ClassifiedMarker = { digestOnly: ['password'], equatable: ['password'] }
    expect(p.equatable && m.equatable.length).toBe(1)
  })
})
