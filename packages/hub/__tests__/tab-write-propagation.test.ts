import { describe, expect, it } from 'vitest'
import { createNoydb } from '../src/noydb.js'
import { withHistory } from '../src/history/index.js'
import { memory } from '../../to-memory/src/index.js'
import type { TabChannel } from '../src/tab-coordination.js'

/** In-memory broadcast bus (each send reaches all OTHER channels). */
function makeBus(n: number): TabChannel[] {
  const listeners: Array<((p: string) => void) | null> = []
  const chans: TabChannel[] = []
  for (let i = 0; i < n; i++) {
    const idx = i
    chans.push({
      isOpen: true,
      send(payload) { for (let j = 0; j < listeners.length; j++) if (j !== idx && listeners[j]) queueMicrotask(() => listeners[j]!(payload)) },
      on(event, l) { if (event === 'message') { listeners[idx] = l as (p: string) => void; return () => { listeners[idx] = null } } return () => {} },
      close() { listeners[idx] = null },
    })
  }
  return chans
}
const settle = async () => { await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)) }

interface Inv extends Record<string, unknown> { id: string; amount: number }
const SECRET = 'tab-prop-pass-1234'

/**
 * Two same-origin/same-user "tabs" sharing one store. db1 seeds a write FIRST
 * so the per-collection DEK is minted + persisted; only then is db2 created, so
 * it loads the same keyring + DEK (otherwise each tab mints its own DEK and the
 * cross-read fails with TamperedError). See persistence.test.ts:41.
 */
async function twoTabs(store = memory()) {
  const db1 = await createNoydb({ store, user: 'alice', secret: SECRET, historyStrategy: withHistory() })
  const v1 = await db1.openVault('books'); const c1 = v1.collection<Inv>('invoices')
  await c1.put('seed', { id: 'seed', amount: 0 }) // mint + persist the invoices DEK
  const db2 = await createNoydb({ store, user: 'alice', secret: SECRET, historyStrategy: withHistory() })
  const v2 = await db2.openVault('books'); const c2 = v2.collection<Inv>('invoices')
  return { store, db1, db2, v1, v2, c1, c2 }
}

describe('apply primitives (#228b)', () => {
  it('_applyRemoteChange refreshes the cache from the shared store and emits change', async () => {
    const { db1, db2, v2, c1, c2 } = await twoTabs()
    await c2.get('seed') // hydrate db2's eager cache (loads the shared DEK too)
    let changed = 0
    db2.on('change', (e) => { if (e.id === 'i1') changed++ })

    await c1.put('i1', { id: 'i1', amount: 7 })       // db1 persists to the shared store
    expect(await c2.get('i1')).toBeNull()              // db2 hasn't seen it yet (stale cache)

    await v2._applyRemoteWrite('invoices', 'i1', 'put') // simulate the relay's apply
    expect(await c2.get('i1')).toMatchObject({ amount: 7 })
    expect(changed).toBe(1)
    db1.close(); db2.close()
  })

  it('_applyRemoteWrite is a no-op for an unloaded collection', async () => {
    const db = await createNoydb({ store: memory(), user: 'alice', secret: SECRET })
    const v = await db.openVault('books')
    await expect(v._applyRemoteWrite('not-loaded', 'x', 'put')).resolves.toBeUndefined()
    db.close()
  })
})

describe('end-to-end cross-tab propagation (#228b)', () => {
  it('a put in one tab refreshes the other; delete removes it', async () => {
    const { db1, db2, c1, c2 } = await twoTabs()
    const [wA, wB] = makeBus(2) // shared write-bus
    db1.enableTabCoordination({ writeChannel: wA!, tabId: 'A' })
    db2.enableTabCoordination({ writeChannel: wB!, tabId: 'B' })
    await c2.get('seed') // hydrate db2

    await c1.put('i1', { id: 'i1', amount: 5 })
    await settle()
    expect(await c2.get('i1')).toMatchObject({ amount: 5 }) // propagated put

    await c1.delete('i1')
    await settle()
    expect(await c2.get('i1')).toBeNull() // propagated delete

    db1.close(); db2.close()
  })

  it('propagateWrites:false disables it; and it no-ops with no channel', async () => {
    const { db1, db2, c1, c2 } = await twoTabs()
    const [wA, wB] = makeBus(2)
    db1.enableTabCoordination({ writeChannel: wA!, tabId: 'A' })
    db2.enableTabCoordination({ writeChannel: wB!, tabId: 'B', propagateWrites: false })
    await c2.get('seed')

    await c1.put('i1', { id: 'i1', amount: 9 })
    await settle()
    expect(await c2.get('i1')).toBeNull() // db2 opted out → no refresh

    // no channel at all (node default) → enabling is a safe no-op, no throw
    const db3 = await createNoydb({ store: memory(), user: 'bob', secret: SECRET })
    expect(() => db3.enableTabCoordination()).not.toThrow()
    db1.close(); db2.close(); db3.close()
  })
})

describe('capture + converge primitive (#228c)', () => {
  it('_captureAndConverge yields local (clobbered), remote (store), base (ancestor)', async () => {
    const { db1, db2, v2, c1, c2 } = await twoTabs() // db1 seeded { seed, amount:0 } @v1
    await c2.get('seed')              // db2 caches seed @v1
    await c1.put('seed', { id: 'seed', amount: 99 }) // db1 overwrites in shared store @v2

    const cap = await v2._captureAndConverge('invoices', 'seed', 'put', 1)
    expect(cap).not.toBeNull()
    expect((cap!.local as { amount: number }).amount).toBe(0)   // db2's pre-converge cache
    expect((cap!.remote as { amount: number }).amount).toBe(99) // store after converge
    expect((cap!.base as { amount: number }).amount).toBe(0)    // ancestor @v1 from history
    db1.close(); db2.close()
  })

  it('_captureAndConverge returns null for an unloaded collection', async () => {
    const db = await createNoydb({ store: memory(), user: 'alice', secret: SECRET })
    const v = await db.openVault('books')
    expect(await v._captureAndConverge('not-loaded', 'x', 'put', 0)).toBeNull()
    db.close()
  })

  it('remote is read from the store in lazy mode (LRU evicted on converge)', async () => {
    const store = memory()
    const db1 = await createNoydb({ store, user: 'alice', secret: SECRET, historyStrategy: withHistory() })
    const c1 = (await db1.openVault('books')).collection<Inv>('invoices', { prefetch: false, cache: { maxRecords: 100 } })
    await c1.put('lz', { id: 'lz', amount: 1 })
    const db2 = await createNoydb({ store, user: 'alice', secret: SECRET, historyStrategy: withHistory() })
    const v2 = await db2.openVault('books')
    const c2 = v2.collection<Inv>('invoices', { prefetch: false, cache: { maxRecords: 100 } })
    await c2.get('lz')                               // hydrate db2's LRU @v1
    await c1.put('lz', { id: 'lz', amount: 42 })     // db1 overwrites in the shared store

    const cap = await v2._captureAndConverge('invoices', 'lz', 'put', 1)
    expect((cap!.local as { amount: number }).amount).toBe(1)   // pre-converge LRU value
    expect((cap!.remote as { amount: number }).amount).toBe(42) // read from store, NOT a null evicted LRU
    db1.close(); db2.close()
  })
})
