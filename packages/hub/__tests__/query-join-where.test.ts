/**
 * #1030 — `.where()` on a `.join()` alias silently returned zero rows.
 *
 * Join legs are applied AFTER every `where` clause so the left set can be
 * narrowed (and index-driven) first. That is the right default, but it meant a
 * predicate addressing a joined alias evaluated against a row where the alias
 * did not exist yet: `readPath` returned `undefined`, nothing matched, and the
 * query returned `[]` with no error.
 *
 * The DSL's other join flavour disagreed: `.crossJoin()` stores its clause IN
 * the clause list, so filtering after expansion always worked. Two join
 * flavours, opposite `.where()` behaviour, one of them silent.
 *
 * The fix splits clauses around the legs. The split is narrow on purpose: when
 * no clause addresses an alias, `postJoin` is empty and execution takes the
 * original path byte-for-byte — so the reordered pipeline only ever runs for
 * queries that matched nothing before.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, ref } from '../src/index.js'
import { count, sum, withReduce } from '../src/with-lookup/reduce/index.js'
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
      return [...data.keys()].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length))
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

const SECRET = 'join-where-1030-secret'

interface Bill extends Record<string, unknown> { id: string; clientId?: string; total: number }

/**
 * b1 → Ann, b2 → a dangling ref, b3 → no FK at all, b4 → Bob.
 * The two null-bearing rows are what make this an outer join worth filtering.
 */
async function seed() {
  const db = await createNoydb({
    store: toMemory(), user: 'a', secret: SECRET, validateSecret: false,
    reduceStrategy: withReduce(),
  })
  const vault = await db.openVault('v')
  await vault.collection('clients').put('c1', { id: 'c1', name: 'Ann' })
  await vault.collection('clients').put('c2', { id: 'c2', name: 'Bob' })
  const bills = vault.collection<Bill>('bills', { refs: { clientId: ref('clients', 'cascade') } })
  await bills.put('b1', { id: 'b1', clientId: 'c1', total: 10 })
  await bills.put('b2', { id: 'b2', clientId: 'GONE', total: 20 })
  await bills.put('b3', { id: 'b3', total: 30 })
  await bills.put('b4', { id: 'b4', clientId: 'c2', total: 40 })
  return { vault, bills }
}

const ids = (rows: readonly { id: string }[]): string[] => rows.map(r => r.id).sort()

