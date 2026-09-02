import { describe, it, expect, afterEach } from 'vitest'
import type { PeerChannel } from '@noy-db/by-peer'
import { isQuorum, runDrainBarrier } from '@noy-db/hub/cargo'
import type { WriterPresence } from '@noy-db/hub/cargo'
import { memoryStore, createNoydb } from '@noy-db/hub'
import { byTabs } from '../src/coordination.js'

/**
 * A deterministic, fully synchronous `PeerChannel` pair: each `send` invokes
 * the *other* peer's message listeners immediately (BroadcastChannel semantics —
 * the sender never sees its own post). No timers, no microtask hops.
 */
function makeChannelPair(): readonly [PeerChannel, PeerChannel] {
  const aMsg = new Set<(p: string) => void>()
  const bMsg = new Set<(p: string) => void>()
  const aClose = new Set<() => void>()
  const bClose = new Set<() => void>()
  let aClosed = false
  let bClosed = false

  function makeSide(
    selfMsg: Set<(p: string) => void>,
    selfClose: Set<() => void>,
    peerMsg: Set<(p: string) => void>,
    isClosed: () => boolean,
    setClosed: () => void,
  ): PeerChannel {
    return {
      get isOpen() {
        return !isClosed()
      },
      send(payload: string) {
        if (isClosed()) throw new Error('PeerChannel closed')
        for (const fn of [...peerMsg]) fn(payload)
      },
      on(event: 'message' | 'close', listener: ((p: string) => void) | (() => void)): () => void {
        if (event === 'message') {
          selfMsg.add(listener as (p: string) => void)
          return () => selfMsg.delete(listener as (p: string) => void)
        }
        selfClose.add(listener as () => void)
        return () => selfClose.delete(listener as () => void)
      },
      close() {
        if (isClosed()) return
        setClosed()
        for (const fn of [...selfClose]) fn()
      },
    } as PeerChannel
  }

  const a = makeSide(
    aMsg,
    aClose,
    bMsg,
    () => aClosed,
    () => {
      aClosed = true
    },
  )
  const b = makeSide(
    bMsg,
    bClose,
    aMsg,
    () => bClosed,
    () => {
      bClosed = true
    },
  )
  return [a, b]
}

const channels: PeerChannel[] = []
function pair(): readonly [PeerChannel, PeerChannel] {
  const [a, b] = makeChannelPair()
  channels.push(a, b)
  return [a, b]
}

afterEach(() => {
  for (const ch of channels.splice(0)) {
    try {
      ch.close()
    } catch {
      /* ignore */
    }
  }
})

const VAULT = 'acme'

function presence(over: Partial<WriterPresence> & { writerId: string }): WriterPresence {
  return {
    sessionId: `sess-${over.writerId}`,
    lastSeen: 1_000,
    quiescedAtVersion: null,
    ...over,
  }
}

describe('byTabs — presence', () => {
  it('A.reportPresence is visible to B.reachableWriters with sessionId preserved', async () => {
    const [chA, chB] = pair()
    const a = byTabs(chA)
    const b = byTabs(chB)

    await a.reportPresence(VAULT, presence({ writerId: 'A', sessionId: 'user-1', lastSeen: 1_000 }))

    const seen = await b.reachableWriters(VAULT, { staleMs: 5_000, now: 2_000 })
    expect(seen).toHaveLength(1)
    expect(seen[0].writerId).toBe('A')
    expect(seen[0].sessionId).toBe('user-1')
  })

  it('a writer past staleMs is pruned from reachableWriters', async () => {
    const [chA, chB] = pair()
    const a = byTabs(chA)
    const b = byTabs(chB)

    await a.reportPresence(VAULT, presence({ writerId: 'A', lastSeen: 1_000 }))

    // now - lastSeen = 9_000 > staleMs 5_000 → pruned.
    const seen = await b.reachableWriters(VAULT, { staleMs: 5_000, now: 10_000 })
    expect(seen).toEqual([])
  })

  it('self-report is visible to the local provider (no echo from the wire)', async () => {
    const [chA] = pair()
    const a = byTabs(chA)

    await a.reportPresence(VAULT, presence({ writerId: 'A', lastSeen: 1_000 }))
    const seen = await a.reachableWriters(VAULT, { staleMs: 5_000, now: 1_500 })
    expect(seen.map((w) => w.writerId)).toEqual(['A'])
  })

  it('observePresence fires on a remote report with a pruned writer array', async () => {
    const [chA, chB] = pair()
    const a = byTabs(chA)
    const b = byTabs(chB)

    const batches: (readonly WriterPresence[])[] = []
    const unsub = b.observePresence(VAULT, (w) => batches.push(w))

    await a.reportPresence(VAULT, presence({ writerId: 'A', lastSeen: 1_000 }))
    unsub()

    expect(batches.length).toBeGreaterThanOrEqual(1)
    expect(batches.at(-1)?.map((w) => w.writerId)).toContain('A')
  })
})

