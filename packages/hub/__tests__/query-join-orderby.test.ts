/**
 * #1337 — `orderBy()` a joined field (`orderBy('client.name')`).
 *
 * Join legs run AFTER `orderBy`/`limit`/`offset`, so an ordering that
 * addresses a join alias sorted a row where the alias did not exist yet:
 * every sort key read `undefined`, the sort was a no-op, and the page came
 * back in insertion order with no error. Consumers post-sorted in userland —
 * which is exactly what `limit` makes wrong, because the page has already
 * been cut from the unsorted set.
 *
 * The fix extends the #1030 split: an ORDERING that addresses an alias moves
 * the sort/paginate to after the legs are attached, the same rule a `where`
 * on an alias already gets. An ordering over the left collection's own fields
 * is untouched and still runs pre-join (index fast path intact).
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, ref } from '../src/index.js'
import { i18nText } from '../src/via/i18n/core.js'
import { withI18n } from '../src/via/i18n/index.js'
import { withReduce } from '../src/with-lookup/reduce/index.js'
import { money } from '../src/via/money/descriptor.js'
import type { NoydbStore, EncryptedEnvelope } from '../src/kernel/types.js'

function toMemory(): NoydbStore {
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
        const [vname, cname, id] = key.split('/')
        if (vname === v && cname !== undefined && id !== undefined) {
          out[cname] = out[cname] ?? {}
          out[cname]![id] = env
        }
      }
      return out
    },
    async saveAll(v, payload) {
      for (const c of Object.keys(payload)) {
        for (const i of Object.keys(payload[c]!)) data.set(k(v, c, i), payload[c]![i]!)
      }
    },
  }
}

const SECRET = 'join-orderby-1337-secret-exact-magnitude'

interface Bill extends Record<string, unknown> { id: string; clientId?: string; total: number }
interface Client extends Record<string, unknown> { id: string; name: string; credit: string }

/**
 * Insertion order is deliberately NOT the sorted order on any axis, so a
 * no-op sort is distinguishable from a correct one.
 *
 * `credit` is a fixed-mode EUR money field, and the two magnitudes are the
 * pair that separates a lexical comparator from a numeric one: stored scaled
 * integers `'9882'` and `'10004'` compare `'10004' < '9882'` as strings and
 * `98.82 < 100.04` as money.
 */
async function seed() {
  const db = await createNoydb({
    store: toMemory(), user: 'a', secret: SECRET, validateSecret: false,
    reduceStrategy: withReduce(),
  })
  const vault = await db.openVault('v')
  const clients = vault.collection<Client>('clients', {
    moneyFields: { credit: money({ currency: 'EUR', scale: 2 }) },
  })
  await clients.put('c1', { id: 'c1', name: 'Della', credit: '98.82' })
  await clients.put('c2', { id: 'c2', name: 'Ann', credit: '100.04' })
  await clients.put('c3', { id: 'c3', name: 'Cyd', credit: '7.00' })
  await clients.put('c4', { id: 'c4', name: 'Bob', credit: '2000.00' })
  const bills = vault.collection<Bill>('bills', {
    refs: { clientId: ref('clients', 'cascade') },
    indexes: ['total'],
  })
  await bills.put('b1', { id: 'b1', clientId: 'c1', total: 10 })
  await bills.put('b2', { id: 'b2', clientId: 'c2', total: 40 })
  await bills.put('b3', { id: 'b3', clientId: 'c3', total: 20 })
  await bills.put('b4', { id: 'b4', clientId: 'c4', total: 30 })
  return { vault, bills, clients }
}

const ids = (rows: readonly unknown[]): string[] => rows.map(r => (r as Bill).id)

