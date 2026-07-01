/**
 * Unit tests for the CEK write-path lifecycle helpers extracted into
 * src/record-keys/lifecycle.ts (extraction slice 2).
 *
 * These pin the two contracts the kernel delegates to: the stable-CEK rule
 * (resolveStableCek) and the same-body-key tier/bundle re-wrap
 * (rewrapBodyToDek). End-to-end tier/seal behaviour is covered through the
 * Collection/Vault integration tests; here we exercise the functions directly.
 */
import { describe, it, expect } from 'vitest'
import { generateDEK, encrypt, decrypt } from '../../src/kernel/enclave/crypto.js'
import {
  resolveStableCek,
  rewrapBodyToDek,
  wrapCek,
  unwrapCek,
} from '../../src/record-keys/index.js'
import { Lru } from '../../src/cache/index.js'
import { NOYDB_FORMAT_VERSION, type EncryptedEnvelope } from '../../src/types.js'

async function cekEnvelope(body: string, dek: CryptoKey): Promise<{ env: EncryptedEnvelope; cek: CryptoKey }> {
  const cek = await generateDEK()
  const { iv, data } = await encrypt(body, cek)
  return {
    cek,
    env: { _noydb: NOYDB_FORMAT_VERSION, _v: 1, _ts: 't', _iv: iv, _data: data, _cek: await wrapCek(cek, dek) },
  }
}

describe('resolveStableCek', () => {
  it('mints a fresh CEK for a genuine insert (no live envelope) and caches it', async () => {
    const cache = new Lru<string, CryptoKey>({ maxRecords: 8 })
    const cek = await resolveStableCek({ cache, getLive: async () => null, getDEK: generateDEK }, 'r1')
    expect(cache.get('r1')).toBe(cek)
  })

  it('reuses an existing record CEK by unwrapping the live _cek', async () => {
    const dek = await generateDEK()
    const { env, cek } = await cekEnvelope('{"a":1}', dek)
    const resolved = await resolveStableCek(
      { cache: null, getLive: async () => env, getDEK: async () => dek },
      'r2',
    )
    // Same key bytes: a body encrypted under `cek` decrypts under `resolved`.
    const { iv, data } = await encrypt('{"a":1}', cek)
    expect(await decrypt(iv, data, resolved)).toBe('{"a":1}')
  })

  it('prefers the cache over a live read (stable CEK across an update)', async () => {
    const cache = new Lru<string, CryptoKey>({ maxRecords: 8 })
    const cached = await generateDEK()
    cache.set('r3', cached, 1)
    let liveReads = 0
    const got = await resolveStableCek(
      { cache, getLive: async () => { liveReads++; return null }, getDEK: generateDEK },
      'r3',
    )
    expect(got).toBe(cached)
    expect(liveReads).toBe(0)
  })
})

describe('rewrapBodyToDek', () => {
  it('moves a CEK record from one DEK to another, preserving the body key', async () => {
    const fromDek = await generateDEK()
    const toDek = await generateDEK()
    const { env, cek } = await cekEnvelope('{"v":42}', fromDek)

    const r = await rewrapBodyToDek(env, fromDek, toDek)
    expect(r._cek).toBeDefined()
    expect(r.cek).not.toBeNull()

    // The new _cek unwraps under the DESTINATION DEK to the SAME body key.
    const movedCek = await unwrapCek(r._cek!, toDek)
    expect(await decrypt(r._iv, r._data, movedCek)).toBe('{"v":42}')
    // And the original body key still decrypts the re-encrypted body (same key).
    expect(await decrypt(r._iv, r._data, cek)).toBe('{"v":42}')
  })

  it('re-encrypts a legacy (no _cek) body directly under the destination DEK', async () => {
    const fromDek = await generateDEK()
    const toDek = await generateDEK()
    const { iv, data } = await encrypt('{"legacy":true}', fromDek)
    const env: EncryptedEnvelope = { _noydb: NOYDB_FORMAT_VERSION, _v: 1, _ts: 't', _iv: iv, _data: data }

    const r = await rewrapBodyToDek(env, fromDek, toDek)
    expect(r._cek).toBeUndefined()
    expect(r.cek).toBeNull()
    expect(await decrypt(r._iv, r._data, toDek)).toBe('{"legacy":true}')
  })
})
