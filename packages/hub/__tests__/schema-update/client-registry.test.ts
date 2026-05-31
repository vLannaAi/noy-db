import { describe, expect, it } from 'vitest'
import { memory } from '../../../to-memory/src/index.js'
import { writeClientDoc, listClientDocs, activeQuiesced } from '../../src/schema-update/client-registry.js'

describe('client registry', () => {
  it('writes and lists per-client docs', async () => {
    const store = memory()
    await writeClientDoc(store, 'v', 'c1', { lastSeen: 100, quiescedAtVersion: null })
    await writeClientDoc(store, 'v', 'c2', { lastSeen: 100, quiescedAtVersion: 3 })
    const docs = await listClientDocs(store, 'v')
    expect(docs.map(d => d.clientId).sort()).toEqual(['c1', 'c2'])
    expect(docs.find(d => d.clientId === 'c2')?.quiescedAtVersion).toBe(3)
  })

  it('overwrites a client doc on re-write (heartbeat update)', async () => {
    const store = memory()
    await writeClientDoc(store, 'v', 'c1', { lastSeen: 100, quiescedAtVersion: null })
    await writeClientDoc(store, 'v', 'c1', { lastSeen: 200, quiescedAtVersion: 4 })
    const docs = await listClientDocs(store, 'v')
    expect(docs).toHaveLength(1)
    expect(docs[0]).toMatchObject({ clientId: 'c1', lastSeen: 200, quiescedAtVersion: 4 })
  })

  it('activeQuiesced: true only when every fresh client acked the target generation', async () => {
    const store = memory()
    await writeClientDoc(store, 'v', 'c1', { lastSeen: 1000, quiescedAtVersion: 5 })
    await writeClientDoc(store, 'v', 'c2', { lastSeen: 1000, quiescedAtVersion: 5 })
    await writeClientDoc(store, 'v', 'stale', { lastSeen: 1, quiescedAtVersion: null }) // stale → ignored
    expect(await activeQuiesced(store, 'v', { generation: 5, now: 1000, staleMs: 500 })).toBe(true)
  })

  it('activeQuiesced: false when a fresh client has not acked the target generation', async () => {
    const store = memory()
    await writeClientDoc(store, 'v', 'c1', { lastSeen: 1000, quiescedAtVersion: 5 })
    await writeClientDoc(store, 'v', 'c2', { lastSeen: 1000, quiescedAtVersion: null })
    expect(await activeQuiesced(store, 'v', { generation: 5, now: 1000, staleMs: 500 })).toBe(false)
  })
})
