/**
 * Tests for `collection.subscribe(cb)` — v0.15.2 #243.
 *
 * Covers:
 *   - put fires with hydrated record
 *   - delete fires with record: null
 *   - events are filtered to the subscribing collection (not cross-collection)
 *   - returned unsubscribe actually detaches
 *   - works with records written post-subscribe (the intent)
 *   - multiple subscribers on same collection both fire
 *   - subscribing on one vault isolates from another vault
 */

import { describe, expect, it } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot, CollectionChangeEvent } from '../src/index.js'
import { ConflictError, createNoydb } from '../src/index.js'

function memory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const gc = (c: string, col: string) => {
    let comp = store.get(c); if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col); if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
    name: 'memory',
    async get(c, col, id) { return store.get(c)?.get(col)?.get(id) ?? null },
    async put(c, col, id, env, ev) {
      const coll = gc(c, col); const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      coll.set(id, env)
    },
    async delete(c, col, id) { store.get(c)?.get(col)?.delete(id) },
    async list(c, col) { const coll = store.get(c)?.get(col); return coll ? [...coll.keys()] : [] },
    async loadAll(c) {
      const comp = store.get(c); const s: VaultSnapshot = {}
      if (comp) for (const [n, coll] of comp) {
        if (!n.startsWith('_')) {
          const r: Record<string, EncryptedEnvelope> = {}
          for (const [id, e] of coll) r[id] = e
          s[n] = r
        }
      }
      return s
    },
    async saveAll(c, data) {
      for (const [n, recs] of Object.entries(data)) {
        const coll = gc(c, n)
        for (const [id, e] of Object.entries(recs)) coll.set(id, e)
      }
    },
  }
}

interface Invoice { id: string; client: string; amount: number }

// Allow the async get() inside subscribe() to resolve before assertions.
async function flushMicrotasks() {
  await Promise.resolve()
  await Promise.resolve()
}

