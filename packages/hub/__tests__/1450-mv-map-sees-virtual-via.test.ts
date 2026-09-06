/**
 * #1450 — a UNION MV arm's `map` receives virtual via fields, with correct
 * values. Decided ON RECORD, and pinned, because the consumer found it by
 * measurement: their suite had deliberately pinned the OLD behaviour (the map
 * saw the stored record only, so `r.virtTag` was `undefined` and every row
 * keyed on a fallback — a well-formed aggregate over a wrong key).
 *
 * It arrived with #1416, which moved presentation to `presentSync` on the
 * synchronous read path the executor drains through. It is intended: the
 * failure mode it removes is a confidently wrong number, silent by
 * construction. Without this test a later refactor of the read path could
 * take it away just as quietly as #1416 gave it.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, withMaterializedView } from '../src/index.js'
import { memoryStore } from '../src/kernel/memory-store.js'
import { count, withReduce } from '../src/with-lookup/reduce/index.js'

interface Item extends Record<string, unknown> { id: string; tag: string }
interface Row extends Record<string, unknown> { tag: string; n: number }

describe('#1450 — MV union map sees virtual via fields', () => {
  it('the map receives the virtual field with its computed value, per row', async () => {
    const seen: string[] = []
    const byTag = withMaterializedView<Row>({
      name: 'byTag',
      unionSources: [{
        collection: 'items',
        map: (r) => { seen.push(String(r.virtTag)); return { tag: (r.virtTag as string | undefined) ?? '<<undefined>>', n: 1 } },
      }],
      groupBy: 'tag',
      aggregate: { n: count() },
      rowKey: (row) => row.tag,
      refresh: 'eager',
    })
    const db = await createNoydb({
      store: memoryStore(), user: 'o', secret: 'issue-1450-virtual-via-in-mv-map',
      materializedViewStrategies: [byTag], reduceStrategy: withReduce(),
    })
    const vault = await db.openVault('V')
    const items = vault.collection<Item>('items', {
      computed: { virtTag: { fn: (r: Record<string, unknown>) => `T-${r.tag}`, mode: 'virtual', deps: ['tag'] } },
    } as never)
    await items.put('a', { id: 'a', tag: 'a' })
    await items.put('b', { id: 'b', tag: 'b' })

    // Read path control: the virtual field is presented on get().
    expect((await items.get('a'))?.virtTag).toBe('T-a')

    const out = await vault.collection<Row>('byTag').list()
    expect(out.map((r) => r.tag).sort()).toEqual(['T-a', 'T-b'])
    expect(out.find((r) => r.tag === '<<undefined>>')).toBeUndefined()
    // Every invocation saw a real value — never the stored-record-only view.
    expect(seen.every((v) => v.startsWith('T-'))).toBe(true)
  })
})