describe('#1030 — where() on a join alias', () => {
  it('filters on a joined field instead of returning zero rows', async () => {
    const { bills } = await seed()
    const rows = await bills.query().join('clientId', { as: 'client' })
      .where('client.name', '==', 'Ann').toArray()

    expect(ids(rows)).toEqual(['b1'])
    expect((rows[0] as { client: { name: string } }).client.name).toBe('Ann')
  })

  it('the anti-join: rows whose right side is absent', async () => {
    const { bills } = await seed()
    // This is #984's anti-join item. It needs no new operator — a left outer
    // join plus a predicate on the alias IS `WHERE NOT EXISTS`, once the
    // predicate can actually see the alias. Both null-bearing shapes qualify:
    // b2's ref dangles, b3 has no ref at all.
    const rows = await bills.query().join('clientId', { as: 'client' })
      .where('client', '==', null).toArray()

    expect(ids(rows)).toEqual(['b2', 'b3'])
  })

  it('the join stays a LEFT outer join — unfiltered, every left row survives', async () => {
    const { bills } = await seed()
    const rows = await bills.query().join('clientId', { as: 'client' }).toArray()

    expect(ids(rows)).toEqual(['b1', 'b2', 'b3', 'b4'])
    const byId = new Map(rows.map(r => [(r as Bill).id, r as unknown as { client: unknown }]))
    expect(byId.get('b2')!.client).toBeNull()
    expect(byId.get('b3')!.client).toBeNull()
  })

  it('combines a left-side and a joined predicate', async () => {
    const { bills } = await seed()
    // 'total > 5' narrows pre-join (index-eligible); 'client.name' post-join.
    const rows = await bills.query().join('clientId', { as: 'client' })
      .where('total', '>', 25)
      .where('client.name', '==', 'Bob')
      .toArray()

    expect(ids(rows)).toEqual(['b4'])
  })

  it('orderBy and limit observe the joined predicate, not precede it', async () => {
    const { bills } = await seed()
    // The regression this guards: if pagination ran before the post-join
    // filter, limit(1) would slice the unfiltered set and could return a row
    // the predicate excludes — or nothing at all.
    const rows = await bills.query().join('clientId', { as: 'client' })
      .where('client', '==', null)
      .orderBy('total', 'desc')
      .limit(1)
      .toArray()

    expect(ids(rows)).toEqual(['b3'])   // b3 (30) outranks b2 (20)
  })

  it('offset also applies after the joined predicate', async () => {
    const { bills } = await seed()
    const rows = await bills.query().join('clientId', { as: 'client' })
      .where('client', '==', null)
      .orderBy('total', 'asc')
      .offset(1)
      .toArray()

    expect(ids(rows)).toEqual(['b3'])
  })

  it('count() reports the filtered cardinality when the predicate is joined', async () => {
    const { bills } = await seed()
    expect(bills.query().join('clientId', { as: 'client' })
      .where('client.name', '==', 'Ann').count()).toBe(1)
    expect(bills.query().join('clientId', { as: 'client' })
      .where('client', '==', null).count()).toBe(2)
  })

  it('count() still skips the legs when no predicate addresses them', async () => {
    const { bills } = await seed()
    // The projection-only contract is preserved: a join that nothing filters
    // on must not change the counted cardinality (and must not pay for the
    // legs to produce a number that discards them).
    expect(bills.query().join('clientId', { as: 'client' }).count()).toBe(4)
    expect(bills.query().join('clientId', { as: 'client' }).where('total', '>', 25).count()).toBe(2)
  })

  it('first() returns a matching row rather than null', async () => {
    const { bills } = await seed()
    const row = bills.query().join('clientId', { as: 'client' })
      .where('client.name', '==', 'Bob').first()
    expect((row as Bill | null)?.id).toBe('b4')
  })

  it('a non-matching joined predicate still yields zero rows', async () => {
    const { bills } = await seed()
    // Guards the obvious over-correction: post-join filtering must still be a
    // filter. An empty result has to remain reachable.
    expect(await bills.query().join('clientId', { as: 'client' })
      .where('client.name', '==', 'Nobody').toArray()).toEqual([])
  })

  it('multi-leg joins: each alias is independently filterable', async () => {
    const db = await createNoydb({ store: toMemory(), user: 'a', secret: SECRET, validateSecret: false })
    const vault = await db.openVault('v')
    await vault.collection('clients').put('c1', { id: 'c1', name: 'Ann' })
    await vault.collection('regions').put('r1', { id: 'r1', code: 'EU' })
    await vault.collection('regions').put('r2', { id: 'r2', code: 'US' })
    const bills = vault.collection<Bill>('bills', {
      refs: { clientId: ref('clients', 'cascade'), regionId: ref('regions', 'cascade') },
    })
    await bills.put('b1', { id: 'b1', clientId: 'c1', regionId: 'r1', total: 10 })
    await bills.put('b2', { id: 'b2', clientId: 'c1', regionId: 'r2', total: 20 })

    const rows = await bills.query()
      .join('clientId', { as: 'client' })
      .join('regionId', { as: 'region' })
      .where('client.name', '==', 'Ann')
      .where('region.code', '==', 'US')
      .toArray()

    expect(ids(rows)).toEqual(['b2'])
  })

  it('an alias-shaped path that is NOT an alias stays a left-side field', async () => {
    const db = await createNoydb({ store: toMemory(), user: 'a', secret: SECRET, validateSecret: false })
    const vault = await db.openVault('v')
    await vault.collection('clients').put('c1', { id: 'c1', name: 'Ann' })
    const bills = vault.collection<Bill>('bills', { refs: { clientId: ref('clients', 'cascade') } })
    // A left-side nested object whose head segment resembles a joined alias.
    await bills.put('b1', { id: 'b1', clientId: 'c1', total: 1, meta: { tag: 'x' } })
    await bills.put('b2', { id: 'b2', clientId: 'c1', total: 2, meta: { tag: 'y' } })

    // 'meta' is not a join alias, so it must keep filtering pre-join.
    const rows = await bills.query().join('clientId', { as: 'client' })
      .where('meta.tag', '==', 'y').toArray()
    expect(ids(rows)).toEqual(['b2'])
  })

  it('scan(): the streaming path filters on a joined alias too', async () => {
    const { bills } = await seed()
    const seen: string[] = []
    for await (const row of bills.scan().join('clientId', { as: 'client' })
      .where('client.name', '==', 'Ann')) {
      seen.push((row as Bill).id)
    }
    expect(seen).toEqual(['b1'])
  })

  it('scan(): anti-join streams the null-bearing rows', async () => {
    const { bills } = await seed()
    const seen: string[] = []
    for await (const row of bills.scan().join('clientId', { as: 'client' })
      .where('client', '==', null)) {
      seen.push((row as Bill).id)
    }
    expect(seen.sort()).toEqual(['b2', 'b3'])
  })

  it('scan(): a left-side predicate still filters before the join', async () => {
    const { bills } = await seed()
    const seen: string[] = []
    for await (const row of bills.scan().join('clientId', { as: 'client' }).where('total', '>', 25)) {
      seen.push((row as Bill).id)
    }
    expect(seen.sort()).toEqual(['b3', 'b4'])
  })
})

