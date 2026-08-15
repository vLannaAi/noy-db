/**
 * #1074 — a DEK rotation must not silently mutate the records it re-keys.
 *
 * `rotateKeys` built a fresh literal carrying only `_noydb/_v/_ts/_iv/_data`,
 * discarding `_by`, `_tier`, `_cek`, `_sealed`, `_vdig` and `_source`. Since
 * #1054 removed `rotateKeys: false`, rotation is the ONLY revocation path — so
 * every revocation on every published version silently erased tier elevation
 * and provenance.
 *
 * Losing `_tier` was the worst of them: tier-0 reads treat elevated as missing
 * (`collection.ts:1428`), so an elevated record did not error after a
 * rotation — it disappeared.
 *
 * These test the enclave helper directly rather than through `revoke()`. The
 * helper is where the decision lives, and testing it here means each assertion
 * fails for one reason.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { rekeyEnvelopeToDek } from '../src/kernel/enclave/record-keys/rekey.js'
import { recordAadFor } from '../src/kernel/enclave/record-aad.js'
import { encrypt, decrypt, generateDEK, wrapCek, unwrapCek } from '../src/kernel/enclave/crypto.js'
import type { EnclaveKey } from '../src/kernel/enclave/crypto.js'
import type { EncryptedEnvelope } from '../src/kernel/types.js'
import { NOYDB_FORMAT_VERSION } from '../src/kernel/types.js'

let oldDek: EnclaveKey
let newDek: EnclaveKey

const BODY = JSON.stringify({ id: 'r1', amount: 4200 })

beforeAll(async () => {
  oldDek = await generateDEK()
  newDek = await generateDEK()
})

const REF = { collection: 'c', id: 'r1' }

/**
 * #1041: a fixture must seal under the identity a reader recomputes — the
 * address PLUS `_tier`/`_by` as they will appear on the envelope. Sealing
 * before knowing `extra` would bind the wrong tier/author, so the AAD is built
 * from the finished shape.
 */
async function bareEnvelope(extra: Partial<EncryptedEnvelope> = {}): Promise<EncryptedEnvelope> {
  const aad = recordAadFor(REF, extra)
  const { iv, data } = await encrypt(BODY, oldDek, aad)
  return { _noydb: NOYDB_FORMAT_VERSION, _v: 7, _ts: '2026-01-01T00:00:00Z', _iv: iv, _data: data, ...extra }
}

describe('#1074 — rotation preserves envelope slots', () => {
  it('1. carries _tier — losing it made elevated records VANISH, not error', async () => {
    const out = await rekeyEnvelopeToDek(REF, await bareEnvelope({ _tier: 2 }), oldDek, newDek)
    expect(out._tier).toBe(2)
  })

  it('2. carries _by and provenance', async () => {
    const env = await bareEnvelope({ _by: 'alice', _source: 'registry', _sourceTs: '2026-01-01T00:00:00Z' })
    const out = await rekeyEnvelopeToDek(REF, env, oldDek, newDek)
    expect(out).toMatchObject({ _by: 'alice', _source: 'registry', _sourceTs: '2026-01-01T00:00:00Z' })
  })

  it('3. carries _sealed and _vdig', async () => {
    const env = await bareEnvelope({
      _sealed: { ssn: 'iv:blob' },
      _vdig: { ssn: 'iv:digest' },
    } as Partial<EncryptedEnvelope>)
    const out = await rekeyEnvelopeToDek(REF, env, oldDek, newDek)
    expect(out._sealed).toEqual({ ssn: 'iv:blob' })
    expect(out._vdig).toEqual({ ssn: 'iv:digest' })
  })

  it('4. preserves the record version — rotation is not a write', async () => {
    const out = await rekeyEnvelopeToDek(REF, await bareEnvelope(), oldDek, newDek)
    expect(out._v).toBe(7)
  })

  it('5. DROPS _bidx, deliberately', async () => {
    // DEK-rooted equality tag: carried across a rotation it can never re-derive
    // to match a query again, while still leaking the old equality partition.
    const env = await bareEnvelope({ _bidx: { email: 'tag' } } as Partial<EncryptedEnvelope>)
    const out = await rekeyEnvelopeToDek(REF, env, oldDek, newDek)
    expect('_bidx' in out).toBe(false)
  })

  it('6. the body actually re-keys — readable under the new DEK, not the old', async () => {
    const out = await rekeyEnvelopeToDek(REF, await bareEnvelope(), oldDek, newDek)
    // AAD is unchanged by a rotation — only the key moves (#1041).
    expect(await decrypt(out._iv, out._data, newDek, recordAadFor(REF, out))).toBe(BODY)
    await expect(decrypt(out._iv, out._data, oldDek, recordAadFor(REF, out))).rejects.toThrow()
  })

  it('7. a per-record-CEK record re-wraps its CEK and leaves the body ALONE', async () => {
    // The old inline code ran decrypt(body, oldDek) on these and threw, so
    // rotation could not complete on any collection holding a CEK record.
    const cek = await generateDEK()
    const { iv, data } = await encrypt(BODY, cek)
    const env: EncryptedEnvelope = {
      _noydb: NOYDB_FORMAT_VERSION, _v: 3, _ts: '2026-01-01T00:00:00Z',
      _iv: iv, _data: data, _cek: await wrapCek(cek, oldDek), _by: 'bob',
    }

    const out = await rekeyEnvelopeToDek(REF, env, oldDek, newDek)

    // Body bytes untouched — only the wrapping moved.
    expect(out._iv).toBe(iv)
    expect(out._data).toBe(data)
    expect(out._by).toBe('bob')
    // ...and the CEK now unwraps under the NEW dek, opening the same body.
    const rewrapped = await unwrapCek(out._cek!, newDek)
    expect(await decrypt(out._iv, out._data, rewrapped)).toBe(BODY)
    await expect(unwrapCek(out._cek!, oldDek)).rejects.toThrow()
  })

  it('8. every slot present on the input is present on the output, except _bidx', async () => {
    // Catches a slot added later that nobody remembers to carry — the exact
    // failure mode this issue is about, generalised.
    const env = await bareEnvelope({
      _by: 'alice', _tier: 1, _source: 'reg', _sourceTs: 'T',
      _sealed: { a: 'x' }, _vdig: { a: 'y' }, _bidx: { a: 'z' },
    } as Partial<EncryptedEnvelope>)
    const out = await rekeyEnvelopeToDek(REF, env, oldDek, newDek)

    const expected = Object.keys(env).filter(k => k !== '_bidx').sort()
    expect(Object.keys(out).sort()).toEqual(expected)
  })
})
