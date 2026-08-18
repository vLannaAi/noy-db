/**
 * #1140 — projection legs that attach to another leg's alias.
 *
 * Every leg used to hang off the primary row, so anything two FKs away was
 * inexpressible. pilot-1's shape is the canonical case and is used verbatim:
 *
 *   bill.entityId   ──forward──►  entity      expressible before
 *   receipt.billId  ──reverse──►  bill        expressible before
 *   client.entityId ═══ matches bill.entityId ═══ NOT expressible before
 *
 * The client is unreachable from the bill: a forward leg would need a
 * `bill.clientId` that does not exist (a bill belongs to an ENTITY; the client
 * is the engagement edge onto that entity), and a reverse leg would need
 * `clients.entityId` to ref `bills` when it refs `entities`.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, withMaterializedView, ref, MaterializedViewConfigError } from '../../src/index.js'
import type { NoydbStore, EncryptedEnvelope } from '../../src/kernel/types.js'

function toMemory(): NoydbStore {
  const data = new Map<string, EncryptedEnvelope>()
  const k = (v: string, c: string, i: string) => `${v}/${c}/${i}`
  return {
    capabilities: { casAtomic: true, auth: { kind: 'none', required: false, flow: 'static' } },
    async get(v, c, i) { return data.get(k(v, c, i)) ?? null },
    async put(v, c, i, e) { data.set(k(v, c, i), e) },
    async delete(v, c, i) { data.delete(k(v, c, i)) },
    async list(v, c) { const p = `${v}/${c}/`; return [...data.keys()].filter(x => x.startsWith(p)).map(x => x.slice(p.length)) },
    async loadAll(v) {
      const o: Record<string, Record<string, EncryptedEnvelope>> = {}
      for (const [key, e] of data) {
        const [vn, cn, id] = key.split('/') as [string, string, string]
        if (vn === v) { o[cn] = o[cn] ?? {}; o[cn][id] = e }
      }
      return o
    },
    async saveAll(v, p) { for (const c of Object.keys(p)) for (const i of Object.keys(p[c]!)) data.set(k(v, c, i), p[c]![i]!) },
  }
}

interface Entity extends Record<string, unknown> { id: string; name: string }
interface Client extends Record<string, unknown> { id: string; entityId: string; name: string }
interface Bill extends Record<string, unknown> { id: string; entityId: string; amount: number }
interface Receipt extends Record<string, unknown> { id: string; billId: string; amount: number }
interface Manager extends Record<string, unknown> { id: string; name: string }

interface BillRow extends Record<string, unknown> {
  billId: string
  entityName: string
  clientNames: readonly string[]
  receiptCount: number
}

/** The two-hop shape: bill → entity, then entity ← clients. */
const twoHopMV = () =>
  withMaterializedView<BillRow>({
    name: 'billRows',
    projection: {
      source: 'bills',
      joins: [
        { field: 'entityId', as: 'entity' },
        { from: 'entity', collect: 'clients', on: 'entityId', as: 'clients' },
        { collect: 'receipts', on: 'billId', as: 'receipts' },
      ],
      map: (r) => ({
        billId: r.id as string,
        entityName: (r.entity as Entity | null)?.name ?? '(none)',
        clientNames: (r.clients as ReadonlyArray<Client>).map(c => c.name).sort(),
        receiptCount: (r.receipts as ReadonlyArray<Receipt>).length,
      }),
    },
    rowKey: (r) => r.billId,
    refresh: 'eager',
  })

async function openBooks(mv: ReturnType<typeof withMaterializedView>) {
  const db = await createNoydb({
    store: toMemory(), user: 'alice', secret: 'projection-leg-from-secret-2026',
    materializedViewStrategies: [mv],
  })
  const vault = await db.openVault('books')
  vault.collection<Entity>('entities')
  vault.collection<Manager>('managers')
  vault.collection<Client>('clients', { refs: { entityId: ref('entities') } })
  vault.collection<Bill>('bills', { refs: { entityId: ref('entities', 'warn') } })
  vault.collection<Receipt>('receipts', { refs: { billId: ref('bills') } })
  return vault
}

