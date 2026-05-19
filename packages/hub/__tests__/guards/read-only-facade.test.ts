import { describe, it, expect } from 'vitest'
import { createNoydb } from '../../src/index.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../../src/types.js'
import { ConflictError } from '../../src/errors.js'
import { ReadOnlyVaultFacade } from '../../src/guards/read-only-facade.js'

function memory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function getCollection(c: string, col: string) {
    let comp = store.get(c)
    if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col)
    if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
    name: 'memory',
    async get(c, col, id) { return store.get(c)?.get(col)?.get(id) ?? null },
    async put(c, col, id, env, ev) {
      const coll = getCollection(c, col)
      const ex = coll.get(id)
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
      const comp = new Map<string, Map<string, EncryptedEnvelope>>()
      for (const [name, records] of Object.entries(data)) {
        const coll = new Map<string, EncryptedEnvelope>()
        for (const [id, env] of Object.entries(records)) coll.set(id, env)
        comp.set(name, coll)
      }
      const existing = store.get(c)
      if (existing) {
        for (const [name, coll] of existing) {
          if (name.startsWith('_') && !comp.has(name)) comp.set(name, coll)
        }
      }
      store.set(c, comp)
    },
  }
}

describe('ReadOnlyVaultFacade', () => {
  it('exposes get and list, denies writes', async () => {
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'guards-readonly-facade-passphrase-2026',
    })
    const vault = await db.openVault('demo')
    await vault.collection('widgets').put('w1', { name: 'red' })

    const facade = new ReadOnlyVaultFacade(vault)
    const got = await facade.collection('widgets').get('w1')
    expect(got).toEqual({ name: 'red' })

    const list = await facade.collection('widgets').list()
    expect(list).toHaveLength(1)

    // No put/delete methods exposed
    expect((facade.collection('widgets') as object).hasOwnProperty('put')).toBe(false)
    expect((facade.collection('widgets') as object).hasOwnProperty('delete')).toBe(false)
  })
})
