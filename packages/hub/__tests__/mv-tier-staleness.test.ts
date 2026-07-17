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
import { withForgetCascade } from '../src/with-audit/forget/index.js'
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
        forgetStrategy: withForgetCascade({ subjects: { people: 'subjectId' } }),
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
