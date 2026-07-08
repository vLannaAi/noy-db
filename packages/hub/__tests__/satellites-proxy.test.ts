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
import { RAW_TARGET, makeSatelliteProxy } from '../src/with-shape/satellites/proxy.js'
import { SatelliteConfigError } from '../src/kernel/errors.js'

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

  it('satellite.query() refuses with SatelliteConfigError — Query terminals are sync, existence authority requires an async check; use list()', async () => {
    const { vault } = await openPair()
    await vault.collection<Msg>('msgs').put('x', { from: 'a' })
    await vault.collection<Msg>('msgs_text').put('x', { body: 'B' })
    expect(() => vault.collection<Msg>('msgs_text').query()).toThrowError(SatelliteConfigError)
    expect(() => vault.collection<Msg>('msgs_text').query()).toThrowError(/list\(\)/)
  })

  it('poison check runs INSIDE the pair lock: a put queued behind a poisoning section rejects', async () => {
    // Unit-level on makeSatelliteProxy with a stub target: the vault fixture
    // can't distinguish the orderings because the Noydb-wide onBeforeWrite
    // poison hook (Task 4) rejects the write either way (defense-in-depth
    // masking). Here there is no write hook — only the proxy's own check.
    const { SatelliteRegistry } = await import('../src/with-shape/satellites/registry.js')
    const registry = new SatelliteRegistry()
    const spec = { base: 'msgs', satellite: 'msgs_text', fields: ['body'] as const, joined: undefined }
    registry.register(spec)
    const liveEnv = { _noydb: 1, _v: 1, _ts: 't', _iv: 'iv', _data: 'd' }
    const target = {
      adapter: { get: async () => liveEnv }, // base always live — only poison can refuse
      vault: 'v1',
      put: async () => undefined,
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const proxied = makeSatelliteProxy(target as any, spec, registry)
    // Occupy the pair lock; poison the satellite inside the held section
    // (models a concurrent fan-out's failure path poisoning under the lock).
    let release!: () => void
    const gate = new Promise<void>(res => { release = res })
    const holding = registry.withPairLock('msgs', async () => {
      await gate
      registry.poison('msgs_text', 'R-S1: poisoned during fan-out (ordering test)')
    })
    // Queue the put behind the held lock. Its poison check must run AFTER
    // acquisition — i.e. after the poisoning section completes — so it rejects.
    const blocked = proxied.put('x', { body: 'B' })
    release()
    await holding
    await expect(blocked).rejects.toThrowError(/poisoned during fan-out/)
  })
})

describe('satellite proxy — bulk methods honor the same overrides as their single-item counterpart (#591 review I1)', () => {
  it('satellite.getMany excludes dead-base ids (real getMany binds to the raw get, bypassing existence filtering)', async () => {
    const { vault, rawStore } = await openPair()
    await vault.collection<Msg>('msgs').put('a', { from: 'a' })
    await vault.collection<Msg>('msgs_text').put('a', { body: '1' })
    await vault.collection<Msg>('msgs').put('b', { from: 'b' })
    await vault.collection<Msg>('msgs_text').put('b', { body: '2' })
    await rawStore.delete('v1', 'msgs', 'b') // simulate offline resurrection state

    const result = await vault.collection<Msg>('msgs_text').getMany(['a', 'b'])

    expect(result.get('a')).toEqual({ body: '1' })
    expect(result.get('b')).toBeNull() // dead base -> null, matching real getMany's missing-record shape
  })

  it('satellite.putMany (non-atomic) refuses an orphan id as a FAILURE entry, not a throw, and still writes live ids', async () => {
    const { vault } = await openPair()
    await vault.collection<Msg>('msgs').put('a', { from: 'a' })

    const result = await vault.collection<Msg>('msgs_text').putMany([
      ['a', { body: '1' }],
      ['ghost', { body: '2' }], // no live base -> R-S6
    ])

    expect(result.ok).toBe(false)
    expect(result.success).toEqual(['a'])
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]!.id).toBe('ghost')
    expect(result.failures[0]!.error.message).toMatch(/R-S6/)
    expect(await vault.collection<Msg>('msgs_text').get('a')).toEqual({ body: '1' })
  })

  it('satellite.putMany({ atomic: true }) refuses the WHOLE call with R-S6 when any id lacks a live base', async () => {
    const { vault, rawStore } = await openPair()
    await vault.collection<Msg>('msgs').put('a', { from: 'a' })

    await expect(vault.collection<Msg>('msgs_text').putMany(
      [['a', { body: '1' }], ['ghost', { body: '2' }]],
      { atomic: true },
    )).rejects.toThrowError(/R-S6/)
    // Whole call refused up front — not even the live id was written.
    expect(await rawStore.get('v1', 'msgs_text', 'a')).toBeNull()
  })

  it('base.deleteMany fans out both legs per id (real deleteMany binds to the raw delete, bypassing pairDelete)', async () => {
    const { vault, rawStore } = await openPair()
    await vault.collection<Msg>('msgs').put('a', { from: 'a' })
    await vault.collection<Msg>('msgs_text').put('a', { body: '1' })
    await vault.collection<Msg>('msgs').put('b', { from: 'b' })
    await vault.collection<Msg>('msgs_text').put('b', { body: '2' })

    const result = await vault.collection<Msg>('msgs').deleteMany(['a', 'b'])

    expect(result.ok).toBe(true)
    expect([...result.success].sort()).toEqual(['a', 'b'])
    expect(await rawStore.get('v1', 'msgs', 'a')).toBeNull()
    expect(await rawStore.get('v1', 'msgs_text', 'a')).toBeNull() // satellite leg fanned out
    expect(await rawStore.get('v1', 'msgs', 'b')).toBeNull()
    expect(await rawStore.get('v1', 'msgs_text', 'b')).toBeNull()
  })
})
