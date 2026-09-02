/**
 * #845 — `toMeter` returns a store, so it composes.
 *
 * The old shape (`{ store, meter }`) meant a meter could not be passed anywhere
 * a store was expected without destructuring first — which made metering
 * *several points* in a compound topology awkward. Returning a
 * `MeteredNoydbStore` (a real store carrying its own handle, shaped after
 * hub's `RoutedNoydbStore`) removes that.
 *
 * These tests pin the three properties that shape depends on.
 */
import { describe, expect, it } from 'vitest'
import { createNoydb, memoryStore, routeStore } from '@noy-db/hub'
import { toMeter } from '../src/index.js'

describe('#845 — toMeter composes as a store', () => {
  it('drops straight into createNoydb({ store })', async () => {
    const metered = toMeter(memoryStore({ full: true }))
    const db = await createNoydb({ store: metered, user: 'u', secret: 'x'.repeat(32) })
    const vault = await db.openVault('acme')
    await vault.collection<{ n: number }>('items').put('a', { n: 1 })

    expect(metered.meter.snapshot().totalCalls).toBeGreaterThan(0)
  })

  it('meters each backend independently inside routeStore', async () => {
    const main = toMeter(memoryStore({ full: true }))
    const blobs = toMeter(memoryStore({ full: true }))

    const routed = routeStore({ default: main, blobs })
    const db = await createNoydb({ store: routed, user: 'u', secret: 'y'.repeat(32) })
    const vault = await db.openVault('acme')
    await vault.collection<{ n: number }>('items').put('a', { n: 1 })

    // The default route saw traffic; each meter is addressable on its own.
    expect(main.meter.snapshot().totalCalls).toBeGreaterThan(0)
    expect(typeof blobs.meter.snapshot().totalCalls).toBe('number')
  })

  it('nests — a meter can wrap an already-metered store', async () => {
    const inner = toMeter(memoryStore({ full: true }))
    const outer = toMeter(inner)

    await outer.put('v', 'c', 'id', { _v: 1, _data: '{}' } as never)

    expect(outer.meter.snapshot().totalCalls).toBeGreaterThan(0)
    expect(inner.meter.snapshot().totalCalls).toBeGreaterThan(0)
  })

  it('with no inner store, is a self-contained metered in-memory store', async () => {
    const standalone = toMeter()

    await standalone.put('v', 'c', 'id', { _v: 1, _data: '{}' } as never)
    const got = await standalone.get('v', 'c', 'id')

    expect(got).not.toBeNull()
    expect(standalone.meter.snapshot().totalCalls).toBeGreaterThan(0)
  })

  it('never adds a method the inner store lacks', () => {
    // hub's built-in default implements the 6-method core + listPage only.
    const overBuiltIn = toMeter(memoryStore())
    expect(typeof overBuiltIn.tx).toBe('undefined')
    expect(typeof overBuiltIn.listVaults).toBe('undefined')

    // `full: true` adds the optional half, so the meter exposes it.
    const overFull = toMeter(memoryStore({ full: true }))
    expect(typeof overFull.tx).toBe('function')
    expect(typeof overFull.listVaults).toBe('function')
  })

  it('meters the optional surface, not just the 6-method core', async () => {
    const metered = toMeter(memoryStore({ full: true }))
    await metered.put('v', 'c', 'id', { _v: 1, _data: '{}' } as never)
    await metered.listPage!('v', 'c')
    await metered.getStoreTime!()

    const snap = metered.meter.snapshot()
    expect(snap.byMethod.listPage.count).toBe(1)
    expect(snap.byMethod.getStoreTime.count).toBe(1)
  })

  it('meters listVaults and ping when the inner store has them (#889)', async () => {
    const metered = toMeter(memoryStore({ full: true }))
    await metered.listVaults!()
    await metered.ping!()

    const snap = metered.meter.snapshot()
    expect(snap.byMethod.listVaults.count).toBe(1)
    expect(snap.byMethod.ping.count).toBe(1)
  })

  it('preserves the inner store name for routing and logging', () => {
    expect(toMeter(memoryStore({ full: true })).name).toBe('meter(memory)')
  })
})
