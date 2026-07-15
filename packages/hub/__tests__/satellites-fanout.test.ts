/**
 * Fan-out writes with revert hardening (#591, Task 6): `joinedPut`/`pairDelete`
 * split/order writes across a base↔satellite pair and best-effort revert +
 * compensate every already-executed leg on failure.
 *
 * `vault.joined()` is Task 7 — not built yet. `joinedPut`/`pairDelete` are
 * driven directly with a hand-built `FanoutDeps`, whose `base()`/`satellite()`
 * accessors return the (possibly proxied) handles straight from
 * `vault.collection(...)` — unwrapping happens inside `fanout.ts` itself, the
 * same as the production base-proxy wiring (`makeBaseProxy` in `proxy.ts`),
 * exercised here through the public API for the pair-delete tests.
 *
 * Fixture pattern (spy store, `db.openVault`) copied from
 * satellites-proxy.test.ts / satellites-registration.test.ts.
 */
import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { createNoydb } from '../src/kernel/noydb.js'
import { withSync } from '../src/with-party/sync/index.js'
import type { NoydbStore, EncryptedEnvelope, ChangeEvent, VaultSnapshot } from '../src/kernel/types.js'
import type { StandardSchemaV1 } from '../src/kernel/schema.js'
import { joinedPut, pairDelete } from '../src/with-shape/satellites/fanout.js'
import type { FanoutDeps } from '../src/with-shape/satellites/fanout.js'

const SECRET = 'satellite-fanout-test-1234'

interface Msg extends Record<string, unknown> {
  from?: string
  subject?: string
  body?: unknown
}

/** In-memory store instrumented with put/delete ordering + one-shot failure injection. */
function spyMemory() {
  const data = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const gc = (v: string, c: string): Map<string, EncryptedEnvelope> => {
    let comp = data.get(v); if (!comp) { comp = new Map(); data.set(v, comp) }
    let coll = comp.get(c); if (!coll) { coll = new Map(); comp.set(c, coll) }
    return coll
  }
  const putOrder: Array<[string, string]> = []
  const deleteOrder: Array<[string, string]> = []
  let failPut: string | null = null
  let failDelete: string | null = null
  const store: NoydbStore = {
    async get(v, c, id) { return data.get(v)?.get(c)?.get(id) ?? null },
    async put(v, c, id, env) {
      if (failPut === c) { failPut = null; throw new Error(`spy: forced put failure for "${c}"`) }
      putOrder.push([c, id])
      gc(v, c).set(id, env)
    },
    async delete(v, c, id) {
      if (failDelete === c) { failDelete = null; throw new Error(`spy: forced delete failure for "${c}"`) }
      deleteOrder.push([c, id])
      gc(v, c).delete(id)
    },
    async list(v, c) { const coll = data.get(v)?.get(c); return coll ? [...coll.keys()] : [] },
    async loadAll(v) {
      const comp = data.get(v); const s: VaultSnapshot = {}
      if (comp) for (const [n, coll] of comp) { if (!n.startsWith('_')) { const r: Record<string, EncryptedEnvelope> = {}; for (const [id, e] of coll) r[id] = e; s[n] = r } }
      return s
    },
    async saveAll(v, recs) {
      for (const [n, byId] of Object.entries(recs)) { const coll = gc(v, n); for (const [id, e] of Object.entries(byId)) coll.set(id, e) }
    },
  }
  return {
    store, putOrder, deleteOrder,
    failNextPutFor: (c: string): void => { failPut = c },
    failNextDeleteFor: (c: string): void => { failDelete = c },
    reset: (): void => { putOrder.length = 0; deleteOrder.length = 0 },
  }
}

async function openPair(opts?: { satelliteSchema?: z.ZodTypeAny }) {
  const local = spyMemory()
  const remote = spyMemory().store // a real sync target so `onDirty` is wired to a real SyncEngine
  const db = await createNoydb({ store: local.store, sync: remote, user: 'alice', secret: SECRET, syncStrategy: withSync() })
  const vault = await db.openVault('v1')
  vault.collection<Msg>('msgs', {})
  vault.collection<Msg>('msgs_text', {
    satelliteOf: 'msgs',
    fields: ['subject', 'body'],
    ...(opts?.satelliteSchema !== undefined ? { schema: opts.satelliteSchema as unknown as StandardSchemaV1<unknown, Msg> } : {}),
  })

  const changeLog: ChangeEvent[] = []
  db.on('change', (e) => changeLog.push(e))

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const engine = (db as any).syncEngines.get('v1') as { dirty: Array<{ collection: string; id: string }> }

  // Filter out internal bookkeeping writes (_keyring, _meta, _sync, …) —
  // the spy exists to observe ordering on the pair's own two collections.
  const pairOnly = (entries: Array<[string, string]>): Array<[string, string]> =>
    entries.filter(([c]) => c === 'msgs' || c === 'msgs_text')
  const spy = {
    get putOrder() { return pairOnly(local.putOrder) },
    get deleteOrder() { return pairOnly(local.deleteOrder) },
    failNextPutFor: local.failNextPutFor,
    failNextDeleteFor: local.failNextDeleteFor,
    reset: local.reset,
    raw: local.store,
  }
  const dirtyLog = {
    entriesFor: (collection: string, id: string) => engine.dirty.filter(d => d.collection === collection && d.id === id),
  }
  const changes = {
    last: (collection: string): ChangeEvent | null => [...changeLog].reverse().find(e => e.collection === collection) ?? null,
  }
  const deps = (): FanoutDeps => ({
    spec: { base: 'msgs', satellite: 'msgs_text', fields: ['subject', 'body'] },
    base: () => vault.collection<Msg>('msgs'),
    satellite: () => vault.collection<Msg>('msgs_text'),
    adapter: local.store,
    vaultName: 'v1',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registry: (vault as any).satelliteRegistry,
  })

  return { vault, spy, dirtyLog, changes, deps }
}

