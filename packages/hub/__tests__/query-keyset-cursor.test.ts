/**
 * Query keyset cursor pagination — `.after(cursor)` + `.page()` (#1346).
 *
 * The properties that matter, and why each is here:
 *  - a cursor round-trips (opaque string in, same keyset out);
 *  - paging N records in pages of k yields every record exactly once —
 *    no gaps, no duplicates;
 *  - a record inserted or deleted mid-pagination does not shift the
 *    window (this is the whole point versus `offset()`);
 *  - a cursor minted for a different sort order, or a different
 *    collection, is REFUSED with an actionable error instead of
 *    silently returning nonsense.
 */
import { describe, it, expect } from 'vitest'
import { Query } from '../src/kernel/query/builder.js'
import type { QuerySource } from '../src/kernel/query/index.js'
import { createNoydb, memoryStore } from '../src/index.js'

interface Row { name: string; score: number }

/**
 * A mutable collection-shaped source: `entries` is the live backing array,
 * so a test can insert or delete between pages the way a concurrent writer
 * would.
 */
function mutableSource(
  identity: string,
  entries: { id: string; record: Row }[],
): QuerySource<Row> {
  return {
    snapshot: () => entries.map(e => e.record),
    snapshotEntries: () => entries,
    identity,
  }
}

function rows(...names: string[]): { id: string; record: Row }[] {
  return names.map((name, i) => ({ id: `id${i}`, record: { name, score: i } }))
}

describe('Query.page() / Query.after() — keyset cursor', () => {
  it('returns a page plus an opaque cursor, and null on the last page', () => {
    const entries = rows('a', 'b', 'c')
    const q = new Query<Row>(mutableSource('v/people', entries)).orderBy('name').limit(2)

    const first = q.page()
    expect(first.rows.map(r => r.name)).toEqual(['a', 'b'])
    expect(typeof first.nextCursor).toBe('string')
    // Opaque: an encoded token, not readable JSON and not the raw keyset.
    expect(() => JSON.parse(first.nextCursor as string)).toThrow()
    expect(first.nextCursor).not.toContain('"')
    expect(first.nextCursor).not.toContain('id1')

    const second = q.after(first.nextCursor as string).page()
    expect(second.rows.map(r => r.name)).toEqual(['c'])
    expect(second.nextCursor).toBeNull()
  })

  it('round-trips a cursor: the same cursor always resumes at the same row', () => {
    const entries = rows('a', 'b', 'c', 'd')
    const q = new Query<Row>(mutableSource('v/people', entries)).orderBy('name').limit(2)
    const cursor = q.page().nextCursor as string

    const once = q.after(cursor).page().rows.map(r => r.name)
    const twice = q.after(cursor).page().rows.map(r => r.name)
    expect(once).toEqual(['c', 'd'])
    expect(twice).toEqual(once)
  })

  it('pages through N records in pages of k exactly once — no gaps, no duplicates', () => {
    const names = Array.from({ length: 23 }, (_, i) => `n${String(i).padStart(2, '0')}`)
    const entries = rows(...names)
    const q = new Query<Row>(mutableSource('v/people', entries)).orderBy('name').limit(5)

    const seen: string[] = []
    let cursor: string | null = null
    for (let guard = 0; guard < 20; guard++) {
      const page: { rows: Row[]; nextCursor: string | null } =
        cursor === null ? q.page() : q.after(cursor).page()
      seen.push(...page.rows.map(r => r.name))
      cursor = page.nextCursor
      if (cursor === null) break
    }
    expect(cursor).toBeNull()
    expect(seen).toEqual(names)
    expect(new Set(seen).size).toBe(names.length)
  })

  it('pages stably in descending order too', () => {
    const entries = rows('a', 'b', 'c', 'd')
    const q = new Query<Row>(mutableSource('v/people', entries)).orderBy('name', 'desc').limit(2)
    const first = q.page()
    expect(first.rows.map(r => r.name)).toEqual(['d', 'c'])
    expect(q.after(first.nextCursor as string).page().rows.map(r => r.name)).toEqual(['b', 'a'])
  })

  it('ties on the sort key still page exactly once (the id is the tiebreak)', () => {
    const entries = [
      { id: 'i1', record: { name: 'same', score: 1 } },
      { id: 'i2', record: { name: 'same', score: 2 } },
      { id: 'i3', record: { name: 'same', score: 3 } },
    ]
    const q = new Query<Row>(mutableSource('v/people', entries)).orderBy('name').limit(1)
    const seen: number[] = []
    let cursor: string | null = null
    for (let guard = 0; guard < 5; guard++) {
      const page: { rows: Row[]; nextCursor: string | null } =
        cursor === null ? q.page() : q.after(cursor).page()
      seen.push(...page.rows.map(r => r.score))
      cursor = page.nextCursor
      if (cursor === null) break
    }
    expect(seen.sort()).toEqual([1, 2, 3])
  })

  it('a record INSERTED before the cursor does not shift the window (offset would)', () => {
    const entries = rows('b', 'd', 'f', 'h')
    const source = mutableSource('v/people', entries)
    const q = new Query<Row>(source).orderBy('name').limit(2)

    const first = q.page()
    expect(first.rows.map(r => r.name)).toEqual(['b', 'd'])

    // A concurrent writer inserts a record that sorts BEFORE the cursor.
    entries.unshift({ id: 'ins', record: { name: 'a', score: 99 } })

    // offset(2) would now re-serve 'd'; the keyset resumes strictly after it.
    expect(q.offset(2).toArray().map(r => r.name)).toEqual(['d', 'f'])
    expect(q.after(first.nextCursor as string).page().rows.map(r => r.name)).toEqual(['f', 'h'])
  })

  it('a record DELETED before the cursor does not shift the window, even the cursor row itself', () => {
    const entries = rows('a', 'b', 'c', 'd')
    const source = mutableSource('v/people', entries)
    const q = new Query<Row>(source).orderBy('name').limit(2)

    const first = q.page()
    expect(first.rows.map(r => r.name)).toEqual(['a', 'b'])

    // Delete both already-served rows, including the one the cursor names.
    entries.splice(0, 2)

    // offset(2) would skip past 'c' and 'd' entirely; the keyset does not.
    expect(q.offset(2).toArray()).toEqual([])
    expect(q.after(first.nextCursor as string).page().rows.map(r => r.name)).toEqual(['c', 'd'])
  })

  it('toArray() keeps its signature and honours an applied cursor', () => {
    const entries = rows('a', 'b', 'c')
    const q = new Query<Row>(mutableSource('v/people', entries)).orderBy('name').limit(2)
    const cursor = q.page().nextCursor as string
    const arr: Row[] = q.after(cursor).toArray()
    expect(arr.map(r => r.name)).toEqual(['c'])
    const one: Row | null = q.after(cursor).first()
    expect(one?.name).toBe('c')
  })

  it('respects the where clauses when paging', () => {
    const entries = rows('a', 'b', 'c', 'd', 'e')
    const q = new Query<Row>(mutableSource('v/people', entries))
      .where('score', '>=', 1)
      .orderBy('name')
      .limit(2)
    const first = q.page()
    expect(first.rows.map(r => r.name)).toEqual(['b', 'c'])
    expect(q.after(first.nextCursor as string).page().rows.map(r => r.name)).toEqual(['d', 'e'])
  })
})

