/**
 * Foreign-key reference tests., v0.4.
 *
 * Covers:
 *   - `ref()` helper: default mode, explicit mode, cross-vault
 *     rejection, internal-collection-name rejection
 *   - strict mode on put: allows valid ref, rejects missing target
 *   - strict mode on delete: rejects delete if referencing records exist
 *   - warn mode: allows both operations, checkIntegrity surfaces orphans
 *   - cascade mode: delete of target propagates to referencing records
 *   - cascade cycle: mutually-cascading collections terminate
 *   - checkIntegrity on a clean vault returns no violations
 *   - checkIntegrity aggregates violations across multiple collections
 *   - ref atomicity: a failed strict put leaves no trace on disk
 *     (no ledger entry, no history entry, no cache write)
 *   - nullish ref values are allowed (treated as "no reference")
 *   - RefRegistry rejects conflicting re-declarations
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { createNoydb } from '../src/noydb.js'
import { withHistory } from '../src/with-commit/history/index.js'
import type { Noydb } from '../src/noydb.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/types.js'
import { ConflictError } from '../src/errors.js'
import { withTransactions } from '../src/with-commit/tx/index.js'
import {
  ref,
  refArray,
  isRefArray,
  RefIntegrityError,
  RefScopeError,
  RefRegistry,
} from '../src/refs.js'

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

interface Client {
  id: string
  name: string
}

interface Invoice {
  id: string
  client: string  // plaintext — not the ref
  clientId: string | null
  amount: number
}

// ─── ref() helper ────────────────────────────────────────────────────

describe('ref() helper', () => {
  it('defaults to strict mode', () => {
    const r = ref('clients')
    expect(r.target).toBe('clients')
    expect(r.mode).toBe('strict')
  })

  it('accepts explicit mode', () => {
    expect(ref('clients', 'warn').mode).toBe('warn')
    expect(ref('clients', 'cascade').mode).toBe('cascade')
    expect(ref('clients', 'strict').mode).toBe('strict')
  })

  it('rejects cross-vault targets with RefScopeError', () => {
    expect(() => ref('other-vault/clients')).toThrow(RefScopeError)
  })

  it('rejects empty target names', () => {
    expect(() => ref('')).toThrow(/non-empty/)
  })

  it('rejects internal collection names', () => {
    expect(() => ref('_ledger')).toThrow(/internal collections/)
    expect(() => ref('_history')).toThrow(/internal collections/)
  })
})

// ─── RefRegistry ────────────────────────────────────────────────────

describe('RefRegistry', () => {
  it('populates outbound and inbound maps symmetrically', () => {
    const reg = new RefRegistry()
    reg.register('invoices', { clientId: ref('clients', 'strict') })
    expect(reg.getOutbound('invoices')['clientId']).toEqual({
      target: 'clients',
      mode: 'strict',
    })
    const inbound = reg.getInbound('clients')
    expect(inbound).toHaveLength(1)
    expect(inbound[0]).toEqual({
      collection: 'invoices',
      field: 'clientId',
      mode: 'strict',
    })
  })

  it('tolerates re-registering with identical refs', () => {
    const reg = new RefRegistry()
    reg.register('invoices', { clientId: ref('clients') })
    expect(() =>
      reg.register('invoices', { clientId: ref('clients') }),
    ).not.toThrow()
  })

  it('rejects re-registering with conflicting refs', () => {
    const reg = new RefRegistry()
    reg.register('invoices', { clientId: ref('clients', 'strict') })
    expect(() =>
      reg.register('invoices', { clientId: ref('clients', 'cascade') }),
    ).toThrow(/conflicting/)
  })
})

// ─── Put enforcement ────────────────────────────────────────────────

describe('strict mode on put.', () => {
  let db: Noydb

  beforeEach(async () => {
    db = await createNoydb({
      store: memory(),
      user: 'alice', historyStrategy: withHistory(),
      secret: 'test-passphrase-1234',
    })
  })

  it('allows put when the referenced target exists', async () => {
    const company = await db.openVault('demo-co')
    const clients = company.collection<Client>('clients')
    const invoices = company.collection<Invoice>('invoices', {
      refs: { clientId: ref('clients') },
    })

    await clients.put('c-1', { id: 'c-1', name: 'Acme' })
    await invoices.put('inv-1', {
      id: 'inv-1',
      client: 'Acme',
      clientId: 'c-1',
      amount: 100,
    })

    expect(await invoices.get('inv-1')).toBeTruthy()
  })

  it('rejects put with RefIntegrityError when the target is missing', async () => {
    const company = await db.openVault('demo-co')
    company.collection<Client>('clients')
    const invoices = company.collection<Invoice>('invoices', {
      refs: { clientId: ref('clients') },
    })

    try {
      await invoices.put('inv-1', {
        id: 'inv-1',
        client: 'Ghost',
        clientId: 'nope',
        amount: 100,
      })
      throw new Error('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(RefIntegrityError)
      const e = err as RefIntegrityError
      expect(e.field).toBe('clientId')
      expect(e.refTo).toBe('clients')
      expect(e.refId).toBe('nope')
    }
  })

  it('allows null/undefined ref values', async () => {
    const company = await db.openVault('demo-co')
    company.collection<Client>('clients')
    const invoices = company.collection<Invoice>('invoices', {
      refs: { clientId: ref('clients') },
    })

    await invoices.put('inv-null', {
      id: 'inv-null',
      client: 'Cash',
      clientId: null,
      amount: 50,
    })
    expect((await invoices.get('inv-null'))?.clientId).toBeNull()
  })

  it('rejected puts leave no trace on disk, history, or ledger', async () => {
    const company = await db.openVault('demo-co')
    company.collection<Client>('clients')
    const invoices = company.collection<Invoice>('invoices', {
      refs: { clientId: ref('clients') },
    })

    await expect(
      invoices.put('inv-orphan', {
        id: 'inv-orphan',
        client: 'Ghost',
        clientId: 'nope',
        amount: 100,
      }),
    ).rejects.toThrow(RefIntegrityError)

    // No record in the data collection
    expect(await invoices.get('inv-orphan')).toBeNull()
    // No entry in the ledger (rejected puts are never recorded)
    const entries = await company.ledger().entries()
    expect(entries).toHaveLength(0)
  })
})

// ─── Delete enforcement ────────────────────────────────────────────

describe('strict mode on delete.', () => {
  let db: Noydb

  beforeEach(async () => {
    db = await createNoydb({
      store: memory(),
      user: 'alice', historyStrategy: withHistory(),
      secret: 'test-passphrase-1234',
    })
  })

  it('rejects delete of a target that has strict references', async () => {
    const company = await db.openVault('demo-co')
    const clients = company.collection<Client>('clients')
    const invoices = company.collection<Invoice>('invoices', {
      refs: { clientId: ref('clients', 'strict') },
    })

    await clients.put('c-1', { id: 'c-1', name: 'Acme' })
    await invoices.put('inv-1', {
      id: 'inv-1',
      client: 'Acme',
      clientId: 'c-1',
      amount: 100,
    })

    await expect(clients.delete('c-1')).rejects.toThrow(RefIntegrityError)
    // Client still there — the failed delete rolled back cleanly.
    expect(await clients.get('c-1')).toBeTruthy()
  })

  it('allows delete when no references exist', async () => {
    const company = await db.openVault('demo-co')
    const clients = company.collection<Client>('clients')
    company.collection<Invoice>('invoices', {
      refs: { clientId: ref('clients', 'strict') },
    })

    await clients.put('c-1', { id: 'c-1', name: 'Acme' })
    await clients.delete('c-1')
    expect(await clients.get('c-1')).toBeNull()
  })
})

// ─── warn mode ──────────────────────────────────────────────────────

describe('warn mode.', () => {
  let db: Noydb

  beforeEach(async () => {
    db = await createNoydb({
      store: memory(),
      user: 'alice', historyStrategy: withHistory(),
      secret: 'test-passphrase-1234',
    })
  })

  it('allows put with missing target', async () => {
    const company = await db.openVault('demo-co')
    company.collection<Client>('clients')
    const invoices = company.collection<Invoice>('invoices', {
      refs: { clientId: ref('clients', 'warn') },
    })
    await invoices.put('inv-1', {
      id: 'inv-1',
      client: 'Ghost',
      clientId: 'nope',
      amount: 100,
    })
    expect(await invoices.get('inv-1')).toBeTruthy()
  })

  it('allows delete of target with referencing records', async () => {
    const company = await db.openVault('demo-co')
    const clients = company.collection<Client>('clients')
    const invoices = company.collection<Invoice>('invoices', {
      refs: { clientId: ref('clients', 'warn') },
    })
    await clients.put('c-1', { id: 'c-1', name: 'Acme' })
    await invoices.put('inv-1', {
      id: 'inv-1',
      client: 'Acme',
      clientId: 'c-1',
      amount: 100,
    })
    await clients.delete('c-1')
    // Invoice is still there with a now-orphaned ref.
    expect((await invoices.get('inv-1'))?.clientId).toBe('c-1')
  })
})

// ─── cascade mode ──────────────────────────────────────────────────

describe('cascade mode.', () => {
  let db: Noydb

  beforeEach(async () => {
    db = await createNoydb({
      store: memory(),
      user: 'alice', historyStrategy: withHistory(),
      secret: 'test-passphrase-1234',
    })
  })

  it('propagates delete from target to referencing records', async () => {
    const company = await db.openVault('demo-co')
    const clients = company.collection<Client>('clients')
    const invoices = company.collection<Invoice>('invoices', {
      refs: { clientId: ref('clients', 'cascade') },
    })

    await clients.put('c-1', { id: 'c-1', name: 'Acme' })
    await invoices.put('inv-1', {
      id: 'inv-1', client: 'Acme', clientId: 'c-1', amount: 100,
    })
    await invoices.put('inv-2', {
      id: 'inv-2', client: 'Acme', clientId: 'c-1', amount: 200,
    })
    await invoices.put('inv-3', {
      id: 'inv-3', client: 'Other', clientId: 'other', amount: 50,
    })

    await clients.delete('c-1')

    // inv-1 and inv-2 should be gone; inv-3 kept.
    expect(await invoices.get('inv-1')).toBeNull()
    expect(await invoices.get('inv-2')).toBeNull()
    expect(await invoices.get('inv-3')).toBeTruthy()
  })

  it('breaks cycles on mutual cascade (does not infinite-loop)', async () => {
    const company = await db.openVault('demo-co')
    // Two collections that reference each other with cascade.
    // A.bId → B cascade, B.aId → A cascade.
    const a = company.collection<{ id: string; bId: string | null }>('a', {
      refs: { bId: ref('b', 'cascade') },
    })
    const b = company.collection<{ id: string; aId: string | null }>('b', {
      refs: { aId: ref('a', 'cascade') },
    })

    await a.put('a-1', { id: 'a-1', bId: 'b-1' })
    await b.put('b-1', { id: 'b-1', aId: 'a-1' })

    // Deleting a-1 should cascade to b-1. When b-1 is deleted, its
    // cascade rule would normally come back to a-1, but the cycle
    // breaker detects that a-1 is already being deleted and stops.
    await a.delete('a-1')

    expect(await a.get('a-1')).toBeNull()
    expect(await b.get('b-1')).toBeNull()
  })

  // ─── cascade atomicity inside db.transaction() (AU+030 / #346) ──────
  //
  // Cascaded child deletes must register on the active TxContext so a
  // later mid-commit failure rolls the children back alongside the
  // parent. We force a mid-Phase-2 failure (AFTER the parent delete +
  // cascade has executed) by staging a strict-ref put to a missing
  // target as a *later* op — `Collection.put` throws RefIntegrityError
  // during execute, triggering the transaction's best-effort revert.

  it('rolls back cascaded children when a tx fails after the parent delete', async () => {
    const txDb = await createNoydb({
      store: memory(),
      user: 'alice', historyStrategy: withHistory(),
      secret: 'test-passphrase-1234',
      txStrategy: withTransactions(),
    })
    const company = await txDb.openVault('demo-co')
    const clients = company.collection<Client>('clients')
    const invoices = company.collection<Invoice>('invoices', {
      refs: { clientId: ref('clients', 'cascade') },
    })
    // A strict-ref collection we use to poison the transaction: a put
    // with a missing target throws RefIntegrityError during execute.
    interface Receipt { id: string; clientId: string | null }
    company.collection<Receipt>('receipts', {
      refs: { clientId: ref('clients', 'strict') },
    })

    await clients.put('c-1', { id: 'c-1', name: 'Acme' })
    await invoices.put('inv-1', { id: 'inv-1', client: 'Acme', clientId: 'c-1', amount: 100 })
    await invoices.put('inv-2', { id: 'inv-2', client: 'Acme', clientId: 'c-1', amount: 200 })

    await expect(
      txDb.transaction(async (tx) => {
        // Stage the parent delete FIRST — cascades inv-1 + inv-2 during execute.
        tx.vault('demo-co').collection<Client>('clients').delete('c-1')
        // Then stage a poison op that fails mid-commit (strict ref to a
        // now-deleted client) — after the cascade already happened.
        tx.vault('demo-co').collection<Receipt>('receipts').put('r-1', { id: 'r-1', clientId: 'c-1' })
      }),
    ).rejects.toThrow(RefIntegrityError)

    // Parent restored…
    expect(await clients.get('c-1')).toBeTruthy()
    // …and every cascaded child restored too.
    expect(await invoices.get('inv-1')).toBeTruthy()
    expect(await invoices.get('inv-2')).toBeTruthy()
    // …and the poison put left no trace.
    expect(await company.collection<Receipt>('receipts').get('r-1')).toBeNull()
  })

  it('rolls back a multi-level cascade (grandparent→parent→child) on tx abort', async () => {
    const txDb = await createNoydb({
      store: memory(),
      user: 'alice', historyStrategy: withHistory(),
      secret: 'test-passphrase-1234',
      txStrategy: withTransactions(),
    })
    const company = await txDb.openVault('demo-co')
    // grandparent ← parent ← child, all cascade.
    interface GP { id: string; name: string }
    interface P { id: string; gpId: string | null }
    interface C { id: string; pId: string | null }
    const gps = company.collection<GP>('gps')
    const parents = company.collection<P>('parents', { refs: { gpId: ref('gps', 'cascade') } })
    const children = company.collection<C>('children', { refs: { pId: ref('parents', 'cascade') } })
    // Poison collection to force a mid-commit failure post-cascade.
    interface Receipt { id: string; gpId: string | null }
    company.collection<Receipt>('receipts', { refs: { gpId: ref('gps', 'strict') } })

    await gps.put('gp-1', { id: 'gp-1', name: 'Root' })
    await parents.put('p-1', { id: 'p-1', gpId: 'gp-1' })
    await parents.put('p-2', { id: 'p-2', gpId: 'gp-1' })
    await children.put('ch-1', { id: 'ch-1', pId: 'p-1' })
    await children.put('ch-2', { id: 'ch-2', pId: 'p-2' })

    await expect(
      txDb.transaction(async (tx) => {
        // Deleting the grandparent cascades through parents to children.
        tx.vault('demo-co').collection<GP>('gps').delete('gp-1')
        // Poison op fails after the whole cascade tree has executed.
        tx.vault('demo-co').collection<Receipt>('receipts').put('r-1', { id: 'r-1', gpId: 'gp-1' })
      }),
    ).rejects.toThrow(RefIntegrityError)

    // Every level of the cascade tree restored.
    expect(await gps.get('gp-1')).toBeTruthy()
    expect(await parents.get('p-1')).toBeTruthy()
    expect(await parents.get('p-2')).toBeTruthy()
    expect(await children.get('ch-1')).toBeTruthy()
    expect(await children.get('ch-2')).toBeTruthy()
  })

  it('regression: cascade OUTSIDE a transaction still deletes children + parent', async () => {
    // No txStrategy — the plain cascade path must be unchanged.
    const company = await db.openVault('demo-co')
    const clients = company.collection<Client>('clients')
    const invoices = company.collection<Invoice>('invoices', {
      refs: { clientId: ref('clients', 'cascade') },
    })

    await clients.put('c-1', { id: 'c-1', name: 'Acme' })
    await invoices.put('inv-1', { id: 'inv-1', client: 'Acme', clientId: 'c-1', amount: 100 })
    await invoices.put('inv-2', { id: 'inv-2', client: 'Acme', clientId: 'c-1', amount: 200 })
    await invoices.put('inv-3', { id: 'inv-3', client: 'Other', clientId: 'other', amount: 50 })

    await clients.delete('c-1')

    expect(await clients.get('c-1')).toBeNull()
    expect(await invoices.get('inv-1')).toBeNull()
    expect(await invoices.get('inv-2')).toBeNull()
    expect(await invoices.get('inv-3')).toBeTruthy()
  })
})

// ─── checkIntegrity ────────────────────────────────────────────────

describe('checkIntegrity.', () => {
  let db: Noydb

  beforeEach(async () => {
    db = await createNoydb({
      store: memory(),
      user: 'alice', historyStrategy: withHistory(),
      secret: 'test-passphrase-1234',
    })
  })

  it('returns no violations on a clean compartment', async () => {
    const company = await db.openVault('demo-co')
    const clients = company.collection<Client>('clients')
    const invoices = company.collection<Invoice>('invoices', {
      refs: { clientId: ref('clients', 'warn') },
    })

    await clients.put('c-1', { id: 'c-1', name: 'Acme' })
    await invoices.put('inv-1', {
      id: 'inv-1', client: 'Acme', clientId: 'c-1', amount: 100,
    })

    const result = await company.checkIntegrity()
    expect(result.violations).toEqual([])
  })

  it('reports orphaned warn-mode references', async () => {
    const company = await db.openVault('demo-co')
    company.collection<Client>('clients')
    const invoices = company.collection<Invoice>('invoices', {
      refs: { clientId: ref('clients', 'warn') },
    })

    await invoices.put('inv-1', {
      id: 'inv-1', client: 'Ghost', clientId: 'does-not-exist', amount: 100,
    })

    const result = await company.checkIntegrity()
    expect(result.violations).toHaveLength(1)
    expect(result.violations[0]).toMatchObject({
      collection: 'invoices',
      id: 'inv-1',
      field: 'clientId',
      refTo: 'clients',
      refId: 'does-not-exist',
      mode: 'warn',
    })
  })

  it('aggregates violations across multiple collections', async () => {
    const company = await db.openVault('demo-co')
    company.collection<Client>('clients')
    company.collection<{ id: string; name: string }>('categories')
    interface Item { id: string; clientId: string | null; categoryId: string | null }
    const items = company.collection<Item>('items', {
      refs: {
        clientId: ref('clients', 'warn'),
        categoryId: ref('categories', 'warn'),
      },
    })

    await items.put('it-1', { id: 'it-1', clientId: 'ghost-c', categoryId: null })
    await items.put('it-2', { id: 'it-2', clientId: null, categoryId: 'ghost-cat' })

    const result = await company.checkIntegrity()
    expect(result.violations).toHaveLength(2)
    expect(result.violations.map((v) => v.field).sort()).toEqual(['categoryId', 'clientId'])
  })
})

// ─── refArray — many-to-many (#377-A) ────────────────────────────────

interface Order {
  id: string
  productIds: string[] | null
}

describe('refArray() helper', () => {
  it('produces an array-ref descriptor flagged isArray', () => {
    const d = refArray('products', 'warn')
    expect(d).toEqual({ target: 'products', mode: 'warn', isArray: true })
    expect(isRefArray(d)).toBe(true)
    expect(isRefArray(ref('products'))).toBe(false)
  })
  it('defaults to strict mode', () => {
    expect(refArray('products').mode).toBe('strict')
  })
  it('rejects cross-vault targets', () => {
    expect(() => refArray('other/products')).toThrow(RefScopeError)
  })
})

describe('refArray — strict on put', () => {
  let db: Noydb
  beforeEach(async () => {
    db = await createNoydb({ store: memory(), user: 'alice', historyStrategy: withHistory(), secret: 'test-passphrase-1234' })
  })

  it('allows put when every element target exists', async () => {
    const company = await db.openVault('demo-co')
    const products = company.collection<Client>('products')
    const orders = company.collection<Order>('orders', { refs: { productIds: refArray('products') } })
    await products.put('p-1', { id: 'p-1', name: 'A' })
    await products.put('p-2', { id: 'p-2', name: 'B' })
    await orders.put('o-1', { id: 'o-1', productIds: ['p-1', 'p-2'] })
    expect(await orders.get('o-1')).toBeTruthy()
  })

  it('rejects put when any element target is missing (reports the bad element)', async () => {
    const company = await db.openVault('demo-co')
    const products = company.collection<Client>('products')
    const orders = company.collection<Order>('orders', { refs: { productIds: refArray('products') } })
    await products.put('p-1', { id: 'p-1', name: 'A' })
    try {
      await orders.put('o-1', { id: 'o-1', productIds: ['p-1', 'ghost'] })
      throw new Error('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(RefIntegrityError)
      const e = err as RefIntegrityError
      expect(e.field).toBe('productIds')
      expect(e.refTo).toBe('products')
      expect(e.refId).toBe('ghost')
    }
  })

  it('allows an empty array and a nullish field', async () => {
    const company = await db.openVault('demo-co')
    company.collection<Client>('products')
    const orders = company.collection<Order>('orders', { refs: { productIds: refArray('products') } })
    await orders.put('o-1', { id: 'o-1', productIds: [] })
    await orders.put('o-2', { id: 'o-2', productIds: null })
    expect(await orders.get('o-1')).toBeTruthy()
    expect(await orders.get('o-2')).toBeTruthy()
  })

  it('rejects a non-array value for an array-ref field', async () => {
    const company = await db.openVault('demo-co')
    company.collection<Client>('products')
    const orders = company.collection<Record<string, unknown>>('orders', { refs: { productIds: refArray('products') } })
    await expect(orders.put('o-1', { id: 'o-1', productIds: 'p-1' })).rejects.toBeInstanceOf(RefIntegrityError)
  })
})

describe('refArray — delete (strict / cascade / warn)', () => {
  let db: Noydb
  beforeEach(async () => {
    db = await createNoydb({ store: memory(), user: 'alice', historyStrategy: withHistory(), secret: 'test-passphrase-1234' })
  })

  it('strict: blocks delete of a target still referenced by any array', async () => {
    const company = await db.openVault('demo-co')
    const products = company.collection<Client>('products')
    const orders = company.collection<Order>('orders', { refs: { productIds: refArray('products', 'strict') } })
    await products.put('p-1', { id: 'p-1', name: 'A' })
    await orders.put('o-1', { id: 'o-1', productIds: ['p-1'] })
    await expect(products.delete('p-1')).rejects.toBeInstanceOf(RefIntegrityError)
    expect(await products.get('p-1')).toBeTruthy()
  })

  it('cascade: deletes every record whose array contains the deleted id', async () => {
    const company = await db.openVault('demo-co')
    const products = company.collection<Client>('products')
    const orders = company.collection<Order>('orders', { refs: { productIds: refArray('products', 'cascade') } })
    await products.put('p-1', { id: 'p-1', name: 'A' })
    await products.put('p-2', { id: 'p-2', name: 'B' })
    await orders.put('o-1', { id: 'o-1', productIds: ['p-1', 'p-9'] })
    await orders.put('o-2', { id: 'o-2', productIds: ['p-2'] })          // unrelated
    await products.delete('p-1')
    expect(await orders.get('o-1')).toBeNull()   // cascaded
    expect(await orders.get('o-2')).toBeTruthy() // untouched
  })

  it('warn: delete leaves an orphaned element, surfaced by checkIntegrity', async () => {
    const company = await db.openVault('demo-co')
    const products = company.collection<Client>('products')
    const orders = company.collection<Order>('orders', { refs: { productIds: refArray('products', 'warn') } })
    await products.put('p-1', { id: 'p-1', name: 'A' })
    await products.put('p-2', { id: 'p-2', name: 'B' })
    await orders.put('o-1', { id: 'o-1', productIds: ['p-1', 'p-2'] })
    await products.delete('p-2') // warn — allowed, leaves orphan
    const result = await company.checkIntegrity()
    expect(result.violations).toHaveLength(1)
    expect(result.violations[0]).toMatchObject({ collection: 'orders', id: 'o-1', field: 'productIds', refTo: 'products', refId: 'p-2', mode: 'warn' })
  })

  it('checkIntegrity reports one violation per dangling element', async () => {
    const company = await db.openVault('demo-co')
    company.collection<Client>('products')
    const orders = company.collection<Order>('orders', { refs: { productIds: refArray('products', 'warn') } })
    await orders.put('o-1', { id: 'o-1', productIds: ['ghost-1', 'ghost-2'] })
    const result = await company.checkIntegrity()
    expect(result.violations).toHaveLength(2)
    expect(result.violations.map((v) => v.refId).sort()).toEqual(['ghost-1', 'ghost-2'])
  })
})
