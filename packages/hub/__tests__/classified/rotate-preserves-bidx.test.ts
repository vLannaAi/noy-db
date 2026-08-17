/**
 * Task 7 — `rotateRecordCek` / `revokeSealedRecord({ hard: true })` must carry
 * `_bidx` VERBATIM (not recompute it): the tag is DEK-rooted and CEK-independent,
 * unlike `_vdig`/`_sealed` which are CEK-bound and get re-sealed above. Omitting
 * the carry would replay the #306 Slice-A data-loss bug on the equality index.
 *
 * The equatable public surface (`equatable: true`) doesn't exist until Task 10,
 * so a real `_bidx` tag can't be minted via `put()` yet. This test mirrors
 * `rotate-preserves-vdig.test.ts`'s self-contained, codec-level setup: seed a
 * minimal envelope directly (bypassing `put()`) with a SYNTHETIC `_bidx` tag,
 * then drive `rotateRecordCek` / `revokeSealedRecord` via a hand-built
 * {@link SealingContext} and assert the tag survives byte-for-byte.
 * @module
 */
import { describe, it, expect } from 'vitest'
import { buildRecordAad, generateDEK, wrapCek, encrypt, type EnclaveKey } from '../../src/kernel/enclave/index.js'
import {
  rotateRecordCek, revokeSealedRecord, type SealingContext,
} from '../../src/kernel/enclave/record-keys/sealing.js'
import { inlineMemory, type InlineMemoryStore } from './harness.js'
import type { EncryptedEnvelope } from '../../src/kernel/types.js'

const COLL = 'users'
const ID = 'u1'
const FIELD = 'password'
// Any valid 33-byte tag, base64-encoded — the carry is a verbatim byte copy,
// so a synthetic value faithfully exercises `live._bidx !== undefined ? ... `.
const SYNTHETIC_BIDX_TAG = Buffer.from(new Uint8Array(33).fill(7)).toString('base64')

/** Seed a live record: body + a synthetic `_bidx[password]` tag under `cek`. */
async function seed(store: InlineMemoryStore, dek: EnclaveKey, cek: EnclaveKey): Promise<void> {
  const { iv, data } = await encrypt(JSON.stringify({ name: 'Nok' }), cek, buildRecordAad({ collection: COLL, id: ID, version: 1 }))
  const env: EncryptedEnvelope = {
    _noydb: 1, _v: 1, _ts: '2026-07-04T00:00:00.000Z',
    _iv: iv, _data: data,
    _cek: await wrapCek(cek, dek),
    _bidx: { [FIELD]: SYNTHETIC_BIDX_TAG },
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

describe('rotateRecordCek / revokeSealedRecord carry _bidx', () => {
  it('rotateRecordCek preserves the _bidx tag verbatim', async () => {
    const store = inlineMemory()
    const dek = await generateDEK()
    const cek = await generateDEK()
    await seed(store, dek, cek)
    const before = store._dump('v1', COLL, ID)!

    await rotateRecordCek(ctxFor(store, dek), COLL, ID)

    const after = store._dump('v1', COLL, ID)!
    expect(after._cek).not.toBe(before._cek) // record re-keyed
    expect(after._bidx?.[FIELD]).toBe(before._bidx?.[FIELD]) // carried verbatim
    expect(after._bidx?.[FIELD]).toBe(SYNTHETIC_BIDX_TAG)
  }, 30_000)

  it('revokeSealedRecord({ hard: true }) preserves the _bidx tag verbatim', async () => {
    const store = inlineMemory()
    const dek = await generateDEK()
    const cek = await generateDEK()
    await seed(store, dek, cek)
    const before = store._dump('v1', COLL, ID)!

    await revokeSealedRecord(ctxFor(store, dek), COLL, ID, 'some-pid', { hard: true })

    const after = store._dump('v1', COLL, ID)!
    expect(after._cek).not.toBe(before._cek)
    expect(after._bidx?.[FIELD]).toBe(before._bidx?.[FIELD])
    expect(after._bidx?.[FIELD]).toBe(SYNTHETIC_BIDX_TAG)
  }, 30_000)
})
