/**
 * #1343 — `retrieve()` over number / date / money / boolean fields.
 *
 * The composable route (the one the issue prefers): typed matching is
 * expressed as a `Query` handed to `retrieve({ within })`, so the typed
 * comparison runs in the query engine — over the range indexes #1344/#1345
 * shipped — and NO second (typed-token) index format is introduced.
 *
 * Three properties are pinned here:
 *
 *  1. `within` narrows BEFORE `limit` and AFTER scoring. BM25 statistics stay
 *     GLOBAL (df / N / avgdl over the whole corpus), so a document's score is
 *     identical whether or not a `within` is paired with it — the ranking is
 *     filter-independent. `limit` then counts hits from the NARROWED set.
 *  2. `retrieve('', { within })` is typed-only retrieval: the typed predicate
 *     IS the query. `retrieve('')` with no `within` still matches nothing.
 *  3. Money / dates compare in their canonical stored space, never lexically
 *     (the '9882' vs '10004' trap of #1336 / #1337).
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, money, withSearch } from '../src/index.js'
import { withIndexing } from '../src/with-lookup/indexing/index.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { ConflictError } from '../src/kernel/errors.js'

function toMemory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function gc(c: string, col: string) {
    let comp = store.get(c); if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col); if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
    name: 'memory',
    async get(c, col, id) { return store.get(c)?.get(col)?.get(id) ?? null },
    async put(c, col, id, env, ev) {
      const coll = gc(c, col); const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      coll.set(id, env)
    },
    async delete(c, col, id) { store.get(c)?.get(col)?.delete(id) },
    async list(c, col) { const coll = store.get(c)?.get(col); return coll ? [...coll.keys()] : [] },
    async loadAll(c) {
      const comp = store.get(c); const s: VaultSnapshot = {}
      if (comp) for (const [n, coll] of comp) if (!n.startsWith('_')) {
        const r: Record<string, EncryptedEnvelope> = {}; for (const [id, e] of coll) r[id] = e; s[n] = r
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
      if (existing) for (const [name, coll] of existing) if (name.startsWith('_')) comp.set(name, coll)
      store.set(c, comp)
    },
  }
}

interface Invoice {
  id: string
  note: string
  amount: string       // money — scaled-integer canonical space
  qty: number
  dueDate: string
  paid: boolean
}

/**
 * `amount` values are chosen so LEXICAL string order disagrees with NUMERIC
 * order: '98.82' > '100.04' lexically, the wrong way round. Any implementation
 * that compares the money field as a string fails cases 6 / 7.
 */
const ROWS: Invoice[] = [
  { id: 'i1', note: 'revenue report march',   amount: '98.82',   qty: 3,  dueDate: '2026-06-04', paid: false },
  { id: 'i2', note: 'revenue summary april',  amount: '100.04',  qty: 12, dueDate: '2026-07-11', paid: true },
  { id: 'i3', note: 'revenue forecast may',   amount: '1000.00', qty: 40, dueDate: '2026-08-02', paid: false },
  { id: 'i4', note: 'revenue ledger june',    amount: '9.99',    qty: 1,  dueDate: '2026-09-23', paid: true },
  { id: 'i5', note: 'revenue notes july',     amount: '250.50',  qty: 7,  dueDate: '2026-06-30', paid: false },
]

async function seed() {
  const db = await createNoydb({
    store: toMemory(),
    user: 'u',
    secret: 'pw-1343-typed-within',
    searchStrategy: withSearch(),
    indexingStrategy: withIndexing(),
  })
  const v = await db.openVault('v')
  const c = v.collection<Invoice>('invoices', {
    textIndexes: ['note'],
    moneyFields: { amount: money({ currency: 'USD' }) },
    indexes: [
      { fields: ['amount'], kind: 'sorted' },
      { fields: ['qty'], kind: 'sorted' },
      { fields: ['dueDate'], kind: 'sorted' },
    ],
  })
  for (const r of ROWS) await c.put(r.id, r)
  return c
}

const ids = (hits: readonly { id: string }[]) => hits.map(h => h.id)

