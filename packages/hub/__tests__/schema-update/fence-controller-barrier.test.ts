import { describe, expect, it } from 'vitest'
import { memory } from '../../../to-memory/src/index.js'
import { SchemaFenceController } from '../../src/with-shape/schema-update/fence-controller.js'
import { loadFence, saveFence } from '../../src/with-shape/schema-update/fence.js'
import { writeClientDoc } from '../../src/with-shape/schema-update/client-registry.js'
import { StoreCoordinationProvider } from '../../src/kernel/coordination/index.js'
import { QuiesceTimeoutError } from '../../src/kernel/errors.js'

function mkCtrl(store = memory(), quiesceTimeoutMs = 10_000) {
  let t = 1000
  // Default coordination = StoreCoordinationProvider over the same store; the
  // ack-barrier behavior (and these store-level assertions) is unchanged.
  const c = new SchemaFenceController({
    coordination: new StoreCoordinationProvider(store), vault: 'v', onFlush: async () => {},
    clientId: 'migrator', now: () => t, staleMs: 500, quiesceTimeoutMs,
  })
  return { store, c, advance: (ms: number) => { t += ms }, now: () => t }
}

describe('SchemaFenceController barrier', () => {
  it('runCutover waits until the active set acks, then migrates + bumps', async () => {
    const { store, c, now } = mkCtrl()
    await c.init()
    c.registerPendingCutover('invoices', (d) => d)
    await writeClientDoc(store, 'v', 'other', { lastSeen: now(), quiescedAtVersion: null })

    const ran: string[] = []
    await c.runCutover(
      async (col) => { ran.push(col) },
      { onPoll: async () => {
          const fence = await loadFence(store, 'v')
          await writeClientDoc(store, 'v', 'other', { lastSeen: now(), quiescedAtVersion: fence.currentSchemaVersion })
        } },
    )
    expect(ran).toEqual(['invoices'])
    const fence = await loadFence(store, 'v')
    expect(fence.currentSchemaVersion).toBe(1)
    expect(fence.fenceState).toBe('normal')
  })

  it('runCutover proceeds past a stale client (never counted)', async () => {
    const { store, c } = mkCtrl()
    await c.init()
    c.registerPendingCutover('invoices', (d) => d)
    await writeClientDoc(store, 'v', 'zombie', { lastSeen: 1, quiescedAtVersion: null }) // stale at now=1000
    await c.runCutover(async () => {}, { onPoll: async () => {} })
    expect((await loadFence(store, 'v')).currentSchemaVersion).toBe(1)
  })

  it('runCutover throws QuiesceTimeoutError when an active client never acks', async () => {
    const { store, c, advance, now } = mkCtrl(memory(), 10_000)
    await c.init()
    c.registerPendingCutover('invoices', (d) => d)
    await writeClientDoc(store, 'v', 'holdout', { lastSeen: now(), quiescedAtVersion: null })
    await expect(
      c.runCutover(async () => {}, {
        onPoll: async () => {
          advance(6_000) // push past the 10s deadline over two polls
          await writeClientDoc(store, 'v', 'holdout', { lastSeen: now(), quiescedAtVersion: null }) // stays fresh, never acks
        },
      }),
    ).rejects.toBeInstanceOf(QuiesceTimeoutError)
  })

  it('abort() resets a stuck draining fence to normal without bumping', async () => {
    const { store, c } = mkCtrl()
    await c.init()
    await saveFence(store, 'v', { currentSchemaVersion: 2, fenceState: 'draining' })
    await c.abort()
    expect(await loadFence(store, 'v')).toEqual({ currentSchemaVersion: 2, fenceState: 'normal' })
  })
})
