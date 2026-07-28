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
import type { NoydbStore, EncryptedEnvelope } from '../../src/kernel/types.js'

function toMemory(): NoydbStore {
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
        store: toMemory(),
        user: 'alice',
        secret: 'overlay-merge-secret-2026',
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
        store: toMemory(),
        user: 'alice',
        secret: 'overlay-write-secret-2026',
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
        store: toMemory(),
        user: 'alice',
        secret: 'overlay-id-mismatch-secret-2026',
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
        store: toMemory(),
        user: 'alice',
        secret: 'overlay-delete-secret-2026',
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

  describe('unimplemented Collection<T> surface throws clearly (niwat-review of #160)', () => {
    async function setupVirtual() {
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
        store: toMemory(),
        user: 'alice',
        secret: 'overlay-stub-secret-2026',
        materializedViewStrategies: [baseMV],
        overlayedViewStrategies: [overlay],
      })
      const vault = await db.openVault('demo')
      // Surface is widened to Collection<T> via the Vault intercept,
      // but `OverlayedCollection` only implements the core read/write
      // surface. The throw-stubs make the error message clear instead
      // of a cryptic "undefined is not a function" crash.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return vault.collection<BaseRow>('v') as any
    }

    it('.query() throws with a clear "not yet implemented" message', async () => {
      const virtual = await setupVirtual()
      expect(() => virtual.query()).toThrow(/not yet implemented for overlay views/)
    })

    it('.subscribe() throws with a clear "not yet implemented" message', async () => {
      const virtual = await setupVirtual()
      expect(() => virtual.subscribe(() => {/* noop */})).toThrow(/not yet implemented for overlay views/)
    })

    it('.live() throws with a clear "not yet implemented" message', async () => {
      const virtual = await setupVirtual()
      expect(() => virtual.live()).toThrow(/not yet implemented for overlay views/)
    })

    it('.scan() / .first() / .count() / putManyAtomic / deleteMany throw with helpful errors', async () => {
      const virtual = await setupVirtual()
      expect(() => virtual.scan()).toThrow(/not yet implemented/)
      expect(() => virtual.first()).toThrow(/not yet implemented/)
      expect(() => virtual.count()).toThrow(/not yet implemented/)
      expect(() => virtual.putManyAtomic()).toThrow(/not yet implemented/)
      expect(() => virtual.deleteMany()).toThrow(/not yet implemented/)
    })

    it('.lazyQuery() throws indicating overlay views never go through lazy-mode', async () => {
      const virtual = await setupVirtual()
      expect(() => virtual.lazyQuery()).toThrow(/not supported/)
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
          store: toMemory(),
          user: 'alice',
          secret: 'overlay-collide-secret-2026',
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
          store: toMemory(),
          user: 'alice',
          secret: 'overlay-virtual-base-secret-2026',
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
          store: toMemory(),
          user: 'alice',
          secret: 'overlay-mv-as-overlay-secret-2026',
          materializedViewStrategies: [mv],
          overlayedViewStrategies: [ov],
        })
        await db.openVault('demo')
      })()).rejects.toBeInstanceOf(OverlayCollectionUnavailableError)
    })
  })

  describe('field-level merge mode (mergeMode)', () => {
    interface MergeRow extends Record<string, unknown> {
      clientId: string
      amount: number
      note?: string
      reviewer?: string
      dataStatus?: 'acquired' | 'approved' | 'flagged' | 'override'
    }

    // Base MV + overlay with a field-merge mergeMode. `approved` pulls
    // amount + note (plus the shadowField) from the overlay; `flagged`
    // pulls only the reviewer + shadowField. `override` keeps the binary
    // full-win path. Anything else falls through to base.
    async function setupMerge() {
      const baseMV = withMaterializedView<MergeRow>({
        name: 'pnd1-aggregate',
        query: (db) => db.collection<MergeRow>('compensations').query(),
        rowKey: (r) => r.clientId,
        refresh: 'eager',
      })
      const overlay = withOverlayedView({
        name: 'pnd1',
        base: 'pnd1-aggregate',
        overlay: 'pnd1-overlay',
        shadowField: 'dataStatus',
        shadowValue: 'override',
        mergeMode: {
          kind: 'field-merge',
          rules: [
            { whenStatus: 'approved', overlayFields: ['dataStatus', 'amount', 'note'] },
            { whenStatus: 'flagged', overlayFields: ['dataStatus', 'reviewer'] },
          ],
        },
      })
      const db = await createNoydb({
        store: toMemory(),
        user: 'alice',
        secret: 'overlay-field-merge-secret-2026',
        materializedViewStrategies: [baseMV],
        overlayedViewStrategies: [overlay],
      })
      const vault = await db.openVault('demo')
      return { vault }
    }

    it('whenStatus=approved → overlayFields come from overlay, rest from base', async () => {
      const { vault } = await setupMerge()
      await vault.collection<MergeRow>('compensations').put('acme', {
        clientId: 'acme', amount: 100, note: 'base-note', reviewer: 'base-rev',
      })
      await vault.collection<MergeRow>('pnd1-overlay').put('acme', {
        clientId: 'acme', amount: 250, note: 'overlay-note', reviewer: 'overlay-rev', dataStatus: 'approved',
      })

      const row = await vault.collection<MergeRow>('pnd1').get('acme')
      // approved pulls amount + note + dataStatus from overlay…
      expect(row?.amount).toBe(250)
      expect(row?.note).toBe('overlay-note')
      expect(row?.dataStatus).toBe('approved')
      // …but reviewer is NOT in the rule → stays the base value.
      expect(row?.reviewer).toBe('base-rev')
    })

    it('overlay status with no matching rule → base wins entirely', async () => {
      const { vault } = await setupMerge()
      await vault.collection<MergeRow>('compensations').put('acme', {
        clientId: 'acme', amount: 100, note: 'base-note',
      })
      await vault.collection<MergeRow>('pnd1-overlay').put('acme', {
        clientId: 'acme', amount: 999, note: 'overlay-note', dataStatus: 'acquired',
      })

      const row = await vault.collection<MergeRow>('pnd1').get('acme')
      expect(row?.amount).toBe(100)
      expect(row?.note).toBe('base-note')
      // No rule matched 'acquired' and it isn't the shadowValue → base.
      expect(row?.dataStatus).toBeUndefined()
    })

    it('shadowField===shadowValue (override) → overlay wins entirely (binary path, mergeMode ignored)', async () => {
      const { vault } = await setupMerge()
      await vault.collection<MergeRow>('compensations').put('acme', {
        clientId: 'acme', amount: 100, note: 'base-note', reviewer: 'base-rev',
      })
      await vault.collection<MergeRow>('pnd1-overlay').put('acme', {
        clientId: 'acme', amount: 777, note: 'overlay-note', reviewer: 'overlay-rev', dataStatus: 'override',
      })

      const row = await vault.collection<MergeRow>('pnd1').get('acme')
      // Full overlay win — every field from overlay, even reviewer.
      expect(row?.amount).toBe(777)
      expect(row?.note).toBe('overlay-note')
      expect(row?.reviewer).toBe('overlay-rev')
      expect(row?.dataStatus).toBe('override')
    })

    it('overlay-only + matching rule (no base) → overlay row returned as-is', async () => {
      const { vault } = await setupMerge()
      await vault.collection<MergeRow>('pnd1-overlay').put('acme', {
        clientId: 'acme', amount: 250, note: 'overlay-note', dataStatus: 'approved',
      })

      const row = await vault.collection<MergeRow>('pnd1').get('acme')
      expect(row?.amount).toBe(250)
      expect(row?.note).toBe('overlay-note')
      expect(row?.dataStatus).toBe('approved')
    })

    it('list() applies field-merge per row', async () => {
      const { vault } = await setupMerge()
      await vault.collection<MergeRow>('compensations').put('acme', {
        clientId: 'acme', amount: 100, note: 'base-acme', reviewer: 'base-rev',
      })
      await vault.collection<MergeRow>('compensations').put('beta', {
        clientId: 'beta', amount: 200, note: 'base-beta',
      })
      // acme: approved → field-merge amount+note. beta: untouched → base.
      await vault.collection<MergeRow>('pnd1-overlay').put('acme', {
        clientId: 'acme', amount: 250, note: 'overlay-acme', reviewer: 'overlay-rev', dataStatus: 'approved',
      })

      const rows = await vault.collection<MergeRow>('pnd1').list()
      expect(rows).toHaveLength(2)
      const acme = rows.find((r) => r.clientId === 'acme')
      const beta = rows.find((r) => r.clientId === 'beta')
      expect(acme?.amount).toBe(250)       // overlay (rule)
      expect(acme?.note).toBe('overlay-acme')
      expect(acme?.reviewer).toBe('base-rev') // not in rule → base
      expect(beta?.amount).toBe(200)       // base only
      expect(beta?.note).toBe('base-beta')
    })

    it('rules evaluated in declaration order — first matching whenStatus wins', async () => {
      // Two rules match the same status; the first declared one must win.
      const baseMV = withMaterializedView<MergeRow>({
        name: 'mv1',
        query: (db) => db.collection<MergeRow>('src').query(),
        rowKey: (r) => r.clientId,
        refresh: 'eager',
      })
      const overlay = withOverlayedView({
        name: 'v',
        base: 'mv1',
        overlay: 'ov',
        shadowField: 'dataStatus',
        shadowValue: 'override',
        mergeMode: {
          kind: 'field-merge',
          rules: [
            // First rule for 'flagged' pulls only reviewer.
            { whenStatus: 'flagged', overlayFields: ['dataStatus', 'reviewer'] },
            // Shadowed second rule for 'flagged' would also pull amount —
            // must be ignored because the first match wins.
            { whenStatus: 'flagged', overlayFields: ['dataStatus', 'reviewer', 'amount'] },
          ],
        },
      })
      const db = await createNoydb({
        store: toMemory(),
        user: 'alice',
        secret: 'overlay-rule-order-secret-2026',
        materializedViewStrategies: [baseMV],
        overlayedViewStrategies: [overlay],
      })
      const vault = await db.openVault('demo')
      await vault.collection<MergeRow>('src').put('acme', {
        clientId: 'acme', amount: 100, reviewer: 'base-rev',
      })
      await vault.collection<MergeRow>('ov').put('acme', {
        clientId: 'acme', amount: 999, reviewer: 'overlay-rev', dataStatus: 'flagged',
      })

      const row = await vault.collection<MergeRow>('v').get('acme')
      expect(row?.reviewer).toBe('overlay-rev') // first rule pulled reviewer
      expect(row?.amount).toBe(100)             // first rule did NOT pull amount → base
      expect(row?.dataStatus).toBe('flagged')
    })

    it('backward-compat: a strategy with NO mergeMode behaves exactly as the binary primitive', async () => {
      const baseMV = withMaterializedView<MergeRow>({
        name: 'mv1',
        query: (db) => db.collection<MergeRow>('src').query(),
        rowKey: (r) => r.clientId,
        refresh: 'eager',
      })
      const overlay = withOverlayedView({
        name: 'v',
        base: 'mv1',
        overlay: 'ov',
        shadowField: 'dataStatus',
        shadowValue: 'override',
        // no mergeMode
      })
      const db = await createNoydb({
        store: toMemory(),
        user: 'alice',
        secret: 'overlay-no-mergemode-secret-2026',
        materializedViewStrategies: [baseMV],
        overlayedViewStrategies: [overlay],
      })
      const vault = await db.openVault('demo')
      await vault.collection<MergeRow>('src').put('acme', { clientId: 'acme', amount: 100, note: 'base' })
      // Non-override status → overlay shadowed out entirely, base wins.
      await vault.collection<MergeRow>('ov').put('acme', {
        clientId: 'acme', amount: 999, note: 'overlay', dataStatus: 'approved',
      })
      expect((await vault.collection<MergeRow>('v').get('acme'))?.amount).toBe(100)
      expect((await vault.collection<MergeRow>('v').get('acme'))?.note).toBe('base')

      // override status → full overlay win, exactly as before.
      await vault.collection<MergeRow>('ov').put('acme', {
        clientId: 'acme', amount: 999, note: 'overlay', dataStatus: 'override',
      })
      expect((await vault.collection<MergeRow>('v').get('acme'))?.amount).toBe(999)
      expect((await vault.collection<MergeRow>('v').get('acme'))?.note).toBe('overlay')
    })
  })
})
