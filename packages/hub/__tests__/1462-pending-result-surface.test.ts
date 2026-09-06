/**
 * #1462 — what a pending result does under EVERY use, enumerated.
 *
 * #1414 made a terminal on an unhydrated collection return a pending result
 * rather than a confident `[]`, and its docstring said the result "throws
 * {@link CollectionNotHydratedError} on **any other use**". Measured by
 * pilot-1, that was true of every access that reads content and false of the
 * type check — and the type check is the one that matters, because
 * `toArray()` is declared `T[]` and this is the defensive shape for a `T[]`:
 *
 * ```ts
 * const rows = coll.query().toArray()
 * const safe = Array.isArray(rows) ? rows : []   // → [] on a cold collection
 * ```
 *
 * ⛔ **That is #1414's silent empty read, restored — and harder to find,
 * because the code now looks like it handles the edge case.**
 *
 * ⭐ **The fix was one line, and the reason it was not obvious is worth
 * keeping.** The report assumed `Array.isArray` returning `true` "needs a real
 * array exotic object and would defeat the throw-on-read design". It does not:
 * `IsArray` unwraps a Proxy to its TARGET, so a proxy over `[]` answers `true`
 * while every trap still fires. The design was never in tension with the type
 * check; only the target was wrong.
 *
 * This file is the enumeration itself. It exists because a probe written
 * against "any other use" PASSES VACUOUSLY — the phrase names no specific use,
 * so nothing can contradict it. Only a table can.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, CollectionNotHydratedError } from '../src/index.js'
import { memoryStore } from '../src/kernel/memory-store.js'
import type { NoydbStore } from '../src/kernel/types.js'

interface Row extends Record<string, unknown> { id: string }

const SECRET = 'issue-1462-pending-result-secret-value'

/** A second Noydb over the same store: its collections have never been read. */
async function coldCollection(store: NoydbStore) {
  const warm = await createNoydb({ store, user: 'u', secret: SECRET })
  await (await warm.openVault('t')).collection<Row>('c').put('r1', { id: 'r1' })

  const cold = await createNoydb({ store, user: 'u', secret: SECRET })
  return (await cold.openVault('t')).collection<Row>('c')
}

describe('#1462 — the type check no longer lies', () => {
  it('⛔ Array.isArray is TRUE, so the idiomatic guard reaches the throwing path', async () => {
    const coll = await coldCollection(memoryStore())
    const rows = coll.query().toArray()

    expect(Array.isArray(rows)).toBe(true)
    // …and the guard's happy branch, which used to be skipped for `[]`, now
    // throws on first use instead of serving a confident empty result.
    const safe = Array.isArray(rows) ? rows : []
    expect(() => safe.length).toThrow(CollectionNotHydratedError)
  })

  it('still awaits to the real rows — the fix must not have made it inert', async () => {
    const coll = await coldCollection(memoryStore())
    expect((await coll.query().toArray()).length).toBe(1)
  })
})

describe('#1462 — every content access still throws (the #1414 contract)', () => {
  const ACCESSES: readonly (readonly [string, (r: Row[]) => unknown])[] = [
    ['.length', (r) => r.length],
    ['index', (r) => r[0]],
    ['spread', (r) => [...r]],
    ['for..of', (r) => { for (const _x of r) void _x; return 0 }],
    ['.map()', (r) => r.map((x) => x)],
    ['JSON.stringify', (r) => JSON.stringify(r)],
    ['String()', (r) => String(r)],
    ['in', (r) => '0' in (r as unknown as object)],
    ['Object.keys', (r) => Object.keys(r as unknown as object)],
  ]

  for (const [name, use] of ACCESSES) {
    it(`${name} throws CollectionNotHydratedError`, async () => {
      const coll = await coldCollection(memoryStore())
      const rows = coll.query().toArray()
      expect(() => use(rows)).toThrow(CollectionNotHydratedError)
    })
  }
})

describe('#1462 — the two uses that stay silent, named rather than implied', () => {
  /**
   * ⚠️ These CANNOT be made to throw: neither reaches a proxy trap. `typeof`
   * is answered from the object's type alone, and truthiness from the fact
   * that an object is truthy. Pinning them is the honest half of the
   * docstring: the boundary is stated, not moved, so a consumer who
   * calibrates against the prose is calibrating against something true.
   */
  it('typeof is "object" and the value is truthy, with no throw', async () => {
    const coll = await coldCollection(memoryStore())
    const rows = coll.query().toArray()
    expect(typeof rows).toBe('object')
    expect(Boolean(rows)).toBe(true)
  })

  it('the docstring enumerates exactly those, and no longer claims "any other use"', async () => {
    // The doc is what a consumer trusts — pilot-1 filed this because a probe
    // written against the old phrasing passed vacuously. So the phrasing is
    // itself under test.
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const src = readFileSync(fileURLToPath(new URL('../src/kernel/query/hydration.ts', import.meta.url)), 'utf8')
    expect(src).not.toMatch(/on \*\*any other use\*\*/)
    expect(src).toMatch(/typeof/)
    expect(src).toMatch(/truthiness/)
    expect(src).toMatch(/Array\.isArray/)
  })
})
