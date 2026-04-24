import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/noydb.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/types.js'

function memory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function col(c: string, n: string): Map<string, EncryptedEnvelope> {
    let comp = store.get(c); if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(n); if (!coll) { coll = new Map(); comp.set(n, coll) }
    return coll
  }
  return {
    name: 'memory',
    async get(c, n, id) { return store.get(c)?.get(n)?.get(id) ?? null },
    async put(c, n, id, env) { col(c, n).set(id, env) },
    async delete(c, n, id) { store.get(c)?.get(n)?.delete(id) },
    async list(c, n) { const coll = store.get(c)?.get(n); return coll ? [...coll.keys()] : [] },
    async loadAll(c) {
      const comp = store.get(c); const s: VaultSnapshot = {}
      if (comp) for (const [k, coll] of comp) {
        if (!k.startsWith('_')) {
          const r: Record<string, EncryptedEnvelope> = {}
          for (const [id, e] of coll) r[id] = e
          s[k] = r
        }
      }
      return s
    },
    async saveAll(c, data) {
      const comp = new Map<string, Map<string, EncryptedEnvelope>>()
      for (const [n, recs] of Object.entries(data)) {
        const coll = new Map<string, EncryptedEnvelope>()
        for (const [id, env] of Object.entries(recs)) coll.set(id, env)
        comp.set(n, coll)
      }
      const existing = store.get(c)
      if (existing) for (const [n, coll] of existing) if (n.startsWith('_')) comp.set(n, coll)
      store.set(c, comp)
    },
  }
}

interface Row { id: string; clientId: string; amount: number }

const SECRET = 'lazy-auto-reconcile-2026'

describe('reconcileOnOpen: auto (#278)', () => {
  it('repairs a missing side-car automatically on first query', async () => {
    const adapter = memory()

    // Phase 1: seed via a first Noydb with no auto-reconcile.
    const db1 = await createNoydb({ store: adapter, user: 'owner', secret: SECRET })
    const v1 = await db1.openVault('ACME')
    const c1 = v1.collection<Row>('rows', {
      prefetch: false,
      cache: { maxRecords: 100 },
      indexes: ['clientId'],
    })
    await c1.put('r-1', { id: 'r-1', clientId: 'c-A', amount: 10 })
    await c1.put('r-2', { id: 'r-2', clientId: 'c-B', amount: 20 })

    // Manufacture drift: delete one side-car behind the back of the hub.
    await adapter.delete('ACME', 'rows', '_idx/clientId/r-2')

    // Phase 2: reopen with reconcileOnOpen: 'auto'.
    const db2 = await createNoydb({ store: adapter, user: 'owner', secret: SECRET })
    const v2 = await db2.openVault('ACME')
    const c2 = v2.collection<Row>('rows', {
      prefetch: false,
      cache: { maxRecords: 100 },
      indexes: ['clientId'],
      reconcileOnOpen: 'auto',
    })

    const events: Array<{ field: string; missing: readonly string[]; applied: number }> = []
    db2.on('index:reconciled', e => {
      events.push({ field: e.field, missing: e.missing, applied: e.applied })
    })

    // First query triggers ensurePersistedIndexesLoaded, which fires
    // autoReconcile, which emits `index:reconciled` per field.
    const rows = await c2.lazyQuery().where('clientId', '==', 'c-B').toArray()
    expect(rows.map(r => r.id)).toEqual(['r-2'])

    expect(events).toHaveLength(1)
    expect(events[0]!.field).toBe('clientId')
    expect(events[0]!.missing).toEqual(['r-2'])
    expect(events[0]!.applied).toBe(1)

    // After repair the side-car is durably back.
    const ids = await adapter.list('ACME', 'rows')
    expect(ids).toContain('_idx/clientId/r-2')
  })

  it('dry-run reports drift without writing anything', async () => {
    const adapter = memory()

    const db1 = await createNoydb({ store: adapter, user: 'owner', secret: SECRET })
    const v1 = await db1.openVault('ACME')
    const c1 = v1.collection<Row>('rows', {
      prefetch: false,
      cache: { maxRecords: 100 },
      indexes: ['clientId'],
    })
    await c1.put('r-1', { id: 'r-1', clientId: 'c-A', amount: 10 })
    await adapter.delete('ACME', 'rows', '_idx/clientId/r-1')

    const db2 = await createNoydb({ store: adapter, user: 'owner', secret: SECRET })
    const v2 = await db2.openVault('ACME')
    const c2 = v2.collection<Row>('rows', {
      prefetch: false,
      cache: { maxRecords: 100 },
      indexes: ['clientId'],
      reconcileOnOpen: 'dry-run',
    })

    const events: Array<{ applied: number; missing: readonly string[] }> = []
    db2.on('index:reconciled', e => events.push({ applied: e.applied, missing: e.missing }))

    // Trigger the load via any lazyQuery call — the query itself will
    // fail to find r-1 (side-car still missing in dry-run mode) which
    // is the correctness guarantee: dry-run REPORTS, never FIXES.
    const rows = await c2.lazyQuery().where('clientId', '==', 'c-A').toArray()
    expect(rows).toEqual([])

    expect(events).toHaveLength(1)
    expect(events[0]!.missing).toEqual(['r-1'])
    expect(events[0]!.applied).toBe(0)

    // Confirm nothing got written.
    const ids = await adapter.list('ACME', 'rows')
    expect(ids).not.toContain('_idx/clientId/r-1')
  })

  it('off (default) does nothing on open', async () => {
    const adapter = memory()
    const db1 = await createNoydb({ store: adapter, user: 'owner', secret: SECRET })
    const v1 = await db1.openVault('ACME')
    const c1 = v1.collection<Row>('rows', {
      prefetch: false,
      cache: { maxRecords: 100 },
      indexes: ['clientId'],
    })
    await c1.put('r-1', { id: 'r-1', clientId: 'c-A', amount: 10 })

    const db2 = await createNoydb({ store: adapter, user: 'owner', secret: SECRET })
    const v2 = await db2.openVault('ACME')
    const c2 = v2.collection<Row>('rows', {
      prefetch: false,
      cache: { maxRecords: 100 },
      indexes: ['clientId'],
    }) // reconcileOnOpen omitted → default 'off'

    const events: number[] = []
    db2.on('index:reconciled', () => events.push(1))

    await c2.lazyQuery().where('clientId', '==', 'c-A').toArray()
    expect(events).toEqual([])
  })

  it('runs once per session, not on every subsequent query', async () => {
    const adapter = memory()
    const db1 = await createNoydb({ store: adapter, user: 'owner', secret: SECRET })
    const v1 = await db1.openVault('ACME')
    const c1 = v1.collection<Row>('rows', {
      prefetch: false,
      cache: { maxRecords: 100 },
      indexes: ['clientId'],
    })
    await c1.put('r-1', { id: 'r-1', clientId: 'c-A', amount: 10 })

    const db2 = await createNoydb({ store: adapter, user: 'owner', secret: SECRET })
    const v2 = await db2.openVault('ACME')
    const c2 = v2.collection<Row>('rows', {
      prefetch: false,
      cache: { maxRecords: 100 },
      indexes: ['clientId'],
      reconcileOnOpen: 'auto',
    })

    let count = 0
    db2.on('index:reconciled', () => count++)

    await c2.lazyQuery().where('clientId', '==', 'c-A').toArray()
    await c2.lazyQuery().where('clientId', '==', 'c-A').toArray()
    await c2.lazyQuery().where('clientId', '==', 'c-A').toArray()

    // One emit per field, not per query.
    expect(count).toBe(1)
  })
})
