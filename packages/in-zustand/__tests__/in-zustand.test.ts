import { describe, it, expect, beforeEach } from 'vitest'
import { createStore } from 'zustand/vanilla'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '@noy-db/hub'
import { ConflictError, createNoydb } from '@noy-db/hub'
import type { Collection } from '@noy-db/hub'
import { createNoydbStore, type NoydbZustandSlice } from '../src/index.js'

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

async function setup(): Promise<{ coll: Collection<Invoice>; zustand: ReturnType<typeof createStore<NoydbZustandSlice<Invoice>>> }> {
  const db = await createNoydb({ store: memory(), user: 'owner', secret: 'pw' })
  const vault = await db.openVault('acme')
  const coll = vault.collection<Invoice>('invoices')
  await coll.put('i1', { id: 'i1', amt: 100 })
  await coll.put('i2', { id: 'i2', amt: 250 })

  const zustand = createStore<NoydbZustandSlice<Invoice>>(createNoydbStore(() => coll))
  return { coll, zustand }
}

async function waitForHydration<T>(zs: ReturnType<typeof createStore<NoydbZustandSlice<T>>>): Promise<void> {
  await new Promise<void>((resolve) => {
    if (!zs.getState().loading) return resolve()
    const unsub = zs.subscribe((s) => {
      if (!s.loading) { unsub(); resolve() }
    })
  })
}

describe('@noy-db/in-zustand', () => {
  it('hydrates records from the collection', async () => {
    const { zustand } = await setup()
    await waitForHydration(zustand)
    const state = zustand.getState()
    expect(state.loading).toBe(false)
    expect(Object.keys(state.records).sort()).toEqual(['i1', 'i2'])
    expect(state.records.i1).toEqual({ id: 'i1', amt: 100 })
  })

  it('put goes through the collection', async () => {
    const { coll, zustand } = await setup()
    await waitForHydration(zustand)
    await zustand.getState().put('i3', { id: 'i3', amt: 500 })
    expect(await coll.get('i3')).toEqual({ id: 'i3', amt: 500 })
  })

  it('remove goes through the collection', async () => {
    const { coll, zustand } = await setup()
    await waitForHydration(zustand)
    await zustand.getState().remove('i1')
    expect(await coll.get('i1')).toBeNull()
  })

  it('subscribes to collection changes and auto-refreshes', async () => {
    const { coll, zustand } = await setup()
    await waitForHydration(zustand)
    await coll.put('i4', { id: 'i4', amt: 750 })
    // Allow the subscribe → refresh cycle to flush.
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setImmediate(resolve))
    expect(zustand.getState().records.i4).toEqual({ id: 'i4', amt: 750 })
  })

  it('refresh() re-hydrates on demand', async () => {
    const { coll, zustand } = await setup()
    await waitForHydration(zustand)
    // Mutate without firing the subscribe callback by bypassing the collection.
    await coll.put('i5', { id: 'i5', amt: 42 })
    await zustand.getState().refresh()
    expect(zustand.getState().records.i5).toEqual({ id: 'i5', amt: 42 })
  })
})
