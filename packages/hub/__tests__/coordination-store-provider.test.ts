import { describe, it, expect, vi, afterEach } from 'vitest'
import { ConflictError } from '../src/kernel/errors.js'
import { isQuorum } from '../src/port/by/index.js'
import type { FenceDoc, WriterPresence } from '../src/port/by/index.js'
import { StoreMesh } from '../src/with-shape/schema-update/store-coordination-provider.js'
import { loadFence, saveFence } from '../src/with-shape/schema-update/fence.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'

function memStore(): NoydbStore {
  const s = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const gc = (c: string, col: string) => {
    let comp = s.get(c); if (!comp) { comp = new Map(); s.set(c, comp) }
    let coll = comp.get(col); if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
    async get(c, col, id) { return s.get(c)?.get(col)?.get(id) ?? null },
    async put(c, col, id, env, ev) {
      const coll = gc(c, col); const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      coll.set(id, env)
    },
    async delete(c, col, id) { s.get(c)?.get(col)?.delete(id) },
    async list(c, col) { const m = s.get(c)?.get(col); return m ? [...m.keys()] : [] },
    async loadAll(c) {
      const comp = s.get(c); const out: VaultSnapshot = {}
      if (comp) for (const [n, coll] of comp) if (!n.startsWith('_')) { const r: Record<string, EncryptedEnvelope> = {}; for (const [id, e] of coll) r[id] = e; out[n] = r }
      return out
    },
    async saveAll(c, data) { for (const [n, recs] of Object.entries(data)) { const coll = gc(c, n); for (const [id, e] of Object.entries(recs)) coll.set(id, e) } },
  }
}

const VAULT = 'v1'

afterEach(() => {
  vi.useRealTimers()
})

