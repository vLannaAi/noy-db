/**
 * Gate test for the tiers capability (S4). The collection-level tier ops
 * (`putAtTier` / `getAtTier` / `listAtTier` / `elevate` / `demote`) throw
 * `TiersNotEnabledError` unless `tiersStrategy: withTiers()` is passed to
 * createNoydb; opting in makes them live.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, ConflictError, TiersNotEnabledError } from '../src/index.js'
import { withTiers } from '../src/with-audit/tiers/index.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/index.js'

interface Doc {
  id: string
  title: string
  body: string
}

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
    async saveAll(v, snap) {
      const vm = new Map<string, Map<string, EncryptedEnvelope>>()
      for (const [cn, recs] of Object.entries(snap)) {
        const cm = new Map<string, EncryptedEnvelope>()
        for (const [id, e] of Object.entries(recs)) cm.set(id, e)
        vm.set(cn, cm)
      }
      data.set(v, vm)
    },
  }
}

describe('tiers opt-in gate (S4)', () => {
  it('throws TiersNotEnabledError when not opted in', async () => {
    const db = await createNoydb({ store: memoryStore(), secret: 'pw', user: 'owner' })
    const vault = await db.openVault('v1')
    const docs = vault.collection<Doc>('docs', { tiers: [0, 1, 2] })
    await expect(docs.putAtTier('d1', { id: 'd1', title: 'Top', body: 'secret' }, 2))
      .rejects.toThrow(TiersNotEnabledError)
    await expect(docs.getAtTier('d1')).rejects.toThrow(TiersNotEnabledError)
    await expect(docs.listAtTier()).rejects.toThrow(TiersNotEnabledError)
    await expect(docs.elevate('d1', 2)).rejects.toThrow(TiersNotEnabledError)
    await expect(docs.demote('d1', 0)).rejects.toThrow(TiersNotEnabledError)
  })

  it('works when opted in via withTiers()', async () => {
    const db = await createNoydb({ store: memoryStore(), secret: 'pw', user: 'owner', tiersStrategy: withTiers() })
    const vault = await db.openVault('v1')
    const docs = vault.collection<Doc>('docs', { tiers: [0, 1, 2] })
    await docs.putAtTier('d1', { id: 'd1', title: 'Top', body: 'secret' }, 2)
    const got = await docs.getAtTier('d1')
    expect(got).toEqual({ id: 'd1', title: 'Top', body: 'secret' })
    const listed = await docs.listAtTier()
    expect(listed).toEqual([{ id: 'd1', tier: 2, readable: true }])
  })
})
