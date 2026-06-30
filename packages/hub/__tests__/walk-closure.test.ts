/**
 * walkClosure — transitive-closure FK walker (#201).
 *
 * Covers:
 *   - empty closure when no record matches the seed predicate
 *   - inbound expansion: a seeded parent pulls its children, transitively
 *   - maxDepth guard throws PartitionExtractionError
 *   - outbound completion: referenced parents pulled without re-expansion
 *   - cycle detection flag + termination
 *   - exported from the @noy-db/hub/bundle subpath
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { createNoydb } from '../src/noydb.js'
import type { Noydb } from '../src/noydb.js'
import { ref } from '../src/refs.js'
import { ConflictError, PartitionExtractionError } from '../src/errors.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/types.js'
import { walkClosure } from '../src/with-share/bundle/walk-closure.js'

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

interface Client { id: string; name: string; operatorUserId: string }
interface Bill { id: string; clientId: string; amount: number }

describe('walkClosure', () => {
  let db: Noydb

  beforeEach(async () => {
    db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'test-passphrase-1234',
    })
  })

  it('returns an empty closure when no record matches the seed predicate', async () => {
    const company = await db.openVault('demo-co')
    await company.collection<Client>('clients').put('c-1', {
      id: 'c-1', name: 'Acme', operatorUserId: 'belle',
    })

    const result = await walkClosure(company, {
      seeds: { clients: () => false },
    })

    expect(result.closure.size).toBe(0)
    expect(result.graph.depth).toBe(0)
    expect(result.graph.cyclesDetected).toBe(false)
  })

  it('expands inbound: a seeded client pulls its bills, transitively', async () => {
    const company = await db.openVault('demo-co')
    const clients = company.collection<Client>('clients')
    const bills = company.collection<Bill>('bills', { refs: { clientId: ref('clients') } })
    const creditNotes = company.collection<{ id: string; billId: string }>(
      'creditNotes', { refs: { billId: ref('bills') } },
    )

    await clients.put('c-belle', { id: 'c-belle', name: 'Hotel A', operatorUserId: 'belle' })
    await clients.put('c-ann', { id: 'c-ann', name: 'Shop B', operatorUserId: 'ann' })
    await bills.put('b-1', { id: 'b-1', clientId: 'c-belle', amount: 100 })
    await bills.put('b-2', { id: 'b-2', clientId: 'c-ann', amount: 50 })
    await creditNotes.put('cn-1', { id: 'cn-1', billId: 'b-1' })

    const { closure } = await walkClosure(company, {
      seeds: { clients: (c) => c['operatorUserId'] === 'belle' },
    })

    expect([...(closure.get('clients') ?? [])]).toEqual(['c-belle'])
    expect([...(closure.get('bills') ?? [])]).toEqual(['b-1'])       // not b-2 (ann's)
    expect([...(closure.get('creditNotes') ?? [])]).toEqual(['cn-1']) // transitive child
  })

  it('throws PartitionExtractionError when maxDepth is exceeded', async () => {
    const company = await db.openVault('demo-co')
    const nodes = company.collection<{ id: string; parentId: string | null }>(
      'nodes', { refs: { parentId: ref('nodes', 'warn') } },
    )
    // A 5-deep chain: n0 <- n1 <- n2 <- n3 <- n4 (each parentId points up)
    await nodes.put('n0', { id: 'n0', parentId: null })
    for (let i = 1; i <= 4; i++) {
      await nodes.put(`n${i}`, { id: `n${i}`, parentId: `n${i - 1}` })
    }

    await expect(
      walkClosure(company, { seeds: { nodes: (n) => n['id'] === 'n0' }, maxDepth: 2 }),
    ).rejects.toThrow(PartitionExtractionError)
  })

  it('completes outbound parents without re-expanding their other children', async () => {
    const company = await db.openVault('demo-co')
    const entities = company.collection<{ id: string; name: string }>('entities')
    const clients = company.collection<Client & { entityId: string }>(
      'clients', { refs: { entityId: ref('entities') } },
    )
    const bills = company.collection<Bill>('bills', { refs: { clientId: ref('clients') } })

    await entities.put('e-1', { id: 'e-1', name: 'Group' })
    // Two clients share entity e-1; only c-belle is seeded.
    await clients.put('c-belle', { id: 'c-belle', name: 'Hotel', operatorUserId: 'belle', entityId: 'e-1' })
    await clients.put('c-ann',   { id: 'c-ann',   name: 'Shop',  operatorUserId: 'ann',   entityId: 'e-1' })
    await bills.put('b-1', { id: 'b-1', clientId: 'c-belle', amount: 100 })

    const { closure } = await walkClosure(company, {
      seeds: { clients: (c) => c['operatorUserId'] === 'belle' },
    })

    expect([...(closure.get('entities') ?? [])]).toEqual(['e-1'])   // parent pulled (FK validity)
    expect([...(closure.get('clients') ?? [])].sort()).toEqual(['c-belle']) // NOT c-ann
    expect([...(closure.get('bills') ?? [])]).toEqual(['b-1'])
  })

  it('flags cyclesDetected and terminates on a self-referential / mutual cycle', async () => {
    const company = await db.openVault('demo-co')
    // a.refB -> b, b.refA -> a : a 2-node cycle.
    const as = company.collection<{ id: string; refB: string | null; tag: string }>(
      'as', { refs: { refB: ref('bs', 'warn') } },
    )
    const bs = company.collection<{ id: string; refA: string | null }>(
      'bs', { refs: { refA: ref('as', 'warn') } },
    )
    await as.put('a-1', { id: 'a-1', refB: 'b-1', tag: 'seed' })
    await bs.put('b-1', { id: 'b-1', refA: 'a-1' })

    const { closure, graph } = await walkClosure(company, {
      seeds: { as: (r) => r['tag'] === 'seed' },
    })

    expect([...(closure.get('as') ?? [])]).toEqual(['a-1'])
    expect([...(closure.get('bs') ?? [])]).toEqual(['b-1'])
    expect(graph.cyclesDetected).toBe(true)
  })

  it('throws PartitionExtractionError on a record with a non-string id', async () => {
    const company = await db.openVault('demo-co')
    const clients = company.collection<{ id: unknown; operatorUserId: string }>('clients')
    // A record whose body `id` is numeric — malformed for closure purposes.
    await clients.put('c-num', { id: 123, operatorUserId: 'belle' })

    await expect(
      walkClosure(company, { seeds: { clients: () => true } }),
    ).rejects.toThrow(PartitionExtractionError)
  })

  it('is exported from the @noy-db/hub/bundle subpath', async () => {
    const mod = await import('../src/with-share/bundle/index.js')
    expect(typeof mod.walkClosure).toBe('function')
    expect(typeof mod.PartitionExtractionError).toBe('function')
  })
})
