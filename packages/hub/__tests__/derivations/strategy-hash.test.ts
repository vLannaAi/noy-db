import { describe, it, expect } from 'vitest'
import { computeStrategyHash } from '../../src/derivations/strategy-hash.js'

describe('computeStrategyHash', () => {
  it('returns identical hash for identical inputs', async () => {
    const fn = (s: { x: number }) => ({ out: { y: s.x + 1 } })
    const h1 = await computeStrategyHash('src', ['out'], fn)
    const h2 = await computeStrategyHash('src', ['out'], fn)
    expect(h1).toBe(h2)
  })

  it('changes when source name changes', async () => {
    const fn = (s: { x: number }) => ({ out: { y: s.x } })
    const a = await computeStrategyHash('src-a', ['out'], fn)
    const b = await computeStrategyHash('src-b', ['out'], fn)
    expect(a).not.toBe(b)
  })

  it('changes when output keys change', async () => {
    const fn = (_s: any) => ({} as any)
    const a = await computeStrategyHash('src', ['out1'], fn)
    const b = await computeStrategyHash('src', ['out1', 'out2'], fn)
    expect(a).not.toBe(b)
  })

  it('changes when derive function body changes', async () => {
    const a = await computeStrategyHash('src', ['out'], (s: any) => ({ out: { y: s.x + 1 } }))
    const b = await computeStrategyHash('src', ['out'], (s: any) => ({ out: { y: s.x + 2 } }))
    expect(a).not.toBe(b)
  })

  it('changes when declared sibling sources change (#344)', async () => {
    const fn = (s: { x: number }) => ({ out: { y: s.x } })
    const none = await computeStrategyHash('src', ['out'], fn)
    const withOne = await computeStrategyHash('src', ['out'], fn, ['sib'])
    const withTwo = await computeStrategyHash('src', ['out'], fn, ['sib', 'sib2'])
    expect(withOne).not.toBe(none)
    expect(withTwo).not.toBe(withOne)
  })

  it('is order-insensitive over declared sibling sources (#344)', async () => {
    const fn = (s: { x: number }) => ({ out: { y: s.x } })
    const a = await computeStrategyHash('src', ['out'], fn, ['a', 'b'])
    const b = await computeStrategyHash('src', ['out'], fn, ['b', 'a'])
    expect(a).toBe(b)
  })

  it('empty sources array is identical to omitting sources (#344)', async () => {
    const fn = (s: { x: number }) => ({ out: { y: s.x } })
    const omitted = await computeStrategyHash('src', ['out'], fn)
    const empty = await computeStrategyHash('src', ['out'], fn, [])
    expect(empty).toBe(omitted)
  })

  it('returns a hex string', async () => {
    const h = await computeStrategyHash('s', ['o'], () => ({ o: {} } as any))
    expect(h).toMatch(/^[0-9a-f]+$/)
  })
})
