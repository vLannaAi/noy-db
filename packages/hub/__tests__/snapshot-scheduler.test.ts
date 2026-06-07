import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SnapshotScheduler } from '../src/snapshots/scheduler.js'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

function makeCallbacks(pending = 1) {
  let count = pending
  const fire = vi.fn(async () => { count = 0 })
  return { fire, pendingCount: () => count, setPending: (n: number) => { count = n } }
}

describe('SnapshotScheduler', () => {
  it('debounce coalesces a burst of writes into one fire', async () => {
    const cb = makeCallbacks(1)
    const s = new SnapshotScheduler({ mode: 'debounce', debounceMs: 1000 }, cb)
    s.start()
    s.notifyChange(); s.notifyChange(); s.notifyChange()
    expect(cb.fire).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1000)
    expect(cb.fire).toHaveBeenCalledTimes(1)
    s.stop()
  })

  it('interval mode fires on each tick regardless of notifyChange', async () => {
    const cb = makeCallbacks(1)
    const s = new SnapshotScheduler({ mode: 'interval', intervalMs: 500 }, cb)
    s.start()
    await vi.advanceTimersByTimeAsync(500)
    cb.setPending(1)
    await vi.advanceTimersByTimeAsync(500)
    expect(cb.fire).toHaveBeenCalledTimes(2)
    s.stop()
  })

  it('does not fire when nothing is pending', async () => {
    const cb = makeCallbacks(0)
    const s = new SnapshotScheduler({ mode: 'debounce', debounceMs: 100 }, cb)
    s.start()
    s.notifyChange()
    await vi.advanceTimersByTimeAsync(100)
    expect(cb.fire).not.toHaveBeenCalled()
    s.stop()
  })

  it('minIntervalMs floor reschedules instead of firing too soon', async () => {
    const cb = makeCallbacks(1)
    const s = new SnapshotScheduler({ mode: 'debounce', debounceMs: 100, minIntervalMs: 1000 }, cb)
    s.start()
    s.notifyChange()
    await vi.advanceTimersByTimeAsync(100)
    expect(cb.fire).toHaveBeenCalledTimes(1) // first fire (lastFireTime was 0)
    cb.setPending(1)
    s.notifyChange()
    await vi.advanceTimersByTimeAsync(100) // ~200ms elapsed < 1000ms floor
    expect(cb.fire).toHaveBeenCalledTimes(1) // suppressed, rescheduled
    await vi.advanceTimersByTimeAsync(1000)
    expect(cb.fire).toHaveBeenCalledTimes(2)
    s.stop()
  })

  it('stop() clears timers — no fire after stop', async () => {
    const cb = makeCallbacks(1)
    const s = new SnapshotScheduler({ mode: 'debounce', debounceMs: 100 }, cb)
    s.start()
    s.notifyChange()
    s.stop()
    await vi.advanceTimersByTimeAsync(1000)
    expect(cb.fire).not.toHaveBeenCalled()
  })

  it('notifyChange is a no-op under interval mode', async () => {
    const cb = makeCallbacks(1)
    const s = new SnapshotScheduler({ mode: 'interval', intervalMs: 1000 }, cb)
    s.start()
    s.notifyChange()
    await vi.advanceTimersByTimeAsync(999)
    expect(cb.fire).not.toHaveBeenCalled()
    s.stop()
  })
})
