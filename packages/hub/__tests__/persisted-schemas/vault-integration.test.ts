import { describe, it, expect, beforeEach } from 'vitest'
import { z } from 'zod'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../../src/kernel/types.js'
import { ConflictError } from '../../src/kernel/errors.js'
import { createNoydb } from '../../src/kernel/noydb.js'
import type { Noydb } from '../../src/kernel/noydb.js'
import { SCHEMAS_COLLECTION } from '../../src/with-shape/persisted-schemas/storage.js'

function inlineMemory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function gc(c: string, col: string) {
    let comp = store.get(c); if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col); if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
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
      if (comp) for (const [n, coll] of comp) { if (!n.startsWith('_')) { const r: Record<string, EncryptedEnvelope> = {}; for (const [id, e] of coll) r[id] = e; s[n] = r } }
      return s
    },
    async saveAll(c, data) {
      for (const [n, recs] of Object.entries(data)) { const coll = gc(c, n); for (const [id, e] of Object.entries(recs)) coll.set(id, e) }
    },
  }
}

interface Invoice { id: string; amount: number }

describe('persistJsonSchema option on vault.collection()', () => {
  const COMP = 'acme'
  let adapter: NoydbStore
  let db: Noydb

  beforeEach(async () => {
    adapter = inlineMemory()
    db = await createNoydb({ store: adapter, user: 'owner-01', secret: 'owner-pass' })
  })

  it('does NOT write _schemas/<col> when persistJsonSchema is omitted (default)', async () => {
    const InvoiceSchema = z.object({ id: z.string(), amount: z.number() })
    const comp = await db.openVault(COMP)
    comp.collection<Invoice>('invoices', { schema: InvoiceSchema })
    await comp._drainPendingSchemaWrites()
    const stored = await adapter.get(COMP, SCHEMAS_COLLECTION, 'invoices')
    expect(stored).toBeNull()
  })

  it('writes _schemas/<col> encrypted envelope when persistJsonSchema: true with a Zod validator', async () => {
    const InvoiceSchema = z.object({ id: z.string(), amount: z.number() })
    const comp = await db.openVault(COMP)
    comp.collection<Invoice>('invoices', { schema: InvoiceSchema, persistJsonSchema: true })
    await comp._drainPendingSchemaWrites()

    const stored = await adapter.get(COMP, SCHEMAS_COLLECTION, 'invoices')
    expect(stored).not.toBeNull()
    expect(stored!._iv.length).toBeGreaterThan(0)
    expect(stored!._data.length).toBeGreaterThan(0)
  })

  it('reopening the vault with an unchanged schema does NOT bump _v (hash-skip)', async () => {
    const InvoiceSchema = z.object({ id: z.string(), amount: z.number() })

    let comp = await db.openVault(COMP)
    comp.collection<Invoice>('invoices', { schema: InvoiceSchema, persistJsonSchema: true })
    await comp._drainPendingSchemaWrites()
    const v1 = (await adapter.get(COMP, SCHEMAS_COLLECTION, 'invoices'))!._v

    // Re-open the same vault as a fresh session
    const db2 = await createNoydb({ store: adapter, user: 'owner-01', secret: 'owner-pass' })
    comp = await db2.openVault(COMP)
    comp.collection<Invoice>('invoices', { schema: InvoiceSchema, persistJsonSchema: true })
    await comp._drainPendingSchemaWrites()
    const v2 = (await adapter.get(COMP, SCHEMAS_COLLECTION, 'invoices'))!._v

    expect(v2).toBe(v1)
  })

  it('reopening with a changed schema DOES bump _v', async () => {
    let comp = await db.openVault(COMP)
    comp.collection<Invoice>('invoices', {
      schema: z.object({ id: z.string(), amount: z.number() }),
      persistJsonSchema: true,
    })
    await comp._drainPendingSchemaWrites()
    const v1 = (await adapter.get(COMP, SCHEMAS_COLLECTION, 'invoices'))!._v

    const db2 = await createNoydb({ store: adapter, user: 'owner-01', secret: 'owner-pass' })
    comp = await db2.openVault(COMP)
    comp.collection<Invoice>('invoices', {
      schema: z.object({ id: z.string(), amount: z.number(), note: z.string() }), // shape changed
      persistJsonSchema: true,
    })
    await comp._drainPendingSchemaWrites()
    const v2 = (await adapter.get(COMP, SCHEMAS_COLLECTION, 'invoices'))!._v

    expect(v2).toBe(v1 + 1)
  })
})
