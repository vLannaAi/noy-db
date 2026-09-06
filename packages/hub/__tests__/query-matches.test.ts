/**
 * #1357 — `where(field, 'matches', /re/ | 'LIKE-string')`.
 *
 * The whole risk of this operator is the LOWERING: an anchored literal
 * prefix is rewritten to `startsWith` so it takes the #1344 sorted index.
 * A wrong lowering returns wrong rows SILENTLY, so every lowering case
 * below asserts the lowered result equals the pattern evaluated by hand
 * over the same records — not merely that it is non-empty.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createNoydb } from '../src/kernel/noydb.js'
import { withIndexing } from '../src/with-lookup/indexing/index.js'
import { UnsafePatternError } from '../src/kernel/errors.js'
import { canonicalizeQueryPlan } from '../src/with-formula/materialized-views/query-hash.js'
import type { Noydb } from '../src/kernel/noydb.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { ConflictError } from '../src/kernel/errors.js'
// #1458 — the query DSL ships in four groups; these side-effect imports
// attach the extension methods this file exercises. A consumer on the root
// barrel needs none of them (it imports all three); this file builds its
// Query from `kernel/query` directly, so it takes what it uses.
import '../src/kernel/query/relate/index.js'

/** Inline memory adapter — same pattern as `query-sorted-indexes.test.ts`. */
function toMemory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function getCollection(c: string, col: string): Map<string, EncryptedEnvelope> {
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
      if (existing) for (const [name, coll] of existing) if (name.startsWith('_')) comp.set(name, coll)
      store.set(c, comp)
    },
  }
}

interface Doc {
  id: string
  client: string
  note: string
  amount: number
}

/**
 * `client` deliberately mixes case and shares prefixes so a
 * case-insensitive pattern and a case-sensitive one disagree — that
 * disagreement is what proves the `i` flag must not lower.
 */
const records: Doc[] = [
  { id: 'r0', client: 'Client-A', note: '100% done', amount: 1 },
  { id: 'r1', client: 'Client-B', note: 'ab_cd', amount: 2 },
  { id: 'r2', client: 'Client-BB', note: 'abxcd', amount: 3 },
  { id: 'r3', client: 'client-b', note: 'nothing', amount: 4 },
  { id: 'r4', client: 'Clientele', note: '50% off', amount: 5 },
  { id: 'r5', client: 'Acme', note: 'plain', amount: 6 },
]

