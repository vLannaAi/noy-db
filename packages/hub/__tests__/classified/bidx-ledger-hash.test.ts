import { describe, it, expect } from 'vitest'
import { envelopeBodyForHash } from '../../src/kernel/enclave/record-keys/envelope-body.js'
import type { EncryptedEnvelope } from '../../src/kernel/types.js'

const base: EncryptedEnvelope = { _noydb: 1, _v: 1, _ts: 't', _iv: 'i', _data: 'd' }

describe('envelopeBodyForHash _bidx widen (SM #5)', () => {
  it('a _bidx-absent, _vdig-only envelope hashes BYTE-IDENTICALLY to its stage-2 value', () => {
    const vdigOnly: EncryptedEnvelope = { ...base, _vdig: { password: 'iv:data' } }
    // Stage-2 golden constant, captured from the pre-widen build.
    expect(envelopeBodyForHash(vdigOnly)).toBe('{"_data":"d","_vdig":{"password":"iv:data"}}')
  })

  it('binds _bidx when present, appended after _vdig (order-stable)', () => {
    const withBidx: EncryptedEnvelope = { ...base, _vdig: { password: 'iv:data' }, _bidx: { password: 'AbCd==' } }
    const s = envelopeBodyForHash(withBidx)
    expect(s.indexOf('_vdig')).toBeLessThan(s.indexOf('_bidx')) // _bidx segment LAST
  })

  it('a bare envelope (no _sealed/_vdig/_bidx) still fast-paths to _data alone', () => {
    expect(envelopeBodyForHash(base)).toBe('d')
  })
})
