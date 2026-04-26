import { describe, expect, it } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '@noy-db/hub'
import { ConflictError, ExportCapabilityError, createNoydb } from '@noy-db/hub'
import { toString, toObject, write } from '../src/index.js'

function memory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const gc = (c: string, col: string): Map<string, EncryptedEnvelope> => {
    let comp = store.get(c); if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col); if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
    name: 'memory',
    async get(c, col, id) { return store.get(c)?.get(col)?.get(id) ?? null },
    async put(c, col, id, env, ev) {
      const coll = gc(c, col); const ex = coll.get(id)
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
      for (const [n, recs] of Object.entries(data)) {
        const coll = gc(c, n)
        for (const [id, e] of Object.entries(recs)) coll.set(id, e)
      }
    },
  }
}

interface Invoice {
  id: string
  client: string
  amount: number
}

async function seed(grantFormats: readonly ('json' | 'csv' | 'xml' | 'ndjson' | 'sql')[] = ['json']) {
  const adapter = memory()
  const db = await createNoydb({ store: adapter, user: 'owner', secret: 'pw' })
  const vault = await db.openVault('acme')
  const invoices = vault.collection<Invoice>('invoices')
  await invoices.put('i1', { id: 'i1', client: 'Alice', amount: 100 })
  await invoices.put('i2', { id: 'i2', client: 'Bob', amount: 250 })
  const payments = vault.collection<{ id: string; invoiceId: string; amount: number }>('payments')
  await payments.put('p1', { id: 'p1', invoiceId: 'i1', amount: 100 })
  await db.grant('acme', {
    userId: 'owner', displayName: 'Owner', role: 'owner',
    passphrase: 'pw',
    exportCapability: { plaintext: grantFormats },
  })
  await db.close()
  const db2 = await createNoydb({ store: adapter, user: 'owner', secret: 'pw' })
  const reopened = await db2.openVault('acme')
  return { db: db2, vault: reopened }
}

describe('as-json', () => {
  it('emits grouped-by-collection JSON', async () => {
    const { vault } = await seed()
    const doc = await toObject(vault)
    expect(Object.keys(doc).sort()).toEqual(['invoices', 'payments'])
    expect(doc.invoices).toHaveLength(2)
    expect(doc.payments).toHaveLength(1)
    expect(doc.invoices![0]).toMatchObject({ client: 'Alice', amount: 100 })
  })

  it('strips envelope metadata by default', async () => {
    const { vault } = await seed()
    const doc = await toObject(vault)
    for (const rec of doc.invoices!) {
      expect(rec).not.toHaveProperty('_v')
      expect(rec).not.toHaveProperty('_ts')
      expect(rec).not.toHaveProperty('_by')
    }
  })

  it('honours the collections allowlist', async () => {
    const { vault } = await seed()
    const doc = await toObject(vault, { collections: ['invoices'] })
    expect(Object.keys(doc)).toEqual(['invoices'])
  })

  it('toString pretty-prints by default', async () => {
    const { vault } = await seed()
    const pretty = await toString(vault)
    expect(pretty).toContain('\n')
    expect(pretty).toContain('  ')
  })

  it('toString compact when pretty: false', async () => {
    const { vault } = await seed()
    const compact = await toString(vault, { pretty: false })
    expect(compact).not.toContain('\n')
  })

  it('throws ExportCapabilityError when canExportPlaintext[json] is absent', async () => {
    const { vault } = await seed(['csv']) // json not granted
    await expect(toObject(vault)).rejects.toBeInstanceOf(ExportCapabilityError)
  })

  it('write() refuses without acknowledgeRisks', async () => {
    const { vault } = await seed()
    await expect(
      write(vault, '/tmp/nope.json', { acknowledgeRisks: false as unknown as true }),
    ).rejects.toThrow(/acknowledgeRisks/)
  })
})
