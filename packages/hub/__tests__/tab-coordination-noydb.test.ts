import { describe, expect, it } from 'vitest'
import { createNoydb } from '../src/noydb.js'
import { memory } from '../../to-memory/src/index.js'
import type { TabLockManager, TabChannel } from '../src/tab-coordination.js'

describe('db.enableTabCoordination (#228)', () => {
  it('no-op outside a browser: returns a disposer; role stays unknown', async () => {
    const db = await createNoydb({ store: memory(), user: 'a', secret: 'tab-pass-1234' })
    const handle = db.enableTabCoordination() // no navigator.locks / BroadcastChannel in node
    expect(db.tabRole).toBe('unknown')
    expect(db.activeTabs()).toEqual([])
    handle.dispose()
  })

  it('with injected lock manager + channel, becomes primary', async () => {
    const db = await createNoydb({ store: memory(), user: 'a', secret: 'tab-pass-1234' })
    let resolveCb: (() => void) | undefined
    const locks: TabLockManager = {
      async request(_n, _o, cb) { return cb(undefined) }, // acquire immediately
    }
    const channel: TabChannel = { isOpen: true, send() {}, on() { return () => {} }, close() {} }
    const handle = db.enableTabCoordination({ lockManager: locks, channel, tabId: 't1' })
    await new Promise((r) => setTimeout(r, 0))
    expect(db.tabRole).toBe('primary')
    void resolveCb
    handle.dispose()
  })
})
