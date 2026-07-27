import { describe, it, expect } from 'vitest'
import {
  createNoydb,
  withMaterializedView,
  ref,
  MaterializedViewConfigError,
  MaterializedViewCycleError,
  JoinTooLargeError,
} from '../../src/index.js'
import { isMVStale } from '../../src/with-formula/materialized-views/stale.js'
import type { NoydbStore, EncryptedEnvelope } from '../../src/kernel/types.js'

function memory(): NoydbStore {
  const data = new Map<string, EncryptedEnvelope>()
  const k = (v: string, c: string, i: string) => `${v}/${c}/${i}`
  return {
    capabilities: { casAtomic: true, auth: { kind: 'none', required: false, flow: 'static' } },
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
        const [vname, cname, id] = key.split('/') as [string, string, string]
        if (vname === v) { out[cname] = out[cname] ?? {}; out[cname][id] = env }
      }
      return out
    },
    async saveAll(v, payload) {
      for (const c of Object.keys(payload)) {
        for (const i of Object.keys(payload[c]!)) { data.set(k(v, c, i), payload[c]![i]!) }
      }
    },
  }
}

interface Client extends Record<string, unknown> { id: string; name: string }
interface Bill extends Record<string, unknown> { id: string; clientId: string; amount: number; status: string }
interface Receipt extends Record<string, unknown> { id: string; billId: string; amount: number }
interface Application extends Record<string, unknown> { id: string; billId: string; applied: number }
interface CreditNote extends Record<string, unknown> { id: string; billId: string; amount: number }
interface Disbursement extends Record<string, unknown> { id: string; billId: string; amount: number }

interface BillRow extends Record<string, unknown> {
  billId: string
  clientName: string
  amount: number
  receiptTotal: number
  receiptCount: number
  appliedTotal: number
  creditTotal: number
  disbursementTotal: number
  outstanding: number
}

const sumOf = (rows: ReadonlyArray<Record<string, unknown>>, field: string): number =>
  rows.reduce((acc, r) => acc + (r[field] as number), 0)

/** The niwat-shaped 5-leg projection: 1 forward (client) + 4 collect legs. */
function billRowsMV(refresh: 'eager' | 'lazy' | 'manual' = 'eager') {
  return withMaterializedView<BillRow>({
    name: 'billRows',
    projection: {
      source: 'bills',
      joins: [
        { field: 'clientId', as: 'client' },
        { collect: 'receipts', on: 'billId', as: 'receipts' },
        { collect: 'receiptBillApplications', on: 'billId', as: 'applications' },
        { collect: 'creditNotes', on: 'billId', as: 'creditNotes' },
        { collect: 'disbursements', on: 'billId', as: 'disbursements' },
      ],
      map: (r) => {
        if (r.status === 'void') return null
        const client = r.client as Client | null
        const receipts = r.receipts as ReadonlyArray<Record<string, unknown>>
        const applications = r.applications as ReadonlyArray<Record<string, unknown>>
        const creditNotes = r.creditNotes as ReadonlyArray<Record<string, unknown>>
        const disbursements = r.disbursements as ReadonlyArray<Record<string, unknown>>
        const appliedTotal = sumOf(applications, 'applied')
        const creditTotal = sumOf(creditNotes, 'amount')
        return {
          billId: r.id as string,
          clientName: client?.name ?? '(unknown)',
          amount: r.amount as number,
          receiptTotal: sumOf(receipts, 'amount'),
          receiptCount: receipts.length,
          appliedTotal,
          creditTotal,
          disbursementTotal: sumOf(disbursements, 'amount'),
          outstanding: (r.amount as number) - appliedTotal - creditTotal,
        }
      },
    },
    rowKey: (r) => r.billId,
    refresh,
  })
}

/** Open a vault with the niwat-shaped collections + refs declared. */
async function openBillsVault(mv = billRowsMV(), secret = 'mv-projection-niwat-secret-2026') {
  const db = await createNoydb({
    store: memory(),
    user: 'alice',
    secret,
    materializedViewStrategies: [mv],
  })
  const vault = await db.openVault('books')
  vault.collection<Client>('clients')
  vault.collection<Bill>('bills', { refs: { clientId: ref('clients') } })
  vault.collection<Receipt>('receipts', { refs: { billId: ref('bills') } })
  vault.collection<Application>('receiptBillApplications', { refs: { billId: ref('bills') } })
  vault.collection<CreditNote>('creditNotes', { refs: { billId: ref('bills') } })
  vault.collection<Disbursement>('disbursements', { refs: { billId: ref('bills') } })
  return vault
}