async function seed(vault: Awaited<ReturnType<typeof openBooks>>) {
  await vault.collection<Entity>('entities').put('e1', { id: 'e1', name: 'Entity One' })
  await vault.collection<Client>('clients').put('c1', { id: 'c1', entityId: 'e1', name: 'Acme' })
  await vault.collection<Bill>('bills').put('b1', { id: 'b1', entityId: 'e1', amount: 1000 })
  await vault.collection<Receipt>('receipts').put('r1', { id: 'r1', billId: 'b1', amount: 400 })
}

describe('#1140 — a leg relative to another leg', () => {
  it('reaches the client two FKs away, with no redundant FK on the bill', async () => {
    const vault = await openBooks(twoHopMV())
    await seed(vault)
    const rows = await vault.collection<BillRow>('billRows').list()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      billId: 'b1', entityName: 'Entity One', clientNames: ['Acme'], receiptCount: 1,
    })
  })

  it('re-materializes when the FAR side changes — the two-hop leg is a tracked dependency', async () => {
    const vault = await openBooks(twoHopMV())
    await seed(vault)
    await vault.collection<Client>('clients').put('c2', { id: 'c2', entityId: 'e1', name: 'Beta Co' })
    const rows = await vault.collection<BillRow>('billRows').list()
    expect(rows[0]!.clientNames).toEqual(['Acme', 'Beta Co'])
  })

  it('preserves the primary row when the from-alias is null (dangling upstream ref)', async () => {
    const vault = await openBooks(twoHopMV())
    await seed(vault)
    await vault.collection<Bill>('bills').put('b2', { id: 'b2', entityId: 'ghost', amount: 20 })
    const rows = (await vault.collection<BillRow>('billRows').list()).sort((a, b) => a.billId.localeCompare(b.billId))
    expect(rows.map(r => r.billId)).toEqual(['b1', 'b2'])
    expect(rows[1]).toMatchObject({ entityName: '(none)', clientNames: [], receiptCount: 0 })
  })

  it('attaches [] rather than every row when the anchor has no children', async () => {
    const vault = await openBooks(twoHopMV())
    await vault.collection<Entity>('entities').put('e2', { id: 'e2', name: 'Entity Two' })
    await vault.collection<Bill>('bills').put('b9', { id: 'b9', entityId: 'e2', amount: 5 })
    const rows = await vault.collection<BillRow>('billRows').list()
    expect(rows[0]).toMatchObject({ entityName: 'Entity Two', clientNames: [] })
  })

  it('supports a FORWARD leg relative to an alias (entity → its manager)', async () => {
    interface Row extends Record<string, unknown> { billId: string; managerName: string }
    const mv = withMaterializedView<Row>({
      name: 'billManagers',
      projection: {
        source: 'bills',
        joins: [
          { field: 'entityId', as: 'entity' },
          { from: 'entity', field: 'managerId', as: 'manager' },
        ],
        map: (r) => ({ billId: r.id as string, managerName: (r.manager as Manager | null)?.name ?? '(none)' }),
      },
      rowKey: (r) => r.billId,
      refresh: 'eager',
    })
    const db = await createNoydb({
      store: toMemory(), user: 'alice', secret: 'projection-leg-from-secret-2026',
      materializedViewStrategies: [mv],
    })
    const vault = await db.openVault('books')
    vault.collection<Manager>('managers')
    vault.collection('entities', { refs: { managerId: ref('managers') } })
    vault.collection<Bill>('bills', { refs: { entityId: ref('entities') } })

    await vault.collection<Manager>('managers').put('m1', { id: 'm1', name: 'Dana' })
    await vault.collection('entities').put('e1', { id: 'e1', name: 'Entity One', managerId: 'm1' })
    await vault.collection<Bill>('bills').put('b1', { id: 'b1', entityId: 'e1', amount: 1 })

    const rows = await vault.collection<Row>('billManagers').list()
    expect(rows[0]).toMatchObject({ billId: 'b1', managerName: 'Dana' })
  })

  it('refuses a `from` naming an alias declared LATER — the rule that makes cycles unspellable', () => {
    const build = () => withMaterializedView<BillRow>({
      name: 'badOrder',
      projection: {
        source: 'bills',
        joins: [
          { from: 'entity', collect: 'clients', on: 'entityId', as: 'clients' },
          { field: 'entityId', as: 'entity' },
        ],
        map: () => null,
      },
      rowKey: (r) => r.billId,
      refresh: 'eager',
    })
    // At spec CONSTRUCTION — not at vault open. `from` wiring needs no refs and
    // no store, so the earliest possible failure is the right one.
    expect(build).toThrow(MaterializedViewConfigError)
    expect(build).toThrow(/not an alias declared EARLIER/)
  })

  it('refuses a `from` naming an unknown alias', () => {
    const build = () => withMaterializedView<BillRow>({
      name: 'badAlias',
      projection: {
        source: 'bills',
        joins: [
          { field: 'entityId', as: 'entity' },
          { from: 'entitty', collect: 'clients', on: 'entityId', as: 'clients' },
        ],
        map: () => null,
      },
      rowKey: (r) => r.billId,
      refresh: 'eager',
    })
    expect(build).toThrow(/from: "entitty"/)
  })

  it('refuses a `from` naming a COLLECT leg — an array is not a record to hang off', () => {
    const build = () => withMaterializedView<BillRow>({
      name: 'badParent',
      projection: {
        source: 'bills',
        joins: [
          { collect: 'receipts', on: 'billId', as: 'receipts' },
          { from: 'receipts', field: 'entityId', as: 'x' },
        ],
        map: () => null,
      },
      rowKey: (r) => r.billId,
      refresh: 'eager',
    })
    expect(build).toThrow(/is a collect leg and holds an ARRAY/)
  })

  it('still refuses a duplicate alias (the factory\'s own check, unchanged)', () => {
    const build = () => withMaterializedView<BillRow>({
      name: 'dupAlias',
      projection: {
        source: 'bills',
        joins: [
          { field: 'entityId', as: 'entity' },
          { field: 'entityId', as: 'entity' },
        ],
        map: () => null,
      },
      rowKey: (r) => r.billId,
      refresh: 'eager',
    })
    expect(build).toThrow(/distinct `as` aliases/)
  })

  it('names the ANCHOR collection, not the projection source, when a from-collect leg refs the wrong thing', async () => {
    const mv = withMaterializedView<BillRow>({
      name: 'wrongRef',
      projection: {
        source: 'bills',
        // `receipts.billId` refs `bills`, but this leg hangs off `entity`.
        joins: [
          { field: 'entityId', as: 'entity' },
          { from: 'entity', collect: 'receipts', on: 'billId', as: 'oops' },
        ],
        map: () => null,
      },
      rowKey: (r) => r.billId,
      refresh: 'eager',
    })
    const vault = await openBooks(mv)
    // `entities` is a dependency (the forward leg's target), so the very first
    // write to it materializes the MV and surfaces the misconfigured leg.
    await expect(vault.collection<Entity>('entities').put('e1', { id: 'e1', name: 'Entity One' }))
      .rejects.toThrow(/the collection behind from: "entity"/)
  })

  it('gives a leg-relative projection a DIFFERENT queryHash from the same legs rooted at the primary row', async () => {
    const { summarizeProjectionPlan } = await import('../../src/with-formula/materialized-views/dependency-analyzer.js')
    const base = { source: 'bills', map: () => null }
    const rooted = summarizeProjectionPlan({
      name: 'x', rowKey: () => '', refresh: 'eager',
      projection: { ...base, joins: [{ field: 'entityId', as: 'entity' }, { collect: 'clients', on: 'entityId', as: 'clients' }] },
    } as never)
    const relative = summarizeProjectionPlan({
      name: 'x', rowKey: () => '', refresh: 'eager',
      projection: { ...base, joins: [{ field: 'entityId', as: 'entity' }, { from: 'entity', collect: 'clients', on: 'entityId', as: 'clients' }] },
    } as never)
    expect(rooted).not.toEqual(relative)
  })
})
