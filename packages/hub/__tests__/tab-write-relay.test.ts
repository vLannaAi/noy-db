import { describe, expect, it } from 'vitest'
import { CrossTabWriteRelay } from '../src/tab-write-relay.js'
import type { TabChannel } from '../src/tab-coordination.js'
import type { WriteEvent } from '../src/write-hooks.js'

/** In-memory broadcast bus: each channel's send() reaches all OTHER channels. */
function makeBus(n: number): TabChannel[] {
  const listeners: Array<((p: string) => void) | null> = []
  const chans: TabChannel[] = []
  for (let i = 0; i < n; i++) {
    const idx = i
    chans.push({
      isOpen: true,
      send(payload) { for (let j = 0; j < listeners.length; j++) if (j !== idx && listeners[j]) queueMicrotask(() => listeners[j]!(payload)) },
      on(event, l) { if (event === 'message') { listeners[idx] = l as (p: string) => void; return () => { listeners[idx] = null } } return () => {} },
      close() { listeners[idx] = null },
    })
  }
  return chans
}

const flush = () => new Promise((r) => setTimeout(r, 0))

/** A controllable onAfterWrite source: returns a subscribe fn + a fire fn. */
function fakeAfterWrite() {
  const handlers = new Set<(e: WriteEvent) => void>()
  return {
    subscribe: (h: (e: WriteEvent) => void) => { handlers.add(h); return () => handlers.delete(h) },
    fire: (e: WriteEvent) => { for (const h of handlers) h(e) },
  }
}

function ev(partial: Partial<WriteEvent>): WriteEvent {
  return { op: 'update', vault: 'books', collection: 'invoices', docId: 'i1', before: null, after: { id: 'i1' }, userId: 'u', timestamp: 0, txId: 't', ...partial }
}

describe('CrossTabWriteRelay', () => {
  it('broadcasts a tab-write signal on a local committed write', async () => {
    const [chA, chB] = makeBus(2)
    const srcA = fakeAfterWrite()
    let received: unknown
    const relayA = new CrossTabWriteRelay({ channel: chA!, writerId: 'A', subscribeAfterWrite: srcA.subscribe, applyRemoteWrite: () => {} })
    chB!.on('message', (p) => { received = JSON.parse(p) })
    relayA.start()
    srcA.fire(ev({ op: 'create', docId: 'i9' }))
    await flush()
    expect(received).toEqual({ kind: 'tab-write', writerId: 'A', vault: 'books', collection: 'invoices', docId: 'i9', action: 'put' })
    relayA.dispose()
  })

  it('maps op:delete to action:delete', async () => {
    const [chA, chB] = makeBus(2)
    const srcA = fakeAfterWrite()
    let received: { action?: string } = {}
    const relayA = new CrossTabWriteRelay({ channel: chA!, writerId: 'A', subscribeAfterWrite: srcA.subscribe, applyRemoteWrite: () => {} })
    chB!.on('message', (p) => { received = JSON.parse(p) })
    relayA.start()
    srcA.fire(ev({ op: 'delete', after: null }))
    await flush()
    expect(received.action).toBe('delete')
    relayA.dispose()
  })

  it('applies a foreign tab-write; ignores its own', async () => {
    const [chA, chB] = makeBus(2)
    const srcA = fakeAfterWrite(); const srcB = fakeAfterWrite()
    const applied: Array<[string, string, string, string]> = []
    const relayA = new CrossTabWriteRelay({ channel: chA!, writerId: 'A', subscribeAfterWrite: srcA.subscribe, applyRemoteWrite: () => {} })
    const relayB = new CrossTabWriteRelay({ channel: chB!, writerId: 'B', subscribeAfterWrite: srcB.subscribe, applyRemoteWrite: (v, c, d, a) => { applied.push([v, c, d, a]) } })
    relayA.start(); relayB.start()
    srcA.fire(ev({ docId: 'i1' }))   // A writes → B should apply
    await flush()
    srcB.fire(ev({ docId: 'i2' }))   // B writes → B must NOT apply its own
    await flush()
    expect(applied).toEqual([['books', 'invoices', 'i1', 'put']])
    relayA.dispose(); relayB.dispose()
  })

  it('does not broadcast or apply after dispose', async () => {
    const [chA, chB] = makeBus(2)
    const srcA = fakeAfterWrite()
    let count = 0
    const relayA = new CrossTabWriteRelay({ channel: chA!, writerId: 'A', subscribeAfterWrite: srcA.subscribe, applyRemoteWrite: () => {} })
    chB!.on('message', () => { count++ })
    relayA.start()
    relayA.dispose()
    srcA.fire(ev({ docId: 'i1' }))
    await flush()
    expect(count).toBe(0)
  })
})
