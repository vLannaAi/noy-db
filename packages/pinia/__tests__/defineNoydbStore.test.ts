import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { setActivePinia, createPinia, storeToRefs } from 'pinia'
import { createNoydb, type Noydb, type NoydbAdapter, type EncryptedEnvelope, type CompartmentSnapshot, type StandardSchemaV1, ConflictError, Query } from '@noy-db/core'
import { defineNoydbStore, setActiveNoydb } from '../src/index.js'

/** Inline memory adapter — same pattern as @noy-db/core integration tests. */
function memory(): NoydbAdapter {
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
      const comp = store.get(c); const s: CompartmentSnapshot = {}
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

interface Invoice {
  id: string
  amount: number
  status: 'draft' | 'open' | 'paid'
  client: string
}

async function makeNoydb(): Promise<Noydb> {
  return createNoydb({
    adapter: memory(),
    user: 'owner',
    secret: 'pinia-test-passphrase-2026',
  })
}

describe('defineNoydbStore — greenfield path', () => {
  let db: Noydb

  beforeEach(async () => {
    setActivePinia(createPinia())
    db = await makeNoydb()
    setActiveNoydb(db)
  })

  afterEach(() => {
    setActiveNoydb(null)
  })

  it('1. instantiates against an in-memory adapter and exposes items', async () => {
    const useInvoices = defineNoydbStore<Invoice>('invoices', { compartment: 'C1' })
    const store = useInvoices()
    await store.$ready
    expect(store.items).toEqual([])
  })

  it('2. items reactivity reflects add()', async () => {
    const useInvoices = defineNoydbStore<Invoice>('invoices', { compartment: 'C1' })
    const store = useInvoices()
    await store.$ready
    await store.add('inv-001', { id: 'inv-001', amount: 100, status: 'draft', client: 'A' })
    expect(store.items).toHaveLength(1)
    expect(store.items[0]?.amount).toBe(100)
  })

  it('3. items reactivity reflects update() (upsert)', async () => {
    const useInvoices = defineNoydbStore<Invoice>('invoices', { compartment: 'C1' })
    const store = useInvoices()
    await store.$ready
    await store.add('inv-001', { id: 'inv-001', amount: 100, status: 'draft', client: 'A' })
    await store.update('inv-001', { id: 'inv-001', amount: 200, status: 'open', client: 'A' })
    expect(store.items).toHaveLength(1)
    expect(store.items[0]?.amount).toBe(200)
    expect(store.items[0]?.status).toBe('open')
  })

  it('4. items reactivity reflects remove()', async () => {
    const useInvoices = defineNoydbStore<Invoice>('invoices', { compartment: 'C1' })
    const store = useInvoices()
    await store.$ready
    await store.add('inv-001', { id: 'inv-001', amount: 100, status: 'draft', client: 'A' })
    await store.add('inv-002', { id: 'inv-002', amount: 200, status: 'draft', client: 'B' })
    await store.remove('inv-001')
    expect(store.items).toHaveLength(1)
    expect(store.items[0]?.id).toBe('inv-002')
  })

  it('5. byId() returns the matching record or undefined', async () => {
    const useInvoices = defineNoydbStore<Invoice>('invoices', { compartment: 'C1' })
    const store = useInvoices()
    await store.$ready
    await store.add('inv-001', { id: 'inv-001', amount: 100, status: 'draft', client: 'A' })
    expect(store.byId('inv-001')?.amount).toBe(100)
    expect(store.byId('missing')).toBeUndefined()
  })

  it('6. count is reactive', async () => {
    const useInvoices = defineNoydbStore<Invoice>('invoices', { compartment: 'C1' })
    const store = useInvoices()
    await store.$ready
    expect(store.count).toBe(0)
    await store.add('a', { id: 'a', amount: 1, status: 'draft', client: 'A' })
    await store.add('b', { id: 'b', amount: 2, status: 'draft', client: 'B' })
    expect(store.count).toBe(2)
  })

  it('7. $ready is a Promise<void> resolved exactly once per store instance', async () => {
    const useInvoices = defineNoydbStore<Invoice>('invoices', { compartment: 'C1' })
    const store = useInvoices()
    expect(store.$ready).toBeInstanceOf(Promise)
    await expect(store.$ready).resolves.toBeUndefined()
    // Second await of the same promise resolves immediately, no re-hydration.
    await expect(store.$ready).resolves.toBeUndefined()
  })

  it('8. schema validation throws on invalid input', async () => {
    // Minimal inline Standard Schema v1 validator. We don't pull in Zod
    // as a dependency of the pinia package tests; a hand-rolled 10-line
    // validator is enough to exercise the wiring end-to-end.
    //
    // The validator intentionally lives in the `~standard` property with
    // a `version: 1` marker — any object shaped like this will be
    // accepted by the schema integration regardless of which validator
    // library it came from.
    const schema: StandardSchemaV1<unknown, Invoice> = {
      '~standard': {
        version: 1,
        vendor: 'inline-test',
        validate: (value) => {
          const r = value as Invoice
          if (typeof r.amount !== 'number') {
            return {
              issues: [
                { message: 'amount must be a number', path: ['amount'] },
              ],
            }
          }
          return { value: r }
        },
      },
    }
    const useInvoices = defineNoydbStore<Invoice>('invoices', {
      compartment: 'C1',
      schema,
    })
    const store = useInvoices()
    await store.$ready
    // @ts-expect-error — intentionally wrong type
    await expect(store.add('bad', { id: 'bad', amount: 'oops', status: 'draft', client: 'X' }))
      .rejects.toThrow(/amount must be a number/)
  })

  it('9. persistence round-trip across store re-creation', async () => {
    const useInvoices1 = defineNoydbStore<Invoice>('invoices', { compartment: 'C1' })
    const store1 = useInvoices1()
    await store1.$ready
    await store1.add('inv-001', { id: 'inv-001', amount: 100, status: 'draft', client: 'A' })

    // Reset Pinia and create a new store backed by the same Noydb instance.
    setActivePinia(createPinia())
    const useInvoices2 = defineNoydbStore<Invoice>('invoices', { compartment: 'C1' })
    const store2 = useInvoices2()
    await store2.$ready
    expect(store2.items).toHaveLength(1)
    expect(store2.items[0]?.id).toBe('inv-001')
  })

  it('10. multi-store isolation: two compartments do not bleed', async () => {
    const useA = defineNoydbStore<Invoice>('invoicesA', { compartment: 'C1', collection: 'invoices' })
    const useB = defineNoydbStore<Invoice>('invoicesB', { compartment: 'C2', collection: 'invoices' })
    const a = useA()
    const b = useB()
    await Promise.all([a.$ready, b.$ready])

    await a.add('a-1', { id: 'a-1', amount: 100, status: 'draft', client: 'A' })
    await b.add('b-1', { id: 'b-1', amount: 200, status: 'open', client: 'B' })

    expect(a.items).toHaveLength(1)
    expect(a.items[0]?.id).toBe('a-1')
    expect(b.items).toHaveLength(1)
    expect(b.items[0]?.id).toBe('b-1')
  })

  it('11. storeToRefs returns reactive refs for items and count', async () => {
    const useInvoices = defineNoydbStore<Invoice>('invoices', { compartment: 'C1' })
    const store = useInvoices()
    await store.$ready
    const { items, count } = storeToRefs(store)
    expect(items.value).toEqual([])
    expect(count.value).toBe(0)

    await store.add('a', { id: 'a', amount: 1, status: 'draft', client: 'A' })
    expect(items.value).toHaveLength(1)
    expect(count.value).toBe(1)
  })

  it('12. throws a clear error when no Noydb instance is bound', async () => {
    setActiveNoydb(null)
    const useInvoices = defineNoydbStore<Invoice>('invoices', { compartment: 'C1' })
    const store = useInvoices()
    await expect(store.$ready).rejects.toThrow(/no Noydb instance bound/)
  })

  it('13. accepts an explicit noydb option (no global binding required)', async () => {
    setActiveNoydb(null)
    const local = await makeNoydb()
    const useInvoices = defineNoydbStore<Invoice>('invoices', {
      compartment: 'C1',
      noydb: local,
    })
    const store = useInvoices()
    await store.$ready
    await store.add('inv-001', { id: 'inv-001', amount: 100, status: 'draft', client: 'A' })
    expect(store.items).toHaveLength(1)
  })

  it('14. prefetch: false defers hydration until refresh()', async () => {
    // Pre-seed the underlying compartment so refresh has something to load.
    const c = await db.openCompartment('C1')
    await c.collection<Invoice>('invoices').put('seeded', { id: 'seeded', amount: 99, status: 'draft', client: 'X' })

    const useInvoices = defineNoydbStore<Invoice>('invoices', {
      compartment: 'C1',
      prefetch: false,
    })
    const store = useInvoices()
    await store.$ready // resolves immediately because prefetch is off
    expect(store.items).toEqual([])

    await store.refresh()
    expect(store.items).toHaveLength(1)
    expect(store.items[0]?.id).toBe('seeded')
  })

  it('15. query() returns a chainable Query<T> bound to the collection', async () => {
    const useInvoices = defineNoydbStore<Invoice>('invoices', { compartment: 'C1' })
    const store = useInvoices()
    await store.$ready
    await store.add('a', { id: 'a', amount: 100,  status: 'draft', client: 'Alpha' })
    await store.add('b', { id: 'b', amount: 5000, status: 'open',  client: 'Bravo' })
    await store.add('c', { id: 'c', amount: 250,  status: 'open',  client: 'Charlie' })

    const q = store.query()
    expect(q).toBeInstanceOf(Query)
    const opens = q.where('status', '==', 'open').orderBy('amount', 'desc').toArray()
    expect(opens.map(r => r.id)).toEqual(['b', 'c'])
  })

  it('16. query() before $ready throws when prefetch is false', async () => {
    const useInvoices = defineNoydbStore<Invoice>('invoices', {
      compartment: 'C1',
      prefetch: false,
    })
    const store = useInvoices()
    expect(() => store.query()).toThrow(/before the store was ready/)
  })

  it('17. refresh() re-hydrates after external mutation', async () => {
    const useInvoices = defineNoydbStore<Invoice>('invoices', { compartment: 'C1' })
    const store = useInvoices()
    await store.$ready

    // Mutate the underlying collection out-of-band (simulating sync pull).
    const c = await db.openCompartment('C1')
    await c.collection<Invoice>('invoices').put('external', { id: 'external', amount: 1, status: 'draft', client: 'X' })

    expect(store.items).toHaveLength(0) // stale until refresh
    await store.refresh()
    expect(store.items).toHaveLength(1)
  })

  it('18. supports `collection` option distinct from store id', async () => {
    const useInvoices = defineNoydbStore<Invoice>('myInvoices', {
      compartment: 'C1',
      collection: 'invoices_v2',
    })
    const store = useInvoices()
    await store.$ready
    await store.add('a', { id: 'a', amount: 1, status: 'draft', client: 'A' })

    // Verify the data landed in the renamed collection on the underlying Noydb.
    const c = await db.openCompartment('C1')
    const direct = await c.collection<Invoice>('invoices_v2').list()
    expect(direct).toHaveLength(1)
    expect(direct[0]?.id).toBe('a')
  })
})
