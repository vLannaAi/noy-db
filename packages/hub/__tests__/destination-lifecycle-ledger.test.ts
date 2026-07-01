/**
 * Destination lifecycle ledger entries (#226 destination slice) — Plan 9.
 * createOwnerOnAdoptedPartition records creation-of-new-owner +
 * transfer-seal-consumed on the carried chain (no-op without carryLedger).
 */

import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/noydb.js'
import { withHistory } from '../src/with-commit/history/index.js'
import { ConflictError } from '../src/errors.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { extractPartition } from '../src/with-cargo/extract-partition.js'
import { adoptPartition, createOwnerOnAdoptedPartition } from '../src/with-cargo/adopt-partition.js'

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
          if (name.startsWith('_')) comp.set(name, coll)
        }
      }
      store.set(c, comp)
    },
  }
}

interface Client { id: string; name: string; operatorUserId: string }

async function srcVault() {
  const db = await createNoydb({ store: memory(), user: 'alice', secret: 'pw-1234', historyStrategy: withHistory() })
  const c = await db.openVault('demo-co')
  await c.collection<Client>('clients').put('c-1', { id: 'c-1', name: 'Hotel', operatorUserId: 'belle' })
  return c
}

describe('destination lifecycle ledger entries (#226)', () => {
  it('records creation-of-new-owner + transfer-seal-consumed when the partition carried a ledger', async () => {
    const company = await srcVault()
    const { bundleBytes, transferKey, sealId } = await extractPartition(company, { seeds: { clients: () => true }, carryLedger: true })

    const dest = memory()
    await adoptPartition(bundleBytes, { transferKey, destinationStore: dest, vaultName: 'acme' })
    await createOwnerOnAdoptedPartition(dest, 'acme', { userId: 'belle', passphrase: 'belle-2026', transferKey })

    const db = await createNoydb({ store: dest, user: 'belle', secret: 'belle-2026', historyStrategy: withHistory() })
    const vault = await db.openVault('acme')
    const entries = await vault._getLedgerOrNull()!.loadAllEntries()

    expect(entries.some((e) => e.op === 'lifecycle' && e.reason === 'creation-of-new-owner:belle')).toBe(true)
    expect(entries.some((e) => e.op === 'lifecycle' && e.reason === `transfer-seal-consumed:${sealId}`)).toBe(true)
    expect((await vault.verifyBackupIntegrity()).ok).toBe(true)
  })

  it('does not duplicate creation-of-new-owner when retried after a Stage B partial failure', async () => {
    const company = await srcVault()
    const { bundleBytes, transferKey, sealId } = await extractPartition(company, { seeds: { clients: () => true }, carryLedger: true })

    // Wrap destination so the SECOND of the two Stage-B appends fails exactly
    // once, simulating a crash strictly between the two adjacent puts. We arm
    // the fault only after adoptPartition has imported its carried ledger so
    // the injection lands on the actual Stage-B boundary, not on imports.
    const dest = memory()
    let stageBAppendCount = 0
    let armed = false
    const flakyDest: NoydbStore = {
      ...dest,
      async put(c, col, id, env, ev) {
        if (armed && col === '_ledger') {
          stageBAppendCount++
          if (stageBAppendCount === 2) throw new Error('injected ledger outage')
        }
        return dest.put(c, col, id, env, ev)
      },
    }

    await adoptPartition(bundleBytes, { transferKey, destinationStore: flakyDest, vaultName: 'acme' })
    armed = true
    await expect(
      createOwnerOnAdoptedPartition(flakyDest, 'acme', { userId: 'belle', passphrase: 'belle-2026', transferKey }),
    ).rejects.toThrow(/injected ledger outage/)

    // Retry against the clean adapter — Stage B must not re-append the first entry.
    armed = false
    await createOwnerOnAdoptedPartition(flakyDest, 'acme', { userId: 'belle', passphrase: 'belle-2026', transferKey })

    const db = await createNoydb({ store: dest, user: 'belle', secret: 'belle-2026', historyStrategy: withHistory() })
    const vault = await db.openVault('acme')
    const entries = await vault._getLedgerOrNull()!.loadAllEntries()

    const creationEntries = entries.filter((e) => e.op === 'lifecycle' && e.reason === 'creation-of-new-owner:belle')
    const consumedEntries = entries.filter((e) => e.op === 'lifecycle' && e.reason === `transfer-seal-consumed:${sealId}`)
    expect(creationEntries).toHaveLength(1)
    expect(consumedEntries).toHaveLength(1)
  })

  it('is a no-op when the partition carried no ledger (carryLedger off)', async () => {
    const company = await srcVault()
    const { bundleBytes, transferKey } = await extractPartition(company, { seeds: { clients: () => true } })
    const dest = memory()
    await adoptPartition(bundleBytes, { transferKey, destinationStore: dest, vaultName: 'acme' })
    await createOwnerOnAdoptedPartition(dest, 'acme', { userId: 'belle', passphrase: 'belle-2026', transferKey })
    expect(await dest.list('acme', '_ledger')).toEqual([])
  })
})
