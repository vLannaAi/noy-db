/**
 * forget() teardown for persisted lexical index (#308 L1.5 Task 5).
 *
 * After vault.forget(subject), the _ftindex blob for the affected collection
 * must be gone, and a subsequent retrieve() must rebuild without the forgotten
 * record's terms.
 *
 * Harness copied from forget.test.ts (group 10 / _idx side-car pattern).
 */

import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/kernel/noydb.js'
import { withSearch } from '../src/index.js'
import { ConflictError } from '../src/kernel/errors.js'
import { withHistory } from '../src/with-commit/history/index.js'
import { withForgetCascade } from '../src/with-audit/forget/index.js'
import { withI18n } from '../src/shape/via-i18n/index.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'

/** In-memory store exposing raw envelopes + a get helper for reserved cols. */
function memory(): NoydbStore & {
  raw(c: string, col: string, id: string): EncryptedEnvelope | undefined
} {
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
    raw(c, col, id) { return store.get(c)?.get(col)?.get(id) },
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
      if (existing) for (const [name, coll] of existing) if (name.startsWith('_')) comp.set(name, coll)
      store.set(c, comp)
    },
  }
}

interface Invoice { id: string; buyerId: string; memo: string }

const SECRET = 'search-forget-passphrase-5678'

/**
 * A NoydbStore wrapper whose `delete` throws for the `_ftindex` collection
 * (simulates a transient/permission failure when purging the lexical-index blob)
 * but passes through all other operations unchanged.
 */
function memoryWithFtindexDeleteFailure(): NoydbStore & {
  raw(c: string, col: string, id: string): EncryptedEnvelope | undefined
} {
  const base = memory()
  return {
    ...base,
    async delete(c, col, id) {
      if (col === '_ftindex') throw new Error('simulated _ftindex delete failure')
      return base.delete(c, col, id)
    },
  }
}

describe('forget — _ftindex purge failure is resilient (#308 L1.5)', () => {
  it('forget() resolves, surfaces _ftindex residue, and still shreds the record when the index-blob delete throws', async () => {
    const store = memoryWithFtindexDeleteFailure()
    const db = await createNoydb({
      store,
      user: 'alice',
      secret: SECRET,
      searchStrategy: withSearch(),
      historyStrategy: withHistory(),
      forgetStrategy: withForgetCascade({ subjects: { invoices: 'buyerId' } }),
      i18nStrategy: withI18n(),
    })
    const vault = await db.openVault('v')
    const invoices = vault.collection<Invoice>('invoices', {
      textIndexes: ['memo'],
      textIndexPersist: true,
    })

    await invoices.put('i-1', { id: 'i-1', buyerId: 'buyer-1', memo: 'overdue payment frombuyer1' })
    await invoices.put('i-2', { id: 'i-2', buyerId: 'buyer-2', memo: 'receipt frombuyer2' })

    // Force the index to be persisted so the purge path is exercised.
    await invoices.flushIndex()

    // (a) forget() must RESOLVE even though _ftindex delete will throw.
    const result = await vault.forget('buyer-1')

    // (b) The returned ForgetResult must surface the FT-index as residue.
    expect(result.indexResidue).toContain('invoices:_ftindex')

    // (c) The record erasure still happened (tombstone written).
    expect(result.recordsShredded).toBe(1)
  })
})

describe('forget — persisted _ftindex blob is purged (#308 L1.5)', () => {
  it('forget() deletes the _ftindex blob and retrieve() rebuilds without the forgotten record', async () => {
    const store = memory()
    const db = await createNoydb({
      store,
      user: 'alice',
      secret: SECRET,
      searchStrategy: withSearch(),
      historyStrategy: withHistory(),
      forgetStrategy: withForgetCascade({ subjects: { invoices: 'buyerId' } }),
      i18nStrategy: withI18n(),
    })
    const vault = await db.openVault('v')
    const invoices = vault.collection<Invoice>('invoices', {
      textIndexes: ['memo'],
      textIndexPersist: true,
    })

    // Write two records for different buyers.
    await invoices.put('i-1', { id: 'i-1', buyerId: 'buyer-1', memo: 'overdue payment frombuyer1' })
    await invoices.put('i-2', { id: 'i-2', buyerId: 'buyer-2', memo: 'receipt frombuyer2' })

    // Force the index to be persisted.
    await invoices.flushIndex()

    // The _ftindex blob must exist before forget.
    expect(await store.get('v', '_ftindex', 'invoices')).not.toBeNull()

    // Forget buyer-1.
    const result = await vault.forget('buyer-1')
    expect(result.recordsShredded).toBe(1)

    // The _ftindex blob must be gone after forget.
    expect(await store.get('v', '_ftindex', 'invoices')).toBeNull()

    // A subsequent retrieve() must rebuild without the forgotten record.
    // buyer-2's record should still be findable.
    const hits = await invoices.retrieve('frombuyer2')
    expect(hits.map((h) => h.id)).toContain('i-2')

    // buyer-1's record must NOT appear in any retrieve.
    const buyer1Hits = await invoices.retrieve('frombuyer1')
    expect(buyer1Hits.map((h) => h.id)).not.toContain('i-1')
  })
})
