/**
 * #766 — `Collection.putAtTier` (`with-audit/tiers/index.ts`) writes via a
 * raw `ctx.adapter.put`, bypassing `Collection.put()`'s write-hook pipeline
 * (the `onAfterWrite` hook that registers a record's ref in the encrypted
 * `_subject_index`). A record whose FIRST persistence is `putAtTier` — a
 * record sensitive from birth, a documented legitimate use — never entered
 * the subject index, so `vault.forget(subjectId)` silently never found it:
 * an unforgettable record.
 *
 * `elevate()`/`demote()` always operate on an ALREADY-registered record
 * (both throw `Record "<id>" not found` when no envelope exists yet), so
 * they need no change — covered here by the put()+elevate() regression case.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, ConflictError } from '../src/index.js'
import { withTiers } from '../src/with-audit/tiers/index.js'
import { withForgetCascade } from '../src/with-audit/forget/index.js'
import { withHistory } from '../src/with-commit/history/index.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/index.js'

interface Invoice { id: string; buyerId: string; amount: number }

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

async function freshVault(subjects: Record<string, string>) {
  const db = await createNoydb({
    store: memoryStore(), secret: 'putattier-subject-index-pw', user: 'owner',
    tiersStrategy: withTiers(),
    historyStrategy: withHistory(),
    forgetStrategy: withForgetCascade({ subjects }),
  })
  return db.openVault('v1')
}

describe('#766 — putAtTier registers the subject ref', () => {
  it('a record whose FIRST write is putAtTier(tier>0) is reachable by forget()', async () => {
    const vault = await freshVault({ invoices: 'buyerId' })
    const invoices = vault.collection<Invoice>('invoices', { tiers: [0, 1] })
    await invoices.putAtTier('r1', { id: 'r1', buyerId: 'B', amount: 10 }, 1)

    const result = await vault.forget('B')

    expect(result.recordsShredded).toBe(1)
  })

  it('a record whose FIRST write is putAtTier(tier 0) is also reachable by forget()', async () => {
    const vault = await freshVault({ invoices: 'buyerId' })
    const invoices = vault.collection<Invoice>('invoices', { tiers: [0, 1] })
    await invoices.putAtTier('r1', { id: 'r1', buyerId: 'B', amount: 10 }, 0)

    const result = await vault.forget('B')

    expect(result.recordsShredded).toBe(1)
  })

  it('a repeat putAtTier on the same record does not corrupt the subject index', async () => {
    const vault = await freshVault({ invoices: 'buyerId' })
    const invoices = vault.collection<Invoice>('invoices', { tiers: [0, 1] })
    await invoices.putAtTier('r1', { id: 'r1', buyerId: 'B', amount: 10 }, 1)
    await invoices.putAtTier('r1', { id: 'r1', buyerId: 'B', amount: 20 }, 1)

    const result = await vault.forget('B')

    expect(result.recordsShredded).toBe(1)
  })

  it('no-ops when the collection has no declared forget-subject field', async () => {
    // "invoices" is not declared in `subjects` — only an unrelated collection is.
    const vault = await freshVault({ other: 'ownerId' })
    const invoices = vault.collection<Invoice>('invoices', { tiers: [0, 1] })
    await invoices.putAtTier('r1', { id: 'r1', buyerId: 'B', amount: 10 }, 1)

    const result = await vault.forget('B')

    expect(result.recordsShredded).toBe(0)
  })

  it('put() + elevate() still registers the subject ref (regression)', async () => {
    const vault = await freshVault({ invoices: 'buyerId' })
    const invoices = vault.collection<Invoice>('invoices', { tiers: [0, 1] })
    await invoices.put('r1', { id: 'r1', buyerId: 'B', amount: 10 })
    await invoices.elevate('r1', 1)

    const result = await vault.forget('B')

    expect(result.recordsShredded).toBe(1)
  })
})
