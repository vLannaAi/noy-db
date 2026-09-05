/**
 * #1417 — `page()`/`after()` must stay a keyset walk, and the memo that makes
 * it one must never serve a stale order.
 *
 * The old path rebuilt an id map, re-matched, re-keyed and RE-SORTED the whole
 * collection on every page, then found the cursor by linear scan — four O(n)
 * passes per page, so a 100-page walk of a 10k collection paid ~100 full
 * sorts. Measured 4.4 ms/page against a 0.3 ms first page.
 *
 * ⛔ THE PERFORMANCE HALF IS THE EASY HALF. A memo over a mutable cache is a
 * stale-read bug wearing a speedup, and a stale keyset page is invisible: it
 * returns plausible rows in a plausible order. So most of this file is about
 * INVALIDATION, and the timing assertion at the end is deliberately loose —
 * it exists to catch the memo being removed, not to police milliseconds.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/kernel/noydb.js'
import { memoryStore } from '../src/kernel/memory-store.js'
import { GenerationMap } from '../src/kernel/generation-map.js'

interface Row { id: string; cycle: string; n: number }

const SECRET = 'issue-1417-keyset-memo-secret'

async function seed(count: number): Promise<{
  col: Awaited<ReturnType<typeof makeCol>>
}> {
  const col = await makeCol()
  for (let i = 0; i < count; i++) {
    await col.put(`r${String(i).padStart(3, '0')}`, {
      id: `r${String(i).padStart(3, '0')}`,
      cycle: `c${String(i % 7)}`,
      n: i,
    })
  }
  await col.list()
  return { col }
}

async function makeCol() {
  const db = await createNoydb({ store: memoryStore(), user: 'owner', secret: SECRET })
  const vault = await db.openVault('V')
  return vault.collection<Row>('rows')
}

/** Walk every page and return the ids in order. */
function walk(col: Awaited<ReturnType<typeof makeCol>>, size: number, order: 'asc' | 'desc' = 'asc'): string[] {
  const out: string[] = []
  let cursor: string | null = null
  let guard = 0
  do {
    const q = col.query().orderBy('cycle', order).limit(size)
    const p = (cursor === null ? q : q.after(cursor)).page()
    out.push(...p.rows.map(r => r.id))
    cursor = p.nextCursor
  } while (cursor !== null && ++guard < 1000)
  return out
}

describe('#1417 — the walk is still correct', () => {
  it('a paged walk visits every row exactly once, in the sorted order', async () => {
    const { col } = await seed(50)

    const paged = walk(col, 7)
    const whole = col.query().orderBy('cycle').toArray().map(r => r.id)

    expect(paged).toEqual(whole)
    expect(new Set(paged).size).toBe(50)
  })

  it('descending order pages independently of the ascending memo', async () => {
    const { col } = await seed(30)

    // Populate the asc entry first, then ask for desc: a key that ignored
    // direction would serve the ascending order back.
    const asc = walk(col, 5, 'asc')
    const desc = walk(col, 5, 'desc')

    expect(desc).not.toEqual(asc)
    expect(desc).toEqual(col.query().orderBy('cycle', 'desc').toArray().map(r => r.id))
  })

  it('a different orderBy field is a different memo entry', async () => {
    const { col } = await seed(30)

    walk(col, 5) // seed the memo on `cycle`
    const byN = col.query().orderBy('n').limit(30).page().rows.map(r => r.id)

    expect(byN).toEqual(col.query().orderBy('n').toArray().map(r => r.id))
  })
})

describe('#1417 — the memo cannot outlive the data it summarises', () => {
  it('a row INSERTED between pages is visible to the rest of the walk', async () => {
    const { col } = await seed(20)

    const first = col.query().orderBy('n').limit(5).page()
    expect(first.rows.map(r => r.id)).toEqual(['r000', 'r001', 'r002', 'r003', 'r004'])

    // Sorts into the middle of the remaining pages.
    await col.put('r007b', { id: 'r007b', cycle: 'c0', n: 7.5 })

    const rest: string[] = []
    let cursor = first.nextCursor
    while (cursor !== null) {
      const p = col.query().orderBy('n').limit(5).after(cursor).page()
      rest.push(...p.rows.map(r => r.id))
      cursor = p.nextCursor
    }

    expect(rest).toContain('r007b')
    expect(rest.indexOf('r007b')).toBe(rest.indexOf('r008') - 1)
  })

  it('a row DELETED between pages disappears from the rest of the walk', async () => {
    const { col } = await seed(20)

    const first = col.query().orderBy('n').limit(5).page()
    await col.delete('r010')

    const rest: string[] = []
    let cursor = first.nextCursor
    while (cursor !== null) {
      const p = col.query().orderBy('n').limit(5).after(cursor).page()
      rest.push(...p.rows.map(r => r.id))
      cursor = p.nextCursor
    }

    expect(rest).not.toContain('r010')
    expect([...first.rows.map(r => r.id), ...rest]).toHaveLength(19)
  })

  it('deleting the CURSOR ROW itself still pages from the right place', async () => {
    // The case an offset cannot survive, and the one a bisect has to get
    // right: the cursor names a position, not a row, so the row may be gone.
    const { col } = await seed(20)

    const first = col.query().orderBy('n').limit(5).page()
    const cursorRow = first.rows[first.rows.length - 1]!
    expect(cursorRow.id).toBe('r004')
    await col.delete('r004')

    const next = col.query().orderBy('n').limit(5).after(first.nextCursor!).page()
    expect(next.rows.map(r => r.id)).toEqual(['r005', 'r006', 'r007', 'r008', 'r009'])
  })

  it('an UPDATE that changes the sort key re-orders the rest of the walk', async () => {
    const { col } = await seed(20)

    const first = col.query().orderBy('n').limit(5).page()
    // Move a late row to just after the cursor.
    await col.put('r019', { id: 'r019', cycle: 'c0', n: 5.5 })

    const next = col.query().orderBy('n').limit(5).after(first.nextCursor!).page()
    expect(next.rows.map(r => r.id)).toEqual(['r005', 'r019', 'r006', 'r007', 'r008'])
  })
})

