/**
 * exportStream() dictionary snapshot — v0.8 #84
 *
 * Tests: collection with dictKey → snapshot present; collection without →
 * no dictionaries field; concurrent mutation during export → snapshot stable;
 * exportJSON embeds _dictionaries; exportJSON({ resolveLabels }) omits snapshot.
 */

import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/types.js'
import { ConflictError } from '../src/errors.js'
import { createNoydb } from '../src/noydb.js'
import { withI18n } from '../src/i18n/index.js'
import { dictKey } from '../src/i18n/dictionary.js'

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
        if (!n.startsWith('_')) { const r: Record<string, EncryptedEnvelope> = {}; for (const [id, e] of coll) r[id] = e; s[n] = r }
      }
      return s
    },
    async saveAll(_c, _d) {},
  }
}

interface Invoice {
  id: string
  amount: number
  status: string
}

async function setup() {
  const adapter = memory()
  const db = await createNoydb({ store: adapter, user: 'alice', i18nStrategy: withI18n(), encrypt: false })
  const company = await db.openVault('company')

  const statusDict = company.dictionary('status')
  await statusDict.putAll({
    draft: { en: 'Draft', th: 'ฉบับร่าง' },
    open: { en: 'Open', th: 'เปิด' },
    paid: { en: 'Paid', th: 'ชำระแล้ว' },
  } as Record<string, Record<string, string>>)

  const invoices = company.collection<Invoice>('invoices', {
    dictKeyFields: {
      status: dictKey('status', ['draft', 'open', 'paid'] as const),
    },
  })

  await invoices.put('inv-1', { id: 'inv-1', amount: 1500, status: 'draft' })
  await invoices.put('inv-2', { id: 'inv-2', amount: 8200, status: 'open' })
  await invoices.put('inv-3', { id: 'inv-3', amount: 12400, status: 'paid' })

  // Collection without dictKey for comparison
  const clients = company.collection<{ id: string; name: string }>('clients')
  await clients.put('c-1', { id: 'c-1', name: 'Acme Corp' })

  return { company, invoices, clients, statusDict }
}

describe('exportStream() dictionary snapshot (v0.8 #84)', () => {
  it('includes dictionaries snapshot for collections with dictKey', async () => {
    const { company } = await setup()

    const chunks: unknown[] = []
    for await (const chunk of company.exportStream()) {
      chunks.push(chunk)
    }

    const invoiceChunk = (chunks as Array<{ collection: string; dictionaries?: unknown }>).find(
      (c) => c.collection === 'invoices',
    )
    expect(invoiceChunk?.dictionaries).toBeDefined()

    const dicts = invoiceChunk?.dictionaries as Record<string, Record<string, Record<string, string>>>
    expect(dicts?.['status']?.['paid']?.['en']).toBe('Paid')
    expect(dicts?.['status']?.['paid']?.['th']).toBe('ชำระแล้ว')
    expect(dicts?.['status']?.['draft']?.['en']).toBe('Draft')
  })

  it('does not include dictionaries field for collections without dictKey', async () => {
    const { company } = await setup()

    const chunks: unknown[] = []
    for await (const chunk of company.exportStream()) {
      chunks.push(chunk)
    }

    const clientChunk = (chunks as Array<{ collection: string; dictionaries?: unknown }>).find(
      (c) => c.collection === 'clients',
    )
    expect(clientChunk?.dictionaries).toBeUndefined()
  })

  it('snapshot is stable across chunks within the same export (concurrent mutation)', async () => {
    const { company, statusDict } = await setup()
    const chunks: unknown[] = []

    let mutated = false
    for await (const chunk of company.exportStream()) {
      chunks.push(chunk)
      // Mutate the dictionary mid-export
      if (!mutated) {
        mutated = true
        await statusDict.put('paid', { en: 'Paid (updated)', th: 'ชำระแล้ว (อัปเดต)' })
      }
    }

    // The snapshot captured at stream start should reflect the original state
    const invoiceChunk = (chunks as Array<{ collection: string; dictionaries?: unknown }>).find(
      (c) => c.collection === 'invoices',
    )
    const dicts = invoiceChunk?.dictionaries as Record<string, Record<string, Record<string, string>>>
    // The snapshot was captured before the mutation
    expect(dicts?.['status']?.['paid']?.['en']).toBe('Paid')
  })

  it('exportJSON embeds _dictionaries at top level', async () => {
    const { company } = await setup()
    const json = JSON.parse(await company.exportJSON())

    expect(json._dictionaries).toBeDefined()
    const invoiceDicts = json._dictionaries?.['invoices'] as Record<string, Record<string, Record<string, string>>>
    expect(invoiceDicts?.['status']?.['open']?.['th']).toBe('เปิด')
  })

  it('exportJSON omits _dictionaries when resolveLabels is set', async () => {
    const { company } = await setup()
    const json = JSON.parse(await company.exportJSON({ resolveLabels: 'th' }))

    expect(json._dictionaries).toBeUndefined()
  })

  it('exportJSON with no dict collections produces no _dictionaries key', async () => {
    const adapter = memory()
    const db = await createNoydb({ store: adapter, user: 'alice', i18nStrategy: withI18n(), encrypt: false })
    const co = await db.openVault('empty')
    const plain = co.collection<{ id: string; name: string }>('plain')
    await plain.put('x', { id: 'x', name: 'No dicts' })

    const json = JSON.parse(await co.exportJSON())
    expect(json._dictionaries).toBeUndefined()
  })

  it('per-record granularity includes dictionary snapshot on every chunk', async () => {
    const { company } = await setup()

    const recordChunks: unknown[] = []
    for await (const chunk of company.exportStream({ granularity: 'record' })) {
      recordChunks.push(chunk)
    }

    const invoiceRecords = (recordChunks as Array<{ collection: string; dictionaries?: unknown; records: unknown[] }>).filter(
      (c) => c.collection === 'invoices',
    )
    expect(invoiceRecords.length).toBe(3) // one per record
    for (const chunk of invoiceRecords) {
      expect(chunk.dictionaries).toBeDefined()
    }
  })
})
