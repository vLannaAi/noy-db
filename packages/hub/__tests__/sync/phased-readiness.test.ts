/**
 * #809 Stage 2 — per-collection readiness.
 *
 * Under a phased pull a `null` from `get()` is ambiguous: absent, or not here
 * yet? Readiness answers that, and only `'live'` claims a miss is a real
 * absence. It rides the SyncStatus surface that already exists rather than a
 * second accessor, and costs the kernel floor nothing.
 */
import { describe, it, expect, vi } from 'vitest'
import { SyncScheduler } from '../../src/kernel/sync-policy.js'
import type { SyncPolicy, SyncSchedulerCallbacks } from '../../src/kernel/sync-policy.js'
import { createNoydb, memoryStore } from '../../src/index.js'
import { withSync } from '../../src/with-sync/index.js'

const MANUAL_PUSH = { mode: 'manual' } as const
const SECRET = 'x'.repeat(32)

const phased = (sequence: readonly string[]): SyncPolicy => ({
  push: MANUAL_PUSH,
  pull: { mode: 'phased', sequence },
})

/** Callbacks whose pull outcome and timing the test controls per collection. */
function controllable(opts: {
  incomplete?: string[]
  throwOn?: string
  gate?: Map<string, Promise<void>>
} = {}) {
  const callbacks: SyncSchedulerCallbacks = {
    push: async () => {},
    getDirtyCount: () => 0,
    pull: async (collections) => {
      const name = collections?.[0] ?? '<all>'
      const gate = opts.gate?.get(name)
      if (gate) await gate
      if (opts.throwOn === name) throw new Error(`boom ${name}`)
      return opts.incomplete?.includes(name) ? 'incomplete' : 'complete'
    },
  }
  return callbacks
}

const readinessOf = (s: SyncScheduler) => Object.fromEntries(s.status.readiness)

describe('#809 — readiness transitions', () => {
  it('seeds every named collection the moment start() returns', () => {
    const s = new SyncScheduler(phased(['a', 'b', 'c']), controllable())
    s.start()

    // Seeded synchronously, so a reader racing the sequence sees "not ready"
    // rather than a missing entry — the distinction the whole map exists for.
    // Phase 1 is already in flight: start() is synchronous, but it runs the
    // first phase up to its first await before returning.
    expect(readinessOf(s)).toEqual({ a: 'pulling', b: 'cold', c: 'cold' })
    expect([...s.status.readiness.values()]).not.toContain('live')
    s.stop()
  })

  it('goes cold → pulling → live', async () => {
    let release!: () => void
    const gate = new Map([['a', new Promise<void>(r => { release = r })]])
    const s = new SyncScheduler(phased(['a']), controllable({ gate }))

    s.start()
    await vi.waitFor(() => expect(s.status.readiness.get('a')).toBe('pulling'))

    release()
    await vi.waitFor(() => expect(s.status.readiness.get('a')).toBe('live'))
    s.stop()
  })

  it('a collection the sequence never names is ABSENT, not cold', async () => {
    const s = new SyncScheduler(phased(['a']), controllable())
    s.start()
    await vi.waitFor(() => expect(s.status.readiness.get('a')).toBe('live'))

    // 'no claim made' must be distinguishable from 'not ready'.
    expect(s.status.readiness.has('other')).toBe(false)
    expect(s.status.readiness.get('other')).toBeUndefined()
    s.stop()
  })

  it('a phase reporting errors leaves its collection COLD, never live', async () => {
    const s = new SyncScheduler(phased(['a', 'b']), controllable({ incomplete: ['a'] }))

    s.start()
    await vi.waitFor(() => expect(s.status.readiness.get('b')).toBe('live'))

    expect(s.status.readiness.get('a')).toBe('cold')
    s.stop()
  })

  it('a throwing phase leaves its collection cold — never stuck pulling', async () => {
    const s = new SyncScheduler(phased(['a', 'b']), controllable({ throwOn: 'a' }))

    s.start()
    await vi.waitFor(() => expect(s.status.readiness.get('b')).toBe('live'))

    expect(s.status.readiness.get('a')).toBe('cold')
    expect([...s.status.readiness.values()]).not.toContain('pulling')
    s.stop()
  })

  it('stop() mid-phase resets pulling → cold, so no skeleton outlives the vault', async () => {
    let release!: () => void
    const gate = new Map([['a', new Promise<void>(r => { release = r })]])
    const s = new SyncScheduler(phased(['a', 'b']), controllable({ gate }))

    s.start()
    await vi.waitFor(() => expect(s.status.readiness.get('a')).toBe('pulling'))
    s.stop()

    expect(s.status.readiness.get('a')).toBe('cold')
    expect(s.status.phase).toBeNull()
    release()
  })
})

