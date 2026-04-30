import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '@noy-db/hub'
import { ConflictError, createNoydb } from '@noy-db/hub'
import { collectionStore, queryStore, syncStore } from '../src/index.js'

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

interface Invoice { id: string; amt: number; status: string }

async function setup() {
  const db = await createNoydb({ store: memory(), user: 'owner', secret: 'pw' })
  const vault = await db.openVault('acme')
  const coll = vault.collection<Invoice>('invoices')
  await coll.put('i1', { id: 'i1', amt: 100, status: 'draft' })
  await coll.put('i2', { id: 'i2', amt: 250, status: 'paid' })
  return { db, vault, coll }
}

// Tiny "drain" helper — waits for async subscribers to catch up.
const drain = () => new Promise(resolve => setImmediate(resolve))

describe('collectionStore', () => {
  it('emits loading:false with records after hydration', async () => {
    const { vault } = await setup()
    const store = collectionStore<Invoice>(vault, 'invoices')
    const snapshots: Array<{ records: readonly Invoice[]; loading: boolean }> = []
    const unsub = store.subscribe((s) => snapshots.push({ records: s.records, loading: s.loading }))
    await drain()
    await drain()
    unsub()
    store.stop()
    expect(snapshots[0]!.loading).toBe(true)
    const last = snapshots[snapshots.length - 1]!
    expect(last.loading).toBe(false)
    expect(last.records.map(r => r.id).sort()).toEqual(['i1', 'i2'])
  })

  it('re-emits on put via subscribe bridge', async () => {
    const { vault, coll } = await setup()
    const store = collectionStore<Invoice>(vault, 'invoices')
    const counts: number[] = []
    const unsub = store.subscribe((s) => counts.push(s.records.length))
    await drain(); await drain()
    await coll.put('i3', { id: 'i3', amt: 500, status: 'draft' })
    await drain(); await drain()
    unsub(); store.stop()
    expect(counts[counts.length - 1]).toBe(3)
  })
})

describe('queryStore', () => {
  it('runs the builder and re-runs on change events', async () => {
    const { vault, coll } = await setup()
    const store = queryStore<Invoice, Invoice[]>(
      vault, 'invoices',
      q => q.where('status', '==', 'paid').toArray(),
    )
    const snapshots: Array<Invoice[] | null> = []
    const unsub = store.subscribe((s) => snapshots.push(s.data))
    await drain(); await drain()
    await coll.put('i3', { id: 'i3', amt: 900, status: 'paid' })
    await drain(); await drain()
    unsub(); store.stop()
    const last = snapshots[snapshots.length - 1]
    expect(last?.map(r => r.id).sort()).toEqual(['i2', 'i3'])
  })

  it('surfaces errors via the store state', async () => {
    const { vault } = await setup()
    const store = queryStore<Invoice, Invoice[]>(
      vault, 'invoices',
      () => { throw new Error('nope') },
    )
    const errs: Array<Error | null> = []
    const unsub = store.subscribe((s) => errs.push(s.error))
    await drain()
    unsub(); store.stop()
    expect(errs.some(e => e?.message === 'nope')).toBe(true)
  })
})

describe('syncStore', () => {
  it('re-emits on every hub change event', async () => {
    const { db, coll } = await setup()
    const store = syncStore(db)
    const events: Array<{ vault: string; collection: string; id: string } | null> = []
    const unsub = store.subscribe((s) => {
      events.push(s.lastEvent ? {
        vault: s.lastEvent.vault,
        collection: s.lastEvent.collection,
        id: s.lastEvent.id,
      } : null)
    })
    await coll.put('ix', { id: 'ix', amt: 1, status: 'draft' })
    await drain()
    unsub(); store.stop()
    expect(events[0]).toBeNull() // initial snapshot
    expect(events.some(e => e?.id === 'ix')).toBe(true)
  })
})