describe('Query keyset cursor — refusals', () => {
  const entries = rows('a', 'b', 'c')

  function cursorFor(identity: string, field: 'name' | 'score', dir: 'asc' | 'desc' = 'asc'): string {
    return new Query<Row>(mutableSource(identity, entries)).orderBy(field, dir).limit(1).page()
      .nextCursor as string
  }

  it('refuses a cursor minted for a different sort ORDER', () => {
    const cursor = cursorFor('v/people', 'name')
    const other = new Query<Row>(mutableSource('v/people', entries)).orderBy('score').limit(1)
    expect(() => other.after(cursor).page()).toThrow(/different query shape/i)
  })

  it('refuses a cursor minted for the same field in the other DIRECTION', () => {
    const cursor = cursorFor('v/people', 'name', 'asc')
    const other = new Query<Row>(mutableSource('v/people', entries)).orderBy('name', 'desc').limit(1)
    expect(() => other.after(cursor).page()).toThrow(/different query shape/i)
  })

  it('refuses a cursor minted for a different COLLECTION', () => {
    const cursor = cursorFor('v/people', 'name')
    const other = new Query<Row>(mutableSource('v/pets', entries)).orderBy('name').limit(1)
    expect(() => other.after(cursor).page()).toThrow(/different query shape/i)
  })

  it('refuses a malformed cursor', () => {
    const q = new Query<Row>(mutableSource('v/people', entries)).orderBy('name').limit(1)
    expect(() => q.after('not-a-cursor').page()).toThrow(/not a valid keyset cursor/i)
    expect(() => q.after('').page()).toThrow(/non-empty string/i)
  })

  it('refuses keyset pagination with no orderBy', () => {
    const q = new Query<Row>(mutableSource('v/people', entries)).limit(1)
    expect(() => q.page()).toThrow(/requires at least one orderBy/i)
  })

  it('refuses keyset pagination on a source with no id-paired snapshot', () => {
    const q = new Query<Row>({ snapshot: () => entries.map(e => e.record) }).orderBy('name').limit(1)
    expect(() => q.page()).toThrow(/snapshotEntries/i)
  })

  it('refuses to mix offset() with keyset pagination', () => {
    const q = new Query<Row>(mutableSource('v/people', entries)).orderBy('name').limit(1).offset(1)
    expect(() => q.page()).toThrow(/offset\(\).*cursor|cursor.*offset\(\)/i)
  })
})

describe('Query keyset cursor — through a real collection', () => {
  it('pages a live collection, and a cursor from a sibling collection is refused', async () => {
    const store = memoryStore()
    const db = await createNoydb({ store, user: 'owner', secret: 'pw' })
    const vault = await db.openVault('v')
    const people = vault.collection<Row>('people')
    const pets = vault.collection<Row>('pets')
    for (const [i, name] of ['a', 'b', 'c', 'd', 'e'].entries()) {
      await people.put(`p${i}`, { name, score: i })
      await pets.put(`q${i}`, { name, score: i })
    }

    const q = people.query().orderBy('name').limit(2)
    const first = q.page()
    expect(first.rows.map(r => r.name)).toEqual(['a', 'b'])
    const second = q.after(first.nextCursor as string).page()
    expect(second.rows.map(r => r.name)).toEqual(['c', 'd'])
    const third = q.after(second.nextCursor as string).page()
    expect(third.rows.map(r => r.name)).toEqual(['e'])
    expect(third.nextCursor).toBeNull()

    expect(() =>
      pets.query().orderBy('name').limit(2).after(first.nextCursor as string).page(),
    ).toThrow(/different query shape/i)
  })
})
