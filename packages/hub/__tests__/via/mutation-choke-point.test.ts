import { describe, it, expect } from 'vitest'
import { createNoydb, withDerivation, withMaterializedView } from '../../src/index.js'
import type { NoydbStore, EncryptedEnvelope } from '../../src/kernel/types.js'

// Reuses the in-memory NoydbStore + `pdfs` → `pdf-meta` derivation fixture
// from `__tests__/derivations/derive-all.test.ts` (record-shape, eager,
// deterministic) — per task-10-brief instruction to reuse an existing
// derivation fixture rather than invent a new one.
function memory(): NoydbStore {
  const data = new Map<string, EncryptedEnvelope>()
  const k = (v: string, c: string, i: string) => `${v}/${c}/${i}`
  return {
    capabilities: { casAtomic: true, auth: { kind: 'none', required: false, flow: 'static' } },
    async get(v, c, i) { return data.get(k(v, c, i)) ?? null },
    async put(v, c, i, env) { data.set(k(v, c, i), env) },
    async delete(v, c, i) { data.delete(k(v, c, i)) },
    async list(v, c) {
      const prefix = `${v}/${c}/`
      return [...data.keys()].filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length))
    },
    async loadAll(v) {
      const out: Record<string, Record<string, EncryptedEnvelope>> = {}
      for (const [key, env] of data) {
        const [vname, cname, id] = key.split('/') as [string, string, string]
        if (vname === v) {
          out[cname] = out[cname] ?? {}
          out[cname][id] = env
        }
      }
      return out
    },
    async saveAll(v, payload) {
      for (const c of Object.keys(payload)) {
        for (const i of Object.keys(payload[c]!)) {
          data.set(k(v, c, i), payload[c]![i]!)
        }
      }
    },
  }
}

interface Pdf extends Record<string, unknown> { id: string; body: string }
interface Invoice extends Record<string, unknown> { id: string; status: 'open' | 'paid'; amount: number }
const SECRET = 'mutation-choke-point-pass-2026'

/** Record-shape derivation `pdfs` → `pdf-meta` (len(body)). Counts invocations. */
function makeDerivation() {
  let calls = 0
  const handle = withDerivation({
    source: 'pdfs',
    deterministic: true,
    outputs: { meta: { shape: 'record', collection: 'pdf-meta' } },
    derive: (s: Pdf) => { calls++; return { meta: { len: s.body.length } } },
    lifecycle: 'eager',
  })
  return { handle, calls: () => calls }
}

/**
 * Parity pins for `Collection._onRecordMutated` (#623 task 10): each origin
 * must fire EXACTLY the side-effect set the seam-map Part-3 table records
 * for it today. These assertions must hold both before and after the
 * `_onRecordMutated` extraction — the refactor moves code, it does not
 * change behavior.
 */
