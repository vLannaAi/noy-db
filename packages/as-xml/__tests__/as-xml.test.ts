import { describe, expect, it } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '@noy-db/hub'
import { withFormats } from '@noy-db/hub/as'
import { ConflictError, ExportCapabilityError, createNoydb } from '@noy-db/hub'
import { asXml } from '../src/index.js'
import { withTeam } from '@noy-db/hub/team'

function toMemory(): NoydbStore {
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

interface Invoice { id: string; client: string; amount: number }

async function seed(grant: readonly ('xml' | 'csv')[] = ['xml']) {
  const adapter = toMemory()
  const db = await createNoydb({ formatsStrategy: withFormats(), teamStrategy: withTeam(), store: adapter, user: 'owner', secret: 'pw' })
  const v = await db.openVault('acme')
  await v.collection<Invoice>('invoices').put('i1', { id: 'i1', client: 'Acme & Co.', amount: 100 })
  await v.collection<Invoice>('invoices').put('i2', { id: 'i2', client: 'Bob <the builder>', amount: 200 })
  await db.grant('acme', {
    userId: 'owner', displayName: 'Owner', role: 'owner',
    secret: 'pw',
    exportCapability: { plaintext: grant },
  })
  await db.close()
  const db2 = await createNoydb({ formatsStrategy: withFormats(), teamStrategy: withTeam(), store: adapter, user: 'owner', secret: 'pw' })
  const vault = await db2.openVault('acme')
  return { vault }
}

describe('as-xml', () => {
  it('emits XML declaration by default', async () => {
    const { vault } = await seed()
    const xml = await vault.export(asXml(), { collections: ['invoices'] })
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true)
  })

  it('wraps records in the inferred element name', async () => {
    const { vault } = await seed()
    const xml = await vault.export(asXml(), { collections: ['invoices'] })
    expect(xml).toContain('<Records>')
    expect(xml).toContain('<Invoice>')
    expect(xml).toContain('</Invoice>')
    expect(xml).toContain('</Records>')
  })

  it('escapes XML entities in text content', async () => {
    const { vault } = await seed()
    const xml = await vault.export(asXml(), { collections: ['invoices'] })
    expect(xml).toContain('Acme &amp; Co.')
    expect(xml).toContain('Bob &lt;the builder&gt;')
  })

  it('honours custom root and record element names', async () => {
    const { vault } = await seed()
    const xml = await vault.export(asXml({ rootElement: 'Batch', recordElement: 'Entry' }), { collections: ['invoices'] })
    expect(xml).toContain('<Batch>')
    expect(xml).toContain('<Entry>')
  })

  it('emits namespace declaration when provided', async () => {
    const { vault } = await seed()
    const xml = await vault.export(asXml({ namespace: 'http://schemas.example.com/accounting/v1' }), { collections: ['invoices'] })
    expect(xml).toContain('xmlns="http://schemas.example.com/accounting/v1"')
  })

  it('compact mode skips indentation', async () => {
    const { vault } = await seed()
    const xml = await vault.export(asXml({ pretty: false }), { collections: ['invoices'] })
    expect(xml).not.toContain('\n  ')
  })

  it('throws ExportCapabilityError without xml grant', async () => {
    const { vault } = await seed(['csv'])
    await expect(vault.export(asXml(), { collections: ['invoices'] })).rejects.toBeInstanceOf(ExportCapabilityError)
  })
})
