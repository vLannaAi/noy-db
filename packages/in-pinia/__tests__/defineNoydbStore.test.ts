import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia, storeToRefs } from 'pinia'
import { effectScope, ref } from 'vue'
import { createNoydb, additiveOnly, i18nText, type Noydb, type NoydbStore, type EncryptedEnvelope, type VaultSnapshot, type StandardSchemaV1, ConflictError, Query } from '@noy-db/hub'
import { withI18n } from '@noy-db/hub/i18n'
import { withAttestation } from '@noy-db/hub/attestation'
import { defineNoydbStore, setActiveNoydb, useNoydbI18n } from '../src/index.js'

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Inline memory adapter — same pattern as @noy-db/core integration tests. */
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

interface Invoice {
  id: string
  amount: number
  status: 'draft' | 'open' | 'paid'
  client: string
}

async function makeNoydb(): Promise<Noydb> {
  return createNoydb({
    store: memory(),
    user: 'owner',
    secret: 'pinia-test-secret-2026',
    attestationStrategy: withAttestation(),
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
    const useInvoices = defineNoydbStore<Invoice>('invoices', { vault: 'C1' })
    const store = useInvoices()
    await store.$ready
    expect(store.items).toEqual([])
  })

  it('2. items reactivity reflects add()', async () => {
    const useInvoices = defineNoydbStore<Invoice>('invoices', { vault: 'C1' })
    const store = useInvoices()
    await store.$ready
    await store.add('inv-001', { id: 'inv-001', amount: 100, status: 'draft', client: 'A' })
    expect(store.items).toHaveLength(1)
    expect(store.items[0]?.amount).toBe(100)
  })

  it('3. items reactivity reflects update() (upsert)', async () => {
    const useInvoices = defineNoydbStore<Invoice>('invoices', { vault: 'C1' })
    const store = useInvoices()
    await store.$ready
    await store.add('inv-001', { id: 'inv-001', amount: 100, status: 'draft', client: 'A' })
    await store.update('inv-001', { id: 'inv-001', amount: 200, status: 'open', client: 'A' })
    expect(store.items).toHaveLength(1)
    expect(store.items[0]?.amount).toBe(200)
    expect(store.items[0]?.status).toBe('open')
  })

  it('4. items reactivity reflects remove()', async () => {
    const useInvoices = defineNoydbStore<Invoice>('invoices', { vault: 'C1' })
    const store = useInvoices()
    await store.$ready
    await store.add('inv-001', { id: 'inv-001', amount: 100, status: 'draft', client: 'A' })
    await store.add('inv-002', { id: 'inv-002', amount: 200, status: 'draft', client: 'B' })
    await store.remove('inv-001')
    expect(store.items).toHaveLength(1)
    expect(store.items[0]?.id).toBe('inv-002')
  })

  it('5. byId() returns the matching record or undefined', async () => {
    const useInvoices = defineNoydbStore<Invoice>('invoices', { vault: 'C1' })
    const store = useInvoices()
    await store.$ready
    await store.add('inv-001', { id: 'inv-001', amount: 100, status: 'draft', client: 'A' })
    expect(store.byId('inv-001')?.amount).toBe(100)
    expect(store.byId('missing')).toBeUndefined()
  })

  it('6. count is reactive', async () => {
    const useInvoices = defineNoydbStore<Invoice>('invoices', { vault: 'C1' })
    const store = useInvoices()
    await store.$ready
    expect(store.count).toBe(0)
    await store.add('a', { id: 'a', amount: 1, status: 'draft', client: 'A' })
    await store.add('b', { id: 'b', amount: 2, status: 'draft', client: 'B' })
    expect(store.count).toBe(2)
  })

  it('7. $ready is a Promise<void> resolved exactly once per store instance', async () => {
    const useInvoices = defineNoydbStore<Invoice>('invoices', { vault: 'C1' })
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
      vault: 'C1',
      schema,
    })
    const store = useInvoices()
    await store.$ready
    // @ts-expect-error — intentionally wrong type
    await expect(store.add('bad', { id: 'bad', amount: 'oops', status: 'draft', client: 'X' }))
      .rejects.toThrow(/amount must be a number/)
  })

  it('9. persistence round-trip across store re-creation', async () => {
    const useInvoices1 = defineNoydbStore<Invoice>('invoices', { vault: 'C1' })
    const store1 = useInvoices1()
    await store1.$ready
    await store1.add('inv-001', { id: 'inv-001', amount: 100, status: 'draft', client: 'A' })

    // Reset Pinia and create a new store backed by the same Noydb instance.
    setActivePinia(createPinia())
    const useInvoices2 = defineNoydbStore<Invoice>('invoices', { vault: 'C1' })
    const store2 = useInvoices2()
    await store2.$ready
    expect(store2.items).toHaveLength(1)
    expect(store2.items[0]?.id).toBe('inv-001')
  })

  it('10. multi-store isolation: two compartments do not bleed', async () => {
    const useA = defineNoydbStore<Invoice>('invoicesA', { vault: 'C1', collection: 'invoices' })
    const useB = defineNoydbStore<Invoice>('invoicesB', { vault: 'C2', collection: 'invoices' })
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
    const useInvoices = defineNoydbStore<Invoice>('invoices', { vault: 'C1' })
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
    const useInvoices = defineNoydbStore<Invoice>('invoices', { vault: 'C1' })
    const store = useInvoices()
    await expect(store.$ready).rejects.toThrow(/no Noydb instance bound/)
  })

  it('13. accepts an explicit noydb option (no global binding required)', async () => {
    setActiveNoydb(null)
    const local = await makeNoydb()
    const useInvoices = defineNoydbStore<Invoice>('invoices', {
      vault: 'C1',
      noydb: local,
    })
    const store = useInvoices()
    await store.$ready
    await store.add('inv-001', { id: 'inv-001', amount: 100, status: 'draft', client: 'A' })
    expect(store.items).toHaveLength(1)
  })

  it('14. prefetch: false defers hydration until refresh()', async () => {
    // Pre-seed the underlying vault so refresh has something to load.
    const c = await db.openVault('C1')
    await c.collection<Invoice>('invoices').put('seeded', { id: 'seeded', amount: 99, status: 'draft', client: 'X' })

    const useInvoices = defineNoydbStore<Invoice>('invoices', {
      vault: 'C1',
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
    const useInvoices = defineNoydbStore<Invoice>('invoices', { vault: 'C1' })
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
      vault: 'C1',
      prefetch: false,
    })
    const store = useInvoices()
    expect(() => store.query()).toThrow(/before the store was ready/)
  })

  it('17. refresh() re-hydrates after external mutation', async () => {
    const useInvoices = defineNoydbStore<Invoice>('invoices', { vault: 'C1' })
    const store = useInvoices()
    await store.$ready

    // Mutate the underlying collection out-of-band (simulating sync pull).
    const c = await db.openVault('C1')
    await c.collection<Invoice>('invoices').put('external', { id: 'external', amount: 1, status: 'draft', client: 'X' })

    expect(store.items).toHaveLength(0) // stale until refresh
    await store.refresh()
    expect(store.items).toHaveLength(1)
  })

  it('19. liveQuery() reflects writes to the bound collection without manual refresh', async () => {
    const useInvoices = defineNoydbStore<Invoice>('invoices', { vault: 'C1' })
    const store = useInvoices()
    await store.$ready

    const live = store.liveQuery(q =>
      q.where('status', '==', 'open').orderBy('amount', 'desc'),
    )
    expect(live.items.value).toEqual([])
    expect(live.error.value).toBeNull()

    await store.add('a', { id: 'a', amount: 100, status: 'draft', client: 'A' })
    await store.add('b', { id: 'b', amount: 5000, status: 'open', client: 'B' })
    await store.add('c', { id: 'c', amount: 250, status: 'open', client: 'C' })

    expect(live.items.value.map(r => r.id)).toEqual(['b', 'c'])

    // External-handle write through the same Noydb instance must also propagate,
    // because LiveQuery subscribes to the underlying Collection emitter — not the
    // Pinia store's reactive cache.
    const c = await db.openVault('C1')
    await c.collection<Invoice>('invoices').put('d', { id: 'd', amount: 999, status: 'open', client: 'D' })
    expect(live.items.value.map(r => r.id)).toEqual(['b', 'd', 'c'])

    live.stop()
  })

  it('20. liveQuery() throws before $ready when prefetch is false', async () => {
    const useInvoices = defineNoydbStore<Invoice>('invoices', {
      vault: 'C1',
      prefetch: false,
    })
    const store = useInvoices()
    expect(() => store.liveQuery(q => q)).toThrow(/before the store was ready/)
  })

  it('21. stop() releases subscriptions; later writes do not update items', async () => {
    const useInvoices = defineNoydbStore<Invoice>('invoices', { vault: 'C1' })
    const store = useInvoices()
    await store.$ready

    const live = store.liveQuery(q => q)
    await store.add('a', { id: 'a', amount: 1, status: 'draft', client: 'A' })
    expect(live.items.value).toHaveLength(1)

    live.stop()
    await store.add('b', { id: 'b', amount: 2, status: 'draft', client: 'B' })
    expect(live.items.value).toHaveLength(1) // frozen at last pre-stop snapshot

    // stop() is idempotent.
    expect(() => live.stop()).not.toThrow()
  })

  it('22. effectScope dispose auto-stops the live query', async () => {
    const useInvoices = defineNoydbStore<Invoice>('invoices', { vault: 'C1' })
    const store = useInvoices()
    await store.$ready

    const scope = effectScope()
    const live = scope.run(() => store.liveQuery(q => q))!
    await store.add('a', { id: 'a', amount: 1, status: 'draft', client: 'A' })
    expect(live.items.value).toHaveLength(1)

    scope.stop()
    await store.add('b', { id: 'b', amount: 2, status: 'draft', client: 'B' })
    expect(live.items.value).toHaveLength(1) // auto-stopped on scope dispose
  })

  it('23. liveQuery() and query() are independent — query() still scans the reactive cache', async () => {
    const useInvoices = defineNoydbStore<Invoice>('invoices', { vault: 'C1' })
    const store = useInvoices()
    await store.$ready
    await store.add('a', { id: 'a', amount: 1, status: 'open', client: 'A' })

    const live = store.liveQuery(q => q.where('status', '==', 'open'))
    const eager = store.query().where('status', '==', 'open').toArray()

    expect(eager.map(r => r.id)).toEqual(['a'])
    expect(live.items.value.map(r => r.id)).toEqual(['a'])

    live.stop()
  })

  it('18. supports `collection` option distinct from store id', async () => {
    const useInvoices = defineNoydbStore<Invoice>('myInvoices', {
      vault: 'C1',
      collection: 'invoices_v2',
    })
    const store = useInvoices()
    await store.$ready
    await store.add('a', { id: 'a', amount: 1, status: 'draft', client: 'A' })

    // Verify the data landed in the renamed collection on the underlying Noydb.
    const c = await db.openVault('C1')
    const direct = await c.collection<Invoice>('invoices_v2').list()
    expect(direct).toHaveLength(1)
    expect(direct[0]?.id).toBe('a')
  })
})

