/**
 * End-to-end injection test for the #469 coordination port.
 *
 * Proves the seam works from the outside: a custom `CoordinationProvider`
 * passed via `createNoydb({ coordinationStrategy })` is the instance the
 * `Noydb` handle exposes AND is the one the schema fence actually dispatches
 * through (setFence / reportPresence / reachableWriters / readFence), not the
 * built-in `StoreCoordinationProvider` default. This is the contract
 * `@klum-db/lobby` binds to via `@noy-db/hub/cargo`.
 */
import { describe, expect, it, expectTypeOf } from 'vitest'
import { z } from 'zod'
import { createNoydb } from '../src/kernel/noydb.js'
import { toMemory } from '../../to-memory/src/index.js'
import { coordinatedCutover, additiveOnly } from '../src/with-shape/schema-update/index.js'
import {
  type CoordinationProvider,
  type FenceState,
  type WriterPresence,
} from '../src/port/by/index.js'
import { StoreCoordinationProvider } from '../src/with-shape/schema-update/store-coordination-provider.js'
import type { NoydbStore } from '../src/kernel/types.js'
import type { Unsubscribe } from '../src/port/with/write-hooks.js'

interface InvOld extends Record<string, unknown> { id: string; total: number }
interface InvNew extends Record<string, unknown> { id: string; amount: { gross: number } }

const oldSchema = z.object({ id: z.string(), total: z.number() })
const newSchema = z.object({ id: z.string(), amount: z.object({ gross: z.number() }) })
const transform = (d: Record<string, unknown>) => ({ id: d['id'], amount: { gross: d['total'] } })

/**
 * A spy `CoordinationProvider` that delegates to a real
 * `StoreCoordinationProvider` (so the fence behaves exactly as the default
 * would) while recording every method invocation. The recording is what lets
 * us prove the injected instance — not the hub default — drives the fence.
 */
class SpyProvider implements CoordinationProvider {
  readonly calls: Record<keyof CoordinationProvider, number> = {
    setFence: 0,
    readFence: 0,
    observeFence: 0,
    reportPresence: 0,
    observePresence: 0,
    reachableWriters: 0,
  }
  readonly #inner: StoreCoordinationProvider

  constructor(store: NoydbStore) {
    // Small poll interval keeps the observe* fallbacks snappy; the cutover
    // here reaches quorum on the seeded snapshot so no real polling occurs.
    this.#inner = new StoreCoordinationProvider(store, { pollIntervalMs: 5 })
  }

  async setFence(vault: string, fence: FenceState): Promise<void> {
    this.calls.setFence++
    return this.#inner.setFence(vault, fence)
  }
  async readFence(vault: string): Promise<FenceState> {
    this.calls.readFence++
    return this.#inner.readFence(vault)
  }
  observeFence(vault: string, onChange: (f: FenceState) => void): Unsubscribe {
    this.calls.observeFence++
    return this.#inner.observeFence(vault, onChange)
  }
  async reportPresence(vault: string, p: WriterPresence): Promise<void> {
    this.calls.reportPresence++
    return this.#inner.reportPresence(vault, p)
  }
  observePresence(vault: string, onChange: (w: readonly WriterPresence[]) => void): Unsubscribe {
    this.calls.observePresence++
    return this.#inner.observePresence(vault, onChange)
  }
  async reachableWriters(vault: string, o: { staleMs: number; now: number }): Promise<readonly WriterPresence[]> {
    this.calls.reachableWriters++
    return this.#inner.reachableWriters(vault, o)
  }
}

describe('coordination injection (#469)', () => {
  it('drives the INJECTED provider through a coordinatedCutover', async () => {
    const store = toMemory()

    // gen 0: seed old-shape data (fresh client, default fence — irrelevant here).
    const seedDb = await createNoydb({ store, user: 'a', secret: 'inject-e2e-pass-1234' })
    const seedVault = await seedDb.openVault('demo')
    const invoicesOld = seedVault.collection<InvOld>('invoices', { schema: oldSchema, persistJsonSchema: true })
    await seedVault._drainPendingSchemaWrites()
    await invoicesOld.put('i1', { id: 'i1', total: 100 })
    await seedDb.close()

    // Fresh client WITH the injected spy provider opens at the new schema +
    // a coordinatedCutover → registers a pending cutover + starts fence
    // coordination on this vault, all dispatching through the spy.
    const spy = new SpyProvider(store)
    const db = await createNoydb({
      store,
      user: 'a',
      secret: 'inject-e2e-pass-1234',
      coordinationStrategy: spy,
    })
    const v = await db.openVault('demo')
    const invNew = v.collection<InvNew>('invoices', {
      schema: newSchema, persistJsonSchema: true,
      schemaUpdate: [coordinatedCutover({ transform }), additiveOnly()],
    })
    await v._drainPendingSchemaWrites()

    // Drive one deterministic heartbeat/watch cycle so the per-client watcher
    // reports presence + reads the fence through the injected provider.
    await v._fenceTick()
    expect(spy.calls.reportPresence).toBeGreaterThan(0)

    // Reset the counters to scope the next assertions to the cutover itself.
    spy.calls.setFence = 0
    spy.calls.readFence = 0
    spy.calls.reachableWriters = 0

    // Single client → quorum is immediate, so the cutover completes.
    const result = await v.runSchemaCutover()
    expect(result.migrated).toBe(1)
    expect((await invNew.get('i1'))?.amount.gross).toBe(100)

    // The fence dispatched through the SPY: setFence (draining/migrating/...),
    // readFence (base generation), reachableWriters (quorum input) all fired.
    expect(spy.calls.setFence).toBeGreaterThan(0)
    expect(spy.calls.readFence).toBeGreaterThan(0)
    expect(spy.calls.reachableWriters).toBeGreaterThan(0)

    db.vault('demo')._stopFenceCoordination()
    await db.close()
  })

  it('exposes the injected instance via db.coordination (identity)', async () => {
    const store = toMemory()
    const spy = new SpyProvider(store)
    const db = await createNoydb({ store, user: 'a', secret: 'inject-identity-pass-1234', coordinationStrategy: spy })
    expect(db.coordination).toBe(spy)
    await db.close()
  })

  it('defaults to StoreCoordinationProvider when none is injected', async () => {
    const store = toMemory()
    const db = await createNoydb({ store, user: 'a', secret: 'inject-default-pass-1234' })
    expect(db.coordination).toBeInstanceOf(StoreCoordinationProvider)
    await db.close()
  })

  it('a hand-rolled object implementing the 6 methods satisfies the port (type-level)', () => {
    // Compile-time proof the port is implementable from outside the hub —
    // exactly what `@klum-db/lobby` / a `by-*` transport does. No `class`
    // needed; structural typing is the whole contract.
    const external = {
      async setFence(_v: string, _f: FenceState): Promise<void> {},
      async readFence(_v: string): Promise<FenceState> {
        return { currentSchemaVersion: 0, fenceState: 'normal' }
      },
      observeFence(_v: string, _on: (f: FenceState) => void): Unsubscribe {
        return () => {}
      },
      async reportPresence(_v: string, _p: WriterPresence): Promise<void> {},
      observePresence(_v: string, _on: (w: readonly WriterPresence[]) => void): Unsubscribe {
        return () => {}
      },
      async reachableWriters(_v: string, _o: { staleMs: number; now: number }): Promise<readonly WriterPresence[]> {
        return []
      },
    }
    expectTypeOf(external).toMatchTypeOf<CoordinationProvider>()
  })
})
