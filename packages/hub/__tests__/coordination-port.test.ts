import { describe, it, expect, vi } from 'vitest'
import {
  isQuorum,
  runDrainBarrier,
  type CoordinationProvider,
  type FenceState,
  type WriterPresence,
} from '../src/kernel/by/index.js'
import { QuiesceTimeoutError } from '../src/kernel/errors.js'

const writer = (over: Partial<WriterPresence> = {}): WriterPresence => ({
  writerId: 'w1',
  sessionId: 's1',
  lastSeen: 0,
  quiescedAtVersion: null,
  ...over,
})

describe('isQuorum', () => {
  it('returns true when every writer has acked at the generation', () => {
    const writers = [
      writer({ writerId: 'a', quiescedAtVersion: 5 }),
      writer({ writerId: 'b', quiescedAtVersion: 5 }),
    ]
    expect(isQuorum(writers, 5)).toBe(true)
  })

  it('returns false when one writer has not acked at the generation', () => {
    const writers = [
      writer({ writerId: 'a', quiescedAtVersion: 5 }),
      writer({ writerId: 'b', quiescedAtVersion: 4 }),
    ]
    expect(isQuorum(writers, 5)).toBe(false)
  })

  it('returns false when a writer has not quiesced at all (null)', () => {
    const writers = [
      writer({ writerId: 'a', quiescedAtVersion: 5 }),
      writer({ writerId: 'b', quiescedAtVersion: null }),
    ]
    expect(isQuorum(writers, 5)).toBe(false)
  })

  it('ignores a non-acked writer whose id equals excludeWriterId', () => {
    const writers = [
      writer({ writerId: 'a', quiescedAtVersion: 5 }),
      writer({ writerId: 'self', quiescedAtVersion: null }),
    ]
    expect(isQuorum(writers, 5, 'self')).toBe(true)
  })

  it('returns true for an empty writer set', () => {
    expect(isQuorum([], 5)).toBe(true)
  })
})

/**
 * Hand-rolled in-memory CoordinationProvider for driving runDrainBarrier
 * deterministically. The test pushes presence sets via `pushPresence`.
 */
class MockProvider implements CoordinationProvider {
  fences: FenceState[] = []
  writers: WriterPresence[] = []
  private presenceListeners = new Set<(w: readonly WriterPresence[]) => void>()

  async setFence(_vault: string, fence: FenceState): Promise<void> {
    this.fences.push(fence)
  }

  async readFence(_vault: string): Promise<FenceState> {
    return this.fences.at(-1) ?? { currentSchemaVersion: 0, fenceState: 'normal' }
  }

  observeFence(): () => void {
    return () => {}
  }

  async reportPresence(_vault: string, p: WriterPresence): Promise<void> {
    this.writers = [...this.writers.filter((w) => w.writerId !== p.writerId), p]
  }

  observePresence(_vault: string, onChange: (w: readonly WriterPresence[]) => void): () => void {
    this.presenceListeners.add(onChange)
    return () => this.presenceListeners.delete(onChange)
  }

  async reachableWriters(_vault: string, _o: { staleMs: number; now: number }): Promise<readonly WriterPresence[]> {
    return this.writers
  }

  /** Test helper: set the live writer set and notify presence observers. */
  pushPresence(writers: WriterPresence[]): void {
    this.writers = writers
    for (const l of this.presenceListeners) l([...writers])
  }
}

describe('runDrainBarrier', () => {
  it('drains, reaches quorum via presence push, then runs exactly once', async () => {
    const provider = new MockProvider()
    // Seed with a non-acked peer so the barrier must wait for a presence push.
    provider.writers = [writer({ writerId: 'peer', quiescedAtVersion: null })]

    const onFlush = vi.fn(async () => {})
    const run = vi.fn(async () => {})
    let now = 1000

    const barrier = runDrainBarrier(
      provider,
      {
        vault: 'v',
        generation: 7,
        writerId: 'migrator',
        onFlush,
        staleMs: 10_000,
        quiesceTimeoutMs: 5_000,
        now: () => now,
      },
      run,
    )

    // onFlush is awaited before quorum is reached; run must not have fired yet.
    await Promise.resolve()
    expect(onFlush).toHaveBeenCalledTimes(1)
    expect(run).not.toHaveBeenCalled()

    // Peer acks at the generation → quorum reached → barrier resolves.
    provider.pushPresence([writer({ writerId: 'peer', quiescedAtVersion: 7 })])
    await barrier

    expect(provider.fences[0]).toEqual({ currentSchemaVersion: 7, fenceState: 'draining' })
    expect(run).toHaveBeenCalledTimes(1)
    // run() fires only after quorum.
    expect(run.mock.invocationCallOrder[0]).toBeGreaterThan(onFlush.mock.invocationCallOrder[0]!)
  })

  it('resolves immediately when the seeded writer set is already a quorum', async () => {
    const provider = new MockProvider()
    provider.writers = [writer({ writerId: 'peer', quiescedAtVersion: 9 })]

    const run = vi.fn(async () => {})
    await runDrainBarrier(
      provider,
      {
        vault: 'v',
        generation: 9,
        writerId: 'migrator',
        onFlush: async () => {},
        staleMs: 10_000,
        quiesceTimeoutMs: 5_000,
        now: () => 0,
      },
      run,
    )
    expect(run).toHaveBeenCalledTimes(1)
    expect(provider.fences[0]?.fenceState).toBe('draining')
  })

  it('rejects with QuiesceTimeoutError when a writer never acks', async () => {
    const provider = new MockProvider()
    provider.writers = [writer({ writerId: 'peer', quiescedAtVersion: null })]

    const run = vi.fn(async () => {})
    let now = 0
    // Advance the clock past the deadline on each poll so the barrier times out
    // deterministically without any real timer waiting.
    const onPoll = vi.fn(async () => {
      now += 1000
    })

    await expect(
      runDrainBarrier(
        provider,
        {
          vault: 'v',
          generation: 7,
          writerId: 'migrator',
          onFlush: async () => {},
          staleMs: 10_000,
          quiesceTimeoutMs: 100,
          now: () => now,
          onPoll,
        },
        run,
      ),
    ).rejects.toBeInstanceOf(QuiesceTimeoutError)

    expect(run).not.toHaveBeenCalled()
  })
})