describe('joined fan-out', () => {
  it('splits by the fields routing table and writes base leg first', async () => {
    const { vault, spy, deps } = await openPair()
    await joinedPut(deps(), 'x', { from: 'a', subject: 's', body: 'B' })
    expect(spy.putOrder).toEqual([['msgs', 'x'], ['msgs_text', 'x']])
    expect(await vault.collection<Msg>('msgs').get('x')).toEqual({ from: 'a' })
    expect((await vault.collection<Msg>('msgs_text').get('x'))?.body).toBe('B')
  })

  it('pre-validates both legs: an invalid satellite field aborts with ZERO adapter writes', async () => {
    const satelliteSchema = z.object({ subject: z.string().optional(), body: z.string() })
    const { spy, deps } = await openPair({ satelliteSchema })
    await expect(joinedPut(deps(), 'x', { from: 'a', body: 42 })).rejects.toThrow()
    expect(spy.putOrder).toEqual([])
  })

  it('satellite-leg adapter failure: base leg reverted, compensating change emitted, no dirty entry survives', async () => {
    const { spy, dirtyLog, changes, deps } = await openPair()
    spy.failNextPutFor('msgs_text')
    await expect(joinedPut(deps(), 'x', { from: 'a', body: 'B' })).rejects.toThrow()
    expect(await spy.raw.get('v1', 'msgs', 'x')).toBeNull() // prior (absent) restored
    expect(dirtyLog.entriesFor('msgs', 'x')).toEqual([]) // dirty entry removed
    // Compensation announces the RESTORED state with the public action
    // vocabulary: prior was absent, so the event is a plain 'delete'.
    expect(changes.last('msgs')).toMatchObject({ id: 'x', action: 'delete' })
  })

  it('#596: a satellite leg whose write THROWS must not drop a PRE-EXISTING dirty entry for the same id', async () => {
    const { vault, spy, dirtyLog, deps } = await openPair()
    // A legitimate, unsynced direct write to msgs_text/x — NOT part of the
    // fan-out about to fail. This is the dirty entry the bug drops.
    await vault.collection<Msg>('msgs').put('x', { from: 'a' })
    await vault.collection<Msg>('msgs_text').put('x', { subject: 's0', body: 'B0' })
    expect(dirtyLog.entriesFor('msgs_text', 'x')).toHaveLength(1)

    spy.failNextPutFor('msgs_text')
    await expect(joinedPut(deps(), 'x', { from: 'a2', subject: 's2', body: 'B2' })).rejects.toThrow()

    // The satellite leg's put never landed (it threw), so it must not be
    // treated as a write that needs dirty-compensation on revert — the
    // pre-existing legitimate dirty entry must survive.
    expect(dirtyLog.entriesFor('msgs_text', 'x')).toHaveLength(1)
    expect((await vault.collection<Msg>('msgs_text').get('x'))?.body).toBe('B0') // unchanged
  })

  it('pair delete removes the satellite leg first; failure reverts', async () => {
    const { vault, spy, changes, deps, dirtyLog } = await openPair()
    await joinedPut(deps(), 'x', { from: 'a', body: 'B' })
    spy.reset()
    await vault.collection<Msg>('msgs').delete('x') // through the public base-proxy delete override
    // #589: under sync, delete() writes a version-ordered marker via adapter.put
    // (not adapter.delete), so the ordering now shows up on putOrder.
    expect(spy.putOrder).toEqual([['msgs_text', 'x'], ['msgs', 'x']])

    await joinedPut(deps(), 'y', { from: 'b', body: 'C' })
    const priorEnvelope = await spy.raw.get('v1', 'msgs_text', 'y') // envelope to be restored
    // subscribe() must see the compensation as a hydrated 'put' with the
    // restored record — not a misrouted 'delete' (record: null).
    const subEvents: Array<{ type: string; id: string; record: Msg | null }> = []
    vault.collection<Msg>('msgs_text').subscribe(e => subEvents.push(e))
    // #589: the base leg's delete-under-sync is itself a `put` (the marker), so
    // the fault injection must target put, not delete, to exercise the revert.
    spy.failNextPutFor('msgs')
    await expect(vault.collection<Msg>('msgs').delete('y')).rejects.toThrow()
    expect(await spy.raw.get('v1', 'msgs_text', 'y')).toEqual(priorEnvelope) // satellite ENVELOPE restored byte-for-byte
    expect(changes.last('msgs_text')).toMatchObject({ id: 'y', action: 'put' }) // restored → 'put'
    // #687: assert the dirty-log side of compensation directly (not just the
    // change-event proxy) — the reverted satellite leg's dirty entry is cleaned.
    expect(dirtyLog.entriesFor('msgs_text', 'y')).toEqual([])
    await new Promise(r => setTimeout(r, 0)) // let subscribe()'s async hydration settle
    expect(subEvents.at(-1)).toMatchObject({ type: 'put', id: 'y', record: { body: 'C' } })
  })
})
