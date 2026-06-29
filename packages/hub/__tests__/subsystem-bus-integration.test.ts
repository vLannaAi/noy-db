import { describe, it, expect, vi } from 'vitest'
import { createNoydb, ConflictError } from '../src/index.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot, WriteEvent } from '../src/index.js'

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

describe('SubsystemBus integration — afterPut fires from put()', () => {
  it('fires with no write-hooks registered (proves decoupling from #230)', async () => {
    const db = await createNoydb({ store: memoryStore(), secret: 'pw', user: 'owner' })
    const seen: WriteEvent[] = []
    db._subsystemBus.register('afterPut', (e) => { seen.push(e) })

    const vault = await db.openVault('v1')
    const docs = vault.collection<{ id: string; n: number }>('docs')
    await docs.put('a', { id: 'a', n: 1 })

    expect(seen).toHaveLength(1)
    expect(seen[0]!.op).toBe('create')
    expect(seen[0]!.collection).toBe('docs')
    expect(seen[0]!.docId).toBe('a')
    expect(seen[0]!.after).toEqual({ id: 'a', n: 1 })
  })

  it('does not dispatch when no handler is registered', async () => {
    const db = await createNoydb({ store: memoryStore(), secret: 'pw', user: 'owner' })
    const vault = await db.openVault('v1')
    const docs = vault.collection<{ id: string; n: number }>('docs')
    const spy = vi.spyOn(db._subsystemBus, 'dispatch')
    await docs.put('a', { id: 'a', n: 1 })
    expect(spy).not.toHaveBeenCalled()
  })

  it('fires afterDelete on delete() with no write-hooks registered (proves decoupling)', async () => {
    const db = await createNoydb({ store: memoryStore(), secret: 'pw', user: 'owner' })
    const seen: WriteEvent[] = []
    db._subsystemBus.register('afterDelete', (e) => { seen.push(e) })

    const vault = await db.openVault('v1')
    const docs = vault.collection<{ id: string; n: number }>('docs')
    await docs.put('a', { id: 'a', n: 1 })
    await docs.delete('a')

    expect(seen).toHaveLength(1)
    expect(seen[0]!.op).toBe('delete')
    expect(seen[0]!.collection).toBe('docs')
    expect(seen[0]!.docId).toBe('a')
    expect(seen[0]!.before).toEqual({ id: 'a', n: 1 })
    expect(seen[0]!.after).toBeNull()
  })

  it('does not fire afterDelete when no afterDelete handler is registered (zero-cost)', async () => {
    const db = await createNoydb({ store: memoryStore(), secret: 'pw', user: 'owner' })
    const vault = await db.openVault('v1')
    const docs = vault.collection<{ id: string; n: number }>('docs')
    await docs.put('a', { id: 'a', n: 1 })
    const spy = vi.spyOn(db._subsystemBus, 'dispatch')
    await docs.delete('a')
    expect(spy).not.toHaveBeenCalled()
  })
})
