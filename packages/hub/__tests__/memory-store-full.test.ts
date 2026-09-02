/**
 * `memoryStore({ full: true })` — the opt-in full-capability kernel store.
 *
 * The zero-config default deliberately implements the 6-method core only, so
 * `Noydb.listAccessibleVaults()` throws its documented capability error rather
 * than enumerating vaults under a store the caller never chose. `full: true`
 * is how a caller asks for the optional half — `listVaults` / `ping` / `tx` —
 * without changing what `createNoydb()` gives everyone else.
 *
 * Half of this file guards the DEFAULT. Adding the optional methods
 * unconditionally would be a silent behaviour change at the trust boundary,
 * and it would look like a feature.
 */
import { describe, it, expect } from 'vitest'
import { memoryStore } from '../src/kernel/memory-store.js'
import { ConflictError } from '../src/kernel/errors.js'
import type { EncryptedEnvelope } from '../src/kernel/types.js'

const env = (v: number): EncryptedEnvelope =>
  ({ _v: v, iv: 'aa', ct: 'bb' }) as unknown as EncryptedEnvelope

describe('memoryStore() — the default stays a 6-method core', () => {
  it('does not implement the optional methods', () => {
    const s = memoryStore()
    expect(typeof s.listVaults).toBe('undefined')
    expect(typeof s.ping).toBe('undefined')
    expect(typeof s.tx).toBe('undefined')
  })

  it('does not declare txAtomic', () => {
    expect(memoryStore().capabilities?.txAtomic).toBeUndefined()
  })

  it('keeps its counter clock (not wall-clock ms)', async () => {
    const t = await memoryStore().getStoreTime!()
    expect(t.earliest).toBe(1)
    expect(t.latest).toBe(1)
  })
})

describe('memoryStore({ full: true })', () => {
  it('implements listVaults / ping / tx', () => {
    const s = memoryStore({ full: true })
    expect(typeof s.listVaults).toBe('function')
    expect(typeof s.ping).toBe('function')
    expect(typeof s.tx).toBe('function')
  })

  it('declares txAtomic, because tx() exists (#845)', () => {
    expect(memoryStore({ full: true }).capabilities?.txAtomic).toBe(true)
  })

  it('listVaults enumerates every vault written to', async () => {
    const s = memoryStore({ full: true })
    await s.put('alpha', 'c', 'r1', env(1))
    await s.put('beta', 'c', 'r1', env(1))
    expect((await s.listVaults!()).sort()).toEqual(['alpha', 'beta'])
  })

  it('ping resolves true', async () => {
    await expect(memoryStore({ full: true }).ping!()).resolves.toBe(true)
  })

  it('tx applies every op', async () => {
    const s = memoryStore({ full: true })
    await s.tx!([
      { type: 'put', vault: 'v', collection: 'c', id: 'a', envelope: env(1) },
      { type: 'put', vault: 'v', collection: 'c', id: 'b', envelope: env(1) },
    ])
    expect(await s.get('v', 'c', 'a')).toEqual(env(1))
    expect(await s.get('v', 'c', 'b')).toEqual(env(1))
  })

  it('tx writes NOTHING when any expectedVersion mismatches', async () => {
    const s = memoryStore({ full: true })
    await s.put('v', 'c', 'a', env(1))
    await expect(
      s.tx!([
        { type: 'put', vault: 'v', collection: 'c', id: 'b', envelope: env(1) },
        { type: 'put', vault: 'v', collection: 'c', id: 'a', envelope: env(2), expectedVersion: 99 },
      ]),
    ).rejects.toBeInstanceOf(ConflictError)
    // The valid op preceded the conflicting one — it must not have landed.
    expect(await s.get('v', 'c', 'b')).toBeNull()
    expect(await s.get('v', 'c', 'a')).toEqual(env(1))
  })

  it('uses a monotonic wall-clock-ms store clock', async () => {
    const s = memoryStore({ full: true })
    const before = Date.now()
    const t1 = await s.getStoreTime!()
    const t2 = await s.getStoreTime!()
    expect(t1.earliest).toBeGreaterThanOrEqual(before)
    expect(t2.earliest).toBeGreaterThan(t1.earliest)
  })

  it('clockUncertaintyMs widens the returned interval', async () => {
    const t = await memoryStore({ full: true, clockUncertaintyMs: 50 }).getStoreTime!()
    expect(t.latest - t.earliest).toBe(100)
  })
})

describe('option validation — hub does not silently drop options', () => {
  it('rejects clockUncertaintyMs without full, naming the fix', () => {
    expect(() => memoryStore({ clockUncertaintyMs: 50 })).toThrow(/full: true/)
  })

  it('rejects an unknown option key', () => {
    expect(() => memoryStore({ fulll: true } as never)).toThrow(/fulll/)
  })
})
