import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SessionStore } from '../src/sessions.js'
import type { Noydb } from '@noy-db/hub'

/**
 * #279 item #5 — SessionStore grows unbounded for long-lived processes
 * when tokens time out without a subsequent `get()` / `peek()`. These
 * tests pin the new background sweep that drops expired entries on a
 * configurable interval.
 */

// A token-store only cares that the inserted `db` is the same object
// on the way out. Stubbed via a minimal typed shape.
function fakeDb(tag: string): Noydb {
  return { __tag: tag } as unknown as Noydb
}

describe('SessionStore — periodic sweep (#279 #5)', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('drops expired sessions on the configured interval', () => {
    const store = new SessionStore(1, { sweepIntervalMs: 100 })
    const tokenA = store.create(fakeDb('a'))
    const tokenB = store.create(fakeDb('b'))
    expect(store.size()).toBe(2)

    // Advance past the TTL (1 second) but BEFORE the sweep interval
    // fires. Without the sweep the entries are still in the map —
    // get()/peek() would drop them lazily, but we deliberately don't
    // call either.
    vi.advanceTimersByTime(1_001)
    expect(store.size()).toBe(2)

    // Fire the sweep interval.
    vi.advanceTimersByTime(100)
    expect(store.size()).toBe(0)

    // Follow-up: freshly created sessions after the sweep should
    // still work normally.
    const tokenC = store.create(fakeDb('c'))
    expect(store.size()).toBe(1)
    expect(store.get(tokenC)).not.toBeNull()

    // The old tokens are genuinely gone — get() returns null without
    // even consulting a timer.
    expect(store.get(tokenA)).toBeNull()
    expect(store.get(tokenB)).toBeNull()

    store.close()
  })

  it('sweep() is idempotent and returns the count of removals', () => {
    const store = new SessionStore(1, { sweepIntervalMs: 0 })
    store.create(fakeDb('a'))
    store.create(fakeDb('b'))
    store.create(fakeDb('c'))
    expect(store.size()).toBe(3)

    vi.advanceTimersByTime(1_001)
    const first = store.sweep()
    expect(first).toBe(3)
    expect(store.size()).toBe(0)
    // Second sweep has nothing to do.
    expect(store.sweep()).toBe(0)

    store.close()
  })

  it('does not drop sessions whose TTL has been refreshed via get()', () => {
    const store = new SessionStore(1, { sweepIntervalMs: 0 })
    const token = store.create(fakeDb('fresh'))

    // Advance halfway through the TTL, then refresh.
    vi.advanceTimersByTime(500)
    expect(store.get(token)).not.toBeNull() // refreshes

    // Advance past the ORIGINAL expiry — but the refresh extended
    // the window, so the sweep should find nothing.
    vi.advanceTimersByTime(600)
    expect(store.sweep()).toBe(0)
    expect(store.size()).toBe(1)

    store.close()
  })

  it('sweepIntervalMs: 0 disables the background timer', () => {
    const store = new SessionStore(1, { sweepIntervalMs: 0 })
    store.create(fakeDb('x'))

    vi.advanceTimersByTime(10 * 1000) // way past TTL
    // No background sweep fired — entry is still there until someone
    // asks for it or calls sweep() manually.
    expect(store.size()).toBe(1)

    store.close()
  })

  it('close() stops the timer and clears the map', () => {
    const store = new SessionStore(60, { sweepIntervalMs: 100 })
    store.create(fakeDb('a'))
    store.create(fakeDb('b'))
    expect(store.size()).toBe(2)

    store.close()
    expect(store.size()).toBe(0)

    // Advancing timers after close() should not resurrect the sessions
    // or throw — the interval is cleared.
    expect(() => vi.advanceTimersByTime(1_000)).not.toThrow()
    expect(store.size()).toBe(0)
  })
})
