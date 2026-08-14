/**
 * #736 — `dispatchMaterializedViewsOnDelete` (the delete/forget/elevate fanout, shared by
 * `forget()` and the tier-move `syncDerived` path) fully recomputes only EAGER MVs. For
 * `refresh: 'lazy'` it flipped an in-memory-only stale bit (lost on vault close — `stale.ts`'s
 * own doc admits persistence isn't implemented); `'manual'` no-opped entirely. Either way the
 * PERSISTED output row(s) kept the elevated/forgotten source's plaintext at rest, and a cold
 * session served it as fresh.
 *
 * Fix: on invalidation, delete the MV's persisted output rows (the at-rest law), and for
 * `lazy` MVs persist the stale mark in the reserved `_mv_stale` collection so a cold session
 * recomputes on first read instead of serving an empty view.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, withMaterializedView, ConflictError } from '../src/index.js'
import { withTiers } from '../src/with-audit/tiers/index.js'
import { withForget } from '../src/with-audit/forget/index.js'
import { withHistory } from '../src/with-commit/history/index.js'
import { isMVStale, MV_STALE_COLLECTION } from '../src/with-formula/materialized-views/stale.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/index.js'

/** One store, reopenable: open() twice = cold second session over the same ciphertext. */
function memoryStore(): NoydbStore {
  const data = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const getColl = (v: string, c: string): Map<string, EncryptedEnvelope> => {
    let vm = data.get(v); if (!vm) { vm = new Map(); data.set(v, vm) }
    let cm = vm.get(c); if (!cm) { cm = new Map(); vm.set(c, cm) }
    return cm
  }
  return {
    name: 'memory',
    async get(v, c, id) { return data.get(v)?.get(c)?.get(id) ?? null },
    async put(v, c, id, env, ev) {
      const coll = getColl(v, c); const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      coll.set(id, env)
    },
    async delete(v, c, id) { data.get(v)?.get(c)?.delete(id) },
    async list(v, c) { return [...(data.get(v)?.get(c)?.keys() ?? [])] },
    async loadAll(v) {
      const vm = data.get(v); const snap: VaultSnapshot = {}
      if (vm) for (const [cn, cm] of vm) {
        const r: Record<string, EncryptedEnvelope> = {}
        for (const [id, e] of cm) r[id] = e
        snap[cn] = r
      }
      return snap
    },
    async saveAll(v, snap) {
      const vm = new Map<string, Map<string, EncryptedEnvelope>>()
      for (const [cn, recs] of Object.entries(snap)) {
        const cm = new Map<string, EncryptedEnvelope>()
        for (const [id, e] of Object.entries(recs)) cm.set(id, e)
        vm.set(cn, cm)
      }
      data.set(v, vm)
    },
  }
}

interface Item extends Record<string, unknown> { id: string; tag: string; subjectId?: string }
interface Disbursement extends Record<string, unknown> { id: string; type: string; period: string; amount: number }

