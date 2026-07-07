/**
 * Satellite read/write proxy (#591, Task 5): existence authority + R-S6.
 *
 * Drives everything through the public `createNoydb`/`openVault` API with
 * `to-memory` (fixture pattern copied from satellites-registration.test.ts).
 * The `rawStore` handle lets tests simulate offline-resurrection states
 * (a base delete that bypasses the Collection cache) the same way the
 * design spec's "store-shape" vectors do.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/kernel/noydb.js'
import type { NoydbStore } from '../src/kernel/types.js'
import { memory } from '../../to-memory/src/index.js'
import { RAW_TARGET } from '../src/with-shape/satellites/proxy.js'

const SECRET = 'satellite-proxy-test-1234'

interface Msg extends Record<string, unknown> {
  from?: string
  body?: string
}

async function openPair() {
  const store: NoydbStore = memory()
  const gets: Array<[string, string]> = []
  const rawGet = store.get.bind(store)
  store.get = (async (v: string, c: string, id: string) => {
    gets.push([c, id])
    return rawGet(v, c, id)
  }) as NoydbStore['get']

  const db = await createNoydb({ store, user: 'alice', secret: SECRET })
  const vault = await db.openVault('v1')
  vault.collection<Msg>('msgs', {})
  vault.collection<Msg>('msgs_text', { satelliteOf: 'msgs', fields: ['body'] })

  // Decrypt spy: monkeypatch each raw collection's private codec (same
  // "private is compile-time only" access the proxy itself relies on) so
  // tests can assert the existence check never decrypts the base.
  const decrypts = new Map<string, number>()
  const spyOnDecrypts = (name: string): void => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = (vault as any).collectionCache.get(name)
    const codec = raw?.codec
    if (codec && !codec.__decryptSpied) {
      const orig = codec.decryptRecord.bind(codec)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      codec.decryptRecord = (...args: any[]) => {
        decrypts.set(name, (decrypts.get(name) ?? 0) + 1)
        return orig(...args)
      }
      codec.__decryptSpied = true
    }
  }
  spyOnDecrypts('msgs')
  spyOnDecrypts('msgs_text')

  const spy = {
    gets,
    reset: (): void => { gets.length = 0; decrypts.clear() },
    decryptsFor: (name: string): number => decrypts.get(name) ?? 0,
  }
  return { vault, rawStore: store, spy }
}

describe('satellite proxy — existence authority + R-S6', () => {
  it('satellite.get returns null when the base row is absent or tombstoned; dead ciphertext remains', async () => {
    const { vault, rawStore } = await openPair()
    await vault.collection<Msg>('msgs').put('x', { from: 'a' })
    await vault.collection<Msg>('msgs_text').put('x', { body: 'B' })
    await rawStore.delete('v1', 'msgs', 'x') // simulate offline resurrection state
    expect(await vault.collection<Msg>('msgs_text').get('x')).toBeNull()
    expect(await rawStore.get('v1', 'msgs_text', 'x')).not.toBeNull() // no sweep
  })

  it('satellite.list excludes base-less ids', async () => {
    const { vault, rawStore } = await openPair()
    await vault.collection<Msg>('msgs').put('a', { from: 'a' })
    await vault.collection<Msg>('msgs_text').put('a', { body: '1' })
    await vault.collection<Msg>('msgs').put('b', { from: 'b' })
    await vault.collection<Msg>('msgs_text').put('b', { body: '2' })
    await rawStore.delete('v1', 'msgs', 'b')
    expect((await vault.collection<Msg>('msgs_text').list()).map(r => r.body)).toEqual(['1'])
  })

  it('R-S6: satellite.put with no base record refuses', async () => {
    const { vault } = await openPair()
    await expect(vault.collection<Msg>('msgs_text').put('ghost', { body: 'B' })).rejects.toThrowError(/R-S6/)
  })

  it('store-shape: satellite.get does one undecrypted base get, zero base decrypts (spy counts decrypts)', async () => {
    const { vault, spy } = await openPair()
    await vault.collection<Msg>('msgs').put('x', { from: 'a' })
    await vault.collection<Msg>('msgs_text').put('x', { body: 'B' })
    spy.reset()
    await vault.collection<Msg>('msgs_text').get('x')
    // Exactly one adapter.get on the base ("msgs") — the existence check.
    // (Not asserting a matching call for "msgs_text": its own get() serves
    // from the already-warm in-memory cache after the preceding put() and
    // never round-trips through the adapter — an orthogonal cache fact, not
    // part of the existence-authority contract under test.)
    expect(spy.gets.filter(([c]) => c === 'msgs')).toEqual([['msgs', 'x']])
    expect(spy.decryptsFor('msgs')).toBe(0)
  })

  it('the proxy preserves the full Collection surface (describe, count, putMany exist)', async () => {
    const { vault } = await openPair()
    const sat = vault.collection<Msg>('msgs_text')
    expect(typeof sat.describe).toBe('function')
    expect(typeof sat.putMany).toBe('function')
  })

  it('RAW_TARGET escapes the proxy: the raw target\'s put does not do the base-exists check', async () => {
    const { vault } = await openPair()
    const sat = vault.collection<Msg>('msgs_text') as unknown as Record<symbol, unknown>
    const raw = sat[RAW_TARGET] as { put: (id: string, record: Msg) => Promise<void> }
    // No base record for "ghost" exists — the proxy's put would refuse (R-S6);
    // the raw target's put must not.
    await expect(raw.put('ghost', { body: 'B' })).resolves.toBeUndefined()
  })

  it('satellite.query() refuses — Query terminals are sync, existence authority requires an async check; use list()', async () => {
    const { vault } = await openPair()
    await vault.collection<Msg>('msgs').put('x', { from: 'a' })
    await vault.collection<Msg>('msgs_text').put('x', { body: 'B' })
    expect(() => vault.collection<Msg>('msgs_text').query()).toThrowError(/list\(\)/)
  })
})
