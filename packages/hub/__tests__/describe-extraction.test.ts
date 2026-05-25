/**
 * describeExtraction — partition-extraction dry-run (#202).
 *
 * Covers:
 *   - record counts per collection + total from the closure
 *   - byte totals + oldest/newest _ts from raw envelopes (no decrypt)
 *   - graph passthrough + empty inaccessible on the owner path
 *   - exported from the @noy-db/hub/bundle subpath
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { createNoydb } from '../src/noydb.js'
import type { Noydb } from '../src/noydb.js'
import { ref } from '../src/refs.js'
import { ConflictError } from '../src/errors.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/types.js'
import { describeExtraction } from '../src/bundle/describe-extraction.js'

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
interface Bill { id: string; clientId: string; amount: number }

describe('describeExtraction', () => {
  let db: Noydb

  beforeEach(async () => {
    db = await createNoydb({ store: memory(), user: 'alice', secret: 'test-passphrase-1234' })
  })

  it('reports record counts per collection and total from the closure', async () => {
    const company = await db.openVault('demo-co')
    const clients = company.collection<Client>('clients')
    const bills = company.collection<Bill>('bills', { refs: { clientId: ref('clients') } })

    await clients.put('c-belle', { id: 'c-belle', name: 'Hotel', operatorUserId: 'belle' })
    await clients.put('c-ann', { id: 'c-ann', name: 'Shop', operatorUserId: 'ann' })
    await bills.put('b-1', { id: 'b-1', clientId: 'c-belle', amount: 100 })
    await bills.put('b-2', { id: 'b-2', clientId: 'c-belle', amount: 200 })
    await bills.put('b-3', { id: 'b-3', clientId: 'c-ann', amount: 50 })

    const preview = await describeExtraction(company, {
      seeds: { clients: (c) => c['operatorUserId'] === 'belle' },
    })

    expect(preview.totalRecords).toBe(3) // c-belle + b-1 + b-2
    const byName = Object.fromEntries(preview.byCollection.map((c) => [c.name, c.recordCount]))
    expect(byName).toEqual({ clients: 1, bills: 2 })
    // byCollection is sorted by name for determinism
    expect(preview.byCollection.map((c) => c.name)).toEqual(['bills', 'clients'])
  })

  it('sums envelope bytes and tracks oldest/newest _ts without decrypting', async () => {
    const company = await db.openVault('demo-co')
    const clients = company.collection<Client>('clients')

    await clients.put('c-1', { id: 'c-1', name: 'A', operatorUserId: 'belle' })
    await clients.put('c-2', { id: 'c-2', name: 'B', operatorUserId: 'belle' })

    const preview = await describeExtraction(company, {
      seeds: { clients: () => true },
    })

    const clientsStats = preview.byCollection.find((c) => c.name === 'clients')!
    expect(clientsStats.recordCount).toBe(2)
    expect(clientsStats.bytes).toBeGreaterThan(0)
    expect(preview.totalBytes).toBe(clientsStats.bytes)
    // Both records exist; oldest <= newest lexicographically.
    expect(clientsStats.oldestTs).toBeDefined()
    expect(clientsStats.newestTs).toBeDefined()
    expect(clientsStats.oldestTs! <= clientsStats.newestTs!).toBe(true)
  })

  it('passes through the walk graph metadata and reports no inaccessible records for an owner', async () => {
    const company = await db.openVault('demo-co')
    const clients = company.collection<Client>('clients')
    const bills = company.collection<Bill>('bills', { refs: { clientId: ref('clients') } })
    const creditNotes = company.collection<{ id: string; billId: string }>(
      'creditNotes', { refs: { billId: ref('bills') } },
    )

    await clients.put('c-1', { id: 'c-1', name: 'A', operatorUserId: 'belle' })
    await bills.put('b-1', { id: 'b-1', clientId: 'c-1', amount: 100 })
    await creditNotes.put('cn-1', { id: 'cn-1', billId: 'b-1' })

    const preview = await describeExtraction(company, {
      seeds: { clients: (c) => c['operatorUserId'] === 'belle' },
    })

    // clients -> bills -> creditNotes : two inbound expansion hops.
    expect(preview.graph.depth).toBe(2)
    expect(preview.graph.cyclesDetected).toBe(false)
    expect(preview.inaccessible).toEqual([])
  })
})