describe('#1417 — clause-bearing pages', () => {
  it('a where() page walk agrees with the unpaged answer', async () => {
    const { col } = await seed(40)

    const out: string[] = []
    let cursor: string | null = null
    do {
      const q = col.query().where('cycle', '==', 'c3').orderBy('n').limit(3)
      const p = (cursor === null ? q : q.after(cursor)).page()
      out.push(...p.rows.map(r => r.id))
      cursor = p.nextCursor
    } while (cursor !== null)

    expect(out).toEqual(col.query().where('cycle', '==', 'c3').orderBy('n').toArray().map(r => r.id))
    expect(out.length).toBeGreaterThan(0)
  })

  it('two different where() operands do not share a memo entry', async () => {
    const { col } = await seed(40)

    const c3 = col.query().where('cycle', '==', 'c3').orderBy('n').limit(50).page().rows.map(r => r.id)
    const c5 = col.query().where('cycle', '==', 'c5').orderBy('n').limit(50).page().rows.map(r => r.id)

    expect(c3.length).toBeGreaterThan(0)
    expect(c5.length).toBeGreaterThan(0)
    expect(new Set([...c3, ...c5]).size).toBe(c3.length + c5.length)
  })

  it('a callback filter() declines the memo and still pages correctly', async () => {
    // `filter()` closes over a function whose identity the fingerprint cannot
    // see, so `keysetMemoKey` returns null and the old path runs. Correctness
    // is the whole assertion — declining is the safe answer.
    const { col } = await seed(30)

    const out: string[] = []
    let cursor: string | null = null
    do {
      const q = col.query().filter(r => r.n % 2 === 0).orderBy('n').limit(4)
      const p = (cursor === null ? q : q.after(cursor)).page()
      out.push(...p.rows.map(r => r.id))
      cursor = p.nextCursor
    } while (cursor !== null)

    expect(out).toEqual(col.query().filter(r => r.n % 2 === 0).orderBy('n').toArray().map(r => r.id))
    expect(out).toHaveLength(15)
  })
})

describe('#1417 — GenerationMap is the invalidation mechanism', () => {
  it('stamps every mutation route, and only mutations', () => {
    const m = new GenerationMap<string, number>()
    const seen: number[] = [m.generation]
    const stamp = (): void => { seen.push(m.generation) }

    m.set('a', 1); stamp()
    // A redundant set still bumps — a spurious invalidation costs one
    // recompute; a missed one costs correctness.
    m.set('a', 1); stamp()
    m.delete('a'); stamp()
    // Removing an absent key bumps too: cheaper than proving it did nothing.
    m.delete('nope'); stamp()
    m.clear(); stamp()

    // Strictly increasing — the assertion is the ORDER, not the values, which
    // are drawn from a process-wide tick.
    for (let i = 1; i < seen.length; i++) expect(seen[i]!).toBeGreaterThan(seen[i - 1]!)

    // Reads do not move it.
    const before = m.generation
    m.get('a'); m.has('a'); [...m.entries()]; void m.size
    expect(m.generation).toBe(before)
  })

  it('stamps are unique ACROSS instances — two same-named collections cannot share a memo key', () => {
    // The bug this caught: the memo keyed on `<vault>/<collection>` plus a
    // per-instance count, so a rebuilt collection with the same name and the
    // same write count read the previous instance's page order back.
    const a = new GenerationMap<string, number>()
    const b = new GenerationMap<string, number>()

    a.set('x', 1)
    b.set('x', 1)

    expect(a.generation).not.toBe(b.generation)
  })

  it('behaves as a Map in every other respect', () => {
    const m = new GenerationMap<string, number>([['a', 1], ['b', 2]])
    expect(m.size).toBe(2)
    expect(m.get('b')).toBe(2)
    expect([...m.keys()]).toEqual(['a', 'b'])
    expect(m instanceof Map).toBe(true)
  })
})

describe('#1417 — the walk is no longer linear in the collection', () => {
  it('paging 2000 rows costs far less than one sort per page', async () => {
    const { col } = await seed(2000)

    const t0 = performance.now()
    const ids = walk(col, 50)
    const perPage = (performance.now() - t0) / (ids.length / 50)

    expect(ids).toHaveLength(2000)
    // Before the memo this was ~1 ms/page at this size and grew with the
    // collection. The bound is deliberately generous — a loaded CI box is
    // slow, and the point is the ORDER of the cost, not its value.
    expect(perPage).toBeLessThan(0.5)
  })
})
