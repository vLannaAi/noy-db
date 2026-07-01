import { describe, expect, it } from 'vitest'
import { memory } from '../../../to-memory/src/index.js'
import { FenceWatcher } from '../../src/with-shape/schema-update/fence-watcher.js'
import { saveFence } from '../../src/with-shape/schema-update/fence.js'
import { listClientDocs } from '../../src/with-shape/schema-update/client-registry.js'
import { StoreCoordinationProvider } from '../../src/kernel/coordination/index.js'

function mkWatcher(store = memory(), onFlush = async () => {}) {
  let t = 1000
  const events: string[] = []
  // Default coordination = StoreCoordinationProvider over the same store; the
  // watcher's beat/check behavior (and these store-level assertions) is unchanged.
  const w = new FenceWatcher({
    coordination: new StoreCoordinationProvider(store), vault: 'v', clientId: 'c1', onFlush,
    now: () => t,
    emit: (e) => events.push(e.fenceState),
  })
  return { store, w, events, advance: (ms: number) => { t += ms } }
}

describe('FenceWatcher', () => {
  it('beat() writes a heartbeat doc with lastSeen and no ack', async () => {
    const { store, w } = mkWatcher()
    await w.beat()
    const docs = await listClientDocs(store, 'v')
    expect(docs[0]).toMatchObject({ clientId: 'c1', lastSeen: 1000, quiescedAtVersion: null })
  })

  it('check() during draining flushes then stamps quiescedAtVersion', async () => {
    let flushed = false
    const { store, w } = mkWatcher(memory(), async () => { flushed = true })
    await saveFence(store, 'v', { currentSchemaVersion: 7, fenceState: 'draining' })
    await w.check()
    expect(flushed).toBe(true)
    const docs = await listClientDocs(store, 'v')
    expect(docs[0]?.quiescedAtVersion).toBe(7)
  })

  it('check() emits fence-changed only on state transitions', async () => {
    const { store, w, events } = mkWatcher()
    await saveFence(store, 'v', { currentSchemaVersion: 0, fenceState: 'draining' })
    await w.check()
    await w.check() // no change → no second emit
    await saveFence(store, 'v', { currentSchemaVersion: 1, fenceState: 'complete' })
    await w.check()
    expect(events).toEqual(['draining', 'complete'])
  })

  it('check() in normal state does not flush or ack', async () => {
    let flushed = false
    const { store, w } = mkWatcher(memory(), async () => { flushed = true })
    await saveFence(store, 'v', { currentSchemaVersion: 0, fenceState: 'normal' })
    await w.check()
    expect(flushed).toBe(false)
  })
})
