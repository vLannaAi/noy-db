/**
 * `Query.traverse()` — bounded BFS over a declared self-referencing `ref()`
 * (#1352), plus the `ancestorsOf` / `descendantsOf` sugar.
 *
 * The properties that decide whether this is safe, and which each block
 * below pins:
 *
 *   - `maxDepth` is REQUIRED — an unbounded traversal is a denial of service
 *     against the consumer's own UI, and a silent default would truncate a
 *     result without saying so.
 *   - Cycles terminate. A 2-cycle, a self-cycle and a longer ring each get
 *     their own case, because they fail at different points in the walk
 *     (first hop / first hop / third hop).
 *   - A node is emitted ONCE, at its shallowest depth — so a diamond (two
 *     seeds converging on one ancestor) yields one row for the ancestor, not
 *     two. This is where naive BFS differs from what a reader expects.
 *   - `path` runs root → this node INCLUSIVE, so `path.length === depth + 1`
 *     for every row. Asserted as a property over the whole result, not on
 *     one row.
 *   - A dangling ref terminates that branch cleanly and never throws.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createNoydb, type Noydb } from '../src/kernel/noydb.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { ConflictError, TraversalCycleError } from '../src/kernel/errors.js'
import { Query } from '../src/kernel/query/index.js'
import type { TraversalRow } from '../src/kernel/query/index.js'
import { ref } from '../src/kernel/refs.js'

/** Inline memory adapter — same shape as the existing join tests. */
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
    async list(c, col) {
      const coll = store.get(c)?.get(col)
      return coll ? [...coll.keys()] : []
    },
    async loadAll(c) {
      const comp = store.get(c)
      const snapshot: VaultSnapshot = {}
      if (comp) for (const [n, coll] of comp) {
        if (!n.startsWith('_')) {
          const r: Record<string, EncryptedEnvelope> = {}
          for (const [id, e] of coll) r[id] = e
          snapshot[n] = r
        }
      }
      return snapshot
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

interface Person {
  id: string
  name: string
  parentId: string | null
}

interface Dept {
  id: string
  label: string
}

/**
 * The org chart every case below reads from:
 *
 *   a
 *   ├── b ── d, e
 *   └── c ── f
 *
 * Plus the deliberately broken corners: `orphan` (dangling parent),
 * `self` (points at itself), `p ↔ q` (2-cycle) and `r1 → r2 → r3 → r1`.
 * `warn` ref mode, because a strict ref cannot be written into a cycle —
 * the target does not exist yet at put time.
 */
async function seed(db: Noydb): Promise<void> {
  const v = await db.openVault('ORG')
  const people = v.collection<Person>('people', { refs: { parentId: ref('people', 'warn') } })
  const rows: Person[] = [
    { id: 'a', name: 'a', parentId: null },
    { id: 'b', name: 'b', parentId: 'a' },
    { id: 'c', name: 'c', parentId: 'a' },
    { id: 'd', name: 'd', parentId: 'b' },
    { id: 'e', name: 'e', parentId: 'b' },
    { id: 'f', name: 'f', parentId: 'c' },
    { id: 'orphan', name: 'orphan', parentId: 'ghost' },
    { id: 'self', name: 'self', parentId: 'self' },
    { id: 'p', name: 'p', parentId: 'q' },
    { id: 'q', name: 'q', parentId: 'p' },
    { id: 'r1', name: 'r1', parentId: 'r3' },
    { id: 'r2', name: 'r2', parentId: 'r1' },
    { id: 'r3', name: 'r3', parentId: 'r2' },
  ]
  for (const r of rows) await people.put(r.id, r)
}

async function peopleOf(db: Noydb) {
  const v = await db.openVault('ORG')
  return v.collection<Person>('people', { refs: { parentId: ref('people', 'warn') } })
}

function ids(rows: readonly TraversalRow<unknown>[]): string[] {
  return rows.map(r => r.id)
}

describe('Query.traverse() — bounded BFS over a declared self-ref (#1352)', () => {
  let db: Noydb

  beforeEach(async () => {
    db = await createNoydb({ store: toMemory(), user: 'owner', secret: 'traverse-secret-2026' })
    await seed(db)
  })

  // ─── up ────────────────────────────────────────────────────────────

  it('ancestorsOf() walks the parent chain, root last, seed at depth 0', async () => {
    const people = await peopleOf(db)
    const rows = people.query().ancestorsOf('d', 'parentId', { maxDepth: 10 }) as TraversalRow<Person>[]

    expect(ids(rows)).toEqual(['d', 'b', 'a'])
    expect(rows.map(r => r.depth)).toEqual([0, 1, 2])
    expect(rows.map(r => r.path)).toEqual([['d'], ['d', 'b'], ['d', 'b', 'a']])
    expect(rows[2]?.record.name).toBe('a')
  })

  it('path is root-inclusive: path.length === depth + 1 on every row', async () => {
    const people = await peopleOf(db)
    const up = people.query().ancestorsOf('d', 'parentId', { maxDepth: 10 }) as TraversalRow<Person>[]
    const down = people.query().descendantsOf('a', 'parentId', { maxDepth: 10 }) as TraversalRow<Person>[]
    for (const r of [...up, ...down]) {
      expect(r.path.length).toBe(r.depth + 1)
      expect(r.path[r.path.length - 1]).toBe(r.id)
    }
  })

  it('.traverse() seeds from the query — where() selects the roots, not the walk', async () => {
    const people = await peopleOf(db)
    const rows = people.query()
      .where('name', '==', 'd')
      .traverse('parentId', { direction: 'up', maxDepth: 10 }) as TraversalRow<Person>[]
    expect(ids(rows)).toEqual(['d', 'b', 'a'])
  })

  // ─── down ──────────────────────────────────────────────────────────

  it('descendantsOf() walks the reverse index breadth-first', async () => {
    const people = await peopleOf(db)
    const rows = people.query().descendantsOf('a', 'parentId', { maxDepth: 10 }) as TraversalRow<Person>[]

    expect(ids(rows).sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
    const byId = new Map(rows.map(r => [r.id, r.depth]))
    expect(byId.get('a')).toBe(0)
    expect(byId.get('b')).toBe(1)
    expect(byId.get('c')).toBe(1)
    expect(byId.get('d')).toBe(2)
    expect(byId.get('f')).toBe(2)
  })

  it('a leaf has no descendants beyond itself', async () => {
    const people = await peopleOf(db)
    const rows = people.query().descendantsOf('f', 'parentId', { maxDepth: 10 })
    expect(ids(rows)).toEqual(['f'])
  })

  // ─── maxDepth ──────────────────────────────────────────────────────

  it('maxDepth bounds the walk', async () => {
    const people = await peopleOf(db)
    const one = people.query().descendantsOf('a', 'parentId', { maxDepth: 1 })
    expect(ids(one).sort()).toEqual(['a', 'b', 'c'])

    const zero = people.query().descendantsOf('a', 'parentId', { maxDepth: 0 })
    expect(ids(zero)).toEqual(['a'])
  })

  it('maxDepth is required and must be a non-negative integer', async () => {
    const people = await peopleOf(db)
    expect(() => people.query().descendantsOf('a', 'parentId', { maxDepth: -1 })).toThrow(/maxDepth/)
    expect(() => people.query().descendantsOf('a', 'parentId', { maxDepth: 1.5 })).toThrow(/maxDepth/)
    expect(() =>
      people.query().traverse('parentId', { direction: 'up' } as unknown as {
        direction: 'up'
        maxDepth: number
      }),
    ).toThrow(/maxDepth/)
  })

  // ─── cycles ────────────────────────────────────────────────────────

  it('terminates on a self-cycle (a.parentId === a)', async () => {
    const people = await peopleOf(db)
    const rows = people.query().ancestorsOf('self', 'parentId', { maxDepth: 100 })
    expect(ids(rows)).toEqual(['self'])
  })

  it('terminates on a 2-cycle (p ↔ q)', async () => {
    const people = await peopleOf(db)
    expect(ids(people.query().ancestorsOf('p', 'parentId', { maxDepth: 100 }))).toEqual(['p', 'q'])
    expect(ids(people.query().descendantsOf('p', 'parentId', { maxDepth: 100 }))).toEqual(['p', 'q'])
  })

  it('terminates on a longer ring (r1 → r2 → r3 → r1)', async () => {
    const people = await peopleOf(db)
    const rows = people.query().ancestorsOf('r1', 'parentId', { maxDepth: 100 })
    expect(ids(rows)).toEqual(['r1', 'r3', 'r2'])
  })

  it('onCycle: "throw" refuses instead of stopping, naming the ring', async () => {
    const people = await peopleOf(db)
    let caught: unknown
    try {
      people.query().ancestorsOf('r1', 'parentId', { maxDepth: 100, onCycle: 'throw' })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(TraversalCycleError)
    const err = caught as TraversalCycleError
    expect(err.field).toBe('parentId')
    expect(err.cycle).toEqual(['r1', 'r3', 'r2', 'r1'])
    expect(err.message).toContain('r1')

    // The default is still "stop", so the same walk succeeds untouched.
    expect(ids(people.query().ancestorsOf('r1', 'parentId', { maxDepth: 100 }))).toHaveLength(3)
  })

  // ─── diamond ───────────────────────────────────────────────────────

  it('a diamond emits the shared ancestor ONCE, at its shallowest depth', async () => {
    const people = await peopleOf(db)
    // Seeds d and e are siblings; both reach b then a.
    const rows = people.query()
      .where('parentId', '==', 'b')
      .traverse('parentId', { direction: 'up', maxDepth: 10 }) as TraversalRow<Person>[]

    expect(ids(rows).sort()).toEqual(['a', 'b', 'd', 'e'])
    expect(rows.filter(r => r.id === 'b')).toHaveLength(1)
    expect(rows.filter(r => r.id === 'a')).toHaveLength(1)
    const byId = new Map(rows.map(r => [r.id, r]))
    expect(byId.get('b')?.depth).toBe(1)
    expect(byId.get('a')?.depth).toBe(2)
    // The surviving path is the branch that reached it first (seed order).
    expect(byId.get('a')?.path).toEqual(['d', 'b', 'a'])
  })

  // ─── dangling ──────────────────────────────────────────────────────

  it('a dangling parent ref terminates the branch cleanly, without throwing', async () => {
    const people = await peopleOf(db)
    const rows = people.query().ancestorsOf('orphan', 'parentId', { maxDepth: 10 })
    expect(ids(rows)).toEqual(['orphan'])
  })

  it('a dangling SEED id yields no rows rather than throwing', async () => {
    const people = await peopleOf(db)
    expect(people.query().ancestorsOf('ghost', 'parentId', { maxDepth: 10 })).toEqual([])
  })

  // ─── declared refs only ────────────────────────────────────────────

  it('refuses a field with no ref() declaration', async () => {
    const people = await peopleOf(db)
    expect(() =>
      people.query().traverse('name', { direction: 'up', maxDepth: 3 }),
    ).toThrow(/ref\(\)/)
  })

  it('refuses a ref that points at another collection — traversal is self-referencing', async () => {
    const v = await db.openVault('ORG')
    v.collection<Dept>('depts')
    const staff = v.collection<{ id: string; deptId: string }>('staff', {
      refs: { deptId: ref('depts', 'warn') },
    })
    expect(() =>
      staff.query().traverse('deptId', { direction: 'down', maxDepth: 3 }),
    ).toThrow(/self-referencing/)
  })

  it('refuses a Query with no join context (plain-object source)', () => {
    const q = new Query<Person>({ snapshot: (): readonly Person[] => [] })
    expect(() => q.traverse('parentId', { direction: 'up', maxDepth: 1 })).toThrow(/collection\.query\(\)/)
  })

  it('ancestorsOf()/descendantsOf() refuse a query that already carries clauses', async () => {
    const people = await peopleOf(db)
    expect(() =>
      people.query().where('name', '==', 'd').ancestorsOf('d', 'parentId', { maxDepth: 3 }),
    ).toThrow(/\.traverse\(/)
    expect(() =>
      people.query().limit(2).descendantsOf('a', 'parentId', { maxDepth: 3 }),
    ).toThrow(/\.traverse\(/)
  })
})
