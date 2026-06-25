import { describe, it, expect } from 'vitest'
import { createNoydb } from '../../src/index.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../../src/types.js'
import { ConflictError } from '../../src/errors.js'

function inlineMemory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function gc(c: string, col: string) {
    let comp = store.get(c)
    if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col)
    if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
    async get(c, col, id) { return store.get(c)?.get(col)?.get(id) ?? null },
    async put(c, col, id, env, ev) {
      const coll = gc(c, col)
      const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      coll.set(id, env)
    },
    async delete(c, col, id) { store.get(c)?.get(col)?.delete(id) },
    async list(c, col) { const coll = store.get(c)?.get(col); return coll ? [...coll.keys()] : [] },
    async loadAll(c) {
      const comp = store.get(c)
      const s: VaultSnapshot = {}
      if (comp) {
        for (const [n, coll] of comp) {
          if (!n.startsWith('_')) {
            const r: Record<string, EncryptedEnvelope> = {}
            for (const [id, e] of coll) r[id] = e
            s[n] = r
          }
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

describe('collectionMeta', () => {
  it('surfaces collection meta in describe() with label fallback', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'u', secret: 's' })
    const v = await db.openVault('v')
    const sales = v.collection('sales', { meta: { label: 'Sales', description: 'Invoices', icon: 'receipt' } })
    expect(sales.describe().meta).toMatchObject({ label: 'Sales', description: 'Invoices', icon: 'receipt' })
    const plain = v.collection('line_items', {})
    expect(plain.describe().meta?.label).toBe('Line Items')   // humanized fallback
  })
})

describe('vaultMeta', () => {
  it('surfaces vaultMeta on dumpSchema, first-wins', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'u', secret: 's' })
    const v = await db.openVault('books', { meta: { label: 'Acme Books', description: '2026' } })
    v.collection('sales', {})
    const dump = await v.dumpSchema()
    expect(dump.meta).toMatchObject({ label: 'Acme Books', description: '2026' })
    // re-open with different meta → first-wins keeps original
    const v2 = await db.openVault('books', { meta: { label: 'OTHER' } })
    expect(v2.getMeta()?.label).toBe('Acme Books')
  })
})
