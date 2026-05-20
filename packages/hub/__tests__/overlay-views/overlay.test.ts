import { describe, it, expect } from 'vitest'
import {
  createNoydb,
  withMaterializedView,
  withOverlayedView,
  OverlayBaseIsVirtualError,
  OverlayCollectionUnavailableError,
  OverlayNameCollisionError,
  OverlayIdMismatchError,
} from '../../src/index.js'
import type { NoydbStore, EncryptedEnvelope } from '../../src/types.js'

function memory(): NoydbStore {
  const data = new Map<string, EncryptedEnvelope>()
  const k = (v: string, c: string, i: string) => `${v}/${c}/${i}`
  return {
    capabilities: { casAtomic: true, auth: { kind: 'none' } },
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
          out[cname] = out[cname] ?? {}
          out[cname][id] = env
        }
      }
      return out
    },
    async saveAll(v, payload) {
      for (const c of Object.keys(payload)) {
        for (const i of Object.keys(payload[c])) {
          data.set(k(v, c, i), payload[c][i])
        }
      }
    },
  }
}

interface BaseRow extends Record<string, unknown> {
  clientId: string
  amount: number
}

interface OverlayRow extends Record<string, unknown> {
  clientId: string
  amount: number
  dataStatus?: 'acquired' | 'override'
}

