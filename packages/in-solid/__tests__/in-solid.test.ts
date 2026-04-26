import { describe, it, expect } from 'vitest'
import { createRoot } from 'solid-js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '@noy-db/hub'
import { ConflictError, createNoydb } from '@noy-db/hub'
import type { Vault, Noydb } from '@noy-db/hub'
import { createCollectionSignal, createQuerySignal, createSyncSignal } from '../src/index.js'

function memory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const gc = (v: string, c: string): Map<string, EncryptedEnvelope> => {
    let vm = store.get(v); if (!vm) { vm = new Map(); store.set(v, vm) }
    let cm = vm.get(c); if (!cm) { cm = new Map(); vm.set(c, cm) }
    return cm
  }
  return {
    name: 'memory',
    async get(v, c, id) { return store.get(v)?.get(c)?.get(id) ?? null },
    async put(v, c, id, env, ev) {
      const cm = gc(v, c); const ex = cm.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      cm.set(id, env)
    },
    async delete(v, c, id) { store.get(v)?.get(c)?.delete(id) },
    async list(v, c) { return [...(store.get(v)?.get(c)?.keys() ?? [])] },
    async loadAll(v) {
      const vm = store.get(v); const snap: VaultSnapshot = {}
      if (vm) for (const [n, cm] of vm) {
        if (n.startsWith('_')) continue
        const r: Record<string, EncryptedEnvelope> = {}
        for (const [id, e] of cm) r[id] = e
        snap[n] = r
      }
      return snap
    },
    async saveAll(v, data) {
      for (const [n, recs] of Object.entries(data)) {
        const cm = gc(v, n)
        for (const [id, e] of Object.entries(recs)) cm.set(id, e)
      }
    },
  }
}

interface Invoice { id: string; amt: number }

async function setup(): Promise<{ db: Noydb; vault: Vault }> {
  const db = await createNoydb({ store: memory(), user: 'owner', secret: 'pw' })
  const vault = await db.openVault('acme')
  const coll = vault.collection<Invoice>('invoices')
  await coll.put('i1', { id: 'i1', amt: 100 })
  await coll.put('i2', { id: 'i2', amt: 250 })
  return { db, vault }
}

const drain = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 20))

describe('createCollectionSignal', () => {
  it('starts loading and resolves to records', async () => {
    const { vault } = await setup()
    await createRoot(async (dispose) => {
      const [records, loading] = createCollectionSignal<Invoice>(vault, 'invoices')
      expect(loading()).toBe(true)
      await drain()
      expect(loading()).toBe(false)
      expect(records().map(r => r.id).sort()).toEqual(['i1', 'i2'])
      dispose()
    })
  })

  it('re-emits when a record is added', async () => {
    const { vault } = await setup()
    await createRoot(async (dispose) => {
      const coll = vault.collection<Invoice>('invoices')
      const [records, loading] = createCollectionSignal<Invoice>(vault, 'invoices')
      await drain()
      expect(loading()).toBe(false)
      await coll.put('i3', { id: 'i3', amt: 500 })
      await drain()
      expect(records().map(r => r.id)).toContain('i3')
      dispose()
    })
  })

  it('stops updating after dispose', async () => {
    const { vault } = await setup()
    const coll = vault.collection<Invoice>('invoices')
    let disposeRoot!: () => void
    let recordsAccessor!: () => Invoice[]

    await createRoot(async (dispose) => {
      disposeRoot = dispose
      const [records] = createCollectionSignal<Invoice>(vault, 'invoices')
      recordsAccessor = records
      await drain()
    })

    // Before dispose: records are loaded
    expect(recordsAccessor().map(r => r.id).sort()).toEqual(['i1', 'i2'])

    disposeRoot()

    // After dispose: the subscription is torn down, so new writes do NOT
    // cause the signal to refresh. The accessor still returns the last
    // value (signals don't "unmount"), but no new value arrives.
    const snapshotBeforeWrite = recordsAccessor().map(r => r.id).sort()
    await coll.put('i4', { id: 'i4', amt: 999 })
    await drain()
    const snapshotAfterWrite = recordsAccessor().map(r => r.id).sort()
    expect(snapshotAfterWrite).toEqual(snapshotBeforeWrite)
    expect(snapshotAfterWrite).not.toContain('i4')
  })
})

describe('createQuerySignal', () => {
  it('re-runs builder on collection change', async () => {
    const { vault } = await setup()
    await createRoot(async (dispose) => {
      const coll = vault.collection<Invoice>('invoices')
      const [data, loading] = createQuerySignal<Invoice, number>(
        vault,
        'invoices',
        (q) => q.count(),
      )
      await drain()
      expect(loading()).toBe(false)
      expect(data()).toBe(2)
      await coll.put('i3', { id: 'i3', amt: 99 })
      await drain()
      expect(data()).toBe(3)
      dispose()
    })
  })
})

describe('createQuerySignal — error accessor', () => {
  it('populates the error signal when the builder throws', async () => {
    // #279 item #9 — the third accessor returned from createQuerySignal
    // was unexercised. A builder that throws surfaces as a non-null
    // error signal, with loading flipped back to false.
    const { vault } = await setup()
    await createRoot(async (dispose) => {
      const failure = new Error('builder blew up')
      const [data, loading, error] = createQuerySignal<Invoice, Invoice[]>(
        vault,
        'invoices',
        () => { throw failure },
      )
      await drain()
      expect(loading()).toBe(false)
      expect(data()).toBeNull()
      expect(error()).toBe(failure)
      dispose()
    })
  })

  it('clears the error signal on a successful subsequent refresh', async () => {
    // Once the underlying condition resolves (subscribe-triggered
    // refresh), error() should flip back to null. Uses a stateful
    // counter the builder consults so first invocation throws,
    // subsequent ones succeed.
    const { vault } = await setup()
    await createRoot(async (dispose) => {
      let calls = 0
      const [data, , error] = createQuerySignal<Invoice, Invoice[]>(
        vault,
        'invoices',
        (q) => {
          calls++
          if (calls === 1) throw new Error('first call fails')
          return q.toArray()
        },
      )
      await drain()
      expect(error()).not.toBeNull()

      // Trigger a re-subscribe: any collection mutation fires the
      // listener, which re-runs the builder.
      const coll = vault.collection<Invoice>('invoices')
      await coll.put('i3', { id: 'i3', amt: 1 })
      await drain()
      expect(error()).toBeNull()
      expect(data()?.length).toBeGreaterThan(0)
      dispose()
    })
  })
})

describe('createSyncSignal', () => {
  it('updates when any collection write fires', async () => {
    const { db, vault } = await setup()
    await createRoot(async (dispose) => {
      const lastEvent = createSyncSignal(db)
      expect(lastEvent()).toBeNull()
      const coll = vault.collection<Invoice>('invoices')
      await coll.put('i3', { id: 'i3', amt: 0 })
      await drain()
      expect(lastEvent()).not.toBeNull()
      expect(lastEvent()?.action).toBe('put')
      dispose()
    })
  })
})