describe('#1343 — retrieve({ within }) over typed fields', () => {
  // ── 1. typed matching at all ────────────────────────────────────
  it('1. number: retrieve ∩ qty > 5', async () => {
    const c = await seed()
    const hits = await c.retrieve('revenue', { within: c.query().where('qty', '>', 5) })
    expect(new Set(ids(hits))).toEqual(new Set(['i2', 'i3', 'i5']))
  })

  it('2. boolean: retrieve ∩ paid == false', async () => {
    const c = await seed()
    const hits = await c.retrieve('revenue', { within: c.query().where('paid', '==', false) })
    expect(new Set(ids(hits))).toEqual(new Set(['i1', 'i3', 'i5']))
  })

  it('3. date: retrieve ∩ dueDate between', async () => {
    const c = await seed()
    const hits = await c.retrieve('revenue', {
      within: c.query().where('dueDate', 'between', ['2026-06-01', '2026-07-31']),
    })
    expect(new Set(ids(hits))).toEqual(new Set(['i1', 'i2', 'i5']))
  })

  // ── 2. before/after scoring, and limit ──────────────────────────
  it('4. `limit` counts hits from the NARROWED set, not from the whole corpus', async () => {
    const c = await seed()
    // 'revenue' matches all five notes. Without narrowing-before-limit, the
    // index slices to 2 corpus-wide first and the within filter can then leave
    // 0 or 1 hits. Narrowed first, exactly 2 of the 3 matching rows come back.
    const hits = await c.retrieve('revenue', { limit: 2, within: c.query().where('paid', '==', false) })
    expect(hits).toHaveLength(2)
    expect(hits.every(h => ['i1', 'i3', 'i5'].includes(h.id))).toBe(true)
    expect(hits.map(h => h.rank)).toEqual([1, 2])
  })

  it('5. scores are GLOBAL — a hit scores identically with and without `within`', async () => {
    const c = await seed()
    const all = await c.retrieve('march')
    const narrowed = await c.retrieve('march', { within: c.query().where('paid', '==', false) })
    const before = all.find(h => h.id === 'i1')!
    const after = narrowed.find(h => h.id === 'i1')!
    expect(before).toBeDefined()
    expect(after.score).toBe(before.score)
  })

  // ── 3. canonical comparison space ───────────────────────────────
  it('6. money compares NUMERICALLY, not lexically (98.82 < 100.04)', async () => {
    const c = await seed()
    const hits = await c.retrieve('revenue', { within: c.query().where('amount', '>', '100.00') })
    // Lexical string order would wrongly admit '98.82' and reject '1000.00'.
    expect(new Set(ids(hits))).toEqual(new Set(['i2', 'i3', 'i5']))
  })

  it('7. money `between` spans the canonical scaled-integer range', async () => {
    const c = await seed()
    const hits = await c.retrieve('revenue', {
      within: c.query().where('amount', 'between', ['50.00', '500.00']),
    })
    expect(new Set(ids(hits))).toEqual(new Set(['i1', 'i2', 'i5']))
  })

  // ── 4. typed-only retrieval (no text) ───────────────────────────
  it('8. retrieve("", { within }) returns the typed set as ranked hits', async () => {
    const c = await seed()
    const hits = await c.retrieve('', { within: c.query().where('amount', '>=', '250.50') })
    expect(new Set(ids(hits))).toEqual(new Set(['i3', 'i5']))
    expect(hits.map(h => h.rank)).toEqual([1, 2])
    expect(hits.every(h => h.score === 0 && h.field === '(within)' && h.snippet === '')).toBe(true)
  })

  it('9. typed-only honours limit and includeRecord', async () => {
    const c = await seed()
    const hits = await c.retrieve('  ', { within: c.query().where('paid', '==', false), limit: 2, includeRecord: true })
    expect(hits).toHaveLength(2)
    expect(hits.every(h => h.record !== undefined && h.record.paid === false)).toBe(true)
  })

  it('10. an empty text query with NO within still matches nothing', async () => {
    const c = await seed()
    expect(await c.retrieve('')).toEqual([])
  })

  it('11. an empty within set yields no hits — text query or not', async () => {
    const c = await seed()
    const q = () => c.query().where('qty', '>', 9999)
    expect(await c.retrieve('revenue', { within: q() })).toEqual([])
    expect(await c.retrieve('', { within: q() })).toEqual([])
  })

  it('12. typed-only works on a collection with NO textIndexes', async () => {
    const db = await createNoydb({
      store: toMemory(), user: 'u', secret: 'pw-1343-no-text',
      searchStrategy: withSearch(), indexingStrategy: withIndexing(),
    })
    const v = await db.openVault('v')
    const c = v.collection<{ id: string; qty: number }>('nums', {
      indexes: [{ fields: ['qty'], kind: 'sorted' }],
    })
    await c.put('n1', { id: 'n1', qty: 1 })
    await c.put('n2', { id: 'n2', qty: 50 })
    const hits = await c.retrieve('', { within: c.query().where('qty', '>', 10) })
    expect(ids(hits)).toEqual(['n2'])
  })
})
