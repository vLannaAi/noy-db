import { describe, it, expect } from 'vitest'
import { createNoydb, ConflictError } from '../src/index.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/index.js'

function memoryStore(): NoydbStore {
  const data = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const getColl = (v: string, c: string): Map<string, EncryptedEnvelope> => {
    let vm = data.get(v); if (!vm) { vm = new Map(); data.set(v, vm) }
    let cm = vm.get(c); if (!cm) { cm = new Map(); vm.set(c, cm) }
    return cm
  }
  return {
    name: 'memory',
    async get(v, c, id) { return data.get(v)?.get(c)?.get(id) ?? null },
    async put(v, c, id, env, ev) {
      const coll = getColl(v, c); const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      coll.set(id, env)
    },
    async delete(v, c, id) { data.get(v)?.get(c)?.delete(id) },
    async list(v, c) { return [...(data.get(v)?.get(c)?.keys() ?? [])] },
    async loadAll(v) {
      const vm = data.get(v); const snap: VaultSnapshot = {}
      if (vm) for (const [cn, cm] of vm) {
        const r: Record<string, EncryptedEnvelope> = {}
        for (const [id, e] of cm) r[id] = e
        snap[cn] = r
      }
      return snap
    },
    async saveAll() {},
  }
}

describe('SubsystemBus gate integration — beforePut/beforeDelete', () => {
  it('a throwing beforePut handler aborts the write (record not persisted)', async () => {
    const db = await createNoydb({ store: memoryStore(), secret: 'pw', user: 'owner' })
    const vault = await db.openVault('v1')
    db._subsystemBus.registerGate('beforePut', (e) => {
      if ((e.incoming as { n: number }).n > 10) throw new Error('too big')
    })
    const docs = vault.collection<{ id: string; n: number }>('docs')
    await expect(docs.put('a', { id: 'a', n: 99 })).rejects.toThrow('too big')
    expect(await docs.get('a')).toBeNull()
  })

  it('a passing beforePut handler lets the write proceed, with correct event shape', async () => {
    const db = await createNoydb({ store: memoryStore(), secret: 'pw', user: 'owner' })
    const vault = await db.openVault('v1')
    const seen: Array<{ op: string; existing: unknown; existingVersion: number }> = []
    db._subsystemBus.registerGate('beforePut', (e) => {
      seen.push({ op: e.op, existing: e.existing, existingVersion: e.existingVersion })
    })
    const docs = vault.collection<{ id: string; n: number }>('docs')
    await docs.put('a', { id: 'a', n: 1 })            // create
    await docs.put('a', { id: 'a', n: 2 })            // update
    expect(seen[0]).toEqual({ op: 'create', existing: null, existingVersion: 0 })
    expect(seen[1].op).toBe('update')
    expect((seen[1].existing as { n: number }).n).toBe(1)
    expect(seen[1].existingVersion).toBeGreaterThanOrEqual(1)
  })

  it('a throwing beforeDelete handler aborts the delete', async () => {
    const db = await createNoydb({ store: memoryStore(), secret: 'pw', user: 'owner' })
    const vault = await db.openVault('v1')
    const docs = vault.collection<{ id: string; n: number }>('docs')
    await docs.put('a', { id: 'a', n: 1 })
    db._subsystemBus.registerGate('beforeDelete', () => { throw new Error('locked') })
    await expect(docs.delete('a')).rejects.toThrow('locked')
    expect(await docs.get('a')).not.toBeNull()
  })

  it('zero-cost: no gate handler → put/delete behave exactly as before', async () => {
    const db = await createNoydb({ store: memoryStore(), secret: 'pw', user: 'owner' })
    const vault = await db.openVault('v1')
    const docs = vault.collection<{ id: string; n: number }>('docs')
    await expect(docs.put('a', { id: 'a', n: 1 })).resolves.toBeUndefined()
    await expect(docs.delete('a')).resolves.toBeUndefined()
  })

  it('beforeDelete fires for internal deletes carrying internal:true; a handler that branches on !internal does not abort', async () => {
    const db = await createNoydb({ store: memoryStore(), secret: 'pw', user: 'owner' })
    const vault = await db.openVault('v1')
    const docs = vault.collection<{ id: string; n: number }>('docs')
    await docs.put('a', { id: 'a', n: 1 })
    const seen: boolean[] = []
    db._subsystemBus.registerGate('beforeDelete', (e) => {
      seen.push(e.internal)
      if (!e.internal) throw new Error('user-delete blocked')
    })
    await (docs as unknown as { _internalDelete(id: string): Promise<void> })._internalDelete('a')
    expect(seen).toEqual([true])
    expect(await docs.get('a')).toBeNull()
  })
})