describe('#809 — phase position', () => {
  it('reports a 1-based index and the total, then null when drained', async () => {
    let release!: () => void
    const gate = new Map([['b', new Promise<void>(r => { release = r })]])
    const s = new SyncScheduler(phased(['a', 'b', 'c']), controllable({ gate }))

    s.start()
    await vi.waitFor(() => expect(s.status.phase).toEqual({ index: 2, total: 3 }))

    release()
    await vi.waitFor(() => expect(s.status.phase).toBeNull())
    s.stop()
  })

  it('is null for a policy that is not phased', () => {
    const s = new SyncScheduler(
      { push: MANUAL_PUSH, pull: { mode: 'interval', intervalMs: 10_000 } },
      controllable(),
    )
    s.start()
    expect(s.status.phase).toBeNull()
    expect(s.status.readiness.size).toBe(0)
    s.stop()
  })
})

describe('#809 — the status snapshot is a copy', () => {
  it('does not mutate under its reader as later phases land', async () => {
    let release!: () => void
    const gate = new Map([['b', new Promise<void>(r => { release = r })]])
    const s = new SyncScheduler(phased(['a', 'b']), controllable({ gate }))

    s.start()
    await vi.waitFor(() => expect(s.status.readiness.get('a')).toBe('live'))
    const snapshot = s.status.readiness
    expect(snapshot.get('b')).toBe('pulling')

    release()
    await vi.waitFor(() => expect(s.status.readiness.get('b')).toBe('live'))

    // The snapshot taken earlier still reads as it did when taken.
    expect(snapshot.get('b')).toBe('pulling')
    s.stop()
  })
})

describe('#809 — readiness reaches the app through db.syncStatus()', () => {
  const open = (syncPolicy?: SyncPolicy) =>
    createNoydb({
      store: memoryStore(),
      sync: memoryStore(),
      user: 'a',
      secret: SECRET,
      syncStrategy: withSync(),
      ...(syncPolicy ? { syncPolicy } : {}),
    })

  it('surfaces readiness on the EXISTING status call, with no second accessor', async () => {
    const db = await open(phased(['invoices', 'clients']))
    await db.openVault('acme')

    await vi.waitFor(() => {
      expect(db.syncStatus('acme').readiness?.get('clients')).toBe('live')
    }, { timeout: 2000 })

    const status = db.syncStatus('acme')
    expect(status.readiness?.get('invoices')).toBe('live')
    // …alongside the fields that were always there.
    expect(status.dirty).toBe(0)
    expect(typeof status.online).toBe('boolean')
    db.close()
  })

  it('omits readiness entirely for a non-phased policy', async () => {
    const db = await open({ push: MANUAL_PUSH, pull: { mode: 'manual' } })
    await db.openVault('acme')

    const status = db.syncStatus('acme')
    expect(status.readiness).toBeUndefined()
    expect(status.phase).toBeUndefined()
    db.close()
  })

  it('omits readiness when no policy was declared at all', async () => {
    const db = await open()
    await db.openVault('acme')

    expect(db.syncStatus('acme').readiness).toBeUndefined()
    db.close()
  })
})