describe('mutation-choke-point origin parity (#623 task 10, #621)', () => {
  it('local-write: fires change and dispatches derivations', async () => {
    const { handle, calls } = makeDerivation()
    const db = await createNoydb({ store: memory(), user: 'alice', secret: SECRET, derivationStrategies: [handle] })
    const vault = await db.openVault('demo')
    const pdfs = vault.collection<Pdf>('pdfs')
    const meta = vault.collection<{ len: number } & Record<string, unknown>>('pdf-meta')

    let changes = 0
    db.on('change', (e) => { if (e.collection === 'pdfs' && e.id === 'doc1') changes++ })

    await pdfs.put('doc1', { id: 'doc1', body: 'hello' })

    expect(changes).toBe(1)
    expect(calls()).toBe(1)
    expect(await meta.get('doc1')).toMatchObject({ len: 5 })
    db.close()
  })

  it('local-delete: fires change but does NOT dispatch derivations', async () => {
    const { handle, calls } = makeDerivation()
    const db = await createNoydb({ store: memory(), user: 'alice', secret: SECRET, derivationStrategies: [handle] })
    const vault = await db.openVault('demo')
    const pdfs = vault.collection<Pdf>('pdfs')
    await pdfs.put('doc1', { id: 'doc1', body: 'hello' }) // seed — fires 1 derivation call
    expect(calls()).toBe(1)

    let changes = 0
    db.on('change', (e) => { if (e.collection === 'pdfs' && e.id === 'doc1') changes++ })

    await pdfs.delete('doc1')

    expect(changes).toBe(1)
    expect(calls()).toBe(1) // unchanged — delete is put-only for derivation dispatch today
    db.close()
  })

  it('tab-mirror (_applyRemoteChange via _applyRemoteWrite): fires change but does NOT dispatch derivations', async () => {
    const { handle, calls } = makeDerivation()
    const store = memory()
    const db1 = await createNoydb({ store, user: 'alice', secret: SECRET, derivationStrategies: [handle] })
    const v1 = await db1.openVault('demo')
    const c1 = v1.collection<Pdf>('pdfs')
    await c1.put('seed', { id: 'seed', body: 'zz' }) // mints + persists the shared collection DEK

    const db2 = await createNoydb({ store, user: 'alice', secret: SECRET, derivationStrategies: [handle] })
    const v2 = await db2.openVault('demo')
    const c2 = v2.collection<Pdf>('pdfs')
    await c2.get('seed') // hydrate db2's cache under the shared DEK

    const beforeOwnWrite = calls()
    await c1.put('doc1', { id: 'doc1', body: 'hello' }) // db1's own local-write
    expect(calls()).toBe(beforeOwnWrite + 1)

    let changed2 = 0
    db2.on('change', (e) => { if (e.id === 'doc1') changed2++ })
    const beforeRelay = calls()

    await v2._applyRemoteWrite('pdfs', 'doc1', 'put') // simulate the cross-tab relay

    expect(changed2).toBe(1)
    expect(calls()).toBe(beforeRelay) // NO new derivation dispatch from the mirror
    expect(await c2.get('doc1')).toMatchObject({ body: 'hello' }) // cache refreshed from the shared store
    db1.close(); db2.close()
  })

  it('sync-apply (_invalidateSyncApplied), inside a graph-dispatch batch: invalidates cache AND dispatches derivations (#621)', async () => {
    const { handle, calls } = makeDerivation()
    const store = memory()
    const db1 = await createNoydb({ store, user: 'alice', secret: SECRET, derivationStrategies: [handle] })
    const v1 = await db1.openVault('demo')
    const c1 = v1.collection<Pdf>('pdfs')
    await c1.put('seed', { id: 'seed', body: 'zz' })

    const db2 = await createNoydb({ store, user: 'alice', secret: SECRET, derivationStrategies: [handle] })
    const v2 = await db2.openVault('demo')
    const c2 = v2.collection<Pdf>('pdfs')
    await c2.get('seed')

    const beforeOwnWrite = calls()
    await c1.put('doc1', { id: 'doc1', body: 'hello' }) // db1's own local-write, into the shared store
    expect(calls()).toBe(beforeOwnWrite + 1)

    let changed2 = 0
    db2.on('change', (e) => { if (e.id === 'doc1') changed2++ })
    const beforeSyncApply = calls()

    // Simulates what SyncEngine#applyRemote does after writing the raw envelope: refresh db2's
    // cache/CEK view of the record, inside an open graph-dispatch batch (what pull()/push() do
    // around every applyRemote call, per §3) — flip: phase C now dispatches on flush.
    // parity-pin: #621 — phase C changes this (was: no event, no derivation dispatch).
    v2._beginGraphBatch()
    await v2._invalidateSyncApplied('pdfs', 'doc1', 'put')
    await v2._flushGraphBatch()

    expect(changed2).toBe(1) // parity-pin: #621 — phase C changes this (the derived pdf-meta/doc1 output write)
    expect(calls()).toBe(beforeSyncApply + 1) // parity-pin: #621 — phase C changes this
    expect(await c2.get('doc1')).toMatchObject({ body: 'hello' }) // cache WAS invalidated/refreshed
    expect(await v2.collection<{ len: number } & Record<string, unknown>>('pdf-meta').get('doc1')).toMatchObject({ len: 5 })
    db1.close(); db2.close()
  })

  it('sync-apply, inside a graph-dispatch batch: dispatches materialized views too (#621)', async () => {
    const openInvoicesMV = withMaterializedView<Invoice>({
      name: 'open-invoices',
      query: (db) => db.collection<Invoice>('invoices').query().where('status', '==', 'open'),
      rowKey: (r) => r.id,
      refresh: 'eager',
    })
    const store = memory()
    const db1 = await createNoydb({ store, user: 'alice', secret: SECRET, materializedViewStrategies: [openInvoicesMV] })
    const v1 = await db1.openVault('demo')
    // 'open' status so the MV materializes a row — mints + persists the shared 'open-invoices'
    // collection DEK before db2 ever opens (mirrors the derivation test's 'seed' comment above).
    await v1.collection<Invoice>('invoices').put('seed', { id: 'seed', status: 'open', amount: 1 })

    const db2 = await createNoydb({ store, user: 'alice', secret: SECRET, materializedViewStrategies: [openInvoicesMV] })
    const v2 = await db2.openVault('demo')
    const invoices2 = v2.collection<Invoice>('invoices')
    await invoices2.get('seed') // hydrate db2's cache under the shared DEK

    await v1.collection<Invoice>('invoices').put('inv-1', { id: 'inv-1', status: 'open', amount: 100 }) // db1's own local-write, into the shared store

    v2._beginGraphBatch()
    await v2._invalidateSyncApplied('invoices', 'inv-1', 'put')
    await v2._flushGraphBatch()

    expect(await v2.collection<Invoice>('open-invoices').get('inv-1')).toMatchObject({ amount: 100 })
    db1.close(); db2.close()
  })

  it('cutover (_applyCutoverTransform): emits nothing', async () => {
    const db = await createNoydb({ store: memory(), user: 'alice', secret: SECRET })
    const vault = await db.openVault('demo')
    const pdfs = vault.collection<Pdf>('pdfs')
    await pdfs.put('doc1', { id: 'doc1', body: 'hello' })

    let changes = 0
    db.on('change', () => { changes++ })

    const count = await pdfs._applyCutoverTransform((doc) => ({ ...doc, body: `${doc.body as string}!` }))

    expect(count).toBe(1)
    expect(changes).toBe(0)
    expect(await pdfs.get('doc1')).toMatchObject({ body: 'hello!' }) // cache reflects the raw-write transform
    db.close()
  })
})
