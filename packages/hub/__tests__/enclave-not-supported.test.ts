/**
 * EnclaveNotSupportedError — the optional-group refusal contract (C4).
 *
 * A fork's enclave must export every frozen barrel symbol, but its optional
 * groups (sealing, deterministic, per-record-keys) may throw this error
 * instead of working. noy-db's own core path (put/get/query) must never
 * throw it — this test pins that invariant against the reference enclave.
 */
import { describe, expect, it } from 'vitest'
import { EnclaveNotSupportedError, NoydbError, createNoydb, memoryStore } from '../src/index.js'

describe('EnclaveNotSupportedError contract', () => {
  it('is a NoydbError with the stable code', () => {
    const e = new EnclaveNotSupportedError('sealing')
    expect(e).toBeInstanceOf(NoydbError)
    expect(e.code).toBe('ENCLAVE_NOT_SUPPORTED')
    expect(e.message).toContain('sealing')
  })

  it('core path (put/get/query) never throws it', async () => {
    const db = await createNoydb({ store: memoryStore(), secret: 'pw-123456', user: 'owner' })
    const v = await db.openVault('t')
    const c = v.collection<{ a: number }>('c')
    await c.put('1', { a: 1 })
    expect(await c.get('1')).toEqual({ a: 1 })
    expect((await c.query().toArray()).length).toBe(1)
    db.close()
  })
})
