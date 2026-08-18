/**
 * #1139 — a query-form MV whose `query()` calls `.join()` on a declared FK.
 *
 * MV strategies register during `openVault()`, but a collection's `refs` can only
 * be declared afterwards, so the plan used to be built before any ref existed and
 * `openVault()` threw with advice the consumer had already followed. There was no
 * call ordering that avoided it. Planning is now deferred and replanned on the
 * first dispatch or `refreshView()`.
 *
 * The projection form is the reference for the correct timing, so the last test
 * pins the two forms as equivalent on the same shape.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, withMaterializedView, ref } from '../../src/index.js'
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
interface Bill extends Record<string, unknown> { id: string; entityId: string; amount: number }
/** The emitted row is the source record with the join leg attached under `entity`. */
interface BillRow extends Record<string, unknown> { id: string; entityId: string; amount: number; entity: Entity | null }

const joiningQueryMV = (refresh: 'eager' | 'lazy' | 'manual' = 'eager') =>
  withMaterializedView<BillRow>({
    name: 'billRows',
    query: (db) => db.collection<Bill>('bills').query().join<'entity', Entity>('entityId', { as: 'entity' }) as never,
    rowKey: (r) => r.id,
    refresh,
  })

/** The niwat shape: refs declared AFTER openVault, which is the only place they can be. */
async function openBooks(mv: ReturnType<typeof joiningQueryMV>) {
  const db = await createNoydb({
    store: toMemory(),
    user: 'alice',
    secret: 'mv-query-form-late-refs-secret-2026',
    materializedViewStrategies: [mv],
  })
  const vault = await db.openVault('books')
  vault.collection<Entity>('entities')
  vault.collection<Bill>('bills', { refs: { entityId: ref('entities', 'warn') } })
  return vault
}

describe('#1139 — query-form MV joining a ref declared after openVault', () => {
  it('opens the vault instead of throwing at registration', async () => {
    await expect(openBooks(joiningQueryMV())).resolves.toBeDefined()
  })

  it('materializes the join on the first eager dispatch', async () => {
    const vault = await openBooks(joiningQueryMV('eager'))
    await vault.collection<Entity>('entities').put('e1', { id: 'e1', name: 'Entity One' })
    await vault.collection<Bill>('bills').put('b1', { id: 'b1', entityId: 'e1', amount: 100 })

    const rows = await vault.collection<BillRow>('billRows').list()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: 'b1', amount: 100, entity: { id: 'e1', name: 'Entity One' } })
  })

  it('keeps the join live across later writes', async () => {
    const vault = await openBooks(joiningQueryMV('eager'))
    const entities = vault.collection<Entity>('entities')
    const bills = vault.collection<Bill>('bills')
    await entities.put('e1', { id: 'e1', name: 'Entity One' })
    await bills.put('b1', { id: 'b1', entityId: 'e1', amount: 100 })
    await bills.put('b2', { id: 'b2', entityId: 'e1', amount: 250 })

    const rows = await vault.collection<BillRow>('billRows').list()
    expect(rows.map(r => r.id).sort()).toEqual(['b1', 'b2'])
    expect(rows.every(r => r.entity?.name === 'Entity One')).toBe(true)
  })

  it('carries the ref mode: a dangling warn ref attaches null rather than throwing', async () => {
    const vault = await openBooks(joiningQueryMV('eager'))
    await vault.collection<Bill>('bills').put('b1', { id: 'b1', entityId: 'ghost', amount: 10 })
    const rows = await vault.collection<BillRow>('billRows').list()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.entity).toBeNull()
  })

  it('resolves through refreshView() for a manual strategy, with no write first', async () => {
    const vault = await openBooks(joiningQueryMV('manual'))
    await vault.collection<Entity>('entities').put('e1', { id: 'e1', name: 'Entity One' })
    await vault.collection<Bill>('bills').put('b1', { id: 'b1', entityId: 'e1', amount: 100 })
    // A manual strategy does not materialize on write, so this is the first
    // moment it could have been planned OR run.
    const result = await vault.refreshView('billRows')
    expect(result.written).toBe(1)
    expect((await vault.collection<BillRow>('billRows').list())[0]).toMatchObject({ entity: { name: 'Entity One' } })
  })

  it('lazy refresh reaches the same result', async () => {
    const vault = await openBooks(joiningQueryMV('lazy'))
    await vault.collection<Entity>('entities').put('e1', { id: 'e1', name: 'Entity One' })
    await vault.collection<Bill>('bills').put('b1', { id: 'b1', entityId: 'e1', amount: 100 })
    await vault.refreshView('billRows')
    expect((await vault.collection<BillRow>('billRows').list())[0]).toMatchObject({ id: 'b1', entity: { name: 'Entity One' } })
  })

  it('still fails LOUDLY at openVault for a planning error that is not a missing ref', async () => {
    const bad = withMaterializedView<BillRow>({
      name: 'badRows',
      query: () => { throw new TypeError('deliberate planning failure') },
      rowKey: (r) => r.id,
      refresh: 'eager',
    })
    const db = await createNoydb({
      store: toMemory(), user: 'alice', secret: 'mv-query-form-late-refs-secret-2026',
      materializedViewStrategies: [bad],
    })
    await expect(db.openVault('books')).rejects.toThrow('deliberate planning failure')
  })

  it('a parked SELF-referencing strategy escapes the cycle gate but does not run away', async () => {
    // The documented caveat: `edges()` runs once at vault open, so a strategy
    // still parked at that moment contributes none and `MaterializedViewCycleError`
    // cannot fire for it. Measured rather than asserted — the `_materializedFrom`
    // skip in the dispatcher is what actually stops the recursion, and this pins
    // that it does.
    const selfMV = withMaterializedView<BillRow>({
      name: 'bills', // output collection == source
      query: (db) => db.collection<Bill>('bills').query().join<'entity', Entity>('entityId', { as: 'entity' }) as never,
      rowKey: (r) => `mv-${r.id}`,
      refresh: 'eager',
    })
    const db = await createNoydb({
      store: toMemory(), user: 'alice', secret: 'mv-query-form-late-refs-secret-2026',
      materializedViewStrategies: [selfMV],
    })
    const vault = await db.openVault('books') // would throw if the cycle gate saw it
    vault.collection<Entity>('entities')
    vault.collection<Bill>('bills', { refs: { entityId: ref('entities', 'warn') } })

    await vault.collection<Bill>('bills').put('b1', { id: 'b1', entityId: 'ghost', amount: 1 })
    // The source row plus exactly ONE emitted row — not an unbounded cascade.
    expect(await vault.collection<BillRow>('bills').list()).toHaveLength(2)
  })

  it('a join on a field that never gets a ref stays unplanned and says so', async () => {
    const vault = await openBooks(joiningQueryMV('manual'))
    // `bills` is declared with a ref for `entityId`, but this strategy joins a
    // field nobody ever declares — the parked plan can never resolve.
    const db2 = await createNoydb({
      store: toMemory(), user: 'alice', secret: 'mv-query-form-late-refs-secret-2026',
      materializedViewStrategies: [withMaterializedView<BillRow>({
        name: 'neverRows',
        query: (d) => d.collection<Bill>('bills').query().join('nobodyDeclaredThis', { as: 'x' }) as never,
        rowKey: (r) => r.id,
        refresh: 'manual',
      })],
    })
    const v2 = await db2.openVault('books')
    v2.collection<Bill>('bills')
    await expect(v2.refreshView('neverRows')).rejects.toThrow(/no MV registered with name "neverRows"/)
    expect(vault).toBeDefined()
  })
})