describe('collection.subscribe', () => {
  it('fires on put with hydrated record', async () => {
    const db = await createNoydb({ store: memory(), user: 'o', secret: 'p' })
    const vault = await db.openVault('acme')
    const invoices = vault.collection<Invoice>('invoices')

    const events: CollectionChangeEvent<Invoice>[] = []
    const unsubscribe = invoices.subscribe(e => events.push(e))

    await invoices.put('inv-1', { id: 'inv-1', client: 'Globex', amount: 1500 })
    await flushMicrotasks()

    expect(events).toHaveLength(1)
    expect(events[0]!.type).toBe('put')
    expect(events[0]!.id).toBe('inv-1')
    expect(events[0]!.record).toEqual({ id: 'inv-1', client: 'Globex', amount: 1500 })

    unsubscribe()
    await db.close()
  })

  it('fires on delete with record: null', async () => {
    const db = await createNoydb({ store: memory(), user: 'o', secret: 'p' })
    const vault = await db.openVault('acme')
    const invoices = vault.collection<Invoice>('invoices')
    await invoices.put('inv-1', { id: 'inv-1', client: 'Globex', amount: 1500 })

    const events: CollectionChangeEvent<Invoice>[] = []
    const unsubscribe = invoices.subscribe(e => events.push(e))

    await invoices.delete('inv-1')
    await flushMicrotasks()

    expect(events).toHaveLength(1)
    expect(events[0]!.type).toBe('delete')
    expect(events[0]!.id).toBe('inv-1')
    expect(events[0]!.record).toBeNull()

    unsubscribe()
    await db.close()
  })

  it('filters to the subscribing collection — other collections do not fire', async () => {
    const db = await createNoydb({ store: memory(), user: 'o', secret: 'p' })
    const vault = await db.openVault('acme')
    const invoices = vault.collection<Invoice>('invoices')
    const payments = vault.collection<{ id: string; amount: number }>('payments')

    const events: CollectionChangeEvent<Invoice>[] = []
    const unsubscribe = invoices.subscribe(e => events.push(e))

    await payments.put('p-1', { id: 'p-1', amount: 500 })
    await flushMicrotasks()

    expect(events).toHaveLength(0)

    await invoices.put('inv-1', { id: 'inv-1', client: 'Globex', amount: 1500 })
    await flushMicrotasks()

    expect(events).toHaveLength(1)
    expect(events[0]!.id).toBe('inv-1')

    unsubscribe()
    await db.close()
  })

  it('unsubscribe() detaches the listener', async () => {
    const db = await createNoydb({ store: memory(), user: 'o', secret: 'p' })
    const vault = await db.openVault('acme')
    const invoices = vault.collection<Invoice>('invoices')

    const events: CollectionChangeEvent<Invoice>[] = []
    const unsubscribe = invoices.subscribe(e => events.push(e))

    await invoices.put('inv-1', { id: 'inv-1', client: 'Globex', amount: 1500 })
    await flushMicrotasks()
    expect(events).toHaveLength(1)

    unsubscribe()

    await invoices.put('inv-2', { id: 'inv-2', client: 'Acme', amount: 2000 })
    await flushMicrotasks()
    expect(events).toHaveLength(1) // still just the first one

    await db.close()
  })

  it('multiple subscribers on the same collection all fire', async () => {
    const db = await createNoydb({ store: memory(), user: 'o', secret: 'p' })
    const vault = await db.openVault('acme')
    const invoices = vault.collection<Invoice>('invoices')

    const a: CollectionChangeEvent<Invoice>[] = []
    const b: CollectionChangeEvent<Invoice>[] = []
    const unsubA = invoices.subscribe(e => a.push(e))
    const unsubB = invoices.subscribe(e => b.push(e))

    await invoices.put('inv-1', { id: 'inv-1', client: 'Globex', amount: 1500 })
    await flushMicrotasks()

    expect(a).toHaveLength(1)
    expect(b).toHaveLength(1)
    expect(a[0]!.id).toBe('inv-1')
    expect(b[0]!.id).toBe('inv-1')

    unsubA()
    unsubB()
    await db.close()
  })

  it('fires for put + update + delete in order', async () => {
    const db = await createNoydb({ store: memory(), user: 'o', secret: 'p' })
    const vault = await db.openVault('acme')
    const invoices = vault.collection<Invoice>('invoices')

    const events: CollectionChangeEvent<Invoice>[] = []
    const unsubscribe = invoices.subscribe(e => events.push(e))

    await invoices.put('inv-1', { id: 'inv-1', client: 'Globex', amount: 1500 })
    await flushMicrotasks()
    await invoices.put('inv-1', { id: 'inv-1', client: 'Globex', amount: 1600 })
    await flushMicrotasks()
    await invoices.delete('inv-1')
    await flushMicrotasks()

    expect(events.map(e => ({ type: e.type, id: e.id, amount: e.record?.amount ?? null }))).toEqual([
      { type: 'put', id: 'inv-1', amount: 1500 },
      { type: 'put', id: 'inv-1', amount: 1600 },
      { type: 'delete', id: 'inv-1', amount: null },
    ])

    unsubscribe()
    await db.close()
  })

  it('cross-vault isolation — subscribing on vault A does not receive vault B events', async () => {
    const db = await createNoydb({ store: memory(), user: 'o', secret: 'p' })
    const vaultA = await db.openVault('acme')
    const vaultB = await db.openVault('stark')
    const invoicesA = vaultA.collection<Invoice>('invoices')
    const invoicesB = vaultB.collection<Invoice>('invoices')

    const events: CollectionChangeEvent<Invoice>[] = []
    const unsubscribe = invoicesA.subscribe(e => events.push(e))

    await invoicesB.put('inv-1', { id: 'inv-1', client: 'Stark', amount: 9999 })
    await flushMicrotasks()
    expect(events).toHaveLength(0)

    await invoicesA.put('inv-1', { id: 'inv-1', client: 'Globex', amount: 1500 })
    await flushMicrotasks()
    expect(events).toHaveLength(1)
    expect(events[0]!.record?.client).toBe('Globex')

    unsubscribe()
    await db.close()
  })
})