describe('projection MV (#810) — niwat-shaped acceptance', () => {
  it('materializes one row per bill with forward client + 4 collect arrays, byte-exact', async () => {
    const vault = await openBillsVault()
    const clients = vault.collection<Client>('clients')
    const bills = vault.collection<Bill>('bills')
    const receipts = vault.collection<Receipt>('receipts')
    const applications = vault.collection<Application>('receiptBillApplications')
    const creditNotes = vault.collection<CreditNote>('creditNotes')
    const disbursements = vault.collection<Disbursement>('disbursements')

    await clients.put('c1', { id: 'c1', name: 'Acme' })
    await clients.put('c2', { id: 'c2', name: 'Globex' })
    await bills.put('b1', { id: 'b1', clientId: 'c1', amount: 1000, status: 'open' })
    await bills.put('b2', { id: 'b2', clientId: 'c2', amount: 500, status: 'open' })
    await receipts.put('r1', { id: 'r1', billId: 'b1', amount: 400 })
    await receipts.put('r2', { id: 'r2', billId: 'b1', amount: 100 })
    await receipts.put('r3', { id: 'r3', billId: 'b2', amount: 500 })
    await applications.put('a1', { id: 'a1', billId: 'b1', applied: 400 })
    await applications.put('a2', { id: 'a2', billId: 'b1', applied: 100 })
    await creditNotes.put('cn1', { id: 'cn1', billId: 'b1', amount: 50 })
    await disbursements.put('d1', { id: 'd1', billId: 'b1', amount: 25 })

    const out = vault.collection<BillRow & { _materializedFrom?: unknown }>('billRows')
    const row1 = await out.get('b1')
    expect(row1).not.toBeNull()
    const { _materializedFrom, ...bare1 } = row1!
    expect(_materializedFrom).toBeDefined()
    expect(bare1).toEqual({
      billId: 'b1',
      clientName: 'Acme',
      amount: 1000,
      receiptTotal: 500,
      receiptCount: 2,
      appliedTotal: 500,
      creditTotal: 50,
      disbursementTotal: 25,
      outstanding: 450,
    })

    const row2 = await out.get('b2')
    const { _materializedFrom: _m2, ...bare2 } = row2!
    expect(bare2).toEqual({
      billId: 'b2',
      clientName: 'Globex',
      amount: 500,
      receiptTotal: 500,
      receiptCount: 1,
      appliedTotal: 0,
      creditTotal: 0,
      disbursementTotal: 0,
      outstanding: 500,
    })
  })

  it('forward-leg freshness: renaming the client refreshes the bill row', async () => {
    const vault = await openBillsVault(billRowsMV(), 'mv-projection-fwd-fresh-secret-2026')
    const clients = vault.collection<Client>('clients')
    const bills = vault.collection<Bill>('bills')

    await clients.put('c1', { id: 'c1', name: 'Acme' })
    await bills.put('b1', { id: 'b1', clientId: 'c1', amount: 100, status: 'open' })
    expect((await vault.collection<BillRow>('billRows').get('b1'))?.clientName).toBe('Acme')

    // Write to the FORWARD ref target — the dependency is auto-resolved
    // from bills' ref(clientId → clients), so this must trigger refresh.
    await clients.put('c1', { id: 'c1', name: 'Acme Renamed' })
    expect((await vault.collection<BillRow>('billRows').get('b1'))?.clientName).toBe('Acme Renamed')
  })
})

