/**
 * C3 — `rotateRecordCek` / `revokeSealedRecord({ hard: true })` must re-encrypt
 * every `_vdig[field]` slot under the NEW CEK (same reconstructed AAD), or the
 * correct password would false-reject forever after a rotation.
 *
 * Self-contained at the codec level (no `put()` / collection dependency): we
 * seal a `_vdig` slot directly with the enclave helpers (same path as
 * `vdig-slot.test.ts`), stitch a minimal envelope under an OLD CEK, drive
 * `rotateRecordCek` via a hand-built {@link SealingContext}, then prove the
 * rotated slot opens under the NEW CEK and NOT the old one.
 * @module
 */
import { describe, it, expect } from 'vitest'
import { generateDEK, wrapCek, unwrapCek, encrypt, type EnclaveKey } from '../../src/kernel/enclave/index.js'
import { sealVdigPayload, openVdigPayload, type VdigPayload } from '../../src/kernel/enclave/classify/vdig.js'
import {
  rotateRecordCek, revokeSealedRecord, type SealingContext,
} from '../../src/kernel/enclave/record-keys/sealing.js'
import { inlineMemory, type InlineMemoryStore } from './harness.js'
import type { EncryptedEnvelope } from '../../src/kernel/types.js'

const COLL = 'users'
const ID = 'u1'
const FIELD = 'password'

const payload: VdigPayload = {
  v: 1, alg: 'PBKDF2-SHA256', iter: 600_000,
  cur: { salt: 'c2FsdA==', hash: 'aGFzaA==', at: '2026-07-04T00:00:00.000Z' },
}

/** Seed a live record: body + `_vdig[password]` slot sealed under `oldCek`. */
async function seed(store: InlineMemoryStore, dek: EnclaveKey, oldCek: EnclaveKey): Promise<void> {
  const { iv, data } = await encrypt(JSON.stringify({ name: 'Nok' }), oldCek)
  const blob = await sealVdigPayload(payload, oldCek, COLL, ID, FIELD)
  const env: EncryptedEnvelope = {
    _noydb: 1, _v: 1, _ts: '2026-07-04T00:00:00.000Z',
    _iv: iv, _data: data,
    _cek: await wrapCek(oldCek, dek),
    _vdig: { [FIELD]: blob },
  }
  await store.put('v1', COLL, ID, env)
}

/** A SealingContext bound to a fixed DEK, over the inline store. */
function ctxFor(store: InlineMemoryStore, dek: EnclaveKey): SealingContext {
  return {
    adapter: store,
    vault: 'v1',
    getDEK: async () => dek,
    actor: '',
    invalidateRecordCaches: async () => {},
  }
}

describe('C3 — CEK rotation preserves _vdig', () => {
  it('rotateRecordCek re-encrypts the slot under the new CEK (same AAD, still openable); old CEK no longer opens it', async () => {
    const store = inlineMemory()
    const dek = await generateDEK()
    const oldCek = await generateDEK()
    await seed(store, dek, oldCek)
    const before = store._dump('v1', COLL, ID)!

    await rotateRecordCek(ctxFor(store, dek), COLL, ID)

    const after = store._dump('v1', COLL, ID)!
    const slot = after._vdig?.[FIELD]
    expect(after._cek).not.toBe(before._cek)            // record re-keyed
    expect(slot).toBeDefined()
    expect(slot).not.toBe(before._vdig?.[FIELD])        // re-sealed, not orphaned bytes

    // Unwrap the rotated CEK and prove the digest survived rotation intact.
    const newCek = await unwrapCek(after._cek!, dek)
    const reopened = await openVdigPayload(slot!, newCek, COLL, ID, FIELD)
    expect(reopened).toEqual(payload)
    expect(reopened.cur.hash).toBe(payload.cur.hash)

    // The old CEK must NOT open the rotated slot (it was re-sealed under newCek).
    await expect(openVdigPayload(slot!, oldCek, COLL, ID, FIELD)).rejects.toThrow()
  }, 60_000)

  it('revokeSealedRecord({ hard: true }) delegates to rotateRecordCek and preserves _vdig', async () => {
    const store = inlineMemory()
    const dek = await generateDEK()
    const oldCek = await generateDEK()
    await seed(store, dek, oldCek)

    await revokeSealedRecord(ctxFor(store, dek), COLL, ID, 'some-pid', { hard: true })

    const after = store._dump('v1', COLL, ID)!
    const slot = after._vdig?.[FIELD]
    expect(slot).toBeDefined()
    const newCek = await unwrapCek(after._cek!, dek)
    const reopened = await openVdigPayload(slot!, newCek, COLL, ID, FIELD)
    expect(reopened.cur.hash).toBe(payload.cur.hash)
  }, 60_000)
})
