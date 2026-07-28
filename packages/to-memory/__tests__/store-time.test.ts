import { describe, it, expect } from 'vitest'
import { toMemory } from '../src/index.js'

describe('toMemory() store clock', () => {
  it('advertises serverWriteTime and returns a monotonic non-decreasing interval', async () => {
    const s = toMemory()
    expect(s.capabilities?.serverWriteTime).toBe(true)
    const a = await s.getStoreTime!()
    const b = await s.getStoreTime!()
    expect(a.earliest).toBeLessThanOrEqual(a.latest)
    expect(b.earliest).toBeGreaterThanOrEqual(a.earliest) // monotonic
  })

  it('widens the interval by the configured uncertainty', async () => {
    const s = toMemory({ clockUncertaintyMs: 5 })
    const t = await s.getStoreTime!()
    expect(t.latest - t.earliest).toBe(10) // ±5
  })
})