describe('projection MV (#810) — freshness', () => {
  it('eager: a child (collect) write refreshes the bill row', async () => {
    const vault = await openBillsVault(billRowsMV(), 'mv-projection-eager-child-secret-2026')
    const clients = vault.collection<Client>('clients')
    const bills = vault.collection<Bill>('bills')
    const receipts = vault.collection<Receipt>('receipts')

    await clients.put('c1', { id: 'c1', name: 'Acme' })
    await bills.put('b1', { id: 'b1', clientId: 'c1', amount: 100, status: 'open' })
    expect((await vault.collection<BillRow>('billRows').get('b1'))?.receiptCount).toBe(0)

    await receipts.put('r1', { id: 'r1', billId: 'b1', amount: 60 })
    const row = await vault.collection<BillRow>('billRows').get('b1')
    expect(row?.receiptCount).toBe(1)
    expect(row?.receiptTotal).toBe(60)
  })

  it('lazy: child write marks stale; first read materializes and clears the bit', async () => {
    const vault = await openBillsVault(billRowsMV('lazy'), 'mv-projection-lazy-secret-2026')
    const clients = vault.collection<Client>('clients')
    const bills = vault.collection<Bill>('bills')
    const receipts = vault.collection<Receipt>('receipts')

    await clients.put('c1', { id: 'c1', name: 'Acme' })
    await bills.put('b1', { id: 'b1', clientId: 'c1', amount: 100, status: 'open' })
    await receipts.put('r1', { id: 'r1', billId: 'b1', amount: 30 })

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const reg = vault._getMaterializedViewRegistry()!
    expect(isMVStale(reg, 'billRows')).toBe(true)

    // Resolve-on-read: first read of the output collection materializes.
    const row = await vault.collection<BillRow>('billRows').get('b1')
    expect(row?.receiptTotal).toBe(30)
    expect(isMVStale(reg, 'billRows')).toBe(false)
  })
})

describe('projection MV (#810) — map omission + empty collect arrays', () => {
  it('map null → primary row omitted; onEmpty delete tombstones it after a status flip', async () => {
    const vault = await openBillsVault(billRowsMV(), 'mv-projection-null-omit-secret-2026')
    const clients = vault.collection<Client>('clients')
    const bills = vault.collection<Bill>('bills')

    await clients.put('c1', { id: 'c1', name: 'Acme' })
    await bills.put('b1', { id: 'b1', clientId: 'c1', amount: 100, status: 'open' })
    await bills.put('b2', { id: 'b2', clientId: 'c1', amount: 200, status: 'void' })

    const out = vault.collection<BillRow>('billRows')
    expect(await out.get('b1')).not.toBeNull()
    expect(await out.get('b2')).toBeNull()

    // Flip b1 to void — the previously-emitted row must be tombstoned.
    await bills.put('b1', { id: 'b1', clientId: 'c1', amount: 100, status: 'void' })
    expect(await out.get('b1')).toBeNull()
  })

  it('a primary row with no children gets empty collect arrays (not null)', async () => {
    const vault = await openBillsVault(billRowsMV(), 'mv-projection-empty-collect-secret-2026')
    await vault.collection<Client>('clients').put('c1', { id: 'c1', name: 'Acme' })
    await vault.collection<Bill>('bills').put('b1', { id: 'b1', clientId: 'c1', amount: 100, status: 'open' })

    const row = await vault.collection<BillRow>('billRows').get('b1')
    expect(row?.receiptCount).toBe(0)
    expect(row?.receiptTotal).toBe(0)
    expect(row?.appliedTotal).toBe(0)
    expect(row?.creditTotal).toBe(0)
    expect(row?.disbursementTotal).toBe(0)
  })
})

