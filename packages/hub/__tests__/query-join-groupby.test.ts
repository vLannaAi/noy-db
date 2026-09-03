/**
 * #1338 — aggregate / groupBy over a joined alias field.
 *
 * `groupBy('client.region').aggregate({ total: sum('total') })` is the
 * accounting-report shape, and it was REFUSED: `assertNoJoinAliasField` threw
 * because the reduce-shaped terminals never applied the legs, so the group key
 * would have read `undefined` for every row.
 *
 * The refusal's own doc named the real blocker, and it was not the legs: the
 * Via pipeline is LEFT-scoped, so `sum('client.credit')` skipped money's
 * exact-BigInt rewrite (a generic sum over stored scaled-integer strings —
 * silently wrong numbers) AND skipped the `queryable: 'none'` posture gate. A
 * gate that silently does not apply is worse than a missing feature.
 *
 * Both halves are answered here: the legs run through the #1030 post-join
 * pipeline, and each aliased reducer is wrapped by the RIGHT collection's own
 * pipeline — which carries its rewrite and its posture gate together.
 *
 * ⭐ EVERYTHING REDUCES IN RAW STORED SPACE, which is not a new decision: it is
 * the space `.groupBy()` has always reduced the LEFT side in (a left money
 * group key comes back as its stored scaled integer today). The money reducers
 * are exact in either space — `toScaledIntFromAny` takes both the stored
 * scaled integer and the decoded decimal — so nothing is lost by staying in
 * the one the rest of the plan already uses.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, ref, FieldNotQueryableError } from '../src/index.js'
import { withReduce } from '../src/with-lookup/reduce/index.js'
import { sum, count, min, max } from '../src/with-lookup/reduce/reducers.js'
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

const SECRET = 'join-groupby-1338-secret-accounting-report'

interface Bill extends Record<string, unknown> { id: string; clientId?: string; total: string }
interface Client extends Record<string, unknown> { id: string; region: string; credit: string }

/**
 * Two regions, four bills, plus one bill whose FK dangles — the unmatched
 * left row every left-outer report has to place somewhere.
 *
 * The money magnitudes are chosen so a float sum and a lexical compare both
 * visibly fail: `0.10 + 0.20` is `0.30` only in exact arithmetic, and the
 * north total (`90071992547410.00`) is past `Number.MAX_SAFE_INTEGER`.
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
  await clients.put('c1', { id: 'c1', region: 'north', credit: '98.82' })
  await clients.put('c2', { id: 'c2', region: 'north', credit: '100.04' })
  await clients.put('c3', { id: 'c3', region: 'south', credit: '7.00' })
  const bills = vault.collection<Bill>('bills', {
    refs: { clientId: ref('clients', 'cascade') },
    moneyFields: { total: money({ currency: 'EUR', scale: 2 }) },
  })
  await bills.put('b1', { id: 'b1', clientId: 'c1', total: '90071992547409.91' })
  await bills.put('b2', { id: 'b2', clientId: 'c2', total: '0.09' })
  await bills.put('b3', { id: 'b3', clientId: 'c3', total: '0.10' })
  await bills.put('b4', { id: 'b4', clientId: 'c3', total: '0.20' })
  await bills.put('b5', { id: 'b5', clientId: 'GONE', total: '5.00' })
  return { vault, bills, clients }
}

type Row = Record<string, unknown>

describe('#1338 — groupBy() over a joined alias', () => {
  it('the accounting report: group by the joined region, sum the LEFT money field exactly', async () => {
    const { bills } = await seed()
    const rows = bills.query().join('clientId', { as: 'client' })
      .groupBy('client.region')
      .aggregate({ total: sum('total'), n: count() })
      .run() as Row[]

    const by = new Map(rows.map(r => [r['client.region'], r]))
    // Exact past Number.MAX_SAFE_INTEGER — a float sum returns …09.91 + 0.09
    // as 90071992547410.00 only by luck, and drifts on the south pair.
    expect(by.get('north')!.total).toBe('90071992547410.00')
    expect(by.get('south')!.total).toBe('0.30') // not 0.30000000000000004
    expect(by.get('north')!.n).toBe(2)
    expect(by.get('south')!.n).toBe(2)
  })

  it('the group key is stamped under the DOTTED path, not the bare field name', async () => {
    const { bills } = await seed()
    const rows = bills.query().join('clientId', { as: 'client' })
      .groupBy('client.region').aggregate({ n: count() }).run() as Row[]
    expect(Object.keys(rows[0]!)[0]).toBe('client.region')
    expect(rows[0]).not.toHaveProperty('region')
  })

  it('an UNMATCHED left row lands in the undefined bucket — it is not dropped and not merged with null', async () => {
    const { bills } = await seed()
    const rows = bills.query().join('clientId', { as: 'client' })
      .groupBy('client.region').aggregate({ total: sum('total'), n: count() }).run() as Row[]

    // b5's ref dangles, so the alias is null and `client.region` reads
    // undefined — the same bucket a MISSING left-side group field already
    // gets, and distinct from an explicit null (Map-based partitioning keeps
    // those apart). Every left row is accounted for: 5 in, 5 counted.
    const orphan = rows.find(r => r['client.region'] === undefined)!
    expect(orphan).toBeDefined()
    expect(orphan.n).toBe(1)
    expect(orphan.total).toBe('5.00')
    expect(rows.reduce((acc, r) => acc + (r.n as number), 0)).toBe(5)
  })

  it('reduces over an ALIASED money field with the exact BigInt reducer', async () => {
    const { bills } = await seed()
    // Two bills point at north clients holding 98.82 and 100.04. A generic
    // sum over the stored scaled integers ('9882', '10004') coerces strings
    // to 0 and returns 0; a lexical min/max inverts the pair.
    const r = bills.query().join('clientId', { as: 'client' })
      .aggregate({
        credit: sum('client.credit'),
        lowest: min('client.credit'),
        highest: max('client.credit'),
      }).run() as Row

    // 98.82 + 100.04 + 7.00 + 7.00 (b3 and b4 both point at c3); b5 dangles.
    expect(r.credit).toBe('212.86')
    expect(r.lowest).toBe('7.00')
    expect(r.highest).toBe('100.04')
  })

  it('groups by the joined region AND sums the joined money field', async () => {
    const { bills } = await seed()
    const rows = bills.query().join('clientId', { as: 'client' })
      .groupBy('client.region')
      .aggregate({ credit: sum('client.credit') })
      .run() as Row[]
    const by = new Map(rows.map(r => [r['client.region'], r]))
    expect(by.get('north')!.credit).toBe('198.86')
    expect(by.get('south')!.credit).toBe('14.00')
  })

  it('a where() on the alias narrows what is grouped', async () => {
    const { bills } = await seed()
    const rows = bills.query().join('clientId', { as: 'client' })
      .where('client.region', '==', 'south')
      .groupBy('client.region').aggregate({ total: sum('total'), n: count() }).run() as Row[]
    expect(rows).toHaveLength(1)
    expect(rows[0]!.n).toBe(2)
    expect(rows[0]!.total).toBe('0.30')
  })

  it('post-group having/orderBy/limit (#1336) compose with an aliased key', async () => {
    const { bills } = await seed()
    const rows = bills.query().join('clientId', { as: 'client' })
      .groupBy('client.region').aggregate({ total: sum('total') })
      .having(r => (r as Row)['client.region'] !== undefined)
      .orderBy('total', 'desc')
      .run() as Row[]
    expect(rows.map(r => r['client.region'])).toEqual(['north', 'south'])
  })

  it('grouping over LEFT fields with a join leg present is unchanged (no legs run)', async () => {
    const { bills } = await seed()
    const rows = bills.query().join('clientId', { as: 'client' })
      .groupBy('clientId').aggregate({ n: count() }).run() as Row[]
    expect(rows).toHaveLength(4) // c1, c2, c3, GONE — one bucket per FK value
    expect(Object.keys(rows[0]!)[0]).toBe('clientId')
  })

  it('an aliased group key over a MONEY field buckets by the value, in the same stored space a left money key uses', async () => {
    const { bills } = await seed()
    const aliased = bills.query().join('clientId', { as: 'client' })
      .groupBy('client.credit').aggregate({ n: count() }).run() as Row[]
    const left = bills.query().groupBy('total').aggregate({ n: count() }).run() as Row[]
    // Three distinct credits behind the four matched bills, plus the orphan.
    expect(aliased).toHaveLength(4)
    // The shape of a money group key is whatever the LEFT side already
    // produces — this pins the two together so they cannot drift.
    expect(typeof aliased.find(r => r.n === 2)!['client.credit'])
      .toBe(typeof left[0]!.total)
  })

  it('distinct() over an alias still refuses — out of scope, and it says so', async () => {
    const { bills } = await seed()
    expect(() => bills.query().join('clientId', { as: 'client' }).distinct('client.region'))
      .toThrow(/join alias/)
  })
})

describe('#1338 — the gates that made the refusal right, now applied', () => {
  it('the RIGHT collection\'s queryable:"none" posture refuses an aliased reducer', async () => {
    const db = await createNoydb({
      store: toMemory(), user: 'a', secret: SECRET, validateSecret: false,
      reduceStrategy: withReduce(),
    })
    const vault = await db.openVault('v')
    const clients = vault.collection<Record<string, unknown>>('clients', { blobFields: { receipt: {} } })
    await clients.put('c1', { id: 'c1' })
    const bills = vault.collection<Bill>('bills', { refs: { clientId: ref('clients') } })
    await bills.put('b1', { id: 'b1', clientId: 'c1', total: '1.00' })

    // The old refusal's doc: "refuseUnqueryableReducers does not fire, so the
    // queryable:'none' gate that would refuse the field never applies. A gate
    // that silently does not apply is worse than a missing feature." It fires
    // now, because the aliased reducer goes through the right side's OWN
    // wrapReducers — the same call that carries the rewrite carries the gate.
    expect(() => bills.query().join('clientId', { as: 'client' })
      .aggregate({ x: sum('client.receipt') })).toThrow(FieldNotQueryableError)
  })

  it('a LEFT group key with an ALIASED reducer is refused, not folded as undefined', async () => {
    const { bills } = await seed()
    // The hole this closes: `Query.aggregate()`'s guard never saw a grouped
    // spec — the grouped terminal is `GroupedQuery.aggregate`, one object
    // along the chain — so this shape returned a confident 0 for every bucket.
    expect(() => bills.query().join('clientId', { as: 'client' })
      .groupBy('clientId').aggregate({ credit: sum('client.credit') }))
      .toThrow(/GROUP KEY does not/)
  })

  it('a live joined aggregate re-fires when the RIGHT side changes', async () => {
    const { bills, clients } = await seed()
    const live = bills.query().join('clientId', { as: 'client' })
      .aggregate({ credit: sum('client.credit') }).live()
    try {
      expect(live.value).toEqual({ credit: '212.86' })
      // Without the right-side upstream this reduction would silently stay at
      // its first value while the number it reports has changed.
      await clients.put('c3', { id: 'c3', region: 'south', credit: '8.00' })
      await new Promise(r => setTimeout(r, 0))
      expect(live.value).toEqual({ credit: '214.86' })
    } finally {
      live.stop()
    }
  })
})
