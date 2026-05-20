import { describe, it, expect } from 'vitest'
import { createNoydb, withMaterializedView } from '../../src/index.js'
import type { NoydbStore, EncryptedEnvelope } from '../../src/types.js'

function memory(): NoydbStore {
  const data = new Map<string, EncryptedEnvelope>()
  const k = (v: string, c: string, i: string) => `${v}/${c}/${i}`
  return {
    capabilities: { casAtomic: true, auth: { kind: 'none' } },
    async get(v, c, i) { return data.get(k(v, c, i)) ?? null },
    async put(v, c, i, env) { data.set(k(v, c, i), env) },
    async delete(v, c, i) { data.delete(k(v, c, i)) },
    async list(v, c) {
      const prefix = `${v}/${c}/`
      return [...data.keys()].filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length))
    },
    async loadAll(v) {
      const out: Record<string, Record<string, EncryptedEnvelope>> = {}
      for (const [key, env] of data) {
        const [vname, cname, id] = key.split('/')
        if (vname === v) {
          out[cname] = out[cname] ?? {}
          out[cname][id] = env
        }
      }
      return out
    },
    async saveAll(v, payload) {
      for (const c of Object.keys(payload)) {
        for (const i of Object.keys(payload[c])) {
          data.set(k(v, c, i), payload[c][i])
        }
      }
    },
  }
}

interface Invoice extends Record<string, unknown> {
  id: string
  status: 'open' | 'paid'
  amount: number
  dueDate: string
}

