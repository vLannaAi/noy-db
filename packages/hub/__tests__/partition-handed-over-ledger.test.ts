/**
 * Source partition-handed-over ledger entry (#226, source slice) — Plan 8.
 * Generic 'lifecycle' ledger op + extractPartition source-side audit append.
 */

import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/noydb.js'
import { withHistory } from '../src/with-commit/history/index.js'
import { ConflictError } from '../src/errors.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/types.js'
import { extractPartition } from '../src/with-share/bundle/extract-partition.js'

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

describe('lifecycle ledger op', () => {
  it('a lifecycle entry does not break verifyBackupIntegrity', async () => {
    const db = await createNoydb({ store: memory(), user: 'alice', secret: 'pw-1234', historyStrategy: withHistory() })
    const vault = await db.openVault('demo')
    await vault.collection<{ id: string }>('items').put('i-1', { id: 'i-1' })

    const ledger = vault._getLedgerOrNull()!
    await ledger.append({ op: 'lifecycle', collection: '', id: '', version: 0, actor: '', payloadHash: '', reason: 'partition-handed-over:seal-xyz' })

    const result = await vault.verifyBackupIntegrity()
    expect(result.ok).toBe(true)
  })
})

describe('extractPartition source ledger audit', () => {
  it('appends partition-handed-over:<sealId> to the source ledger', async () => {
    const db = await createNoydb({ store: memory(), user: 'alice', secret: 'pw-1234', historyStrategy: withHistory() })
    const company = await db.openVault('demo-co')
    await company.collection<Client>('clients').put('c-1', { id: 'c-1', name: 'Hotel', operatorUserId: 'belle' })

    const { sealId } = await extractPartition(company, { seeds: { clients: () => true } })

    const ledger = company._getLedgerOrNull()!
    const entries = await ledger.loadAllEntries()
    const handover = entries.find((e) => e.op === 'lifecycle' && e.reason === `partition-handed-over:${sealId}`)
    expect(handover).toBeTruthy()

    expect((await company.verifyBackupIntegrity()).ok).toBe(true)
    expect(await company.collection<Client>('clients').get('c-1')).toMatchObject({ id: 'c-1' })
  })

  it('is a no-op when the source vault has no history strategy', async () => {
    const db = await createNoydb({ store: memory(), user: 'alice', secret: 'pw-1234' })
    const company = await db.openVault('demo-co')
    await company.collection<Client>('clients').put('c-1', { id: 'c-1', name: 'A', operatorUserId: 'belle' })

    const result = await extractPartition(company, { seeds: { clients: () => true } })
    expect(result.sealId.length).toBeGreaterThan(0)
    expect(company._getLedgerOrNull()).toBeNull()
  })
})
