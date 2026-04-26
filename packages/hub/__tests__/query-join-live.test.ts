/**
 * .join().live() — v0.6 #74. Merged change-stream subscription
 * over the left collection AND every right-side join target.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { createNoydb, type Noydb } from '../src/noydb.js'
import type {
  NoydbStore,
  EncryptedEnvelope,
  VaultSnapshot,
} from '../src/types.js'
import { ConflictError } from '../src/errors.js'
import { resetJoinWarnings } from '../src/query/index.js'
import { ref } from '../src/refs.js'

function memory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function getCollection(c: string, col: string): Map<string, EncryptedEnvelope> {
    let comp = store.get(c)
    if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col)
    if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
    name: 'memory',
    async get(c, col, id) { return store.get(c)?.get(col)?.get(id) ?? null },
    async put(c, col, id, env, ev) {
      const coll = getCollection(c, col)
      const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      coll.set(id, env)
    },
    async delete(c, col, id) { store.get(c)?.get(col)?.delete(id) },
    async list(c, col) {
      const coll = store.get(c)?.get(col)
      return coll ? [...coll.keys()] : []
    },
    async loadAll(c) {
      const comp = store.get(c)
      const snapshot: VaultSnapshot = {}
      if (comp) for (const [n, coll] of comp) {
        if (!n.startsWith('_')) {
          const r: Record<string, EncryptedEnvelope> = {}
          for (const [id, e] of coll) r[id] = e
          snapshot[n] = r
        }
      }
      return snapshot
    },
    async saveAll(c, data) {
      const comp = new Map<string, Map<string, EncryptedEnvelope>>()
      for (const [name, records] of Object.entries(data)) {
        const coll = new Map<string, EncryptedEnvelope>()
        for (const [id, env] of Object.entries(records)) coll.set(id, env)
        comp.set(name, coll)
      }
      const existing = store.get(c)
      if (existing) {
        for (const [name, coll] of existing) {
          if (name.startsWith('_')) comp.set(name, coll)
        }
      }
      store.set(c, comp)
    },
  }
}

interface Client { id: string; name: string; tier: 'standard' | 'premium' }
interface Invoice {
  id: string
  amount: number
  status: 'open' | 'paid'
  clientId: string | null
}
type JoinedRow = Invoice & { client: Client | null }

describe('Query.live() with .join() — v0.6 #74', () => {
  let db: Noydb

  beforeEach(async () => {
    db = await createNoydb({
      store: memory(),
      user: 'owner',
      secret: 'live-join-test-passphrase-2026',
    })
    resetJoinWarnings()
  })

  afterEach(() => {
    resetJoinWarnings()
  })

  // ─── Initial value + tear-down basics ───────────────────────────

  it('initial .live() value reflects current state including joins', async () => {
    const c = await db.openVault('TEST')
    const clients = c.collection<Client>('clients')
    const invoices = c.collection<Invoice>('invoices', {
      refs: { clientId: ref('clients') },
    })
    await clients.put('cli-A', { id: 'cli-A', name: 'Acme', tier: 'premium' })
    await invoices.put('inv-1', { id: 'inv-1', amount: 100, status: 'open', clientId: 'cli-A' })

    const live = invoices.query()
      .join<'client', Client>('clientId', { as: 'client' })
      .live()

    expect(live.value).toHaveLength(1)
    expect((live.value[0] as JoinedRow).client?.name).toBe('Acme')
    expect(live.error).toBeNull()
    live.stop()
  })

  it('stop() is idempotent and silences further notifications', async () => {
    const c = await db.openVault('TEST')
    const clients = c.collection<Client>('clients')
    const invoices = c.collection<Invoice>('invoices', {
      refs: { clientId: ref('clients') },
    })
    await clients.put('cli-A', { id: 'cli-A', name: 'Acme', tier: 'premium' })
    await invoices.put('inv-1', { id: 'inv-1', amount: 100, status: 'open', clientId: 'cli-A' })

    const live = invoices.query()
      .join<'client', Client>('clientId', { as: 'client' })
      .live()

    let callCount = 0
    live.subscribe(() => { callCount++ })

    live.stop()
    live.stop()  // idempotent

    // Mutation after stop should NOT fire the listener.
    await invoices.put('inv-2', { id: 'inv-2', amount: 200, status: 'open', clientId: 'cli-A' })
    expect(callCount).toBe(0)
  })

  // ─── Left-side mutations re-fire ────────────────────────────────

  it('insert on the left collection re-fires the live query', async () => {
    const c = await db.openVault('TEST')
    const clients = c.collection<Client>('clients')
    const invoices = c.collection<Invoice>('invoices', {
      refs: { clientId: ref('clients') },
    })
    await clients.put('cli-A', { id: 'cli-A', name: 'Acme', tier: 'premium' })
    await invoices.put('inv-1', { id: 'inv-1', amount: 100, status: 'open', clientId: 'cli-A' })

    const live = invoices.query()
      .join<'client', Client>('clientId', { as: 'client' })
      .live()

    let notifications = 0
    live.subscribe(() => { notifications++ })

    expect(live.value).toHaveLength(1)
    await invoices.put('inv-2', { id: 'inv-2', amount: 250, status: 'open', clientId: 'cli-A' })
    expect(notifications).toBeGreaterThanOrEqual(1)
    expect(live.value).toHaveLength(2)
    expect((live.value[1] as JoinedRow).client?.name).toBe('Acme')
    live.stop()
  })

  it('update on the left collection re-fires with the new joined data', async () => {
    const c = await db.openVault('TEST')
    const clients = c.collection<Client>('clients')
    const invoices = c.collection<Invoice>('invoices', {
      refs: { clientId: ref('clients') },
    })
    await clients.put('cli-A', { id: 'cli-A', name: 'Acme', tier: 'premium' })
    await clients.put('cli-B', { id: 'cli-B', name: 'Beacon', tier: 'standard' })
    await invoices.put('inv-1', { id: 'inv-1', amount: 100, status: 'open', clientId: 'cli-A' })

    const live = invoices.query()
      .join<'client', Client>('clientId', { as: 'client' })
      .live()
    expect((live.value[0] as JoinedRow).client?.name).toBe('Acme')

    // Update the invoice to point at a different client.
    await invoices.put('inv-1', { id: 'inv-1', amount: 100, status: 'open', clientId: 'cli-B' })
    expect((live.value[0] as JoinedRow).client?.name).toBe('Beacon')
    live.stop()
  })

  it('delete on the left collection re-fires with fewer rows', async () => {
    const c = await db.openVault('TEST')
    const clients = c.collection<Client>('clients')
    const invoices = c.collection<Invoice>('invoices', {
      refs: { clientId: ref('clients') },
    })
    await clients.put('cli-A', { id: 'cli-A', name: 'Acme', tier: 'premium' })
    await invoices.put('inv-1', { id: 'inv-1', amount: 100, status: 'open', clientId: 'cli-A' })
    await invoices.put('inv-2', { id: 'inv-2', amount: 200, status: 'open', clientId: 'cli-A' })

    const live = invoices.query()
      .join<'client', Client>('clientId', { as: 'client' })
      .live()
    expect(live.value).toHaveLength(2)

    await invoices.delete('inv-1')
    expect(live.value).toHaveLength(1)
    expect((live.value[0] as JoinedRow).id).toBe('inv-2')
    live.stop()
  })

  // ─── Right-side mutations re-fire (the #74 core feature) ────────

  it('insert on the right collection updates the joined value for dependent rows', async () => {
    const c = await db.openVault('TEST')
    const clients = c.collection<Client>('clients', {})
    const invoices = c.collection<Invoice>('invoices', {
      refs: { clientId: ref('clients', 'warn') },
    })
    // Touch clients so its cache hydrates and querySourceForJoin sees it.
    await clients.list()
    // Plant an invoice with a dangling clientId initially.
    await invoices.put('inv-1', { id: 'inv-1', amount: 100, status: 'open', clientId: 'cli-A' })

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const live = invoices.query()
      .join<'client', Client>('clientId', { as: 'client' })
      .live()
    // Initially dangling — null + warn (warn mode).
    expect((live.value[0] as JoinedRow).client).toBeNull()

    // Now insert the missing client. Live should re-fire and resolve.
    await clients.put('cli-A', { id: 'cli-A', name: 'Acme', tier: 'premium' })
    expect((live.value[0] as JoinedRow).client?.name).toBe('Acme')
    expect(live.error).toBeNull()

    warnSpy.mockRestore()
    live.stop()
  })

  it('update on the right collection updates the joined value for dependent rows', async () => {
    const c = await db.openVault('TEST')
    const clients = c.collection<Client>('clients')
    const invoices = c.collection<Invoice>('invoices', {
      refs: { clientId: ref('clients') },
    })
    await clients.put('cli-A', { id: 'cli-A', name: 'Acme', tier: 'standard' })
    await invoices.put('inv-1', { id: 'inv-1', amount: 100, status: 'open', clientId: 'cli-A' })
    await invoices.put('inv-2', { id: 'inv-2', amount: 200, status: 'open', clientId: 'cli-A' })

    const live = invoices.query()
      .join<'client', Client>('clientId', { as: 'client' })
      .live()
    expect((live.value[0] as JoinedRow).client?.tier).toBe('standard')
    expect((live.value[1] as JoinedRow).client?.tier).toBe('standard')

    // Promote the client to premium — both invoices should reflect.
    await clients.put('cli-A', { id: 'cli-A', name: 'Acme', tier: 'premium' })
    expect((live.value[0] as JoinedRow).client?.tier).toBe('premium')
    expect((live.value[1] as JoinedRow).client?.tier).toBe('premium')
    live.stop()
  })

  it('delete on the right collection in warn mode flips joined value to null', async () => {
    const c = await db.openVault('TEST')
    const clients = c.collection<Client>('clients')
    const invoices = c.collection<Invoice>('invoices', {
      refs: { clientId: ref('clients', 'warn') },
    })
    await clients.put('cli-A', { id: 'cli-A', name: 'Acme', tier: 'premium' })
    await invoices.put('inv-1', { id: 'inv-1', amount: 100, status: 'open', clientId: 'cli-A' })

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const live = invoices.query()
      .join<'client', Client>('clientId', { as: 'client' })
      .live()
    expect((live.value[0] as JoinedRow).client?.name).toBe('Acme')

    // Delete the client out-of-band (warn mode allows this without
    // deleting the invoice).
    await clients.delete('cli-A')
    expect((live.value[0] as JoinedRow).client).toBeNull()
    expect(live.error).toBeNull()
    warnSpy.mockRestore()
    live.stop()
  })

  // ─── Ref-mode behavior on right-side disappearance ──────────────
  //
  // Strict-mode dangling at read time is verified in query-join.test.ts
  // for the eager .toArray() path. The .live() path uses the same
  // recompute (it just wraps the call in try/catch and stores any
  // throw in `live.error`), and the throwing-filter test below
  // exercises the same try/catch with a synthetic throw — together
  // they cover the strict-mode live error path without needing to
  // bypass the put-time strict enforcement that would otherwise
  // prevent us from constructing a dangling state.

  it('cascade mode: right-side delete propagates and live re-fires with fewer rows', async () => {
    const c = await db.openVault('TEST')
    const clients = c.collection<Client>('clients')
    const invoices = c.collection<Invoice>('invoices', {
      refs: { clientId: ref('clients', 'cascade') },
    })
    await clients.put('cli-A', { id: 'cli-A', name: 'Acme', tier: 'premium' })
    await clients.put('cli-B', { id: 'cli-B', name: 'Beacon', tier: 'standard' })
    await invoices.put('inv-1', { id: 'inv-1', amount: 100, status: 'open', clientId: 'cli-A' })
    await invoices.put('inv-2', { id: 'inv-2', amount: 200, status: 'open', clientId: 'cli-B' })

    const live = invoices.query()
      .orderBy('id')
      .join<'client', Client>('clientId', { as: 'client' })
      .live()
    expect(live.value).toHaveLength(2)

    // Delete cli-A → cascade deletes inv-1 → live re-fires with only inv-2.
    await clients.delete('cli-A')
    expect(live.value).toHaveLength(1)
    expect((live.value[0] as JoinedRow).id).toBe('inv-2')
    expect((live.value[0] as JoinedRow).client?.name).toBe('Beacon')
    live.stop()
  })

  // ─── Multiple subscribers + dedup of right-side targets ─────────

  it('subscribers receive notifications for both left and right mutations', async () => {
    const c = await db.openVault('TEST')
    const clients = c.collection<Client>('clients')
    const invoices = c.collection<Invoice>('invoices', {
      refs: { clientId: ref('clients') },
    })
    await clients.put('cli-A', { id: 'cli-A', name: 'Acme', tier: 'standard' })
    await invoices.put('inv-1', { id: 'inv-1', amount: 100, status: 'open', clientId: 'cli-A' })

    const live = invoices.query()
      .join<'client', Client>('clientId', { as: 'client' })
      .live()

    let notifications = 0
    const stop1 = live.subscribe(() => { notifications++ })

    // Right-side update.
    await clients.put('cli-A', { id: 'cli-A', name: 'Acme', tier: 'premium' })
    const afterRight = notifications

    // Left-side insert.
    await invoices.put('inv-2', { id: 'inv-2', amount: 200, status: 'open', clientId: 'cli-A' })
    expect(notifications).toBeGreaterThan(afterRight)

    stop1()
    live.stop()
  })

  it('non-joined .live() works as a plain reactive query', async () => {
    const c = await db.openVault('TEST')
    const invoices = c.collection<Invoice>('invoices')
    await invoices.put('inv-1', { id: 'inv-1', amount: 100, status: 'open', clientId: null })

    const live = invoices.query()
      .where('status', '==', 'open')
      .live()
    expect(live.value).toHaveLength(1)

    let notifications = 0
    live.subscribe(() => { notifications++ })

    await invoices.put('inv-2', { id: 'inv-2', amount: 200, status: 'open', clientId: null })
    expect(live.value).toHaveLength(2)
    expect(notifications).toBeGreaterThanOrEqual(1)
    live.stop()
  })

  it('error preserves the previous value (does not flash to empty)', async () => {
    const c = await db.openVault('TEST')
    const invoices = c.collection<Invoice>('invoices')
    await invoices.put('inv-1', { id: 'inv-1', amount: 100, status: 'open', clientId: null })

    // A query with a thrown filter to simulate an error after success.
    let shouldThrow = false
    const live = invoices.query()
      .filter((r: Invoice) => {
        if (shouldThrow) throw new Error('boom')
        return r.amount > 0
      })
      .live()

    expect(live.value).toHaveLength(1)
    expect(live.error).toBeNull()

    // Trigger a re-run with the throwing filter.
    shouldThrow = true
    await invoices.put('inv-2', { id: 'inv-2', amount: 200, status: 'open', clientId: null })

    // Previous value preserved, error populated.
    expect(live.error).not.toBeNull()
    expect(live.error?.message).toContain('boom')
    expect(live.value).toHaveLength(1)  // last good state
    live.stop()
  })
})
