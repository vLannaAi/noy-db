/**
 * JoinedHandle + vault.joined() (#591, Task 7): the full-record access point
 * for a base↔satellite pair declared with `joined:`. Reads merge base ⊕
 * satellite under existence authority (rule 1); writes/deletes delegate to
 * the Task 6 fan-out (`joinedPut`/`pairDelete`). Deliberately narrow — no
 * reactive members.
 *
 * Fixture pattern (spy store, `db.openVault`) copied from
 * satellites-fanout.test.ts.
 */
import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { createNoydb } from '../src/kernel/noydb.js'
import { withSync } from '../src/with-sync/index.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { SatelliteConfigError } from '../src/kernel/errors.js'

const SECRET = 'satellite-joined-test-1234'

interface Msg extends Record<string, unknown> {
  from?: string
  subject?: string
  body?: string
}

/** In-memory store instrumented with delete ordering (copied from satellites-fanout.test.ts). */
function spyMemory() {
  const data = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const gc = (v: string, c: string): Map<string, EncryptedEnvelope> => {
    let comp = data.get(v); if (!comp) { comp = new Map(); data.set(v, comp) }
    let coll = comp.get(c); if (!coll) { coll = new Map(); comp.set(c, coll) }
    return coll
  }
  const deleteOrder: Array<[string, string]> = []
  const putOrder: Array<[string, string]> = []
  const store: NoydbStore = {
    async get(v, c, id) { return data.get(v)?.get(c)?.get(id) ?? null },
    async put(v, c, id, env) { putOrder.push([c, id]); gc(v, c).set(id, env) },
    async delete(v, c, id) { deleteOrder.push([c, id]); gc(v, c).delete(id) },
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
  return { store, deleteOrder, putOrder, reset: (): void => { deleteOrder.length = 0; putOrder.length = 0 } }
}

async function openPair() {
  const local = spyMemory()
  const remote = spyMemory().store // a real sync target so onDirty is wired to a real SyncEngine
  const db = await createNoydb({ store: local.store, sync: remote, user: 'alice', secret: SECRET, syncStrategy: withSync() })
  const vault = await db.openVault('v1')
  vault.collection<Msg>('msgs', { fieldMeta: { from: { label: 'From' } } })
  vault.collection<Msg>('msgs_text', {
    satelliteOf: 'msgs',
    fields: ['subject', 'body'],
    joined: 'msgs_full',
    fieldMeta: { subject: { label: 'Subject' }, body: { label: 'Body' } },
  })

  const pairOnly = (entries: Array<[string, string]>): Array<[string, string]> =>
    entries.filter(([c]) => c === 'msgs' || c === 'msgs_text')
  const spy = {
    get deleteOrder() { return pairOnly(local.deleteOrder) },
    get putOrder() { return pairOnly(local.putOrder) },
    reset: local.reset,
  }
  return { vault, rawStore: local.store, spy }
}

describe('JoinedHandle', () => {
  it('get merges base ⊕ satellite; absent satellite reads all-null for declared fields', async () => {
    const { vault } = await openPair()
    await vault.collection<Msg>('msgs').put('x', { from: 'a' })
    expect(await vault.joined<Msg>('msgs_full').get('x')).toEqual({ from: 'a', subject: null, body: null })
    await vault.collection<Msg>('msgs_text').put('x', { subject: 's', body: 'B' })
    expect(await vault.joined<Msg>('msgs_full').get('x')).toEqual({ from: 'a', subject: 's', body: 'B' })
  })

  it('get returns null when the base is absent, even if a satellite envelope exists', async () => {
    const { vault, rawStore } = await openPair()
    await vault.joined<Msg>('msgs_full').put('x', { from: 'a', body: 'B' })
    await rawStore.delete('v1', 'msgs', 'x')
    expect(await vault.joined<Msg>('msgs_full').get('x')).toBeNull()
  })

  it('get returns null when the base is tombstoned (not merely absent), even if a satellite envelope exists', async () => {
    const { vault, rawStore } = await openPair()
    await vault.joined<Msg>('msgs_full').put('x', { from: 'a', body: 'B' })
    // buildTombstone() shape: _iv === '' && _data === '' — written directly via the raw store.
    await rawStore.put('v1', 'msgs', 'x', { _noydb: 1, _v: 2, _ts: 't', _iv: '', _data: '' })
    expect(await vault.joined<Msg>('msgs_full').get('x')).toBeNull()
  })

  it('delete removes the pair (delegates to pairDelete, satellite first)', async () => {
    const { vault, spy } = await openPair()
    await vault.joined<Msg>('msgs_full').put('x', { from: 'a', body: 'B' })
    spy.reset()
    await vault.joined<Msg>('msgs_full').delete('x')
    // #589: under sync, delete() writes a version-ordered marker via adapter.put
    // (not adapter.delete), so the ordering now shows up on putOrder.
    expect(spy.putOrder).toEqual([['msgs_text', 'x'], ['msgs', 'x']])
  })

  it('list returns merged records for live-base ids only (mirror of satellite proxy list test, through joined)', async () => {
    const { vault, rawStore } = await openPair()
    await vault.joined<Msg>('msgs_full').put('a', { from: 'a', body: '1' })
    await vault.joined<Msg>('msgs_full').put('b', { from: 'b', body: '2' })
    await rawStore.delete('v1', 'msgs', 'b') // simulate offline resurrection state
    expect(await vault.joined<Msg>('msgs_full').list()).toEqual([{ from: 'a', subject: null, body: '1' }])
  })

  it('describe() works and unions both sides fields (UI contract); no narrow member is undefined', async () => {
    const { vault } = await openPair()
    const handle = vault.joined<Msg>('msgs_full')
    const d = await handle.describe()
    const keys = d.fields.map(f => f.key)
    expect(keys).toEqual(expect.arrayContaining(['from', 'subject', 'body']))
    for (const m of ['get', 'put', 'delete', 'list', 'describe'] as const) {
      expect(typeof handle[m]).toBe('function')
    }
  })

  it('reactive API members are absent from the handle at runtime', async () => {
    const { vault } = await openPair()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((vault.joined<Msg>('msgs_full') as any).subscribe).toBeUndefined()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((vault.joined<Msg>('msgs_full') as any).live).toBeUndefined()
  })

  it('throws SatelliteConfigError for an unregistered joined name, pointing at declaring joined:', async () => {
    const { vault } = await openPair()
    expect(() => vault.joined('nope')).toThrowError(SatelliteConfigError)
    expect(() => vault.joined('nope')).toThrowError(/joined:/)
  })
})

describe('JoinedHandle describe() carries field ids through (#946 Task 2)', () => {
  it('no persisted schema on either side — describe() does not crash, ids undefined', async () => {
    const { vault } = await openPair()
    const d = await vault.joined<Msg>('msgs_full').describe()
    for (const f of d.fields) expect(f.id).toBeUndefined()
  })

  it('base + satellite both persist a schema — describe() carries each side\'s id through unmodified', async () => {
    const local = spyMemory()
    const db = await createNoydb({ store: local.store, user: 'alice', secret: SECRET })
    const vault = await db.openVault('v946')

    const baseSchema = z.object({ from: z.string() })
    const satSchema = z.object({ subject: z.string(), body: z.string() })

    vault.collection<Msg>('msgs', {
      schema: baseSchema as unknown as import('../src/kernel/schema.js').StandardSchemaV1<unknown, Msg>,
      persistJsonSchema: true,
    })
    vault.collection<Msg>('msgs_text', {
      satelliteOf: 'msgs',
      fields: ['subject', 'body'],
      joined: 'msgs_full',
      schema: satSchema as unknown as import('../src/kernel/schema.js').StandardSchemaV1<unknown, Msg>,
      persistJsonSchema: true,
    })
    await vault._drainPendingSchemaWrites()

    const d = await vault.joined<Msg>('msgs_full').describe()
    const byKey = Object.fromEntries(d.fields.map((f) => [f.key, f]))
    expect(byKey.from!.id).toBeDefined()
    expect(byKey.subject!.id).toBeDefined()
    expect(byKey.body!.id).toBeDefined()
    expect(byKey.from!.id).not.toBe(byKey.subject!.id)
    expect(byKey.subject!.id).not.toBe(byKey.body!.id)
  })
})