describe('attestation option forwarding', () => {
  it('forwards `attestation` to the Collection so vault.issueAttestation works', async () => {
    setActivePinia(createPinia())
    const db = await makeNoydb()
    setActiveNoydb(db)
    const useStore = defineNoydbStore<Invoice>('att-invoices', {
      vault: 'books',
      collection: 'invoices',
      attestation: {
        fields: [
          { path: 'amount', normalize: 'cents' },
          { path: 'client', normalize: 'trim' },
        ],
      },
    })
    const store = useStore()
    await store.$ready
    await store.add('i1', { id: 'i1', amount: 100, status: 'open', client: 'ACME' })

    // Without the forward the collection carries no attestation schema and this throws.
    const vault = await db.openVault('books')
    const att = await vault.issueAttestation('invoices', 'i1')
    expect(att.docId).toBeTruthy()
    expect(att.qr).toBeTruthy()
    expect(att.keyId).toBeTruthy()
  })
})

describe('schema-update option forwarding (#255)', () => {
  it('forwards `persistJsonSchema` and `schemaUpdate` to the underlying Collection', async () => {
    setActivePinia(createPinia())
    const db = await makeNoydb()
    setActiveNoydb(db)

    // `openVault` caches per name, so the store's internal `openVault('books')`
    // resolves to this same instance. Spy on its prototype's `collection` to
    // capture exactly the options the store forwards — this asserts the
    // forwarding (the unit under test) without depending on persistJsonSchema's
    // downstream baseline derivation.
    const vault = await db.openVault('books')
    const spy = vi.spyOn(Object.getPrototypeOf(vault) as { collection: unknown }, 'collection')

    // Pass-through Standard Schema (in-pinia has no Zod dep); the store still
    // installs it, but this test only checks the migration options forward.
    const schema: StandardSchemaV1<unknown, Invoice> = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: (value) => ({ value: value as Invoice }),
      },
    }

    const useStore = defineNoydbStore<Invoice>('mig-invoices', {
      vault: 'books',
      collection: 'invoices',
      schema,
      persistJsonSchema: true,
      schemaUpdate: [additiveOnly()],
    })
    const store = useStore()
    // Swallow any downstream baseline-derivation outcome — the spy already
    // captured the forwarded options at the synchronous collection() call.
    await store.$ready.catch(() => {})

    const call = spy.mock.calls.find((c) => c[0] === 'invoices')
    expect(call, 'vault.collection("invoices", …) should have been called').toBeTruthy()
    const opts = call![1] as { persistJsonSchema?: boolean; schemaUpdate?: readonly unknown[] }
    expect(opts?.persistJsonSchema).toBe(true)
    expect(opts?.schemaUpdate).toHaveLength(1)

    spy.mockRestore()
  })
})