describe('#736 whole-branch review — invalidateMVAtRest scopes deletion to MV-stamped rows', () => {
  it('CRITICAL: same-collection partition MV (DERIV-PP30-001) — ordinary delete of one source record must NOT erase other source records at rest', async () => {
    const store = memoryStore()
    const mv = withMaterializedView<Disbursement>({
      name: 'pp30-aggregate',
      query: (db) => db.collection<Disbursement>('disbursements')
        .query()
        .where('type', 'in', ['vatSales', 'vatPurchase', 'vatCredit']),
      rowKey: (r) => `pp30|${r.period}|${r.id}`,
      refresh: 'lazy',
      output: { collection: 'disbursements', partition: { field: 'type', value: 'pp30' } },
      // `onEmpty: 'keep'` isolates this test to the `invalidateMVAtRest` fix under test —
      // the executor's own `onEmpty: 'delete'` tombstone-diff pass has a SEPARATE,
      // pre-existing bug for same-collection partition MVs (it diffs the new emitted-id
      // set against EVERY id in the output collection, so an ordinary first materialize
      // already tombstones untouched source rows before any delete/elevate/forget ever
      // runs) — out of scope for this fix wave (stale.ts only); flagged separately.
      onEmpty: 'keep',
    })
    const db = await createNoydb({
      store, user: 'owner', secret: 'mv-tier-stale-same-coll-critical-2026',
      materializedViewStrategies: [mv],
    })
    const vault = await db.openVault('demo')
    const disb = vault.collection<Disbursement>('disbursements')
    await disb.put('d1', { id: 'd1', type: 'vatSales', period: '2026-05', amount: 1000 })
    await disb.put('d2', { id: 'd2', type: 'vatPurchase', period: '2026-05', amount: 500 })
    // Materialize (first read fires the lazy resolve — writes the pp30|* rows into the SAME collection).
    expect(await disb.get('pp30|2026-05|d1')).not.toBeNull()
    expect(await disb.get('pp30|2026-05|d2')).not.toBeNull()
    // Sanity: the pre-existing executor bug (see comment above) is neutralized by
    // `onEmpty: 'keep'` — both original source rows are still present after materialize.
    expect(await store.get('demo', 'disbursements', 'd1')).not.toBeNull()
    expect(await store.get('demo', 'disbursements', 'd2')).not.toBeNull()

    // Ordinary delete of an UNTOUCHED source record — must invalidate this MV's own output
    // rows but must NEVER erase the other user source record ('d2') sharing the collection.
    await disb.delete('d1')

    // The other user source record survives at rest — the bug this test guards against.
    expect(await store.get('demo', 'disbursements', 'd2')).not.toBeNull()
    // MV-stamped output rows are still purged (invalidation still works).
    expect(await store.get('demo', 'disbursements', 'pp30|2026-05|d1')).toBeNull()
    expect(await store.get('demo', 'disbursements', 'pp30|2026-05|d2')).toBeNull()
  })

  it('IMPORTANT: hydrate-once race — two concurrent first reads over a cold registry both see the recomputed view', async () => {
    const store = memoryStore()
    const lazyMV = withMaterializedView<Item>({
      name: 'people-mirror',
      query: (db) => db.collection<Item>('people').query(),
      rowKey: (r) => r.id,
      refresh: 'lazy',
    })
    const open = async () => {
      const db = await createNoydb({
        store, user: 'owner', secret: 'mv-tier-stale-hydrate-race-2026',
        materializedViewStrategies: [lazyMV],
        historyStrategy: withHistory(),
        forgetStrategy: withForget({ subjects: { people: 'subjectId' } }),
      })
      const vault = await db.openVault('demo')
      return { vault, people: vault.collection<Item>('people') }
    }

    const { vault, people } = await open()
    await people.put('p1', { id: 'p1', tag: 'x', subjectId: 'subj-1' })
    await people.put('p2', { id: 'p2', tag: 'y', subjectId: 'subj-2' })
    expect(await vault.collection<Item>('people-mirror').get('p1')).not.toBeNull()
    expect(await vault.collection<Item>('people-mirror').get('p2')).not.toBeNull()

    await vault.forget('subj-1')
    // Rows purged at rest + the lazy marker persisted (mirrors the existing #736 forget test).
    expect(await store.get('demo', MV_STALE_COLLECTION, 'people-mirror')).not.toBeNull()

    // Cold session: fresh registry. Fire two concurrent first-reads for the SAME id —
    // without the promise-memo fix, whichever call loses the race sees "hydrate already
    // in flight" and an empty in-memory pending set, and returns the not-yet-recomputed
    // (purged) row instead of waiting for the recompute to finish.
    const { vault: coldVault } = await open()
    const coll = coldVault.collection<Item>('people-mirror')
    const [r1, r2] = await Promise.all([coll.get('p2'), coll.get('p2')])
    expect(r1).not.toBeNull()
    expect(r2).not.toBeNull()
    expect(r1?.tag).toBe('y')
    expect(r2?.tag).toBe('y')
  })

  it('IMPORTANT: hydrate-promise poison — a transient store failure on the first cold read must not brick the MV read surface for the rest of the session', async () => {
    const store = memoryStore()
    const lazyMV = withMaterializedView<Item>({
      name: 'red-items',
      query: (db) => db.collection<Item>('items').query().where('tag', '==', 'red'),
      rowKey: (r) => r.id,
      refresh: 'lazy',
    })
    const db = await createNoydb({
      store, user: 'owner', secret: 'mv-tier-stale-hydrate-poison-2026',
      materializedViewStrategies: [lazyMV],
    })
    const vault = await db.openVault('demo')
    const items = vault.collection<Item>('items')
    await items.put('a', { id: 'a', tag: 'red' })

    // Make the store's list() reject ONCE for the reserved `_mv_stale` collection
    // (the hydrate fold-in's only store call), then succeed on every later call.
    let failed = false
    const originalList = store.list.bind(store)
    store.list = async (v, c) => {
      if (c === MV_STALE_COLLECTION && !failed) {
        failed = true
        throw new Error('transient store failure')
      }
      return originalList(v, c)
    }

    // First read: the hydrate rejects — must surface, not be swallowed.
    await expect(vault.collection<Item>('red-items').get('a')).rejects.toThrow('transient store failure')

    // Second read: must RETRY the hydrate (not re-await the same cached rejection)
    // and recover, serving the recomputed view.
    const row = await vault.collection<Item>('red-items').get('a')
    expect(row).not.toBeNull()
    expect(row?.tag).toBe('red')
  })

  it('orphaned _mv_stale marker for an unregistered MV name is deleted on the next read (renamed/removed MV)', async () => {
    const store = memoryStore()
    const mv = withMaterializedView<Item>({
      name: 'red-items',
      query: (db) => db.collection<Item>('items').query().where('tag', '==', 'red'),
      rowKey: (r) => r.id,
      refresh: 'lazy',
    })
    const db = await createNoydb({
      store, user: 'owner', secret: 'mv-tier-stale-orphan-marker-2026',
      materializedViewStrategies: [mv],
    })
    const vault = await db.openVault('demo')

    // Plant a marker for a name that is NOT (and never will be) a registered MV —
    // simulates a marker surviving a rename/removal of the MV that wrote it.
    const env = (await store.get('demo', MV_STALE_COLLECTION, 'ghost-mv')) ?? null
    expect(env).toBeNull()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plainEnv = (await import('../src/kernel/enclave/index.js')).RecordCodec.buildPlaintextEnvelope({ collection: 'c', id: 'r1' }, { version: 1, data: '{}' })
    await store.put('demo', MV_STALE_COLLECTION, 'ghost-mv', plainEnv)
    expect(await store.get('demo', MV_STALE_COLLECTION, 'ghost-mv')).not.toBeNull()

    // One read (triggers hydrate + the stale-check path).
    await vault.collection<Item>('items').get('nonexistent')

    // The orphaned marker is gone — it can never re-hydrate into a real recompute.
    expect(await store.get('demo', MV_STALE_COLLECTION, 'ghost-mv')).toBeNull()
  })
})