describe('#1030 — reducing terminals over a joined alias (superseded by #1338)', () => {
  /**
   * These three shapes THREW until #1338. The refusal was right for what it
   * knew: the terminals did not apply the legs, so a group key or a reducer
   * over an alias would have folded `undefined`. #1338 supplies the missing
   * half — the legs run, and each aliased reducer is wrapped by the RIGHT
   * collection's pipeline, which carries money's exact rewrite and the
   * `queryable: 'none'` gate together. `query-join-groupby.test.ts` owns the
   * behaviour; what is pinned HERE is that the shapes #1030 refused are the
   * shapes that now work, so nobody re-adds the guard by reading only its doc.
   */
  it('groupBy() on a joined alias buckets by the joined value', async () => {
    const { bills } = await seed()
    const rows = bills.query().join('clientId', { as: 'client' })
      .groupBy('client.name').aggregate({ n: count() }).run() as Record<string, unknown>[]
    const by = new Map(rows.map(r => [r['client.name'], r.n]))
    expect(by.get('Ann')).toBe(1)
    expect(by.get('Bob')).toBe(1)
    // b2 (dangling) and b3 (no FK) share the undefined bucket.
    expect(by.get(undefined)).toBe(2)
  })

  it('aggregate() over a joined alias reduces the joined relation', async () => {
    const { bills } = await seed()
    const r = bills.query().join('clientId', { as: 'client' })
      .aggregate({ n: count() }).run() as Record<string, unknown>
    expect(r.n).toBe(4)
  })

  it('distinct() over an alias is still refused, and still names crossJoin', async () => {
    const { bills } = await seed()
    expect(() => bills.query().join('clientId', { as: 'client' }).distinct('client.name'))
      .toThrow(/addresses the join alias "client"/)
    expect(() => bills.query().join('clientId', { as: 'client' }).distinct('client.name'))
      .toThrow(/crossJoin/)
  })

  it('grouping and aggregating over LEFT-side fields is unaffected', async () => {
    const { bills } = await seed()
    expect(() => bills.query().join('clientId', { as: 'client' })
      .aggregate({ t: sum('total') })).not.toThrow()
    expect(() => bills.query().join('clientId', { as: 'client' }).groupBy('clientId'))
      .not.toThrow()
  })
})