describe('projection MV (#810) — collect ceilings + ref requirement', () => {
  it('exceeding a collect leg maxRows for one primary row throws JoinTooLargeError', async () => {
    const mv = withMaterializedView<Record<string, unknown>>({
      name: 'capped',
      projection: {
        source: 'bills',
        joins: [{ collect: 'receipts', on: 'billId', as: 'receipts', maxRows: 2 }],
        map: (r) => ({ billId: r.id, n: (r.receipts as unknown[]).length }),
      },
      rowKey: (r) => r.billId as string,
      refresh: 'eager',
    })
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'mv-projection-ceiling-secret-2026',
      materializedViewStrategies: [mv],
    })
    const vault = await db.openVault('books')
    vault.collection<Bill>('bills')
    vault.collection<Receipt>('receipts', { refs: { billId: ref('bills') } })

    await vault.collection<Bill>('bills').put('b1', { id: 'b1', clientId: 'c1', amount: 1, status: 'open' })
    await vault.collection<Receipt>('receipts').put('r1', { id: 'r1', billId: 'b1', amount: 1 })
    await vault.collection<Receipt>('receipts').put('r2', { id: 'r2', billId: 'b1', amount: 1 })
    // Third child for the same primary row crosses the 2-row ceiling.
    await expect(
      vault.collection<Receipt>('receipts').put('r3', { id: 'r3', billId: 'b1', amount: 1 }),
    ).rejects.toBeInstanceOf(JoinTooLargeError)
  })

  it('collect `on` without a ref() throws at first materialization', async () => {
    const mv = withMaterializedView<Record<string, unknown>>({
      name: 'norefs',
      projection: {
        source: 'bills',
        joins: [{ collect: 'receipts', on: 'billId', as: 'receipts' }],
        map: (r) => ({ billId: r.id }),
      },
      rowKey: (r) => r.billId as string,
      refresh: 'eager',
    })
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'mv-projection-noref-secret-2026',
      materializedViewStrategies: [mv],
    })
    const vault = await db.openVault('books')
    vault.collection<Bill>('bills')
    vault.collection<Receipt>('receipts') // NO ref on billId

    await expect(
      vault.collection<Bill>('bills').put('b1', { id: 'b1', clientId: 'c1', amount: 1, status: 'open' }),
    ).rejects.toThrow(/ref\(\)/)
  })

  it('collect `on` whose ref() targets a different collection throws at first materialization', async () => {
    const mv = withMaterializedView<Record<string, unknown>>({
      name: 'wrongtarget',
      projection: {
        source: 'bills',
        joins: [{ collect: 'receipts', on: 'billId', as: 'receipts' }],
        map: (r) => ({ billId: r.id }),
      },
      rowKey: (r) => r.billId as string,
      refresh: 'eager',
    })
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'mv-projection-wrongref-secret-2026',
      materializedViewStrategies: [mv],
    })
    const vault = await db.openVault('books')
    vault.collection<Bill>('bills')
    vault.collection<Record<string, unknown>>('other')
    vault.collection<Receipt>('receipts', { refs: { billId: ref('other', 'warn') } })

    await expect(
      vault.collection<Bill>('bills').put('b1', { id: 'b1', clientId: 'c1', amount: 1, status: 'open' }),
    ).rejects.toBeInstanceOf(MaterializedViewConfigError)
  })
})

describe('projection MV (#810) — config validation', () => {
  const validProjection = {
    source: 'bills',
    joins: [{ collect: 'receipts', on: 'billId', as: 'receipts' }],
    map: (r: Record<string, unknown>) => r,
  }

  it('rejects projection combined with query', () => {
    expect(() =>
      withMaterializedView({
        name: 'bad-both',
        query: () => ({}) as never,
        projection: validProjection,
        rowKey: () => 'k',
        refresh: 'eager',
      }),
    ).toThrow(MaterializedViewConfigError)
  })

  it('rejects projection combined with unionSources', () => {
    expect(() =>
      withMaterializedView({
        name: 'bad-both-union',
        unionSources: [{ collection: 'a', map: (r) => r as Record<string, unknown> }],
        projection: validProjection,
        rowKey: () => 'k',
        refresh: 'eager',
      }),
    ).toThrow(MaterializedViewConfigError)
  })

  it('rejects duplicate `as` aliases across legs', () => {
    expect(() =>
      withMaterializedView({
        name: 'bad-dup-as',
        projection: {
          source: 'bills',
          joins: [
            { field: 'clientId', as: 'x' },
            { collect: 'receipts', on: 'billId', as: 'x' },
          ],
          map: (r: Record<string, unknown>) => r,
        },
        rowKey: () => 'k',
        refresh: 'eager',
      }),
    ).toThrow(/distinct.*as|duplicate/i)
  })

  it('rejects an empty joins array', () => {
    expect(() =>
      withMaterializedView({
        name: 'bad-empty-legs',
        projection: { source: 'bills', joins: [], map: (r: Record<string, unknown>) => r },
        rowKey: () => 'k',
        refresh: 'eager',
      }),
    ).toThrow(/at least (1|one)/i)
  })

  it('rejects a leg declaring neither field nor collect', () => {
    expect(() =>
      withMaterializedView({
        name: 'bad-leg-shape',
        projection: {
          source: 'bills',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          joins: [{ as: 'x' } as any],
          map: (r: Record<string, unknown>) => r,
        },
        rowKey: () => 'k',
        refresh: 'eager',
      }),
    ).toThrow(MaterializedViewConfigError)
  })

  it('rejects a leg declaring both field and collect', () => {
    expect(() =>
      withMaterializedView({
        name: 'bad-leg-both',
        projection: {
          source: 'bills',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          joins: [{ field: 'clientId', collect: 'receipts', on: 'billId', as: 'x' } as any],
          map: (r: Record<string, unknown>) => r,
        },
        rowKey: () => 'k',
        refresh: 'eager',
      }),
    ).toThrow(MaterializedViewConfigError)
  })

  it('rejects an empty projection source', () => {
    expect(() =>
      withMaterializedView({
        name: 'bad-source',
        projection: { source: '', joins: validProjection.joins, map: (r: Record<string, unknown>) => r },
        rowKey: () => 'k',
        refresh: 'eager',
      }),
    ).toThrow(MaterializedViewConfigError)
  })
})

