import { describe, it, expect } from 'vitest'
import { createNoydb, withMaterializedView } from '../../src/index.js'
import { isMVStale } from '../../src/with-formula/materialized-views/stale.js'
import type { NoydbStore, EncryptedEnvelope } from '../../src/kernel/types.js'

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
        const [vname, cname, id] = key.split('/')
        if (vname === v) {
          out[cname!] = out[cname!] ?? {}
          out[cname!]![id!] = env
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

interface Item extends Record<string, unknown> { id: string; tag: string }

describe('MV lazy lifecycle + vault.refreshView (#151)', () => {
  it('lazy MV: source write marks stale; first read materializes', async () => {
    const lazyMV = withMaterializedView<Item>({
      name: 'red-items',
      query: (db) => db.collection<Item>('items').query().where('tag', '==', 'red'),
      rowKey: (r) => r.id,
      refresh: 'lazy',
    })
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'mv-lazy-passphrase-2026',
      materializedViewStrategies: [lazyMV],
    })
    const vault = await db.openVault('demo')

    // No put yet → MV output is empty
    expect(await vault.collection<Item>('red-items').get('a')).toBeNull()

    // Source write fires lazy path: mark stale, no materialization.
    await vault.collection<Item>('items').put('a', { id: 'a', tag: 'red' })
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const reg = vault._getMaterializedViewRegistry()!
    expect(isMVStale(reg, 'red-items')).toBe(true)

    // First read triggers resolveStaleMVOnRead → materializes.
    const row = await vault.collection<Item>('red-items').get('a')
    expect(row).not.toBeNull()
    expect(row?.tag).toBe('red')
    // Stale bit cleared after refresh.
    expect(isMVStale(reg, 'red-items')).toBe(false)
  })

  it('lazy MV: subsequent reads after a source change re-stale + re-materialize', async () => {
    const lazyMV = withMaterializedView<Item>({
      name: 'red-items',
      query: (db) => db.collection<Item>('items').query().where('tag', '==', 'red'),
      rowKey: (r) => r.id,
      refresh: 'lazy',
    })
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'mv-lazy-restale-passphrase-2026',
      materializedViewStrategies: [lazyMV],
    })
    const vault = await db.openVault('demo')

    await vault.collection<Item>('items').put('a', { id: 'a', tag: 'red' })
    expect(await vault.collection<Item>('red-items').get('a')).not.toBeNull()

    // Flip 'a' to blue + add new red 'b'. Two source writes → still
    // only one stale bit (set semantics).
    await vault.collection<Item>('items').put('a', { id: 'a', tag: 'blue' })
    await vault.collection<Item>('items').put('b', { id: 'b', tag: 'red' })
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const reg = vault._getMaterializedViewRegistry()!
    expect(isMVStale(reg, 'red-items')).toBe(true)

    // Re-read 'b' triggers refresh; 'b' shows up.
    expect(await vault.collection<Item>('red-items').get('b')).not.toBeNull()
    // Stale cleared again.
    expect(isMVStale(reg, 'red-items')).toBe(false)
    // With #152's onEmpty: 'delete' default, 'a' (now blue) is
    // tombstoned by the refresh diff — the row disappeared from the
    // query result, so it's removed from the MV.
    expect(await vault.collection<Item>('red-items').get('a')).toBeNull()
  })

  it('manual MV: source writes do NOT materialize; only refreshView(name) does', async () => {
    const manualMV = withMaterializedView<Item>({
      name: 'all-items',
      query: (db) => db.collection<Item>('items').query(),
      rowKey: (r) => r.id,
      refresh: 'manual',
    })
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'mv-manual-passphrase-2026',
      materializedViewStrategies: [manualMV],
    })
    const vault = await db.openVault('demo')

    await vault.collection<Item>('items').put('a', { id: 'a', tag: 'red' })
    await vault.collection<Item>('items').put('b', { id: 'b', tag: 'blue' })

    // Manual MV does not auto-materialize on source write OR on read.
    expect(await vault.collection<Item>('all-items').get('a')).toBeNull()
    expect(await vault.collection<Item>('all-items').get('b')).toBeNull()
    // The stale map is also not populated for manual MVs.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const reg = vault._getMaterializedViewRegistry()!
    expect(isMVStale(reg, 'all-items')).toBe(false)

    // Explicit refresh materializes.
    const result = await vault.refreshView('all-items')
    expect(result.written).toBe(2)
    expect(result.deleted).toBe(0)
    expect(result.failed).toBe(0)

    expect(await vault.collection<Item>('all-items').get('a')).not.toBeNull()
    expect(await vault.collection<Item>('all-items').get('b')).not.toBeNull()
  })

  it('vault.refreshView clears the stale bit for a lazy MV', async () => {
    const lazyMV = withMaterializedView<Item>({
      name: 'red-items',
      query: (db) => db.collection<Item>('items').query().where('tag', '==', 'red'),
      rowKey: (r) => r.id,
      refresh: 'lazy',
    })
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'mv-refresh-clears-stale-passphrase-2026',
      materializedViewStrategies: [lazyMV],
    })
    const vault = await db.openVault('demo')
    await vault.collection<Item>('items').put('a', { id: 'a', tag: 'red' })
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const reg = vault._getMaterializedViewRegistry()!
    expect(isMVStale(reg, 'red-items')).toBe(true)

    // Manual refresh clears the stale flag without needing a read.
    await vault.refreshView('red-items')
    expect(isMVStale(reg, 'red-items')).toBe(false)
    expect(await vault.collection<Item>('red-items').get('a')).not.toBeNull()
  })

  it('refreshView throws on unknown MV name', async () => {
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'mv-refresh-unknown-passphrase-2026',
    })
    const vault = await db.openVault('demo')
    // No MVs registered — returns zero counts.
    expect(await vault.refreshView('nonexistent')).toEqual({ written: 0, deleted: 0, failed: 0, residue: [] })

    // With at least one MV registered, an unknown name throws.
    const mv = withMaterializedView<Item>({
      name: 'red',
      query: (d) => d.collection<Item>('items').query().where('tag', '==', 'red'),
      rowKey: (r) => r.id,
      refresh: 'manual',
    })
    const db2 = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'mv-refresh-unknown-2-passphrase-2026',
      materializedViewStrategies: [mv],
    })
    const v2 = await db2.openVault('demo')
    await expect(v2.refreshView('does-not-exist')).rejects.toThrow(/refreshView.*does-not-exist/)
  })

  it('list() triggers lazy-MV resolve-on-read (niwat-review of #157)', async () => {
    const lazyMV = withMaterializedView<Item>({
      name: 'red-items',
      query: (db) => db.collection<Item>('items').query().where('tag', '==', 'red'),
      rowKey: (r) => r.id,
      refresh: 'lazy',
    })
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'mv-list-resolves-lazy-passphrase-2026',
      materializedViewStrategies: [lazyMV],
    })
    const vault = await db.openVault('demo')
    await vault.collection<Item>('items').put('a', { id: 'a', tag: 'red' })
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const reg = vault._getMaterializedViewRegistry()!
    expect(isMVStale(reg, 'red-items')).toBe(true)

    // list() should trigger the resolve-on-read hook — same as get()
    const rows = await vault.collection<Item>('red-items').list()
    expect(rows).toHaveLength(1)
    expect(isMVStale(reg, 'red-items')).toBe(false)
  })

  it('refreshView returns executor counts with deleted in the shape (niwat-review of #157)', async () => {
    // Tombstoning ships in #158 (next sub-issue). On this branch the
    // executor always returns `deleted: 0` — but the shape is forward-
    // compatible, so consumers reading `result.deleted` see a real
    // number instead of `undefined`. The #158 branch adds the test
    // that asserts `deleted: 1` when a row flips out of the query.
    const mv = withMaterializedView<Item>({
      name: 'red-items',
      query: (db) => db.collection<Item>('items').query().where('tag', '==', 'red'),
      rowKey: (r) => r.id,
      refresh: 'manual',
    })
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'mv-refresh-deleted-count-passphrase-2026',
      materializedViewStrategies: [mv],
    })
    const vault = await db.openVault('demo')
    await vault.collection<Item>('items').put('a', { id: 'a', tag: 'red' })
    const result = await vault.refreshView('red-items')
    expect(result.written).toBe(1)
    expect(result.deleted).toBe(0) // not undefined — shape stable
    expect(result.failed).toBe(0)
  })
})
