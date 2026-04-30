import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot, ChangeEvent } from '@noy-db/hub'
import { ConflictError, createNoydb } from '@noy-db/hub'
import { withI18n } from '@noy-db/hub/i18n'

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

describe('DictionaryHandle — change event emission', () => {
  it('put() emits a change event with action:put', async () => {
    const db = await createNoydb({ store: memory(), user: 'owner', i18nStrategy: withI18n(), secret: 'pw' })
    const vault = await db.openVault('acme')
    const events: ChangeEvent[] = []
    db.on('change', (e) => events.push(e))

    await vault.dictionary('status').put('paid', { en: 'Paid', th: 'ชำระแล้ว' })

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ vault: 'acme', collection: '_dict_status', id: 'paid', action: 'put' })
  })

  it('delete() emits a change event with action:delete', async () => {
    const db = await createNoydb({ store: memory(), user: 'owner', i18nStrategy: withI18n(), secret: 'pw' })
    const vault = await db.openVault('acme')
    await vault.dictionary('status').put('draft', { en: 'Draft' })
    const events: ChangeEvent[] = []
    db.on('change', (e) => events.push(e))

    await vault.dictionary('status').delete('draft', { mode: 'warn' })

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ vault: 'acme', collection: '_dict_status', id: 'draft', action: 'delete' })
  })

  it('rename() emits delete for old key then put for new key', async () => {
    const db = await createNoydb({ store: memory(), user: 'owner', i18nStrategy: withI18n(), secret: 'pw' })
    const vault = await db.openVault('acme')
    await vault.dictionary('status').put('open', { en: 'Open' })
    const events: ChangeEvent[] = []
    db.on('change', (e) => events.push(e))

    await vault.dictionary('status').rename('open', 'active')

    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ vault: 'acme', collection: '_dict_status', id: 'open', action: 'delete' })
    expect(events[1]).toMatchObject({ vault: 'acme', collection: '_dict_status', id: 'active', action: 'put' })
  })

  it('putAll() emits one change event per key', async () => {
    const db = await createNoydb({ store: memory(), user: 'owner', i18nStrategy: withI18n(), secret: 'pw' })
    const vault = await db.openVault('acme')
    const events: ChangeEvent[] = []
    db.on('change', (e) => events.push(e))

    await vault.dictionary('status').putAll({
      draft: { en: 'Draft' },
      paid: { en: 'Paid' },
    })

    expect(events).toHaveLength(2)
    expect(events.map(e => e.id).sort()).toEqual(['draft', 'paid'])
    expect(events.every(e => e.action === 'put')).toBe(true)
  })
})