describe('projection MV (#810) — cycle refusal', () => {
  it('collect target fed by an MV over this projection output throws MaterializedViewCycleError', async () => {
    const proj = withMaterializedView<Record<string, unknown>>({
      name: 'projOut',
      projection: {
        source: 'bills',
        joins: [{ collect: 'ledger', on: 'billId', as: 'entries' }],
        map: (r) => ({ billId: r.id }),
      },
      rowKey: (r) => r.billId as string,
      refresh: 'eager',
    })
    // Query-form MV reading projOut and writing INTO 'ledger' — the loop.
    const loop = withMaterializedView<Record<string, unknown>>({
      name: 'loopMV',
      query: (db) => db.collection<Record<string, unknown>>('projOut').query(),
      rowKey: (r) => r.billId as string,
      refresh: 'eager',
      output: { collection: 'ledger' },
    })

    await expect(
      (async () => {
        const db = await createNoydb({
          store: memory(),
          user: 'alice',
          secret: 'mv-projection-cycle-secret-2026',
          materializedViewStrategies: [proj, loop],
        })
        await db.openVault('books')
      })(),
    ).rejects.toBeInstanceOf(MaterializedViewCycleError)
  })
})

describe('projection MV (#810) — queryHash', () => {
  it('is stable across re-open with an identical strategy', async () => {
    const store = memory()
    const hashes: string[] = []
    for (let i = 0; i < 2; i++) {
      const db = await createNoydb({
        store,
        user: 'alice',
        secret: 'mv-projection-hash-stable-secret-2026',
        materializedViewStrategies: [billRowsMV()],
      })
      const vault = await db.openVault('books')
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      hashes.push(vault._getMaterializedViewRegistry()!.byName('billRows')!.queryHash)
    }
    expect(hashes[0]).toBe(hashes[1])
  })

  it('is insensitive to leg declaration order (sorted descriptors)', async () => {
    const { summarizeProjectionPlan } = await import('../../src/with-formula/materialized-views/dependency-analyzer.js')
    const a = withMaterializedView<Record<string, unknown>>({
      name: 'h',
      projection: {
        source: 'bills',
        joins: [
          { field: 'clientId', as: 'client' },
          { collect: 'receipts', on: 'billId', as: 'receipts' },
        ],
        map: (r) => r,
      },
      rowKey: (r) => String(r.id),
      refresh: 'eager',
    })
    const b = withMaterializedView<Record<string, unknown>>({
      name: 'h',
      projection: {
        source: 'bills',
        joins: [
          { collect: 'receipts', on: 'billId', as: 'receipts' },
          { field: 'clientId', as: 'client' },
        ],
        map: (r) => r,
      },
      rowKey: (r) => String(r.id),
      refresh: 'eager',
    })
    expect(summarizeProjectionPlan(a.spec)).toBe(summarizeProjectionPlan(b.spec))
  })

  it('changes when the leg set changes (forces refresh on next visit)', async () => {
    const { summarizeProjectionPlan } = await import('../../src/with-formula/materialized-views/dependency-analyzer.js')
    const one = withMaterializedView<Record<string, unknown>>({
      name: 'h',
      projection: {
        source: 'bills',
        joins: [{ collect: 'receipts', on: 'billId', as: 'receipts' }],
        map: (r) => r,
      },
      rowKey: (r) => String(r.id),
      refresh: 'eager',
    })
    const two = withMaterializedView<Record<string, unknown>>({
      name: 'h',
      projection: {
        source: 'bills',
        joins: [
          { collect: 'receipts', on: 'billId', as: 'receipts' },
          { collect: 'creditNotes', on: 'billId', as: 'creditNotes' },
        ],
        map: (r) => r,
      },
      rowKey: (r) => String(r.id),
      refresh: 'eager',
    })
    expect(summarizeProjectionPlan(one.spec)).not.toBe(summarizeProjectionPlan(two.spec))
    expect(summarizeProjectionPlan(two.spec)).toContain('creditNotes')
  })
})
