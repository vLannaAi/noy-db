/**
 * Tests for `servePeerStore({ leaderElection })` — the fix for issue #3
 * (duplicate RPC responses when 3+ tabs each run servePeerStore on a
 * shared BroadcastChannel-backed PeerChannel).
 */

import { describe, it, expect } from 'vitest'
import { memory } from '@noy-db/to-memory'
import type { EncryptedEnvelope } from '@noy-db/hub'
import { pairInMemory, peerStore, servePeerStore } from '../src/index.js'
import type { MinimalLockManager } from '../src/serve.js'

function envelope(v: number, iv = 'aaaa'): EncryptedEnvelope {
  return {
    _noydb: 1,
    _v: v,
    _ts: new Date(1700000000000 + v * 1000).toISOString(),
    _iv: iv,
    _data: `ciphertext-${v}`,
  }
}

/** Small helper: yield to the microtask queue so queued tasks run. */
async function flushMicrotasks(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve()
  }
}

/**
 * In-memory implementation of `MinimalLockManager` modelled on the
 * Web Locks API: one named lock at a time, FIFO queue for waiters,
 * AbortSignal cancels a queued wait.
 */
function createMockLocks(): MinimalLockManager {
  type Task = { run: () => Promise<unknown>; resolve: (v: unknown) => void; reject: (e: unknown) => void; signal?: AbortSignal; cancelled: boolean }
  const queues = new Map<string, Task[]>()
  const held = new Set<string>()

  async function processQueue(name: string): Promise<void> {
    if (held.has(name)) return
    const queue = queues.get(name)
    if (!queue || queue.length === 0) return
    let task = queue.shift()
    while (task && task.cancelled) task = queue.shift()
    if (!task) return
    held.add(name)
    try {
      const result = await task.run()
      task.resolve(result)
    } catch (e) {
      task.reject(e)
    } finally {
      held.delete(name)
      queueMicrotask(() => void processQueue(name))
    }
  }

  return {
    request<T>(
      name: string,
      options: { mode?: 'exclusive' | 'shared'; signal?: AbortSignal },
      callback: (lock: unknown) => Promise<T>,
    ): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const task: Task = {
          run: () => callback({ name, mode: options.mode ?? 'exclusive' }),
          resolve: resolve as (v: unknown) => void,
          reject,
          signal: options.signal,
          cancelled: false,
        }

        if (options.signal) {
          if (options.signal.aborted) {
            task.cancelled = true
            const err = new Error('AbortError')
            ;(err as { name: string }).name = 'AbortError'
            reject(err)
            return
          }
          options.signal.addEventListener('abort', () => {
            task.cancelled = true
            const err = new Error('AbortError')
            ;(err as { name: string }).name = 'AbortError'
            reject(err)
          })
        }

        const q = queues.get(name) ?? []
        q.push(task)
        queues.set(name, q)
        queueMicrotask(() => void processQueue(name))
      })
    },
  }
}

/**
 * Wrap a MinimalLockManager to count concurrent leader callbacks.
 * If the wrapped value is ever > 1, mutual exclusion is broken.
 */
function trackConcurrency(inner: MinimalLockManager): MinimalLockManager & {
  acquisitions: () => number
  maxConcurrent: () => number
} {
  let concurrent = 0
  let maxConcurrent = 0
  let acquisitions = 0
  return {
    request(name, options, callback) {
      return inner.request(name, options, async (lock) => {
        acquisitions++
        concurrent++
        maxConcurrent = Math.max(maxConcurrent, concurrent)
        try {
          return await callback(lock)
        } finally {
          concurrent--
        }
      })
    },
    acquisitions: () => acquisitions,
    maxConcurrent: () => maxConcurrent,
  }
}