describe('withOverlayedView read-shadow primitive (#154)', () => {
  describe('merge semantics — base/overlay/predicate operations table', () => {
    async function setupBoth() {
      // Base MV computes a constant row per source row.
      const baseMV = withMaterializedView<BaseRow>({
        name: 'pnd1-aggregate',
        query: (db) => db.collection<BaseRow>('compensations').query(),
        rowKey: (r) => r.clientId,
        refresh: 'eager',
      })
      const overlay = withOverlayedView({
        name: 'pnd1',
        base: 'pnd1-aggregate',
        overlay: 'pnd1-overlay',
        shadowField: 'dataStatus',
        shadowValue: 'override',
      })
      const db = await createNoydb({
        store: memory(),
        user: 'alice',
        secret: 'overlay-merge-passphrase-2026',
        materializedViewStrategies: [baseMV],
        overlayedViewStrategies: [overlay],
      })
      const vault = await db.openVault('demo')
      return { vault }
    }

    it('base only (no overlay) → returns base row', async () => {
      const { vault } = await setupBoth()
      await vault.collection<BaseRow>('compensations').put('acme', { clientId: 'acme', amount: 100 })
      const row = await vault.collection<OverlayRow>('pnd1').get('acme')
      expect(row?.amount).toBe(100)
    })

    it('overlay present + predicate true → returns overlay row', async () => {
      const { vault } = await setupBoth()
      await vault.collection<BaseRow>('compensations').put('acme', { clientId: 'acme', amount: 100 })
      await vault.collection<OverlayRow>('pnd1-overlay').put('acme', { clientId: 'acme', amount: 99999, dataStatus: 'override' })
      const row = await vault.collection<OverlayRow>('pnd1').get('acme')
      expect(row?.amount).toBe(99999)
    })

    it('overlay present + predicate false → returns base row (overlay shadowed but predicate fails)', async () => {
      const { vault } = await setupBoth()
      await vault.collection<BaseRow>('compensations').put('acme', { clientId: 'acme', amount: 100 })
      await vault.collection<OverlayRow>('pnd1-overlay').put('acme', { clientId: 'acme', amount: 99999, dataStatus: 'acquired' })
      const row = await vault.collection<OverlayRow>('pnd1').get('acme')
      expect(row?.amount).toBe(100) // base wins; overlay's dataStatus !== 'override'
    })

    it('overlay-only + predicate true → returns overlay row (orphaned-override pattern)', async () => {
      const { vault } = await setupBoth()
      // Write override BEFORE the base materializes
      await vault.collection<OverlayRow>('pnd1-overlay').put('acme', { clientId: 'acme', amount: 99999, dataStatus: 'override' })
      const row = await vault.collection<OverlayRow>('pnd1').get('acme')
      expect(row?.amount).toBe(99999)
    })

    it('overlay-only + predicate false → returns null (stale override state)', async () => {
      const { vault } = await setupBoth()
      await vault.collection<OverlayRow>('pnd1-overlay').put('acme', { clientId: 'acme', amount: 99999, dataStatus: 'acquired' })
      const row = await vault.collection<OverlayRow>('pnd1').get('acme')
      expect(row).toBeNull()
    })

    it('absent on both sides → returns null', async () => {
      const { vault } = await setupBoth()
      expect(await vault.collection<OverlayRow>('pnd1').get('nonexistent')).toBeNull()
    })

    it('list() unions ids and applies merge per row', async () => {
      const { vault } = await setupBoth()
      await vault.collection<BaseRow>('compensations').put('acme', { clientId: 'acme', amount: 100 })
      await vault.collection<BaseRow>('compensations').put('beta', { clientId: 'beta', amount: 200 })
      await vault.collection<OverlayRow>('pnd1-overlay').put('acme', { clientId: 'acme', amount: 99999, dataStatus: 'override' })

      const rows = await vault.collection<OverlayRow>('pnd1').list()
      expect(rows).toHaveLength(2)
      const acme = rows.find(r => r.clientId === 'acme')
      const beta = rows.find(r => r.clientId === 'beta')
      expect(acme?.amount).toBe(99999) // overlay wins
      expect(beta?.amount).toBe(200) // base only
    })
  })

  describe('write semantics', () => {
    it('put(record) derives id via base MV rowKey, routes to overlay collection only', async () => {
      const baseMV = withMaterializedView<BaseRow>({
        name: 'pnd1-aggregate',
        query: (db) => db.collection<BaseRow>('compensations').query(),
        rowKey: (r) => r.clientId,
        refresh: 'eager',
      })
      const overlay = withOverlayedView({
        name: 'pnd1',
        base: 'pnd1-aggregate',
        overlay: 'pnd1-overlay',
        shadowField: 'dataStatus',
        shadowValue: 'override',
      })
      const db = await createNoydb({
        store: memory(),
        user: 'alice',
        secret: 'overlay-write-passphrase-2026',
        materializedViewStrategies: [baseMV],
        overlayedViewStrategies: [overlay],
      })
      const vault = await db.openVault('demo')
      await vault.collection<BaseRow>('compensations').put('acme', { clientId: 'acme', amount: 100 })

      // Write through the virtual collection — id auto-derived
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const virtual: any = vault.collection<OverlayRow>('pnd1')
      await virtual.put({ clientId: 'acme', amount: 99999, dataStatus: 'override' })

      // Confirm: overlay collection has the row; base unchanged
      const overlayRow = await vault.collection<OverlayRow>('pnd1-overlay').get('acme')
      expect(overlayRow?.amount).toBe(99999)
      const baseRow = await vault.collection<BaseRow>('pnd1-aggregate').get('acme')
      expect(baseRow?.amount).toBe(100)
    })

    it('put(id, record) with id !== rowKey(record) throws OverlayIdMismatchError', async () => {
      const baseMV = withMaterializedView<BaseRow>({
        name: 'mv1',
        query: (db) => db.collection<BaseRow>('src').query(),
        rowKey: (r) => r.clientId,
        refresh: 'eager',
      })
      const overlay = withOverlayedView({
        name: 'v',
        base: 'mv1',
        overlay: 'overlay',
        shadowField: 'dataStatus',
        shadowValue: 'override',
      })
      const db = await createNoydb({
        store: memory(),
        user: 'alice',
        secret: 'overlay-id-mismatch-passphrase-2026',
        materializedViewStrategies: [baseMV],
        overlayedViewStrategies: [overlay],
      })
      const vault = await db.openVault('demo')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const virtual: any = vault.collection<OverlayRow>('v')
      await expect(
        virtual.put('wrong-id', { clientId: 'acme', amount: 1, dataStatus: 'override' }),
      ).rejects.toBeInstanceOf(OverlayIdMismatchError)
    })

    it('delete(id) removes overlay row only; base resurfaces', async () => {
      const baseMV = withMaterializedView<BaseRow>({
        name: 'mv1',
        query: (db) => db.collection<BaseRow>('src').query(),
        rowKey: (r) => r.clientId,
        refresh: 'eager',
      })
      const overlay = withOverlayedView({
        name: 'v',
        base: 'mv1',
        overlay: 'overlay',
        shadowField: 'dataStatus',
        shadowValue: 'override',
      })
      const db = await createNoydb({
        store: memory(),
        user: 'alice',
        secret: 'overlay-delete-passphrase-2026',
        materializedViewStrategies: [baseMV],
        overlayedViewStrategies: [overlay],
      })
      const vault = await db.openVault('demo')
      await vault.collection<BaseRow>('src').put('acme', { clientId: 'acme', amount: 100 })
      await vault.collection<OverlayRow>('overlay').put('acme', { clientId: 'acme', amount: 99999, dataStatus: 'override' })

      expect((await vault.collection<OverlayRow>('v').get('acme'))?.amount).toBe(99999)

      // "Un-override": delete the overlay row through the virtual proxy
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const virtual: any = vault.collection<OverlayRow>('v')
      await virtual.delete('acme')

      // Base resurfaces
      expect((await vault.collection<OverlayRow>('v').get('acme'))?.amount).toBe(100)
      // Overlay row gone
      expect(await vault.collection<OverlayRow>('overlay').get('acme')).toBeNull()
    })
  })

  describe('pre-registration validation', () => {
    it('throws OverlayNameCollisionError when virtual name collides with an MV output', async () => {
      const mv = withMaterializedView<BaseRow>({
        name: 'collide',
        query: (db) => db.collection<BaseRow>('src').query(),
        rowKey: (r) => r.clientId,
        refresh: 'eager',
      })
      const ov = withOverlayedView({
        name: 'collide', // collides
        base: 'whatever',
        overlay: 'overlay',
        shadowField: 'flag',
        shadowValue: 1,
      })
      await expect((async () => {
        const db = await createNoydb({
          store: memory(),
          user: 'alice',
          secret: 'overlay-collide-passphrase-2026',
          materializedViewStrategies: [mv],
          overlayedViewStrategies: [ov],
        })
        await db.openVault('demo')
      })()).rejects.toBeInstanceOf(OverlayNameCollisionError)
    })

    it('throws OverlayBaseIsVirtualError when base references another overlay name', async () => {
      const ov1 = withOverlayedView({
        name: 'a',
        base: 'mv-base',
        overlay: 'overlay-a',
        shadowField: 'flag',
        shadowValue: 1,
      })
      const ov2 = withOverlayedView({
        name: 'b',
        base: 'a', // virtual name of ov1
        overlay: 'overlay-b',
        shadowField: 'flag',
        shadowValue: 1,
      })
      await expect((async () => {
        const db = await createNoydb({
          store: memory(),
          user: 'alice',
          secret: 'overlay-virtual-base-passphrase-2026',
          overlayedViewStrategies: [ov1, ov2],
        })
        await db.openVault('demo')
      })()).rejects.toBeInstanceOf(OverlayBaseIsVirtualError)
    })

    it('throws OverlayCollectionUnavailableError when overlay references an MV output', async () => {
      const mv = withMaterializedView<BaseRow>({
        name: 'mv1',
        query: (db) => db.collection<BaseRow>('src').query(),
        rowKey: (r) => r.clientId,
        refresh: 'eager',
      })
      const ov = withOverlayedView({
        name: 'v',
        base: 'src',
        overlay: 'mv1', // MV output — disallowed
        shadowField: 'flag',
        shadowValue: 1,
      })
      await expect((async () => {
        const db = await createNoydb({
          store: memory(),
          user: 'alice',
          secret: 'overlay-mv-as-overlay-passphrase-2026',
          materializedViewStrategies: [mv],
          overlayedViewStrategies: [ov],
        })
        await db.openVault('demo')
      })()).rejects.toBeInstanceOf(OverlayCollectionUnavailableError)
    })
  })
})
