import { describe, it, expect } from 'vitest'
import { envelopeBodyForHash } from '../../src/kernel/enclave/index.js'
import type { EncryptedEnvelope } from '../../src/kernel/types.js'

const base = { _noydb: 1 as const, _v: 1, _ts: 't', _iv: 'i' }

describe('envelopePayloadHash conditional _vdig widen', () => {
  it('legacy: no _sealed, no _vdig → _data alone, byte-identical', () => {
    const env: EncryptedEnvelope = { ...base, _data: 'CIPHERTEXT' }
    expect(envelopeBodyForHash(env)).toBe('CIPHERTEXT')
  })

  it('_sealed-only output is unchanged from stage 1 (back-compat pin)', () => {
    const env: EncryptedEnvelope = { ...base, _data: 'D', _sealed: { b: '2', a: '1' } }
    expect(envelopeBodyForHash(env)).toBe('{"_data":"D","_sealed":{"a":"1","b":"2"}}')
  })

  it('binds _vdig when present, sorted, independent of insertion order', () => {
    const env: EncryptedEnvelope = { ...base, _data: 'D', _vdig: { pin: 'p', password: 'q' } }
    expect(envelopeBodyForHash(env)).toBe('{"_data":"D","_vdig":{"password":"q","pin":"p"}}')
  })

  it('binds both maps together (sorted top-level keys)', () => {
    const env: EncryptedEnvelope = { ...base, _data: 'D', _vdig: { p: 'v' }, _sealed: { s: 'x' } }
    expect(envelopeBodyForHash(env)).toBe('{"_data":"D","_sealed":{"s":"x"},"_vdig":{"p":"v"}}')
  })

  it('temporal-rollback detector: swapping a _vdig blob changes the body string', () => {
    const a: EncryptedEnvelope = { ...base, _data: 'D', _vdig: { password: 'old-blob' } }
    const b: EncryptedEnvelope = { ...base, _data: 'D', _vdig: { password: 'new-blob' } }
    expect(envelopeBodyForHash(a)).not.toBe(envelopeBodyForHash(b))
  })

  it('temporal-rollback detector: dropping _vdig from an envelope that had it fails the cross-check', () => {
    const withVdig: EncryptedEnvelope = { ...base, _data: 'D', _vdig: { password: 'blob' } }
    const { _vdig, ...rest } = withVdig
    const dropped = rest as EncryptedEnvelope
    expect(envelopeBodyForHash(dropped)).not.toBe(envelopeBodyForHash(withVdig))
  })
})