describe('MV declaredDeterministicPredicates (#153)', () => {
  it('wherePredicate filters rows via the registered fn', async () => {
    const mv = withMaterializedView<Invoice>({
      name: 'overdue',
      predicates: {
        isOverdue: {
          hash: 'is-overdue-v1',
          fn: (inv: Invoice, ctx?: unknown) => {
            const { asOf } = ctx as { asOf: string }
            return inv.status === 'open' && inv.dueDate < asOf
          },
        },
      },
      query: (db) => db.collection<Invoice>('invoices').query().wherePredicate('isOverdue', { asOf: '2026-05-20' }),
      rowKey: (r) => r.id,
      refresh: 'eager',
    })
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'mv-predicates-basic-passphrase-2026',
      materializedViewStrategies: [mv],
    })
    const vault = await db.openVault('demo')
    await vault.collection<Invoice>('invoices').put('a', { id: 'a', status: 'open', amount: 100, dueDate: '2026-05-01' })
    await vault.collection<Invoice>('invoices').put('b', { id: 'b', status: 'paid', amount: 200, dueDate: '2026-05-01' })
    await vault.collection<Invoice>('invoices').put('c', { id: 'c', status: 'open', amount: 50, dueDate: '2026-06-01' })

    // 'a' is overdue. 'b' is paid (filtered by predicate). 'c' due-in-future (filtered).
    expect(await vault.collection<Invoice>('overdue').get('a')).not.toBeNull()
    expect(await vault.collection<Invoice>('overdue').get('b')).toBeNull()
    expect(await vault.collection<Invoice>('overdue').get('c')).toBeNull()
  })

  it('queryHash changes when predicate hash bumps — forces refresh', async () => {
    // Two MVs differing only by predicate.hash should produce different queryHash.
    const v1 = withMaterializedView<Invoice>({
      name: 'mv1',
      predicates: { p: { hash: 'h1', fn: () => true } },
      query: (db) => db.collection<Invoice>('inv').query().wherePredicate('p'),
      rowKey: (r) => r.id,
      refresh: 'eager',
    })
    const v2 = withMaterializedView<Invoice>({
      name: 'mv2',
      predicates: { p: { hash: 'h2', fn: () => true } },
      query: (db) => db.collection<Invoice>('inv').query().wherePredicate('p'),
      rowKey: (r) => r.id,
      refresh: 'eager',
    })
    // Two separate vaults to isolate, then compare _materializedFrom queryHash
    const dbA = await createNoydb({
      store: memory(), user: 'alice',
      secret: 'mv-predicates-hash-A-passphrase-2026',
      materializedViewStrategies: [v1],
    })
    const dbB = await createNoydb({
      store: memory(), user: 'alice',
      secret: 'mv-predicates-hash-B-passphrase-2026',
      materializedViewStrategies: [v2],
    })
    const vA = await dbA.openVault('demo')
    const vB = await dbB.openVault('demo')
    await vA.collection<Invoice>('inv').put('x', { id: 'x', status: 'open', amount: 1, dueDate: '2026-01-01' })
    await vB.collection<Invoice>('inv').put('x', { id: 'x', status: 'open', amount: 1, dueDate: '2026-01-01' })

    const rowA = await vA.collection<Invoice & { _materializedFrom: { queryHash: string } }>('mv1').get('x')
    const rowB = await vB.collection<Invoice & { _materializedFrom: { queryHash: string } }>('mv2').get('x')
    expect(rowA?._materializedFrom.queryHash).not.toBe(rowB?._materializedFrom.queryHash)
  })

  it('queryHash changes when ctx differs (same name + hash) — proves ctx folding', async () => {
    const mvA = withMaterializedView<Invoice>({
      name: 'overdueA',
      predicates: { isOverdue: { hash: 'h1', fn: (inv, ctx) => inv.status === 'open' && inv.dueDate < (ctx as { asOf: string }).asOf } },
      query: (db) => db.collection<Invoice>('inv').query().wherePredicate('isOverdue', { asOf: '2026-05-20' }),
      rowKey: (r) => r.id,
      refresh: 'eager',
    })
    const mvB = withMaterializedView<Invoice>({
      name: 'overdueB',
      predicates: { isOverdue: { hash: 'h1', fn: (inv, ctx) => inv.status === 'open' && inv.dueDate < (ctx as { asOf: string }).asOf } },
      query: (db) => db.collection<Invoice>('inv').query().wherePredicate('isOverdue', { asOf: '2026-06-01' }),
      rowKey: (r) => r.id,
      refresh: 'eager',
    })
    const dbA = await createNoydb({
      store: memory(), user: 'alice',
      secret: 'mv-predicates-ctxA-passphrase-2026',
      materializedViewStrategies: [mvA],
    })
    const dbB = await createNoydb({
      store: memory(), user: 'alice',
      secret: 'mv-predicates-ctxB-passphrase-2026',
      materializedViewStrategies: [mvB],
    })
    const vA = await dbA.openVault('demo')
    const vB = await dbB.openVault('demo')
    await vA.collection<Invoice>('inv').put('y', { id: 'y', status: 'open', amount: 1, dueDate: '2026-05-25' })
    await vB.collection<Invoice>('inv').put('y', { id: 'y', status: 'open', amount: 1, dueDate: '2026-05-25' })

    const rowA = await vA.collection<Invoice & { _materializedFrom: { queryHash: string } }>('overdueA').get('y')
    // mvB's asOf is '2026-06-01' → 'y' due '2026-05-25' is overdue.
    const rowB = await vB.collection<Invoice & { _materializedFrom: { queryHash: string } }>('overdueB').get('y')
    expect(rowB).not.toBeNull()
    // mvA's asOf is '2026-05-20' → 'y' (due 05-25) is NOT yet overdue.
    expect(rowA).toBeNull()
    // Different ctx → different queryHash on whatever rows DID materialize.
    // Force matching rows by re-using vB with a permissive predicate, but
    // the simpler proof: the canonical-JSON of `{asOf: 'A'}` differs from
    // `{asOf: 'B'}` and that flows into the hash. We assert that
    // materialized rows from each vault carry different queryHash values
    // when the ctx differs (rowB is non-null; instantiate a parallel row
    // for vA with a later due date to compare).
    await vA.collection<Invoice>('inv').put('z', { id: 'z', status: 'open', amount: 1, dueDate: '2026-04-01' })
    const rowA2 = await vA.collection<Invoice & { _materializedFrom: { queryHash: string } }>('overdueA').get('z')
    expect(rowA2?._materializedFrom.queryHash).not.toBe(rowB?._materializedFrom.queryHash)
  })

  it('throws helpful error when .wherePredicate is called on a Query without predicates', async () => {
    // A bare Query (outside an MV) shouldn't support .wherePredicate().
    const db = await createNoydb({
      store: memory(), user: 'alice',
      secret: 'mv-predicates-bare-passphrase-2026',
    })
    const vault = await db.openVault('demo')
    await vault.collection<Invoice>('inv').put('a', { id: 'a', status: 'open', amount: 1, dueDate: '2026-01-01' })
    const q = vault.collection<Invoice>('inv').query()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => (q as any).wherePredicate('whatever')).toThrow(/no predicates registered/i)
  })

  it('throws when wherePredicate references an unknown name', async () => {
    const mv = withMaterializedView<Invoice>({
      name: 'mv-unknown',
      predicates: { existsP: { hash: 'h1', fn: () => true } },
      query: (db) => db.collection<Invoice>('inv').query().wherePredicate('doesNotExist' as 'existsP'),
      rowKey: (r) => r.id,
      refresh: 'eager',
    })
    await expect((async () => {
      const db = await createNoydb({
        store: memory(),
        user: 'alice',
        secret: 'mv-predicates-unknown-passphrase-2026',
        materializedViewStrategies: [mv],
      })
      await db.openVault('demo')
    })()).rejects.toThrow(/not registered/i)
  })
})