// ─── i18nFields / dictKeyFields forwarding (#274) ──────────────────────

describe('defineNoydbStore — i18nFields / dictKeyFields forwarding', () => {
  let db: Noydb

  beforeEach(async () => {
    setActivePinia(createPinia())
    db = await createNoydb({
      store: memory(),
      user: 'owner',
      i18nStrategy: withI18n(),
      secret: 'pinia-i18n-test-secret',
    })
    setActiveNoydb(db)
  })

  it('forwards i18nFields to vault.collection', async () => {
    const vault = await db.openVault('shop')
    const spy = vi.spyOn(Object.getPrototypeOf(vault) as { collection: unknown }, 'collection')

    const nameDesc = i18nText({ languages: ['en', 'th'], required: 'any' })
    const useProducts = defineNoydbStore('products-i18n-fwd', {
      vault: 'shop',
      collection: 'products',
      i18nFields: { name: nameDesc },
    })
    const store = useProducts()
    await store.$ready.catch(() => {})

    const call = spy.mock.calls.find((c) => c[0] === 'products')
    expect(call, 'vault.collection("products", …) should have been called').toBeTruthy()
    const opts = call![1] as { i18nFields?: Record<string, unknown> }
    expect(opts?.i18nFields).toBeDefined()
    expect(opts?.i18nFields?.name).toBe(nameDesc)

    spy.mockRestore()
  })

  it('resolves i18n field on read when forwarded', async () => {
    type Product = { id: string; name: Record<string, string> | string }
    const nameDesc = i18nText({ languages: ['en', 'th'], required: 'any' })
    const useProducts = defineNoydbStore<Product>('products-i18n-read', {
      vault: 'shop2',
      i18nFields: { name: nameDesc },
    })
    const store = useProducts()
    await store.$ready

    await store.add('p1', { id: 'p1', name: { en: 'Widget', th: 'วิดเจ็ต' } })

    const vault = await db.openVault('shop2')
    const col = vault.collection<Product>('products-i18n-read')
    const row = await col.get('p1', { locale: 'th' }) as { id: string; name: string }
    expect(row.name).toBe('วิดเจ็ต')
  })

  it("default i18n mode ('raw') keeps the {th,en} map (non-breaking)", async () => {
    type P = { id: string; name: Record<string, string> | string }
    const useP = defineNoydbStore<P>('p-raw', {
      vault: 'rawv',
      i18nFields: { name: i18nText({ languages: ['th', 'en'], required: 'any' }) },
    })
    const store = useP()
    await store.$ready
    await store.add('p1', { id: 'p1', name: { th: 'สมชาย', en: 'Somchai' } })
    expect(store.items.find((x) => x.id === 'p1')?.name).toEqual({ th: 'สมชาย', en: 'Somchai' })
  })

  it("i18n:'follow' resolves to the global locale and re-reads on flip", async () => {
    const i18n = useNoydbI18n()
    i18n.setLocale('en')
    type P = { id: string; name: Record<string, string> | string }
    const useP = defineNoydbStore<P>('p-follow', {
      vault: 'followv',
      i18n: 'follow',
      i18nFields: { name: i18nText({ languages: ['th', 'en'], required: 'any' }) },
    })
    const store = useP()
    await store.$ready
    await store.add('p1', { id: 'p1', name: { th: 'สมชาย', en: 'Somchai' } })
    expect(store.items.find((x) => x.id === 'p1')?.name).toBe('Somchai')
    i18n.setLocale('th')
    for (let n = 0; n < 50 && store.items.find((x) => x.id === 'p1')?.name !== 'สมชาย'; n++) await tick(10)
    expect(store.items.find((x) => x.id === 'p1')?.name).toBe('สมชาย')
  })

  it("i18n:{locale:'th'} pins regardless of the global locale", async () => {
    const i18n = useNoydbI18n()
    i18n.setLocale('en')
    type P = { id: string; name: Record<string, string> | string }
    const useP = defineNoydbStore<P>('p-pin', {
      vault: 'pinv',
      i18n: { locale: 'th' },
      i18nFields: { name: i18nText({ languages: ['th', 'en'], required: 'any' }) },
    })
    const store = useP()
    await store.$ready
    await store.add('p1', { id: 'p1', name: { th: 'สมชาย', en: 'Somchai' } })
    expect(store.items.find((x) => x.id === 'p1')?.name).toBe('สมชาย')
  })
})