describe('#1357 where(field, "matches", …)', () => {
  let indexed: ReturnType<Awaited<ReturnType<typeof setup>>['pick']>
  let plain: ReturnType<Awaited<ReturnType<typeof setup>>['pick']>

  async function setup() {
    const db: Noydb = await createNoydb({
      store: toMemory(),
      user: 'owner',
      secret: 'matches-operator-test-secret-2026',
      indexingStrategy: withIndexing(),
    })
    const vault = await db.openVault('TEST')
    const withIdx = vault.collection<Doc>('indexed', {
      indexes: [{ fields: ['client'], kind: 'sorted' }, { fields: ['note'], kind: 'sorted' }],
    })
    const noIdx = vault.collection<Doc>('plain')
    for (const r of records) {
      await withIdx.put(r.id, r)
      await noIdx.put(r.id, r)
    }
    return { pick: (which: 'indexed' | 'plain') => (which === 'indexed' ? withIdx : noIdx) }
  }

  beforeEach(async () => {
    const s = await setup()
    indexed = s.pick('indexed')
    plain = s.pick('plain')
  })

  const ids = (rows: readonly Doc[]): string[] => rows.map(r => r.id).sort()
  const byHand = (fn: (d: Doc) => boolean): string[] => records.filter(fn).map(r => r.id).sort()
  /** `toPlan()` is deliberately `unknown` — narrow it once, here. */
  const clause0 = (plan: unknown): unknown => (plan as { clauses: unknown[] }).clauses[0]

  // ─── lowering ────────────────────────────────────────────────

  it('1. an anchored literal prefix lowers to startsWith', () => {
    const plan = plain.query().where('client', 'matches', /^Client-B/).toPlan()
    expect(clause0(plan)).toMatchObject({ type: 'field', field: 'client', op: 'startsWith', value: 'Client-B' })
  })

  it('2. LOWERED == SCANNED == the pattern applied by hand', () => {
    const want = byHand(d => /^Client-B/.test(d.client))
    expect(want).toEqual(['r1', 'r2'])
    expect(ids(indexed.query().where('client', 'matches', /^Client-B/).toArray())).toEqual(want)
    expect(ids(plain.query().where('client', 'matches', /^Client-B/).toArray())).toEqual(want)
    // and the un-lowered spelling of the same predicate agrees
    expect(ids(plain.query().where('client', 'matches', /^Client-B[\s\S]*$/).toArray())).toEqual(want)
    expect(ids(plain.query().filter(d => /^Client-B/.test(d.client)).toArray())).toEqual(want)
  })

  it('3. a case-insensitive anchored pattern does NOT lower, and its rows differ', () => {
    const plan = plain.query().where('client', 'matches', /^client-b/i).toPlan()
    expect(clause0(plan)).toMatchObject({ op: 'matches', value: { source: '^client-b', flags: 'i' } })
    const want = byHand(d => /^client-b/i.test(d.client))
    expect(want).toEqual(['r1', 'r2', 'r3'])
    expect(ids(indexed.query().where('client', 'matches', /^client-b/i).toArray())).toEqual(want)
    expect(ids(plain.query().where('client', 'matches', /^client-b/i).toArray())).toEqual(want)
    // the case-SENSITIVE lowering would have been wrong here
    expect(want).not.toEqual(byHand(d => d.client.startsWith('client-b')))
  })

  it('4. an unanchored or metacharacter-bearing pattern does NOT lower', () => {
    for (const re of [/Client-B/, /^Client-[AB]/, /^Client.B/, /^Client-B$/, /^(a|b)/]) {
      expect(clause0(plain.query().where('client', 'matches', re).toPlan())).toMatchObject({ op: 'matches' })
    }
  })

  // ─── LIKE strings ────────────────────────────────────────────

  it('5. LIKE: % is any run, _ is one char, and the pattern is fully anchored', () => {
    expect(ids(plain.query().where('note', 'matches', 'ab_cd').toArray())).toEqual(['r1', 'r2'])
    expect(ids(plain.query().where('client', 'matches', 'Client%').toArray())).toEqual(byHand(d => d.client.startsWith('Client')))
    expect(ids(plain.query().where('client', 'matches', 'Client').toArray())).toEqual([]) // anchored: no partial match
    expect(ids(plain.query().where('note', 'matches', '%done').toArray())).toEqual(['r0'])
  })

  it('6. LIKE: a trailing-% literal prefix lowers to startsWith and agrees with the scan', () => {
    expect(clause0(plain.query().where('client', 'matches', 'Client-B%').toPlan()))
      .toMatchObject({ op: 'startsWith', value: 'Client-B' })
    const want = byHand(d => d.client.startsWith('Client-B'))
    expect(ids(indexed.query().where('client', 'matches', 'Client-B%').toArray())).toEqual(want)
    expect(ids(plain.query().where('client', 'matches', 'Client-B%').toArray())).toEqual(want)
  })

  it('7. LIKE: a backslash escapes % and _ into literals', () => {
    expect(ids(plain.query().where('note', 'matches', '100\\% done').toArray())).toEqual(['r0'])
    expect(ids(plain.query().where('note', 'matches', 'ab\\_cd').toArray())).toEqual(['r1'])
    expect(ids(plain.query().where('note', 'matches', '%\\%%').toArray())).toEqual(['r0', 'r4'])
  })

  it('8. a non-string field value never matches, on either path', () => {
    expect(plain.query().where('amount', 'matches', /^1/).toArray()).toEqual([])
    expect(indexed.query().where('amount', 'matches', /^1/).toArray()).toEqual([])
    expect(plain.query().where('amount', 'matches', '1%').toArray()).toEqual([])
    expect(plain.query().where('missing', 'matches', /^x/).toArray()).toEqual([])
  })

  // ─── queryHash ───────────────────────────────────────────────

  it('9. queryHash: identical patterns canonicalize identically; flags change it', () => {
    const h = (v: RegExp): string => canonicalizeQueryPlan(plain.query().where('note', 'matches', v).toPlan())
    expect(h(/a.c/)).toBe(h(/a.c/))
    expect(h(/a.c/)).not.toBe(h(/a.c/i))
    expect(h(/a.c/)).not.toBe(h(/a.d/))
    // a bare RegExp would canonicalize to `{}` — source+flags must be visible
    expect(h(/a.c/)).toContain('a.c')
  })

  // ─── ReDoS budget ────────────────────────────────────────────

  it('10. the ReDoS budget refuses loudly', () => {
    const bad: [unknown, RegExp][] = [
      [new RegExp(`^${'a'.repeat(250)}b+`), /budget|characters/],
      [/(a+)+$/, /nested quantifier/],
      [/((((((x))))))/, /nesting/],
      [new RegExp('a?'.repeat(25)), /quantifier/],
      [/abc/g, /flag/],
      [/abc/y, /flag/],
      [42, /RegExp or a LIKE string/],
    ]
    for (const [operand, message] of bad) {
      expect(() => plain.query().where('note', 'matches', operand)).toThrow(UnsafePatternError)
      expect(() => plain.query().where('note', 'matches', operand)).toThrow(message)
    }
  })

  // ─── explain() ───────────────────────────────────────────────

  it('11. explain() shows the lowering as the clause operator', () => {
    expect(indexed.query().where('client', 'matches', /^Client-B/).explain().text).toContain('client startsWith')
    expect(indexed.query().where('client', 'matches', /^client-b/i).explain().text).toContain('client matches')
  })
})
