import { describe, it, expect, beforeEach } from 'vitest'
import { z } from 'zod'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../../src/kernel/types.js'
import { ConflictError } from '../../src/kernel/errors.js'
import { createNoydb } from '../../src/kernel/noydb.js'
import type { Noydb } from '../../src/kernel/noydb.js'

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

interface Invoice { id: string; amount: number; status: string }
interface Client { id: string; name: string }

describe('vault.dumpSchema() — baseline', () => {
  const COMP = 'acme'
  let adapter: NoydbStore
  let db: Noydb

  beforeEach(async () => {
    adapter = inlineMemory()
    db = await createNoydb({ store: adapter, user: 'owner-01', secret: 'owner-pass' })
  })

  it('returns _noydb_snapshot version + vault name + emittedAt', async () => {
    const comp = await db.openVault(COMP)
    const snap = await comp.dumpSchema()
    expect(snap._noydb_snapshot).toBe(1)
    expect(snap.vault).toBe(COMP)
    expect(snap.emittedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('lists user collections (without internals) alphabetically', async () => {
    const comp = await db.openVault(COMP)
    comp.collection<Invoice>('invoices')
    comp.collection<Client>('clients')
    await comp.collection<Invoice>('invoices').put('i1', { id: 'i1', amount: 100, status: 'draft' })
    await comp.collection<Client>('clients').put('c1', { id: 'c1', name: 'Acme' })

    const snap = await comp.dumpSchema()
    expect(Object.keys(snap.collections)).toEqual(['clients', 'invoices'])
    // internals never appear at top level
    expect(snap.collections).not.toHaveProperty('_keyring')
    expect(snap.collections).not.toHaveProperty('_meta')
    expect(snap.collections).not.toHaveProperty('_schemas')
  })

  it('emits a field block sourced from the persisted JSON Schema (Route B)', async () => {
    const Invoice = z.object({
      id: z.string(),
      amount: z.number().positive(),
      status: z.enum(['draft', 'paid']),
    })
    const comp = await db.openVault(COMP)
    comp.collection<Invoice>('invoices', { schema: Invoice, persistJsonSchema: true })
    await comp.collection<Invoice>('invoices').put('i1', { id: 'i1', amount: 100, status: 'draft' })
    await comp._drainPendingSchemaWrites()

    const snap = await comp.dumpSchema()
    const inv = snap.collections.invoices
    expect(inv).toBeDefined()
    expect(inv!.validator).toEqual({ kind: 'Zod', source: 'persisted' })
    expect(Object.keys(inv!.fields).sort()).toEqual(['amount', 'id', 'status'])
    expect(inv!.fields.id?.source).toBe('persisted')
    expect(inv!.fields.amount?.type).toBe('number')
  })

  it('emits a field block sourced from the LIVE validator when no persisted snapshot exists', async () => {
    const Invoice = z.object({ id: z.string(), amount: z.number() })
    const comp = await db.openVault(COMP)
    comp.collection('invoices', { schema: Invoice }) // no persistJsonSchema
    await comp.collection<Invoice>('invoices').put('i1', { id: 'i1', amount: 100, status: 'draft' })

    const snap = await comp.dumpSchema()
    const inv = snap.collections.invoices
    expect(inv!.validator).toEqual({ kind: 'Zod', source: 'live-validator' })
    expect(inv!.fields.id?.source).toBe('live-validator')
    expect(inv!.fields.amount?.type).toBe('number')
  })

  it('marks fields source=unknown when no schema is available and sampling is disabled', async () => {
    const comp = await db.openVault(COMP)
    comp.collection<Invoice>('invoices')
    await comp.collection<Invoice>('invoices').put('i1', { id: 'i1', amount: 100, status: 'draft' })

    const snap = await comp.dumpSchema({ sampleSize: 0 })
    const inv = snap.collections.invoices
    expect(inv!.validator).toBeUndefined()
    expect(inv!.fields).toEqual({})
  })

  it('reports the service opt-in matrix (presence of registries)', async () => {
    const comp = await db.openVault(COMP)
    const snap = await comp.dumpSchema()
    expect(snap.subsystems).toEqual(expect.objectContaining({
      guards: expect.any(Boolean),
      derivations: expect.any(Boolean),
      materializedViews: expect.any(Boolean),
      overlayViews: expect.any(Boolean),
    }))
  })

  it('surfaces collection-level config (embeddings/textIndexes/crdt/provenance/tiers)', async () => {
    const comp = await db.openVault(COMP)
    comp.collection<{ id: string; body: string }>('docs', {
      textIndexes: ['body'],
      embeddings: {
        source: 'body',
        dim: 128,
        model: 'test-model',
        encode: async () => new Float32Array(128),
      },
      provenance: true,
      tiers: [1, 2],
    })
    const dump = await comp.dumpSchema()
    const cfg = dump.collections['docs']!.config!
    expect(cfg.textIndexes).toContain('body')
    expect(cfg.provenance).toBe(true)
    expect(cfg.tiers).toEqual([1, 2])
    expect(cfg.embeddings?.dim).toBeGreaterThan(0)
  })

  it('omits config when a collection has no configured options', async () => {
    const comp = await db.openVault(COMP)
    comp.collection<Invoice>('plain')
    const dump = await comp.dumpSchema()
    expect(dump.collections['plain']!.config).toBeUndefined()
  })
})

describe('vault.dumpSchema() — archive + schemaUpdate config', () => {
  const COMP = 'acme-config'
  let adapter: NoydbStore
  let db: Noydb

  beforeEach(async () => {
    adapter = inlineMemory()
    db = await createNoydb({ store: adapter, user: 'owner-01', secret: 'owner-pass' })
  })

  it('surfaces archive: true when a collection declares an archive policy', async () => {
    const comp = await db.openVault(COMP)
    comp.collection<Invoice>('invoices', {
      archive: { archiveWhen: (r) => r.status === 'paid' },
    })
    const dump = await comp.dumpSchema()
    const cfg = dump.collections['invoices']!.config
    expect(cfg).toBeDefined()
    expect(cfg!.archive).toBe(true)
  })

  it('surfaces schemaUpdate with strategy names when registered', async () => {
    const comp = await db.openVault(COMP)
    const strategy = {
      name: 'addDueDate',
      detect: async () => false as const,
      transform: async (r: unknown) => r,
      onSchemaDelta: () => ({ action: 'allow' as const }),
    }
    comp.collection<Invoice>('invoices', {
      schema: z.object({ id: z.string(), amount: z.number(), status: z.string() }),
      persistJsonSchema: true,
      schemaUpdate: [strategy],
    })
    await comp.collection<Invoice>('invoices').put('i1', { id: 'i1', amount: 100, status: 'draft' })
    await comp._drainPendingSchemaWrites()
    const dump = await comp.dumpSchema()
    const cfg = dump.collections['invoices']!.config!
    expect(cfg.schemaUpdate).toContain('addDueDate')
  })

  it('merges archive + Collection-level options into a single config object', async () => {
    const comp = await db.openVault(COMP)
    comp.collection<{ id: string; body: string }>('docs', {
      textIndexes: ['body'],
      archive: { archiveWhen: () => false },
    })
    const dump = await comp.dumpSchema()
    const cfg = dump.collections['docs']!.config!
    expect(cfg.textIndexes).toContain('body')
    expect(cfg.archive).toBe(true)
  })

  it('surfaces history: true when historyConfig is explicitly provided and enabled', async () => {
    const comp = await db.openVault(COMP)
    comp.collection<Invoice>('invoices', {
      historyConfig: { maxVersions: 10 },
    })
    const dump = await comp.dumpSchema()
    const cfg = dump.collections['invoices']!.config!
    expect(cfg.history).toBe(true)
  })

  it('omits history from config when no explicit historyConfig is declared', async () => {
    const comp = await db.openVault(COMP)
    comp.collection<Invoice>('plain')
    const dump = await comp.dumpSchema()
    // A plain collection has no explicit historyConfig — history must not appear.
    expect(dump.collections['plain']!.config?.history).toBeUndefined()
  })
})
