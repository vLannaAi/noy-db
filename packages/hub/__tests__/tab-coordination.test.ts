import { describe, expect, it } from 'vitest'
import { TabCoordinator, type TabLockManager, type TabChannel } from '../src/tab-coordination.js'

/** FIFO exclusive lock manager (mirrors by-peer's createMockLocks). */
function mockLocks(): TabLockManager {
  const held = new Set<string>()
  const queues = new Map<string, Array<() => void>>()
  async function pump(name: string) {
    if (held.has(name)) return
    const q = queues.get(name) ?? []
    const next = q.shift()
    if (!next) return
    held.add(name)
    next()
  }
  return {
    request(name, _opts, cb) {
      return new Promise((resolve, reject) => {
        const run = () => {
          void Promise.resolve()
            .then(() => cb(undefined))
            .then((v) => { held.delete(name); void pump(name); resolve(v as never) },
                  (e) => { held.delete(name); void pump(name); reject(e) })
        }
        const q = queues.get(name) ?? []
        q.push(run); queues.set(name, q)
        // abort: drop from queue if still waiting
        _opts.signal?.addEventListener('abort', () => {
          const qq = queues.get(name) ?? []
          const i = qq.indexOf(run); if (i >= 0) qq.splice(i, 1)
          reject(new Error('aborted'))
        })
        void pump(name)
      })
    },
  }
}

/** In-memory broadcast bus: each channel's send() reaches all OTHER channels. */
function makeBus(n: number): TabChannel[] {
  const listeners: Array<((p: string) => void) | null> = []
  const chans: TabChannel[] = []
  for (let i = 0; i < n; i++) {
    const idx = i
    chans.push({
      isOpen: true,
      send(payload) { for (let j = 0; j < listeners.length; j++) if (j !== idx && listeners[j]) queueMicrotask(() => listeners[j]!(payload)) },
      on(event, l) { if (event === 'message') { listeners[idx] = l as (p: string) => void; return () => { listeners[idx] = null } } return () => {} },
      close() { listeners[idx] = null },
    })
  }
  return chans
}

const flush = () => new Promise((r) => setTimeout(r, 0))

function mkCoordinator(lockManager: TabLockManager, channel: TabChannel, tabId: string, now: () => number) {
  return new TabCoordinator({ lockManager, channel, tabId, heartbeatMs: 1_000_000, staleMs: 500, now })
}

describe('TabCoordinator', () => {
  it('elects exactly one primary; the rest are secondary', async () => {
    const locks = mockLocks()
    const bus = makeBus(3)
    let t = 1000
    const tabs = bus.map((ch, i) => mkCoordinator(locks, ch, `tab${i}`, () => t))
    tabs.forEach((c) => c.start())
    await flush()
    const roles = tabs.map((c) => c.role).sort()
    expect(roles.filter((r) => r === 'primary')).toHaveLength(1)
    expect(roles.filter((r) => r === 'secondary')).toHaveLength(2)
  })

  it('promotes a secondary when the primary disposes', async () => {
    const locks = mockLocks()
    const bus = makeBus(2)
    let t = 1000
    const tabs = bus.map((ch, i) => mkCoordinator(locks, ch, `tab${i}`, () => t))
    tabs.forEach((c) => c.start())
    await flush()
    const primary = tabs.find((c) => c.role === 'primary')!
    const secondary = tabs.find((c) => c.role === 'secondary')!
    primary.dispose()
    await flush()
    expect(secondary.role).toBe('primary')
  })

  it('presence: a tab sees the others; stale tabs drop out', async () => {
    const locks = mockLocks()
    const bus = makeBus(2)
    let t = 1000
    const [a, b] = bus.map((ch, i) => mkCoordinator(locks, ch, `tab${i}`, () => t))
    a!.start(); b!.start()
    await flush()
    a!._beat(); b!._beat()
    await flush()
    expect(a!.activeTabs().map((p) => p.tabId).sort()).toEqual(['tab0', 'tab1'])
    t += 10_000 // advance past staleMs; b never beats again
    a!._beat()
    await flush()
    expect(a!.activeTabs().map((p) => p.tabId)).toEqual(['tab0'])
  })

  it('emits onTabRoleChange', async () => {
    const locks = mockLocks()
    const bus = makeBus(1)
    let t = 1000
    const c = mkCoordinator(locks, bus[0]!, 'tab0', () => t)
    const seen: string[] = []
    c.onTabRoleChange((r) => seen.push(r))
    c.start()
    await flush()
    expect(seen).toContain('primary')
  })

  it('no-op when no lock manager and no channel', async () => {
    const c = new TabCoordinator({ heartbeatMs: 1_000_000, staleMs: 500, now: () => 0 })
    c.start()
    await flush()
    expect(c.role).toBe('unknown')
    expect(c.activeTabs()).toEqual([])
    c.dispose()
  })

  it('disposing a tab does not broadcast a phantom heartbeat', async () => {
    const locks = mockLocks()
    const bus = makeBus(2)
    let t = 1000
    const [a, b] = bus.map((ch, i) => mkCoordinator(locks, ch, `tab${i}`, () => t))
    a!.start(); b!.start()
    await flush()
    a!._beat(); b!._beat()
    await flush()
    b!.dispose()
    await flush()
    // No phantom 'unknown' refresh into a's view of tab1.
    const after = a!.activeTabs().find((p) => p.tabId === 'tab1')
    expect(after?.role).not.toBe('unknown')
  })

  it('goes inert (role unknown) when the channel closes', async () => {
    const locks = mockLocks()
    let closeListener: (() => void) | undefined
    const channel: TabChannel = {
      isOpen: true,
      send() {},
      on(event, l) {
        if (event === 'close') { closeListener = l as () => void; return () => { closeListener = undefined } }
        return () => {}
      },
      close() {},
    }
    let t = 1000
    const c = new TabCoordinator({ lockManager: locks, channel, tabId: 't0', heartbeatMs: 1_000_000, staleMs: 500, now: () => t })
    c.start()
    await flush()
    expect(c.role).toBe('primary')
    closeListener?.()
    expect(c.role).toBe('unknown')
    c.dispose()
  })

  it('emits onActiveTabsChange when a peer appears', async () => {
    const locks = mockLocks()
    const bus = makeBus(2)
    let t = 1000
    const [a, b] = bus.map((ch, i) => mkCoordinator(locks, ch, `tab${i}`, () => t))
    const seen: number[] = []
    a!.onActiveTabsChange((tabs) => seen.push(tabs.length))
    a!.start(); b!.start()
    await flush()
    b!._beat()
    await flush()
    expect(seen.some((n) => n >= 2)).toBe(true)
  })

  it('closes the channel on dispose only when it owns it', async () => {
    const locks = mockLocks()
    let ownedClosed = 0
    const ownedCh: TabChannel = { isOpen: true, send() {}, on() { return () => {} }, close() { ownedClosed++ } }
    const owned = new TabCoordinator({ lockManager: locks, channel: ownedCh, tabId: 'o', closeChannelOnDispose: true, heartbeatMs: 1_000_000, staleMs: 500, now: () => 0 })
    owned.start(); await flush(); owned.dispose()
    expect(ownedClosed).toBe(1)

    let injectedClosed = 0
    const injectedCh: TabChannel = { isOpen: true, send() {}, on() { return () => {} }, close() { injectedClosed++ } }
    const injected = new TabCoordinator({ lockManager: locks, channel: injectedCh, tabId: 'i', heartbeatMs: 1_000_000, staleMs: 500, now: () => 0 })
    injected.start(); await flush(); injected.dispose()
    expect(injectedClosed).toBe(0)
  })
})