describe('StoreMesh', () => {
  it('setFence then reachableWriters/observeFence round-trips a written fence', async () => {
    const store = memStore()
    const prov = new StoreMesh(store, { pollIntervalMs: 5 })
    const fence: FenceDoc = { currentSchemaVersion: 3, fenceState: 'draining' }
    await prov.setFence(VAULT, fence)

    const seen: FenceDoc[] = []
    const unsub = prov.observeFence(VAULT, (f) => seen.push(f))
    // wait a couple of poll intervals
    await new Promise((r) => setTimeout(r, 30))
    unsub()

    expect(seen.length).toBeGreaterThanOrEqual(1)
    expect(seen[seen.length - 1]).toEqual(fence)
  })

  it('observeFence only fires on change', async () => {
    // "no change -> no new emissions" is a non-occurrence claim over a real 5ms
    // poll, and both assertions are exact counts. Driving the poll with fake
    // timers states how many ticks happened instead of racing them (#1382
    // class): a real 20ms sleep can deliver a different number of polls on a
    // loaded box, and `afterFirst` can be snapshotted before the first
    // emission has landed at all.
    vi.useFakeTimers()
    try {
      const store = memStore()
      const prov = new StoreMesh(store, { pollIntervalMs: 5 })
      await prov.setFence(VAULT, { currentSchemaVersion: 1, fenceState: 'normal' })

      const seen: FenceDoc[] = []
      const unsub = prov.observeFence(VAULT, (f) => seen.push(f))
      await vi.advanceTimersByTimeAsync(20)   // 4 polls
      expect(seen.length).toBe(1)             // exactly the initial state

      // no change -> no new emissions, however many polls run
      await vi.advanceTimersByTimeAsync(20)   // 4 more polls
      expect(seen.length).toBe(1)

      // change -> one more emission, and only one
      await prov.setFence(VAULT, { currentSchemaVersion: 2, fenceState: 'draining' })
      await vi.advanceTimersByTimeAsync(20)
      unsub()
      expect(seen.length).toBe(2)
      expect(seen[seen.length - 1]).toEqual({ currentSchemaVersion: 2, fenceState: 'draining' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('reportPresence for 2 writers; reachableWriters returns both with sessionId preserved', async () => {
    const store = memStore()
    const prov = new StoreMesh(store)
    const now = 1_000_000

    await prov.reportPresence(VAULT, { writerId: 'w1', sessionId: 's1', lastSeen: now, quiescedAtVersion: null })
    await prov.reportPresence(VAULT, { writerId: 'w2', sessionId: 's2', lastSeen: now, quiescedAtVersion: 4 })

    const writers = await prov.reachableWriters(VAULT, { staleMs: 1000, now })
    const byId = new Map(writers.map((w) => [w.writerId, w]))
    expect(byId.size).toBe(2)
    expect(byId.get('w1')).toEqual({ writerId: 'w1', sessionId: 's1', lastSeen: now, quiescedAtVersion: null })
    expect(byId.get('w2')).toEqual({ writerId: 'w2', sessionId: 's2', lastSeen: now, quiescedAtVersion: 4 })
  })

  it('reachableWriters prunes writers older than staleMs', async () => {
    const store = memStore()
    const prov = new StoreMesh(store)
    const now = 1_000_000

    await prov.reportPresence(VAULT, { writerId: 'fresh', sessionId: 's', lastSeen: now - 100, quiescedAtVersion: null })
    await prov.reportPresence(VAULT, { writerId: 'stale', sessionId: 's', lastSeen: now - 5000, quiescedAtVersion: null })

    const writers = await prov.reachableWriters(VAULT, { staleMs: 1000, now })
    expect(writers.map((w) => w.writerId)).toEqual(['fresh'])
  })

  it('observePresence fires when a new presence is written, mapping ClientDoc -> WriterPresence', async () => {
    const store = memStore()
    const prov = new StoreMesh(store, { pollIntervalMs: 5 })
    const now = 2_000_000

    const emissions: (readonly WriterPresence[])[] = []
    const unsub = prov.observePresence(VAULT, (ws) => emissions.push(ws))

    await prov.reportPresence(VAULT, { writerId: 'w1', sessionId: 'sX', lastSeen: now, quiescedAtVersion: 7 })
    await new Promise((r) => setTimeout(r, 30))
    unsub()

    const last = emissions[emissions.length - 1]
    expect(last).toBeDefined()
    expect(last).toContainEqual({ writerId: 'w1', sessionId: 'sX', lastSeen: now, quiescedAtVersion: 7 })
  })

  it('isQuorum over reachableWriters() flips false -> true as writers ack', async () => {
    const store = memStore()
    const prov = new StoreMesh(store)
    const now = 3_000_000
    const generation = 9

    await prov.reportPresence(VAULT, { writerId: 'leader', sessionId: 's', lastSeen: now, quiescedAtVersion: null })
    await prov.reportPresence(VAULT, { writerId: 'w1', sessionId: 's', lastSeen: now, quiescedAtVersion: null })

    let writers = await prov.reachableWriters(VAULT, { staleMs: 1000, now })
    expect(isQuorum(writers, generation, 'leader')).toBe(false)

    // w1 acks at generation
    await prov.reportPresence(VAULT, { writerId: 'w1', sessionId: 's', lastSeen: now, quiescedAtVersion: generation })
    writers = await prov.reachableWriters(VAULT, { staleMs: 1000, now })
    expect(isQuorum(writers, generation, 'leader')).toBe(true)
  })

  it('reportPresence omits sessionId gracefully on read (defaults to writerId)', async () => {
    // writeClientDoc called without sessionId (legacy doc) maps to a non-empty sessionId.
    const store = memStore()
    const prov = new StoreMesh(store)
    const now = 4_000_000
    // simulate a legacy doc: report without sessionId via the registry path
    await prov.reportPresence(VAULT, { writerId: 'legacy', sessionId: '', lastSeen: now, quiescedAtVersion: null })
    const writers = await prov.reachableWriters(VAULT, { staleMs: 1000, now })
    const w = writers.find((x) => x.writerId === 'legacy')
    expect(w).toBeDefined()
    // empty sessionId in -> defaults to writerId on read
    expect(w?.sessionId).toBe('legacy')
  })
})

describe('#1197 — a fence transition must not erase fields it does not carry', () => {
  it('preserves `schemaHash` across a setFence that only changes the phase', async () => {
    const store = memStore()
    await saveFence(store, 'v', { currentSchemaVersion: 3, fenceState: 'normal', schemaHash: 'abc123' })

    const mesh = new StoreMesh(store)
    // Exactly what `FenceController.#setState` constructs: a partial FenceDoc,
    // valid because `schemaHash` is optional.
    await mesh.setFence('v', { currentSchemaVersion: 3, fenceState: 'draining' })

    const after = await loadFence(store, 'v')
    expect(after.fenceState).toBe('draining')
    expect(after.schemaHash).toBe('abc123')
  })

  it('a setFence that DOES carry a schemaHash still overwrites it', async () => {
    // The merge must not become a one-way ratchet: a cutover writing a new
    // generation's hash has to win over the old one.
    const store = memStore()
    await saveFence(store, 'v', { currentSchemaVersion: 3, fenceState: 'normal', schemaHash: 'old' })

    await new StoreMesh(store).setFence('v', { currentSchemaVersion: 4, fenceState: 'normal', schemaHash: 'new' })

    const after = await loadFence(store, 'v')
    expect(after.schemaHash).toBe('new')
    expect(after.currentSchemaVersion).toBe(4)
  })
})
