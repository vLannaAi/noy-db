/**
 * Unit tests for WriteQueueTracker — the framework-agnostic in-flight
 * write counter behind hub.writeQueue (#227, M12 Slice 1).
 */
import { describe, expect, it, vi } from 'vitest'
import { WriteQueueTracker } from '../src/kernel/write-queue.js'

describe('WriteQueueTracker', () => {
  it('starts empty', () => {
    const t = new WriteQueueTracker()
    expect(t.depth).toBe(0)
    expect(t.pending).toBe(false)
  })

  it('begin() raises depth and pending; settle() lowers them', () => {
    const t = new WriteQueueTracker()
    t.begin()
    expect(t.depth).toBe(1)
    expect(t.pending).toBe(true)
    t.begin()
    expect(t.depth).toBe(2)
    t.settle()
    expect(t.depth).toBe(1)
    expect(t.pending).toBe(true)
    t.settle()
    expect(t.depth).toBe(0)
    expect(t.pending).toBe(false)
  })

  it('settle() never drives depth below zero', () => {
    const t = new WriteQueueTracker()
    t.settle()
    expect(t.depth).toBe(0)
  })

  it('onChange fires on every begin and settle and unsubscribes', () => {
    const t = new WriteQueueTracker()
    const spy = vi.fn()
    const unsub = t.onChange(spy)
    t.begin()
    t.settle()
    expect(spy).toHaveBeenCalledTimes(2)
    unsub()
    t.begin()
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('onFlush() resolves immediately when depth is already 0', async () => {
    const t = new WriteQueueTracker()
    await expect(t.onFlush()).resolves.toBeUndefined()
  })

  it('onFlush() resolves once depth returns to 0', async () => {
    const t = new WriteQueueTracker()
    t.begin()
    let resolved = false
    const flush = t.onFlush().then(() => { resolved = true })
    expect(resolved).toBe(false)
    t.settle()
    await flush
    expect(resolved).toBe(true)
  })

  it('onFlush() rejects when a write settled with an error during the wait', async () => {
    const t = new WriteQueueTracker()
    t.begin()
    const flush = t.onFlush()
    t.settle(new Error('adapter exploded'))
    await expect(flush).rejects.toThrow('adapter exploded')
  })

  it('a fresh onFlush() after an error drain resolves cleanly', async () => {
    const t = new WriteQueueTracker()
    t.begin()
    const first = t.onFlush()
    t.settle(new Error('boom'))
    await expect(first).rejects.toThrow('boom')
    await expect(t.onFlush()).resolves.toBeUndefined()
  })

  it('track() increments around a successful async fn and returns its value', async () => {
    const t = new WriteQueueTracker()
    const result = await t.track(async () => {
      expect(t.depth).toBe(1)
      return 42
    })
    expect(result).toBe(42)
    expect(t.depth).toBe(0)
  })

  it('track() decrements and propagates when the fn throws', async () => {
    const t = new WriteQueueTracker()
    await expect(t.track(async () => { throw new Error('nope') })).rejects.toThrow('nope')
    expect(t.depth).toBe(0)
  })
})