describe('#1337 — orderBy() on a join alias', () => {
  it('sorts by the joined field instead of leaving the rows unsorted', async () => {
    const { bills } = await seed()
    const rows = await bills.query().join('clientId', { as: 'client' })
      .orderBy('client.name').toArray()

    // Ann(c2/b2), Bob(c4/b4), Cyd(c3/b3), Della(c1/b1)
    expect(ids(rows)).toEqual(['b2', 'b4', 'b3', 'b1'])
  })

  it('limit() pages the SORTED joined relation, not the unsorted one', async () => {
    const { bills } = await seed()
    const limited = await bills.query().join('clientId', { as: 'client' })
      .orderBy('client.name').limit(2).toArray()
    // The reference answer: sort the whole joined relation, then slice. This
    // is what a userland post-sort cannot reproduce — it only ever sees the
    // page the unsorted limit already cut.
    const full = await bills.query().join('clientId', { as: 'client' })
      .orderBy('client.name').toArray()

    expect(ids(limited)).toEqual(ids(full).slice(0, 2))
    expect(ids(limited)).toEqual(['b2', 'b4'])
  })

  it('offset + limit page the sorted joined relation', async () => {
    const { bills } = await seed()
    const page = await bills.query().join('clientId', { as: 'client' })
      .orderBy('client.name').offset(1).limit(2).toArray()
    expect(ids(page)).toEqual(['b4', 'b3'])
  })

  it('desc reverses the joined ordering', async () => {
    const { bills } = await seed()
    const rows = await bills.query().join('clientId', { as: 'client' })
      .orderBy('client.name', 'desc').limit(2).toArray()
    expect(ids(rows)).toEqual(['b1', 'b3'])
  })

  it('an aliased MONEY field sorts by magnitude, where a lexical compare inverts it', async () => {
    const { bills } = await seed()
    const rows = await bills.query().join('clientId', { as: 'client' })
      .orderBy('client.credit').toArray()

    // By magnitude: 7.00, 98.82, 100.04, 2000.00.
    // Lexically over the stored scaled ints ('700','9882','10004','200000'):
    // '10004' < '200000' < '700' < '9882' — a different answer on every row.
    expect(ids(rows)).toEqual(['b3', 'b1', 'b2', 'b4'])
    // And the value handed back is still the DECODED one.
    expect((rows[0] as { client: { credit: string } }).client.credit).toBe('7.00')
  })

  it('an unmatched left row sorts last in asc (nullish-last, same as the row pipeline)', async () => {
    const { bills } = await seed()
    await bills.put('b5', { id: 'b5', total: 50 })
    const rows = await bills.query().join('clientId', { as: 'client' })
      .orderBy('client.name').toArray()
    expect(ids(rows)).toEqual(['b2', 'b4', 'b3', 'b1', 'b5'])
  })

  it('a where() on the alias and an orderBy() on the alias compose', async () => {
    const { bills } = await seed()
    const rows = await bills.query().join('clientId', { as: 'client' })
      .where('client.name', '!=', 'Ann')
      .orderBy('client.name').limit(2).toArray()
    expect(ids(rows)).toEqual(['b4', 'b3'])
  })

  it('NO REGRESSION: ordering by a LEFT field with a join still runs pre-join', async () => {
    const { bills } = await seed()
    const q = bills.query().join('clientId', { as: 'client' }).orderBy('total').limit(2)
    const plan = q.explain()
    const order = plan.nodes.find(n => n.op === 'orderBy')!
    expect(order.notes).toContain('pre-join')
    // …and the legs are still emitted after the page node.
    const idx = (op: string) => plan.nodes.findIndex(n => n.op === op)
    expect(idx('join')).toBeGreaterThan(idx('page'))
    expect(ids(await q.toArray())).toEqual(['b1', 'b3'])
  })

  it('explain() reports post-join placement when the ordering addresses an alias', async () => {
    const { bills } = await seed()
    const plan = bills.query().join('clientId', { as: 'client' })
      .orderBy('client.name').limit(2).explain()
    expect(plan.nodes.find(n => n.op === 'orderBy')!.notes).toContain('post-join')
    expect(plan.nodes.find(n => n.op === 'page')!.notes).toContain('post-join')
    const idx = (op: string) => plan.nodes.findIndex(n => n.op === op)
    expect(idx('join')).toBeLessThan(idx('orderBy'))
  })
})

describe('#1337 — orderBy() on an alias, the other join directions', () => {
  it('rightJoin: the reverse-index drive orders by the alias too', async () => {
    const { bills } = await seed()
    // Every client survives, including one no bill points at — sorted by the
    // aliased name, the unreferenced client is placed by its own key, not
    // stranded at the end of the reverse-index walk.
    const rows = bills.query()
      .rightJoin<'client', Client>('clientId', { as: 'client' })
      .orderBy('client.name').limit(2).toArray()
    expect(rows.map(r => (r as unknown as { client: Client }).client.name)).toEqual(['Ann', 'Bob'])
  })

  it('fullOuterJoin: an unmatched LEFT row (null alias) still sorts nullish-last', async () => {
    const { bills } = await seed()
    await bills.put('b5', { id: 'b5', total: 50 })
    const rows = bills.query()
      .fullOuterJoin<'client', Client>('clientId', { as: 'client' })
      .orderBy('client.name').toArray()
    const names = rows.map(r => (r as unknown as { client: Client | null }).client?.name ?? null)
    expect(names).toEqual(['Ann', 'Bob', 'Cyd', 'Della', null])
  })
})

describe('#1337 — label-aware ordering keeps working through presentForJoin', () => {
  interface Category extends Record<string, unknown> { id: string; name: Record<string, string> }
  interface Product extends Record<string, unknown> { id: string; categoryId: string }

  it('an aliased i18nText field sorts by the LOCALE-RESOLVED text, not the raw map', async () => {
    const db = await createNoydb({
      store: toMemory(), user: 'a', secret: SECRET, validateSecret: false, i18nStrategy: withI18n(),
    })
    const vault = await db.openVault('v')
    const categories = vault.collection<Category>('categories', {
      i18nFields: { name: i18nText({ languages: ['en', 'de'], required: 'all' }) },
    })
    // The two locales rank the same three categories differently — so a sort
    // that reads the raw `{en,de}` map (an object: the generic comparator
    // calls every pair equal) cannot accidentally agree with either.
    await categories.put('k1', { id: 'k1', name: { en: 'Cheese', de: 'Ahorn' } })
    await categories.put('k2', { id: 'k2', name: { en: 'Apple', de: 'Zimt' } })
    await categories.put('k3', { id: 'k3', name: { en: 'Bread', de: 'Milch' } })
    const products = vault.collection<Product>('products', { refs: { categoryId: ref('categories') } })
    await products.put('p1', { id: 'p1', categoryId: 'k1' })
    await products.put('p2', { id: 'p2', categoryId: 'k2' })
    await products.put('p3', { id: 'p3', categoryId: 'k3' })

    const order = (locale: string): string[] =>
      products.query().join('categoryId', { as: 'category' })
        .orderBy('category.name').toArray({ locale })
        .map(r => (r as unknown as { id: string }).id)

    expect(order('en')).toEqual(['p2', 'p3', 'p1']) // Apple, Bread, Cheese
    expect(order('de')).toEqual(['p1', 'p3', 'p2']) // Ahorn, Milch, Zimt
  })
})
