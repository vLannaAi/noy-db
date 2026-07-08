import { describe, it, expect } from 'vitest'
import { SatelliteRegistry } from '../src/with-shape/satellites/registry.js'

const spec = { base: 'msgs', satellite: 'msgs_text', fields: ['body'] as const, joined: 'msgs_full' }

describe('SatelliteRegistry', () => {
  it('registers a pair and resolves by base, satellite, and joined name', () => {
    const r = new SatelliteRegistry()
    r.register(spec)
    expect(r.satelliteOf('msgs')?.satellite).toBe('msgs_text')
    expect(r.bySatellite('msgs_text')?.base).toBe('msgs')
    expect(r.byJoined('msgs_full')?.base).toBe('msgs')
    expect(r.isPairMember('msgs')).toBe(true)
  })

  it('R-S1(v1): refuses a second satellite on the same base', () => {
    const r = new SatelliteRegistry()
    r.register(spec)
    expect(() => r.register({ base: 'msgs', satellite: 'msgs_att', fields: ['att'] })).toThrowError(/R-S1/)
  })

  it('R-S3: refuses registering a spec whose satellite name is already registered as a base (order-inverted chain)', () => {
    const r = new SatelliteRegistry()
    r.register({ base: 'msgs_text', satellite: 'deep', fields: ['x'] }) // msgs_text is a BASE here
    expect(() => r.register({ base: 'msgs', satellite: 'msgs_text', fields: ['body'] })) // now claimed as a satellite too
      .toThrowError(/R-S3/)
  })

  it('R-S5: refuses a joined name that collides with any registered collection role', () => {
    const r = new SatelliteRegistry()
    r.register(spec)
    expect(() => r.register({ base: 'docs', satellite: 'docs_body', fields: ['b'], joined: 'msgs_text' }))
      .toThrowError(/R-S5/)
  })

  it('poison → assertNotPoisoned throws with the recorded reason', () => {
    const r = new SatelliteRegistry()
    r.register(spec)
    r.poison('msgs_text', 'R-S1: fields overlap base schema field "subject"')
    expect(() => r.assertNotPoisoned('msgs_text')).toThrowError(/R-S1.*subject/)
  })

  it('withPairLock serializes concurrent sections per base', async () => {
    const r = new SatelliteRegistry()
    r.register(spec)
    const order: number[] = []
    await Promise.all([
      r.withPairLock('msgs', async () => { order.push(1); await new Promise(res => setTimeout(res, 20)); order.push(2) }),
      r.withPairLock('msgs', async () => { order.push(3) }),
    ])
    expect(order).toEqual([1, 2, 3])
  })

  it('expandNames adds satellites of named bases (and vice versa) without duplicates', () => {
    const r = new SatelliteRegistry()
    r.register(spec)
    expect(r.expandNames(['msgs', 'other']).sort()).toEqual(['msgs', 'msgs_text', 'other'])
    expect(r.expandNames(['msgs_text']).sort()).toEqual(['msgs', 'msgs_text'])
  })
})
