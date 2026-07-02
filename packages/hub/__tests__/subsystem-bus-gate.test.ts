import { describe, it, expect } from 'vitest'
import { SubsystemBus } from '../src/port/with/service-bus.js'
import type { GatePutEvent, GateDeleteEvent } from '../src/port/with/service-bus.js'

function putEv(over: Partial<GatePutEvent> = {}): GatePutEvent {
  return {
    op: 'create', vault: 'v', collection: 'c', docId: 'd',
    incoming: { x: 1 }, existing: null, existingVersion: 0, existingTs: undefined,
    userId: 'u', role: 'owner', ...over,
  }
}

function deleteEv(over: Partial<GateDeleteEvent> = {}): GateDeleteEvent {
  return {
    vault: 'v', collection: 'c', docId: 'd',
    existing: { x: 1 }, existingVersion: 1, existingTs: undefined, internal: false,
    userId: 'u', role: 'owner', ...over,
  }
}

describe('SubsystemBus (gate)', () => {
  it('runs gate handlers in registration order', async () => {
    const bus = new SubsystemBus()
    const order: number[] = []
    bus.registerGate('beforePut', () => { order.push(1) })
    bus.registerGate('beforePut', () => { order.push(2) })
    await bus.dispatchGate('beforePut', putEv())
    expect(order).toEqual([1, 2])
  })

  it('hasGateHandlers reflects registration and unsubscribe', () => {
    const bus = new SubsystemBus()
    expect(bus.hasGateHandlers('beforePut')).toBe(false)
    const off = bus.registerGate('beforePut', () => {})
    expect(bus.hasGateHandlers('beforePut')).toBe(true)
    off()
    expect(bus.hasGateHandlers('beforePut')).toBe(false)
  })

  it('PROPAGATES a handler throw and stops subsequent handlers (gate policy)', async () => {
    const bus = new SubsystemBus()
    const ran: string[] = []
    bus.registerGate('beforePut', () => { ran.push('first') })
    bus.registerGate('beforePut', () => { throw new Error('blocked') })
    bus.registerGate('beforePut', () => { ran.push('third') })
    await expect(bus.dispatchGate('beforePut', putEv())).rejects.toThrow('blocked')
    expect(ran).toEqual(['first'])
  })

  it('awaits async gate handlers and propagates async rejection', async () => {
    const bus = new SubsystemBus()
    bus.registerGate('beforePut', async () => {
      await new Promise((r) => setTimeout(r, 5))
      throw new Error('async-blocked')
    })
    await expect(bus.dispatchGate('beforePut', putEv())).rejects.toThrow('async-blocked')
  })

  it('dispatchGate is a no-op when no gate handler is registered', async () => {
    const bus = new SubsystemBus()
    await expect(bus.dispatchGate('beforePut', putEv())).resolves.toBeUndefined()
  })

  it('observe and gate registries are independent', () => {
    const bus = new SubsystemBus()
    bus.registerGate('beforePut', () => { throw new Error('gate') })
    expect(bus.hasHandlers('afterPut')).toBe(false)
    expect(bus.hasGateHandlers('beforePut')).toBe(true)
  })

  it('tolerates gate handler unsubscribe during dispatch (snapshot semantics)', async () => {
    const bus = new SubsystemBus()
    const ran: string[] = []
    let off = () => {}
    off = bus.registerGate('beforePut', () => { off(); ran.push('first') })
    bus.registerGate('beforePut', () => { ran.push('second') })
    await bus.dispatchGate('beforePut', putEv())
    expect(ran).toEqual(['first', 'second'])
  })

  it('beforeDelete: a throwing handler propagates and aborts (gate policy)', async () => {
    const bus = new SubsystemBus()
    const ran: string[] = []
    bus.registerGate('beforeDelete', () => { ran.push('first') })
    bus.registerGate('beforeDelete', () => { throw new Error('locked') })
    bus.registerGate('beforeDelete', () => { ran.push('third') })
    await expect(bus.dispatchGate('beforeDelete', deleteEv())).rejects.toThrow('locked')
    expect(ran).toEqual(['first'])
  })
})
