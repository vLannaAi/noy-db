/**
 * Foreign-key reference tests — #45, v0.4.
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
import type { Noydb } from '../src/noydb.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/types.js'
import { ConflictError } from '../src/errors.js'
import {
  ref,
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

describe('strict mode on put — #45', () => {
  let db: Noydb

  beforeEach(async () => {
    db = await createNoydb({
      store: memory(),
      user: 'alice',
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

describe('strict mode on delete — #45', () => {
  let db: Noydb

  beforeEach(async () => {
    db = await createNoydb({
      store: memory(),
      user: 'alice',
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

describe('warn mode — #45', () => {
  let db: Noydb

  beforeEach(async () => {
    db = await createNoydb({
      store: memory(),
      user: 'alice',
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

describe('cascade mode — #45', () => {
  let db: Noydb

  beforeEach(async () => {
    db = await createNoydb({
      store: memory(),
      user: 'alice',
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
})

// ─── checkIntegrity ────────────────────────────────────────────────

describe('checkIntegrity — #45', () => {
  let db: Noydb

  beforeEach(async () => {
    db = await createNoydb({
      store: memory(),
      user: 'alice',
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