describe('byTabs — fence', () => {
  it('A.setFence(draining) makes B.observeFence fire with draining', async () => {
    const [chA, chB] = pair()
    const a = byTabs(chA)
    const b = byTabs(chB)

    const fences: string[] = []
    const unsub = b.observeFence(VAULT, (f) => fences.push(f.fenceState))

    await a.setFence(VAULT, { currentSchemaVersion: 7, fenceState: 'draining' })
    unsub()

    expect(fences).toContain('draining')
    const read = await b.readFence(VAULT)
    expect(read).toEqual({ currentSchemaVersion: 7, fenceState: 'draining' })
  })

  it('readFence defaults to normal/0 when nothing seen', async () => {
    const [chA] = pair()
    const a = byTabs(chA)
    expect(await a.readFence(VAULT)).toEqual({ currentSchemaVersion: 0, fenceState: 'normal' })
  })

  it('observeFence fires on a local set too', async () => {
    const [chA] = pair()
    const a = byTabs(chA)
    const fences: string[] = []
    a.observeFence(VAULT, (f) => fences.push(f.fenceState))
    await a.setFence(VAULT, { currentSchemaVersion: 1, fenceState: 'migrating' })
    expect(fences).toEqual(['migrating'])
  })
})

describe('byTabs — drain barrier (real quorum)', () => {
  it('resolves and runs when the other writer acks at generation', async () => {
    const [chA, chB] = pair()
    const a = byTabs(chA)
    const b = byTabs(chB)

    const generation = 5
    let clock = 0
    const now = () => clock

    // Writer B is present (heartbeat) before the cutover starts.
    await b.reportPresence(VAULT, presence({ writerId: 'B', lastSeen: now(), quiescedAtVersion: null }))

    // Writer B observes the fence; when it goes draining, it quiesces + acks.
    b.observeFence(VAULT, (f) => {
      if (f.fenceState === 'draining') {
        void b.reportPresence(
          VAULT,
          presence({ writerId: 'B', lastSeen: now(), quiescedAtVersion: f.currentSchemaVersion }),
        )
      }
    })

    let ran = 0
    await runDrainBarrier(
      a,
      {
        vault: VAULT,
        generation,
        writerId: 'A',
        onFlush: async () => {},
        staleMs: 10_000,
        quiesceTimeoutMs: 1_000,
        now,
      },
      async () => {
        ran++
      },
    )

    expect(ran).toBe(1)
    const writers = await a.reachableWriters(VAULT, { staleMs: 10_000, now: now() })
    expect(isQuorum(writers, generation, 'A')).toBe(true)
  })

  it('rejects with a timeout when the other writer never acks', async () => {
    const [chA, chB] = pair()
    const a = byTabs(chA)
    const b = byTabs(chB)

    let clock = 0
    const now = () => clock
    // B is present but will NOT ack (no observeFence handler).
    await b.reportPresence(VAULT, presence({ writerId: 'B', lastSeen: now(), quiescedAtVersion: null }))

    let ran = 0
    const promise = runDrainBarrier(
      a,
      {
        vault: VAULT,
        generation: 5,
        writerId: 'A',
        onFlush: async () => {},
        staleMs: 10_000,
        quiesceTimeoutMs: 200,
        now,
        // Advance the clock each poll so the deadline is eventually crossed.
        onPoll: async () => {
          clock += 100
        },
      },
      async () => {
        ran++
      },
    )

    await expect(promise).rejects.toThrow(/timed out/i)
    expect(ran).toBe(0)
  })
})

describe('byTabs — e2e through createNoydb', () => {
  it('is accepted as createNoydb({ mesh }) and is the live instance', async () => {
    const store = memoryStore()
    const [chA, chB] = pair()
    const coA = byTabs(chA)

    const db = await createNoydb({
      store,
      user: 'a',
      secret: 'tabs-e2e-pass-1234',
      mesh: coA,
    })
    // The injected by-tabs provider is the one the Noydb handle exposes/uses.
    expect(db.mesh).toBe(coA)

    // A second tab's provider on the paired channel converges on a fence the
    // first client's coordination pushes — the real-time cutover signal path.
    const coB = byTabs(chB)
    const states: string[] = []
    const unsub = coB.observeFence('demo', (f) => states.push(f.fenceState))

    await db.mesh.setFence('demo', { currentSchemaVersion: 3, fenceState: 'draining' })
    unsub()

    expect(states).toContain('draining')
    expect(await coB.readFence('demo')).toEqual({ currentSchemaVersion: 3, fenceState: 'draining' })

    await db.close()
  })
})