describe('defineNoydbStore — dynamic vault resolver (#383)', () => {
  let db: Noydb
  beforeEach(async () => {
    setActivePinia(createPinia())
    db = await makeNoydb()
    setActiveNoydb(db)
  })
  afterEach(() => { setActiveNoydb(null) })

  it('resolves the vault from a function and re-hydrates when its reactive dep changes', async () => {
    // Seed two per-client shard vaults directly.
    const c1 = await db.openVault('clients-C1')
    await c1.collection<Invoice>('invoices').put('a', { id: 'a', amount: 1, status: 'open', client: 'C1' })
    const c2 = await db.openVault('clients-C2')
    await c2.collection<Invoice>('invoices').put('b', { id: 'b', amount: 2, status: 'open', client: 'C2' })

    const code = ref('C1') // active client scope (e.g. from the URL)
    const useInvoices = defineNoydbStore<Invoice>('invoices', { vault: () => `clients-${code.value}` })
    const store = useInvoices()
    await store.$ready
    expect(store.items.map((i) => i.id)).toEqual(['a'])

    // Drill into the other client → the store follows into its shard.
    code.value = 'C2'
    for (let n = 0; n < 50 && store.items[0]?.id !== 'b'; n++) await tick(10)
    expect(store.items.map((i) => i.id)).toEqual(['b'])

    // …and back.
    code.value = 'C1'
    for (let n = 0; n < 50 && store.items[0]?.id !== 'a'; n++) await tick(10)
    expect(store.items.map((i) => i.id)).toEqual(['a'])
  })

  it('writes land in the currently-resolved vault', async () => {
    const code = ref('C1')
    const useInvoices = defineNoydbStore<Invoice>('invoices', { vault: () => `w-${code.value}` })
    const store = useInvoices()
    await store.$ready
    await store.add('x', { id: 'x', amount: 5, status: 'open', client: 'C1' })

    code.value = 'C2'
    await tick(20) // let the re-bind watch settle
    await store.add('y', { id: 'y', amount: 9, status: 'open', client: 'C2' })

    const w1 = await db.openVault('w-C1')
    const w2 = await db.openVault('w-C2')
    expect((await w1.collection<Invoice>('invoices').list()).map((i) => i.id)).toEqual(['x'])
    expect((await w2.collection<Invoice>('invoices').list()).map((i) => i.id)).toEqual(['y'])
  })

  it('a non-reactive resolver self-heals on the next refresh()/add()', async () => {
    let current = 'C1'
    const useInvoices = defineNoydbStore<Invoice>('invoices', { vault: () => `nr-${current}` })
    const store = useInvoices()
    await store.$ready
    await store.add('a', { id: 'a', amount: 1, status: 'open', client: 'C1' })
    expect(store.items.map((i) => i.id)).toEqual(['a'])

    current = 'C2' // non-reactive change — no auto-watch fires
    await store.refresh() // explicit re-bind
    expect(store.items.map((i) => i.id)).toEqual([]) // nr-C2 is empty
    await store.add('b', { id: 'b', amount: 2, status: 'open', client: 'C2' })
    expect(store.items.map((i) => i.id)).toEqual(['b'])
  })

  it('a static string vault still works (back-compat)', async () => {
    const useInvoices = defineNoydbStore<Invoice>('invoices', { vault: 'static-v' })
    const store = useInvoices()
    await store.$ready
    await store.add('a', { id: 'a', amount: 1, status: 'open', client: 'X' })
    expect(store.items.map((i) => i.id)).toEqual(['a'])
  })
})
