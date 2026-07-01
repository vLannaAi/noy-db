import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../../src/kernel/types.js'
import { ConflictError } from '../../src/errors.js'
import { createNoydb, writeNoydbBundle, readNoydbBundle } from '../../src/index.js'
import { withHistory } from '../../src/with-commit/history/index.js'
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

describe('persisted schemas survive bundle write → read round-trip', () => {
  it('vault.dump() embeds _schemas under backup._internal', async () => {
    const Invoice = z.object({ id: z.string(), amount: z.number() })

    const db = await createNoydb({ store: inlineMemory(), user: 'alice', secret: 'test-pw-12345678', historyStrategy: withHistory() })
    const vault = await db.openVault('acme')
    vault.collection<{ id: string; amount: number }>('invoices', {
      schema: Invoice, persistJsonSchema: true,
    })
    await vault._drainPendingSchemaWrites()

    const dumpJson = await vault.dump()
    const backup = JSON.parse(dumpJson) as { _internal?: Record<string, Record<string, EncryptedEnvelope>> }

    expect(backup._internal).toBeDefined()
    expect(backup._internal![SCHEMAS_COLLECTION]).toBeDefined()
    expect(Object.keys(backup._internal![SCHEMAS_COLLECTION]!)).toContain('invoices')
  })

  it('after writeNoydbBundle → readNoydbBundle → vault.load, _schemas/<col> is queryable', async () => {
    const Invoice = z.object({ id: z.string(), amount: z.number() })

    // Source vault — write persisted schema, write bundle
    const srcStore = inlineMemory()
    const srcDb = await createNoydb({ store: srcStore, user: 'alice', secret: 'test-pw-12345678', historyStrategy: withHistory() })
    const srcVault = await srcDb.openVault('acme')
    srcVault.collection<{ id: string; amount: number }>('invoices', {
      schema: Invoice, persistJsonSchema: true,
    })
    await srcVault._drainPendingSchemaWrites()
    const bundleBytes = await writeNoydbBundle(srcVault, { compression: 'none' })

    // Target vault — fresh memory, load the bundle
    const dstStore = inlineMemory()
    const dstDb = await createNoydb({ store: dstStore, user: 'alice', secret: 'test-pw-12345678', historyStrategy: withHistory() })
    const dstVault = await dstDb.openVault('acme')
    const { dumpJson } = await readNoydbBundle(bundleBytes)
    await dstVault.load(dumpJson)

    // After load, _schemas/invoices envelope is queryable in the target store
    const env = await dstStore.get('acme', SCHEMAS_COLLECTION, 'invoices')
    expect(env).not.toBeNull()
    expect(env!._iv.length).toBeGreaterThan(0)
    expect(env!._data.length).toBeGreaterThan(0)

    // Critical: dumpSchema() must surface it via the 'persisted' source path.
    dstVault.collection('invoices') // touch
    const snap = await dstVault.dumpSchema()
    expect(snap.collections.invoices?.validator).toEqual({ kind: 'Zod', source: 'persisted' })
  })

  it('full CLI-style flow: collections+records put before bundle, then load + collections() + touch + dumpSchema', async () => {
    const Invoice = z.object({ id: z.string(), amount: z.number() })

    const srcStore = inlineMemory()
    const srcDb = await createNoydb({ store: srcStore, user: 'alice', secret: 'test-pw-12345678', historyStrategy: withHistory() })
    const srcVault = await srcDb.openVault('acme')
    srcVault.collection<{ id: string; amount: number }>('invoices', {
      schema: Invoice, persistJsonSchema: true,
    })
    srcVault.collection('clients')
    await srcVault._drainPendingSchemaWrites()
    await srcVault.collection<{ id: string; amount: number }>('invoices').put('i1', { id: 'i1', amount: 100 })
    await srcVault.collection('clients').put('c1', { id: 'c1', name: 'Acme' })

    const bundleBytes = await writeNoydbBundle(srcVault, { compression: 'none' })

    const dstStore = inlineMemory()
    const dstDb = await createNoydb({ store: dstStore, user: 'alice', secret: 'test-pw-12345678', historyStrategy: withHistory() })
    const dstVault = await dstDb.openVault('acme')
    const { dumpJson } = await readNoydbBundle(bundleBytes)
    await dstVault.load(dumpJson)

    // Mirror CLI describeBundle: iterate collections() + touch each
    const names = await dstVault.collections()
    for (const name of names) {
      if (!name.startsWith('_')) dstVault.collection(name)
    }

    const snap = await dstVault.dumpSchema()
    expect(snap.collections.invoices?.validator).toEqual({ kind: 'Zod', source: 'persisted' })
  })
})
