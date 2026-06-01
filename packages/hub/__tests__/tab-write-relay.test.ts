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
  return { op: 'update', vault: 'books', collection: 'invoices', docId: 'i1', before: null, after: { id: 'i1' }, userId: 'u', timestamp: 0, txId: 't', baseVersion: 3, version: 4, ...partial }
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
    expect(received).toEqual({ kind: 'tab-write', writerId: 'A', vault: 'books', collection: 'invoices', docId: 'i9', action: 'put', baseV: 3, v: 4 })
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

  it('reports a conflict when a remote write predates this tab\'s own write', async () => {
    const [chA, chB] = makeBus(2)
    const srcA = fakeAfterWrite(); const srcB = fakeAfterWrite()
    const applied: string[] = []; const conflicts: Array<[string, number, number, number]> = []
    const relayA = new CrossTabWriteRelay({ channel: chA!, writerId: 'A', subscribeAfterWrite: srcA.subscribe, applyRemoteWrite: () => {} })
    const relayB = new CrossTabWriteRelay({
      channel: chB!, writerId: 'B', subscribeAfterWrite: srcB.subscribe,
      applyRemoteWrite: (_v, _c, d) => { applied.push(d) },
      reportConflict: (_v, _c, d, _a, baseV, v, ownV) => { conflicts.push([d, baseV, v, ownV]) },
    })
    relayA.start(); relayB.start()
    srcB.fire(ev({ docId: 'i1', baseVersion: 3, version: 4 })) // B writes i1 @v4 → ledger[i1]=4
    srcA.fire(ev({ docId: 'i1', baseVersion: 3, version: 4 })) // A wrote i1 from base 3 too
    await flush()
    expect(conflicts).toEqual([['i1', 3, 4, 4]]) // baseV 3 < ownV 4 → conflict
    expect(applied).toEqual([])                  // conflict path does NOT also apply
    relayA.dispose(); relayB.dispose()
  })

  it('no conflict when the remote incorporated our write (baseV >= ownV)', async () => {
    const [chA, chB] = makeBus(2)
    const srcA = fakeAfterWrite(); const srcB = fakeAfterWrite()
    const applied: string[] = []; let conflictCount = 0
    const relayA = new CrossTabWriteRelay({ channel: chA!, writerId: 'A', subscribeAfterWrite: srcA.subscribe, applyRemoteWrite: () => {} })
    const relayB = new CrossTabWriteRelay({
      channel: chB!, writerId: 'B', subscribeAfterWrite: srcB.subscribe,
      applyRemoteWrite: (_v, _c, d) => { applied.push(d) },
      reportConflict: () => { conflictCount++ },
    })
    relayA.start(); relayB.start()
    srcB.fire(ev({ docId: 'i1', baseVersion: 3, version: 4 }))   // ledger[i1]=4
    srcA.fire(ev({ docId: 'i1', baseVersion: 4, version: 5 }))   // A built on our v4
    await flush()
    expect(conflictCount).toBe(0)
    expect(applied).toEqual(['i1'])
    relayA.dispose(); relayB.dispose()
  })

  it('no conflict for a doc this tab never wrote', async () => {
    const [chA, chB] = makeBus(2)
    const srcA = fakeAfterWrite(); const srcB = fakeAfterWrite()
    const applied: string[] = []; let conflictCount = 0
    const relayA = new CrossTabWriteRelay({ channel: chA!, writerId: 'A', subscribeAfterWrite: srcA.subscribe, applyRemoteWrite: () => {} })
    const relayB = new CrossTabWriteRelay({
      channel: chB!, writerId: 'B', subscribeAfterWrite: srcB.subscribe,
      applyRemoteWrite: (_v, _c, d) => { applied.push(d) },
      reportConflict: () => { conflictCount++ },
    })
    relayA.start(); relayB.start()
    srcA.fire(ev({ docId: 'i2', baseVersion: 3, version: 4 }))   // B never wrote i2
    await flush()
    expect(conflictCount).toBe(0)
    expect(applied).toEqual(['i2'])
    relayA.dispose(); relayB.dispose()
  })
})