describe('#736 MV lazy/manual invalidation purges persisted rows + persists the lazy stale mark', () => {
  it('lazy MV + elevate: output rows purged at rest, marker persisted, cold session recomputes without the elevated contribution', async () => {
    const store = memoryStore()
    const lazyMV = withMaterializedView<Item>({
      name: 'red-items',
      // Tiered options must land on the FIRST `collection()` call the query
      // callback makes (registration-time, first-construction-wins) — see
      // tiers-derived.test.ts for the same pattern.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      query: (db) => { (db as any).collection('items', { tiers: [0, 1], perRecordKeys: true }); return db.collection<Item>('items').query().where('tag', '==', 'red') },
      rowKey: (r) => r.id,
      refresh: 'lazy',
    })
    const open = async () => {
      const db = await createNoydb({
        store, user: 'owner', secret: 'mv-tier-stale-lazy-elevate-2026',
        tiersStrategy: withTiers(), materializedViewStrategies: [lazyMV],
      })
      const vault = await db.openVault('demo')
      return { vault, items: vault.collection<Item>('items', { tiers: [0, 1], perRecordKeys: true }) }
    }

    const { vault, items } = await open()
    await items.put('a', { id: 'a', tag: 'red' })
    await items.put('b', { id: 'b', tag: 'red' })
    // Materialize (first read).
    expect(await vault.collection<Item>('red-items').get('a')).not.toBeNull()
    expect(await vault.collection<Item>('red-items').get('b')).not.toBeNull()

    await items.elevate('a', 1)

    // At-rest law: BOTH persisted output rows are gone (full-purge invalidation),
    // not just the elevated one — adapter-level check bypasses the lazy resolve-on-read.
    expect(await store.get('demo', 'red-items', 'a')).toBeNull()
    expect(await store.get('demo', 'red-items', 'b')).toBeNull()
    // The lazy stale mark survived the in-memory WeakMap's lifetime — persisted.
    expect(await store.get('demo', MV_STALE_COLLECTION, 'red-items')).not.toBeNull()

    // Cold session: fresh Noydb instance + fresh registry over the SAME store.
    const { vault: coldVault } = await open()
    const coldRow = await coldVault.collection<Item>('red-items').get('b')
    expect(coldRow).not.toBeNull()
    expect(coldRow?.tag).toBe('red')
    expect(await coldVault.collection<Item>('red-items').get('a')).toBeNull()

    // Marker cleaned up after the successful cold recompute.
    expect(await store.get('demo', MV_STALE_COLLECTION, 'red-items')).toBeNull()
  })

  it('lazy MV + forget(): same at-rest purge + persisted marker + cold recompute (shared dispatcher)', async () => {
    const store = memoryStore()
    const lazyMV = withMaterializedView<Item>({
      name: 'people-mirror',
      query: (db) => db.collection<Item>('people').query(),
      rowKey: (r) => r.id,
      refresh: 'lazy',
    })
    const open = async () => {
      const db = await createNoydb({
        store, user: 'owner', secret: 'mv-tier-stale-lazy-forget-2026',
        materializedViewStrategies: [lazyMV],
        historyStrategy: withHistory(),
        forgetStrategy: withForget({ subjects: { people: 'subjectId' } }),
      })
      const vault = await db.openVault('demo')
      return { vault, people: vault.collection<Item>('people') }
    }

    const { vault, people } = await open()
    await people.put('p1', { id: 'p1', tag: 'x', subjectId: 'subj-1' })
    await people.put('p2', { id: 'p2', tag: 'y', subjectId: 'subj-2' })
    expect(await vault.collection<Item>('people-mirror').get('p1')).not.toBeNull()
    expect(await vault.collection<Item>('people-mirror').get('p2')).not.toBeNull()

    await vault.forget('subj-1')

    expect(await store.get('demo', 'people-mirror', 'p1')).toBeNull()
    expect(await store.get('demo', 'people-mirror', 'p2')).toBeNull()
    expect(await store.get('demo', MV_STALE_COLLECTION, 'people-mirror')).not.toBeNull()

    const { vault: coldVault } = await open()
    const coldRow = await coldVault.collection<Item>('people-mirror').get('p2')
    expect(coldRow).not.toBeNull()
    expect(await coldVault.collection<Item>('people-mirror').get('p1')).toBeNull()
    expect(await store.get('demo', MV_STALE_COLLECTION, 'people-mirror')).toBeNull()
  })

  it('manual MV + elevate: rows purged at rest; read serves empty (no recompute); refreshView() rebuilds', async () => {
    const store = memoryStore()
    const manualMV = withMaterializedView<Item>({
      name: 'all-items',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      query: (db) => { (db as any).collection('items', { tiers: [0, 1], perRecordKeys: true }); return db.collection<Item>('items').query() },
      rowKey: (r) => r.id,
      refresh: 'manual',
    })
    const db = await createNoydb({
      store, user: 'owner', secret: 'mv-tier-stale-manual-elevate-2026',
      tiersStrategy: withTiers(), materializedViewStrategies: [manualMV],
    })
    const vault = await db.openVault('demo')
    const items = vault.collection<Item>('items', { tiers: [0, 1], perRecordKeys: true })
    await items.put('a', { id: 'a', tag: 'red' })
    await items.put('b', { id: 'b', tag: 'blue' })
    await vault.refreshView('all-items')
    expect(await vault.collection<Item>('all-items').get('a')).not.toBeNull()
    expect(await vault.collection<Item>('all-items').get('b')).not.toBeNull()

    await items.elevate('a', 1)

    // Rows gone at rest.
    expect(await store.get('demo', 'all-items', 'a')).toBeNull()
    expect(await store.get('demo', 'all-items', 'b')).toBeNull()
    // Manual MVs never get a persisted stale marker — erasure wins, no auto-recompute promise.
    expect(await store.get('demo', MV_STALE_COLLECTION, 'all-items')).toBeNull()

    // Serves empty — no auto-recompute for a manual MV.
    expect(await vault.collection<Item>('all-items').get('b')).toBeNull()

    // Explicit refreshView() rebuilds without the elevated record.
    const result = await vault.refreshView('all-items')
    expect(result.written).toBe(1)
    expect(await vault.collection<Item>('all-items').get('b')).not.toBeNull()
    expect(await vault.collection<Item>('all-items').get('a')).toBeNull()
  })

  it('ordinary lazy source write (no delete/elevate/forget): no _mv_stale row written — the cheap-path guarantee', async () => {
    const store = memoryStore()
    const lazyMV = withMaterializedView<Item>({
      name: 'red-items',
      query: (db) => db.collection<Item>('items').query().where('tag', '==', 'red'),
      rowKey: (r) => r.id,
      refresh: 'lazy',
    })
    const db = await createNoydb({
      store, user: 'owner', secret: 'mv-tier-stale-cheap-write-2026',
      materializedViewStrategies: [lazyMV],
    })
    const vault = await db.openVault('demo')

    await vault.collection<Item>('items').put('a', { id: 'a', tag: 'red' })

    // In-memory stale behaviour is unchanged (ordinary write path, not the delete dispatcher).
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const reg = vault._getMaterializedViewRegistry()!
    expect(isMVStale(reg, 'red-items')).toBe(true)
    // No store I/O for the cheap ordinary-write path.
    expect(await store.get('demo', MV_STALE_COLLECTION, 'red-items')).toBeNull()
  })
})
