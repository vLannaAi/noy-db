/**
 * #809 Stage 1 — a phased pull policy.
 *
 * `PullPolicy` could say *when* to pull, never *in what order*. `mode: 'phased'`
 * walks `sequence` one collection at a time, then settles into steady state.
 *
 * Phasing is sequencing, not new pull capability: each phase is an ordinary
 * `pull({ collections: [name] })`.
 */
import { describe, it, expect, vi } from 'vitest'
import { SyncScheduler } from '../../src/kernel/sync-policy.js'
// SyncSchedulerCallbacks is the scheduler↔engine contract, deliberately NOT on
// the root barrel — imported from its module rather than widening the surface.
import type { SyncPolicy, SyncSchedulerCallbacks } from '../../src/kernel/sync-policy.js'

const MANUAL_PUSH = { mode: 'manual' } as const

/** Records the collection scope of every pull the scheduler asks for. */
function recorder(opts: { delayMs?: number; failOn?: string; throwOn?: string } = {}) {
  const scopes: (readonly string[] | undefined)[] = []
  const inFlight: string[] = []
  let maxConcurrent = 0

  const callbacks: SyncSchedulerCallbacks = {
    push: async () => {},
    getDirtyCount: () => 0,
    pull: async (collections) => {
      scopes.push(collections)
      const label = collections?.[0] ?? '<all>'
      inFlight.push(label)
      maxConcurrent = Math.max(maxConcurrent, inFlight.length)
      if (opts.delayMs) await new Promise(r => setTimeout(r, opts.delayMs))
      inFlight.splice(inFlight.indexOf(label), 1)
      if (opts.throwOn === label) throw new Error(`pull failed for ${label}`)
    },
  }
  return {
    callbacks,
    order: () => scopes.map(s => s?.[0] ?? '<all>'),
    maxConcurrent: () => maxConcurrent,
  }
}

/**
 * A recorder whose phases BLOCK until the test releases them. Turns "did the
 * walk continue after stop()?" from a wall-clock race into a stated ordering.
 */
function gatedRecorder() {
  const scopes: string[] = []
  const pending: (() => void)[] = []
  const callbacks: SyncSchedulerCallbacks = {
    push: async () => {},
    getDirtyCount: () => 0,
    pull: async (collections) => {
      scopes.push(collections?.[0] ?? '<all>')
      await new Promise<void>(r => pending.push(r))
    },
  }
  return {
    callbacks,
    order: () => [...scopes],
    /** Let every blocked phase finish. */
    release: () => { for (const r of pending.splice(0)) r() },
  }
}

