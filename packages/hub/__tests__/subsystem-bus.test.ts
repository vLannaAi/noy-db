import { describe, it, expect } from 'vitest'
import { SubsystemBus } from '../src/subsystem-bus.js'
import type { WriteEvent } from '../src/write-hooks.js'

function ev(over: Partial<WriteEvent> = {}): WriteEvent {
  return {
    op: 'create', vault: 'v', collection: 'c', docId: 'd',
    before: null, after: { x: 1 }, baseVersion: 0, version: 1,
    userId: 'u', timestamp: 0, txId: 't', ...over,
  }
}

describe('SubsystemBus (observe)', () => {
  it('dispatches handlers in registration order', async () => {
    const bus = new SubsystemBus()
    const order: number[] = []
    bus.register('afterPut', () => { order.push(1) })
    bus.register('afterPut', () => { order.push(2) })
    await bus.dispatch('afterPut', ev())
    expect(order).toEqual([1, 2])
  })

  it('hasHandlers reflects registration and unsubscribe', async () => {
    const bus = new SubsystemBus()
    expect(bus.hasHandlers('afterPut')).toBe(false)
    const off = bus.register('afterPut', () => {})
    expect(bus.hasHandlers('afterPut')).toBe(true)
    off()
    expect(bus.hasHandlers('afterPut')).toBe(false)
  })

  it('awaits async handlers', async () => {
    const bus = new SubsystemBus()
    let done = false
    bus.register('afterPut', async () => {
      await new Promise((r) => setTimeout(r, 5))
      done = true
    })
    await bus.dispatch('afterPut', ev())
    expect(done).toBe(true)
  })

  it('isolates a throwing handler — others still run, dispatch never rejects (observe policy)', async () => {
    const bus = new SubsystemBus()
    const ran: string[] = []
    bus.register('afterPut', () => { throw new Error('boom') })
    bus.register('afterPut', () => { ran.push('second') })
    await expect(bus.dispatch('afterPut', ev())).resolves.toBeUndefined()
    expect(ran).toEqual(['second'])
  })

  it('dispatch is a no-op when no handler is registered', async () => {
    const bus = new SubsystemBus()
    await expect(bus.dispatch('afterPut', ev())).resolves.toBeUndefined()
  })

  it('tolerates handler unsubscribe during dispatch (snapshot semantics)', async () => {
    const bus = new SubsystemBus()
    const ran: string[] = []
    let off = () => {}
    off = bus.register('afterPut', () => { off(); ran.push('first') })
    bus.register('afterPut', () => { ran.push('second') })
    await bus.dispatch('afterPut', ev())
    // Both handlers were in the dispatch snapshot; the first unsubscribing
    // itself must not skip the second.
    expect(ran).toEqual(['first', 'second'])
  })
})
