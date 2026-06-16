import { describe, it, expect } from 'vitest'
import { CrossVaultLive } from '../src/federation/cross-vault-live.js'

function fakeEmitter() {
  const hs = new Set<(e: any) => void>()
  return {
    subscribe: (h: (e: any) => void) => { hs.add(h); return () => hs.delete(h) },
    fire: (e: any) => { for (const h of hs) h(e) },
  }
}
const tick = () => new Promise<void>((r) => setTimeout(r, 0))

it('computes initial snapshot, updates on relevant change, single-flights, stops', async () => {
  const em = fakeEmitter()
  let n = 0
  const core = new CrossVaultLive<number>({
    subscribeToChanges: em.subscribe,
    isRelevant: (e) => e.relevant === true,
    compute: async () => { await tick(); return ++n },
    initialSnapshot: 0,
    debounceMs: 0,
  })
  expect(core.snapshot).toBe(0)              // initial, before first settle
  await core.ready                            // first compute settled
  expect(core.snapshot).toBe(1)

  let fired = 0
  const off = core.subscribe(() => { fired++ })
  em.fire({ relevant: false })                // ignored
  await tick(); await tick()
  expect(core.snapshot).toBe(1)
  em.fire({ relevant: true })
  await new Promise((r) => setTimeout(r, 5))
  expect(core.snapshot).toBe(2)
  expect(fired).toBeGreaterThanOrEqual(1)

  off(); core.stop()
  em.fire({ relevant: true })
  await new Promise((r) => setTimeout(r, 5))
  expect(core.snapshot).toBe(2)              // stopped → no recompute
})