/** Drain a few event-loop turns — enough for an unstopped walk to advance. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0))
}

const phased = (sequence: readonly string[], intervalMs?: number): SyncPolicy => ({
  push: MANUAL_PUSH,
  pull: { mode: 'phased', sequence, ...(intervalMs ? { intervalMs } : {}) },
})

describe('#809 — phased pull executes the sequence in order', () => {
  it('pulls each collection once, in the declared order', async () => {
    const rec = recorder()
    const s = new SyncScheduler(phased(['clients', 'invoices', 'attachments']), rec.callbacks)

    s.start()
    await vi.waitFor(() => expect(rec.order()).toHaveLength(3))

    expect(rec.order()).toEqual(['clients', 'invoices', 'attachments'])
    s.stop()
  })

  it('scopes each phase to exactly that one collection', async () => {
    const rec = recorder()
    const s = new SyncScheduler(phased(['a', 'b']), rec.callbacks)

    s.start()
    await vi.waitFor(() => expect(rec.order()).toHaveLength(2))

    // Not a whole-vault pull, and never more than one collection per phase.
    expect(rec.order()).toEqual(['a', 'b'])
    s.stop()
  })

  it('is strictly sequential — phase n+1 never starts before n resolves', async () => {
    // Concurrency would defeat the prioritisation that is the point of a sequence.
    const rec = recorder({ delayMs: 20 })
    const s = new SyncScheduler(phased(['a', 'b', 'c']), rec.callbacks)

    s.start()
    await vi.waitFor(() => expect(rec.order()).toHaveLength(3), { timeout: 2000 })

    expect(rec.maxConcurrent()).toBe(1)
    s.stop()
  })

  it('runs the sequence ONCE, not on a loop', async () => {
    const rec = recorder()
    const s = new SyncScheduler(phased(['a']), rec.callbacks)

    s.start()
    await vi.waitFor(() => expect(rec.order()).toHaveLength(1))
    await new Promise(r => setTimeout(r, 120))

    expect(rec.order()).toEqual(['a'])
    s.stop()
  })

  it('a phase that throws does not abort the phases behind it', async () => {
    const rec = recorder({ throwOn: 'b' })
    const s = new SyncScheduler(phased(['a', 'b', 'c']), rec.callbacks)

    s.start()
    await vi.waitFor(() => expect(rec.order()).toHaveLength(3), { timeout: 2000 })

    expect(rec.order()).toEqual(['a', 'b', 'c'])
    s.stop()
  })

  it('a later successful phase CLEARS lastError — the error slot is not per-phase', async () => {
    // Pinning this down because it is the argument for Stage 2's per-collection
    // readiness map: the scheduler has one error slot, and `executePull` nulls it
    // on success, so after a sequence `lastError` reflects the LAST phase only.
    // Readiness must therefore be tracked per collection, never derived from here.
    const failsMidway = recorder({ throwOn: 'b' })
    const s1 = new SyncScheduler(phased(['a', 'b', 'c']), failsMidway.callbacks)
    s1.start()
    await vi.waitFor(() => expect(failsMidway.order()).toHaveLength(3), { timeout: 2000 })
    expect(s1.status.lastError).toBeNull()
    s1.stop()

    // Whereas a failure in the final phase does survive.
    const failsLast = recorder({ throwOn: 'c' })
    const s2 = new SyncScheduler(phased(['a', 'b', 'c']), failsLast.callbacks)
    s2.start()
    await vi.waitFor(() => expect(s2.status.lastError).not.toBeNull(), { timeout: 2000 })
    expect(s2.status.lastError?.message).toContain('pull failed for c')
    s2.stop()
  })

  it('stop() cuts the sequence short', async () => {
    // The claim is causal — stop() ends the walk — so the phase boundary is
    // GATED rather than raced against a 30ms-per-phase wall clock. The old
    // shape could let all four phases finish before a loaded runner reached
    // `s.stop()`, failing `toBeLessThan(4)` with no bug present (#1382 class).
    const rec = gatedRecorder()
    const s = new SyncScheduler(phased(['a', 'b', 'c', 'd']), rec.callbacks)

    s.start()
    // Phase 'a' is in flight and BLOCKED on the gate — stop() therefore
    // happens strictly before the phase completes, every run.
    await vi.waitFor(() => expect(rec.order()).toEqual(['a']))
    s.stop()
    rec.release()
    // `runSequence` continues to the next phase immediately after the awaited
    // pull resolves — no timer — so a handful of event-loop turns is decisive.
    await settle()

    expect(rec.order()).toEqual(['a'])
  })

  it('settles into the steady-state interval after the sequence drains', async () => {
    const rec = recorder()
    const s = new SyncScheduler(phased(['a'], 40), rec.callbacks)

    s.start()
    await vi.waitFor(() => expect(rec.order()).toHaveLength(1))
    // Steady-state pulls are whole-vault, not scoped to a phase.
    await vi.waitFor(() => expect(rec.order().length).toBeGreaterThan(1), { timeout: 2000 })

    expect(rec.order()[0]).toBe('a')
    expect(rec.order()[1]).toBe('<all>')
    s.stop()
  })

  it('goes idle after the sequence when no interval is given', async () => {
    const rec = recorder()
    const s = new SyncScheduler(phased(['a']), rec.callbacks)

    s.start()
    await vi.waitFor(() => expect(rec.order()).toHaveLength(1))
    await new Promise(r => setTimeout(r, 150))

    expect(rec.order()).toHaveLength(1)
    s.stop()
  })
})

describe('#809 — an unusable phased policy is rejected at construction', () => {
  const build = (pull: unknown) =>
    () => new SyncScheduler({ push: MANUAL_PUSH, pull } as SyncPolicy, recorder().callbacks)

  it('rejects mode:phased with no sequence', () => {
    expect(build({ mode: 'phased' })).toThrow(/requires a non-empty 'sequence'/)
  })

  it('rejects mode:phased with an empty sequence', () => {
    expect(build({ mode: 'phased', sequence: [] })).toThrow(/requires a non-empty 'sequence'/)
  })

  it('rejects a sequence on a non-phased mode', () => {
    expect(build({ mode: 'interval', intervalMs: 100, sequence: ['a'] }))
      .toThrow(/only meaningful with mode: 'phased'/)
  })

  it('rejects an empty collection name', () => {
    expect(build({ mode: 'phased', sequence: ['a', ''] })).toThrow(/non-empty collection names/)
  })

  it('rejects a duplicate collection', () => {
    // Without period narrowing a repeat can only be a mistake.
    expect(build({ mode: 'phased', sequence: ['a', 'b', 'a'] })).toThrow(/lists "a" more than once/)
  })

  it('accepts the modes that existed before, unchanged', () => {
    expect(build({ mode: 'manual' })).not.toThrow()
    expect(build({ mode: 'interval', intervalMs: 100 })).not.toThrow()
    expect(build({ mode: 'on-focus' })).not.toThrow()
  })
})