describe('servePeerStore({ leaderElection }) — issue #3', () => {
  it('serializes leader-callback execution across multiple servePeerStore calls', async () => {
    const tracker = trackConcurrency(createMockLocks())
    const remote = memory()

    // 3 servers all want to lead the same lock. Only one acquires at a time.
    const [a, b] = pairInMemory()
    const [, c] = pairInMemory()
    const [, d] = pairInMemory()

    const dispose1 = servePeerStore({ channel: b, store: remote, leaderElection: { lockName: 'L', locks: tracker } })
    const dispose2 = servePeerStore({ channel: c, store: remote, leaderElection: { lockName: 'L', locks: tracker } })
    const dispose3 = servePeerStore({ channel: d, store: remote, leaderElection: { lockName: 'L', locks: tracker } })

    await flushMicrotasks()

    // Exactly one server has acquired the lock; max concurrency is 1.
    expect(tracker.acquisitions()).toBe(1)
    expect(tracker.maxConcurrent()).toBe(1)

    // The leader (server 1) responds to the client; we verify by routing
    // through its dedicated pair.
    const client = peerStore({ channel: a })
    await remote.put('v', 'c', 'r1', envelope(1))
    expect(await client.get('v', 'c', 'r1')).toEqual(envelope(1))

    client.dispose()
    dispose1()
    dispose2()
    dispose3()
  })

  it('hands leadership to the next waiter when the leader is disposed', async () => {
    const tracker = trackConcurrency(createMockLocks())
    const remote = memory()

    const [, b] = pairInMemory()
    const [, c] = pairInMemory()
    const [, d] = pairInMemory()

    const dispose1 = servePeerStore({ channel: b, store: remote, leaderElection: { lockName: 'L', locks: tracker } })
    const dispose2 = servePeerStore({ channel: c, store: remote, leaderElection: { lockName: 'L', locks: tracker } })
    const dispose3 = servePeerStore({ channel: d, store: remote, leaderElection: { lockName: 'L', locks: tracker } })

    await flushMicrotasks()
    expect(tracker.acquisitions()).toBe(1)

    // Disposing the leader releases the lock; the next waiter takes over.
    dispose1()
    await flushMicrotasks()
    expect(tracker.acquisitions()).toBe(2)
    expect(tracker.maxConcurrent()).toBe(1)

    dispose2()
    await flushMicrotasks()
    expect(tracker.acquisitions()).toBe(3)
    expect(tracker.maxConcurrent()).toBe(1)

    dispose3()
  })

  it('non-leader servers do not respond to RPC', async () => {
    const locks = createMockLocks()
    const remote = memory()
    await remote.put('v', 'c', 'r1', envelope(1))

    // Server 1 acquires the lock first (it's queued first); servers 2 and 3 wait.
    const [client1Ch, server1Ch] = pairInMemory()
    const [client2Ch, server2Ch] = pairInMemory()
    const [client3Ch, server3Ch] = pairInMemory()

    const dispose1 = servePeerStore({ channel: server1Ch, store: remote, leaderElection: { lockName: 'L', locks } })
    const dispose2 = servePeerStore({ channel: server2Ch, store: remote, leaderElection: { lockName: 'L', locks } })
    const dispose3 = servePeerStore({ channel: server3Ch, store: remote, leaderElection: { lockName: 'L', locks } })

    await flushMicrotasks()

    // Server 1 (leader) answers normally.
    const client1 = peerStore({ channel: client1Ch })
    expect(await client1.get('v', 'c', 'r1')).toEqual(envelope(1))

    // Servers 2 and 3 are queued behind the lock — their channels have no
    // RPC handler attached. A call there will hang until timeout.
    const client2 = peerStore({ channel: client2Ch, timeoutMs: 50 })
    await expect(client2.get('v', 'c', 'r1')).rejects.toThrow(/timed out/)

    const client3 = peerStore({ channel: client3Ch, timeoutMs: 50 })
    await expect(client3.get('v', 'c', 'r1')).rejects.toThrow(/timed out/)

    client1.dispose()
    client2.dispose()
    client3.dispose()
    dispose1()
    dispose2()
    dispose3()
  })

  it('dispose before lock is acquired aborts the wait without error', async () => {
    const tracker = trackConcurrency(createMockLocks())
    const remote = memory()

    const [, b] = pairInMemory()
    const [, c] = pairInMemory()

    // Server 1 gets the lock first.
    const dispose1 = servePeerStore({ channel: b, store: remote, leaderElection: { lockName: 'L', locks: tracker } })
    // Server 2 is queued.
    const dispose2 = servePeerStore({ channel: c, store: remote, leaderElection: { lockName: 'L', locks: tracker } })

    await flushMicrotasks()
    expect(tracker.acquisitions()).toBe(1)

    // Dispose server 2 BEFORE it acquires. Should not throw, should not deadlock.
    dispose2()
    await flushMicrotasks()
    // Still only one acquisition — server 2's queued wait was cancelled.
    expect(tracker.acquisitions()).toBe(1)

    // After server 1 disposes, no waiters are left — the lock is released cleanly.
    dispose1()
    await flushMicrotasks()
    expect(tracker.acquisitions()).toBe(1)
  })

  it('default behaviour (no leaderElection) is unchanged — single tab serves immediately', async () => {
    const remote = memory()
    await remote.put('v', 'c', 'r1', envelope(1))

    const [a, b] = pairInMemory()
    const dispose = servePeerStore({ channel: b, store: remote })
    const client = peerStore({ channel: a })

    expect(await client.get('v', 'c', 'r1')).toEqual(envelope(1))

    client.dispose()
    dispose()
  })

  it('throws a clear error if leaderElection is set but no locks impl is available', () => {
    // We can only test this in environments without `navigator.locks`. Vitest
    // typically runs in Node so `navigator` is undefined; if the test runner
    // sets up a happy-dom or jsdom env that DOES include navigator.locks we
    // skip. The point of the test is to verify the error message is helpful.
    const navAny = (globalThis as { navigator?: { locks?: unknown } }).navigator
    if (navAny && navAny.locks) {
      // Environment polyfills navigator.locks; skip.
      return
    }
    const remote = memory()
    const [, b] = pairInMemory()
    expect(() =>
      servePeerStore({ channel: b, store: remote, leaderElection: { lockName: 'L' } }),
    ).toThrow(/Web Locks API/)
  })
})
