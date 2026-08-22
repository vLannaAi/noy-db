import { describe, it, expect, afterEach } from 'vitest'
import { isQuorum, runDrainBarrier } from '@noy-db/hub/cargo'
import type { WriterPresence } from '@noy-db/hub/cargo'
import { pairInMemory, byPeer, channelMesh } from '../src/index.js'
import type { PeerChannel } from '../src/index.js'

/**
 * by-peer's `pairInMemory()` delivers each `send` to the *other* peer via
 * `queueMicrotask` (it never echoes to the sender). So unlike by-tabs'
 * synchronous pair, a cross-channel hop needs one microtask flush before the
 * remote provider's state reflects it. `flush()` drains the microtask queue.
 */
const flush = (): Promise<void> => new Promise<void>((r) => queueMicrotask(r))

const channels: PeerChannel[] = []
function pair(): readonly [PeerChannel, PeerChannel] {
  const [a, b] = pairInMemory()
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

describe('byPeer — presence', () => {
  it('A.reportPresence is visible to B.reachableWriters with sessionId preserved', async () => {
    const [chA, chB] = pair()
    const a = byPeer(chA)
    const b = byPeer(chB)

    await a.reportPresence(VAULT, presence({ writerId: 'A', sessionId: 'user-1', lastSeen: 1_000 }))
    await flush()

    const seen = await b.reachableWriters(VAULT, { staleMs: 5_000, now: 2_000 })
    expect(seen).toHaveLength(1)
    expect(seen[0].writerId).toBe('A')
    expect(seen[0].sessionId).toBe('user-1')
  })

  it('a writer past staleMs is pruned from reachableWriters', async () => {
    const [chA, chB] = pair()
    const a = byPeer(chA)
    const b = byPeer(chB)

    await a.reportPresence(VAULT, presence({ writerId: 'A', lastSeen: 1_000 }))
    await flush()

    // now - lastSeen = 9_000 > staleMs 5_000 → pruned.
    const seen = await b.reachableWriters(VAULT, { staleMs: 5_000, now: 10_000 })
    expect(seen).toEqual([])
  })

  it('self-report is visible to the local provider (no echo from the wire)', async () => {
    const [chA] = pair()
    const a = byPeer(chA)

    await a.reportPresence(VAULT, presence({ writerId: 'A', lastSeen: 1_000 }))
    const seen = await a.reachableWriters(VAULT, { staleMs: 5_000, now: 1_500 })
    expect(seen.map((w) => w.writerId)).toEqual(['A'])
  })

  it('observePresence fires on a remote report with the reporting writer present', async () => {
    const [chA, chB] = pair()
    const a = byPeer(chA)
    const b = byPeer(chB)

    const batches: (readonly WriterPresence[])[] = []
    const unsub = b.observePresence(VAULT, (w) => batches.push(w))

    await a.reportPresence(VAULT, presence({ writerId: 'A', lastSeen: 1_000 }))
    await flush()
    unsub()

    expect(batches.length).toBeGreaterThanOrEqual(1)
    expect(batches.at(-1)?.map((w) => w.writerId)).toContain('A')
  })
})

describe('byPeer — fence', () => {
  it('A.setFence(draining) makes B.observeFence fire with draining', async () => {
    const [chA, chB] = pair()
    const a = byPeer(chA)
    const b = byPeer(chB)

    const fences: string[] = []
    const unsub = b.observeFence(VAULT, (f) => fences.push(f.fenceState))

    await a.setFence(VAULT, { currentSchemaVersion: 7, fenceState: 'draining' })
    await flush()
    unsub()

    expect(fences).toContain('draining')
    const read = await b.readFence(VAULT)
    expect(read).toEqual({ currentSchemaVersion: 7, fenceState: 'draining' })
  })

  it('readFence defaults to normal/0 when nothing seen', async () => {
    const [chA] = pair()
    const a = byPeer(chA)
    expect(await a.readFence(VAULT)).toEqual({ currentSchemaVersion: 0, fenceState: 'normal' })
  })

  it('observeFence fires on a local set too', async () => {
    const [chA] = pair()
    const a = byPeer(chA)
    const fences: string[] = []
    a.observeFence(VAULT, (f) => fences.push(f.fenceState))
    await a.setFence(VAULT, { currentSchemaVersion: 1, fenceState: 'migrating' })
    expect(fences).toEqual(['migrating'])
  })
})

describe('byPeer — drain barrier (real quorum)', () => {
  it('resolves and runs when the other writer acks at generation', async () => {
    const [chA, chB] = pair()
    const a = byPeer(chA)
    const b = byPeer(chB)

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
    const a = byPeer(chA)
    const b = byPeer(chB)

    let clock = 0
    const now = () => clock
    // B is present but will NOT ack (no observeFence handler).
    await b.reportPresence(VAULT, presence({ writerId: 'B', lastSeen: now(), quiescedAtVersion: null }))
    await flush()

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

describe('channelMesh — alias parity', () => {
  it('channelMesh and byPeer are the same factory', () => {
    expect(channelMesh).toBe(byPeer)
  })

  it('channelMesh over a pair carries a fence A→B', async () => {
    const [chA, chB] = pair()
    const a = channelMesh(chA)
    const b = channelMesh(chB)

    await a.setFence(VAULT, { currentSchemaVersion: 2, fenceState: 'migrating' })
    await flush()

    expect(await b.readFence(VAULT)).toEqual({ currentSchemaVersion: 2, fenceState: 'migrating' })
  })
})
