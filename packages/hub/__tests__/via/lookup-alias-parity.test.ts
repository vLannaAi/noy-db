/**
 * Alias-equivalence lock (#650 Task 2) — the phase's biggest regression
 * surface. For the reserved tier (dictKey vs dict()) and the static tier
 * (staticDict vs lookup(static)), the SAME fixture declared once under the
 * legacy alias and once under the native lookup descriptor must produce
 * byte-identical `_getStoredRecord`, `present({locale})` (`.get()`),
 * `describe()`, and `.join()` dressing.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../../src/kernel/noydb.js'
import { withI18n } from '../../src/via/i18n/index.js'
import { dictKey, staticDict } from '../../src/via/i18n/dictionary.js'
import { via } from '../../src/kernel/via/compose.js'
import { lookup, dict } from '../../src/via/lookup/descriptor.js'
import { ConflictError } from '../../src/kernel/errors.js'
import type { Noydb } from '../../src/kernel/noydb.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../../src/kernel/types.js'

function toMemory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function gc(c: string, col: string) {
    let comp = store.get(c); if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col); if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
    name: 'memory',
    async get(c, col, id) { return store.get(c)?.get(col)?.get(id) ?? null },
    async put(c, col, id, env, ev) {
      const coll = gc(c, col); const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      coll.set(id, env)
    },
    async delete(c, col, id) { store.get(c)?.get(col)?.delete(id) },
    async list(c, col) { const coll = store.get(c)?.get(col); return coll ? [...coll.keys()] : [] },
    async loadAll(c) {
      const comp = store.get(c); const s: VaultSnapshot = {}
      if (comp) for (const [n, coll] of comp) if (!n.startsWith('_')) {
        const r: Record<string, EncryptedEnvelope> = {}; for (const [id, e] of coll) r[id] = e; s[n] = r
      }
      return s
    },
    async saveAll(c, data) {
      const comp = new Map<string, Map<string, EncryptedEnvelope>>()
      for (const [name, records] of Object.entries(data)) {
        const coll = new Map<string, EncryptedEnvelope>()
        for (const [id, env] of Object.entries(records)) coll.set(id, env)
        comp.set(name, coll)
      }
      const existing = store.get(c)
      if (existing) for (const [name, coll] of existing) if (name.startsWith('_')) comp.set(name, coll)
      store.set(c, comp)
    },
  }
}

async function freshDb(): Promise<Noydb> {
  return createNoydb({ store: toMemory(), user: 'a', secret: 'lookup-alias-parity-pass-2026', i18nStrategy: withI18n() })
}

interface Invoice extends Record<string, unknown> { id: string; status: string }
interface Worker extends Record<string, unknown> { id: string; civilStatus: string }

describe('lookup alias-equivalence parity (#650 Task 2)', () => {
  describe('reserved tier — dictKey() vs dict()', () => {
    it('_getStoredRecord, present({locale}), describe(), and .join() are byte-identical', async () => {
      const db = await freshDb()
      const vault = await db.openVault('v')
      await vault.dictionary('status').putAll({
        draft: { en: 'Draft', th: 'ฉบับร่าง' },
        paid: { en: 'Paid', th: 'ชำระแล้ว' },
      })

      const aliasColl = vault.collection<Invoice>('invoices-alias', {
        dictKeyFields: { status: dictKey('status', ['draft', 'paid'] as const) },
      })
      const nativeColl = vault.collection<Invoice>('invoices-native', {
        viaFields: { status: via(dict('status', { keys: ['draft', 'paid'] as const })) },
      })

      await aliasColl.put('i1', { id: 'i1', status: 'paid' })
      await nativeColl.put('i1', { id: 'i1', status: 'paid' })

      // _getStoredRecord
      const aliasStored = await aliasColl._getStoredRecord('i1')
      const nativeStored = await nativeColl._getStoredRecord('i1')
      expect(nativeStored?.status).toEqual(aliasStored?.status)

      // present({locale})
      const aliasRead = await aliasColl.get('i1', { locale: 'th' }) as Invoice & { statusLabel?: string }
      const nativeRead = await nativeColl.get('i1', { locale: 'th' }) as Invoice & { statusLabel?: string }
      expect(nativeRead.status).toBe(aliasRead.status)
      expect(nativeRead.statusLabel).toBe(aliasRead.statusLabel)
      expect(nativeRead.statusLabel).toBe('ชำระแล้ว')

      // present({locale:'raw'}) — Minor 1: binding.ts:97's raw guard applies to
      // a native lookup field exactly as it does to the dictKey alias (no
      // synthetic statusLabel on a raw read).
      const aliasRaw = await aliasColl.get('i1', { locale: 'raw' }) as Invoice & { statusLabel?: string }
      const nativeRaw = await nativeColl.get('i1', { locale: 'raw' }) as Invoice & { statusLabel?: string }
      expect(nativeRaw).toEqual(aliasRaw)
      expect(nativeRaw.statusLabel).toBeUndefined()

      // describe()
      const aliasField = aliasColl.describe().fields.find((f) => f.key === 'status')
      const nativeField = nativeColl.describe().fields.find((f) => f.key === 'status')
      expect(nativeField?.type).toBe(aliasField?.type)
      expect(nativeField?.widget).toBe(aliasField?.widget)
      expect(nativeField?.dict).toEqual(aliasField?.dict)

      // .join() dressing
      const aliasJoin = aliasColl.query().where('id', '==', 'i1').join('status', { as: 'statusInfo' }).toArray()
      const nativeJoin = nativeColl.query().where('id', '==', 'i1').join('status', { as: 'statusInfo' }).toArray()
      expect((nativeJoin[0] as Record<string, unknown>)['statusInfo']).toEqual(
        (aliasJoin[0] as Record<string, unknown>)['statusInfo'],
      )
    })

    it('describeAsync({resolveDictLabels:true}) resolves labels identically to the dictKey alias', async () => {
      const db = await freshDb()
      const vault = await db.openVault('v')
      await vault.dictionary('status').putAll({
        draft: { en: 'Draft', th: 'ฉบับร่าง' },
        paid: { en: 'Paid', th: 'ชำระแล้ว' },
      })

      const aliasColl = vault.collection<Invoice>('invoices-alias-async', {
        dictKeyFields: { status: dictKey('status', ['draft', 'paid'] as const) },
      })
      const nativeColl = vault.collection<Invoice>('invoices-native-async', {
        viaFields: { status: via(dict('status', { keys: ['draft', 'paid'] as const })) },
      })

      const aliasDesc = await aliasColl.describe({ resolveDictLabels: true })
      const nativeDesc = await nativeColl.describe({ resolveDictLabels: true })
      const aliasField = aliasDesc.fields.find((f) => f.key === 'status')
      const nativeField = nativeDesc.fields.find((f) => f.key === 'status')
      expect(nativeField?.dict).toEqual(aliasField?.dict)
      expect(nativeField?.dict?.values?.every((v) => v.label !== undefined)).toBe(true)
    })
  })

  describe('static tier — staticDict() vs lookup(static)', () => {
    const TABLE = {
      adultMale: { th: 'นาย', en: 'Mr' },
      adultFemale: { th: 'นาง', en: 'Mrs' },
    } as const

    it('_getStoredRecord, present({locale}), describe(), and .join() are byte-identical', async () => {
      const db = await freshDb()
      const vault = await db.openVault('v')

      const aliasColl = vault.collection<Worker>('workers-alias', {
        dictKeyFields: { civilStatus: staticDict('civilStatus-alias', TABLE, { displayLocale: 'th' }) },
      })
      const nativeColl = vault.collection<Worker>('workers-native', {
        viaFields: {
          civilStatus: via(lookup('civilStatus-native', { backing: 'static', table: TABLE, displayLocale: 'th' })),
        },
      })

      await aliasColl.put('w1', { id: 'w1', civilStatus: 'adultMale' })
      await nativeColl.put('w1', { id: 'w1', civilStatus: 'adultMale' })

      // _getStoredRecord
      const aliasStored = await aliasColl._getStoredRecord('w1')
      const nativeStored = await nativeColl._getStoredRecord('w1')
      expect(nativeStored?.civilStatus).toEqual(aliasStored?.civilStatus)

      // present({locale}) — locale-less (the hybrid hinge via displayLocale) and locale-active
      const aliasNoLocale = await aliasColl.get('w1') as Worker & { civilStatusLabel?: string }
      const nativeNoLocale = await nativeColl.get('w1') as Worker & { civilStatusLabel?: string }
      expect(nativeNoLocale.civilStatusLabel).toBe(aliasNoLocale.civilStatusLabel)
      expect(nativeNoLocale.civilStatusLabel).toBe('นาย')

      const aliasEn = await aliasColl.get('w1', { locale: 'en' }) as Worker & { civilStatusLabel?: string }
      const nativeEn = await nativeColl.get('w1', { locale: 'en' }) as Worker & { civilStatusLabel?: string }
      expect(nativeEn.civilStatusLabel).toBe(aliasEn.civilStatusLabel)
      expect(nativeEn.civilStatusLabel).toBe('Mr')

      // describe() — dict.values differ in `name` only because the two
      // fixtures use distinct dimension names (avoids cross-collection
      // staticByName collisions); compare shape/values, not the name.
      const aliasField = aliasColl.describe().fields.find((f) => f.key === 'civilStatus')
      const nativeField = nativeColl.describe().fields.find((f) => f.key === 'civilStatus')
      expect(nativeField?.type).toBe(aliasField?.type)
      expect(nativeField?.widget).toBe(aliasField?.widget)
      expect(nativeField?.dict?.static).toBe(aliasField?.dict?.static)
      expect(nativeField?.dict?.values).toEqual(aliasField?.dict?.values)

      // describeAsync({resolveDictLabels:true}) — the static tier resolves
      // synchronously from the in-code table either way; assert the async
      // overload's output matches the sync overload's, for both alias and native.
      const aliasAsyncField = (await aliasColl.describe({ resolveDictLabels: true })).fields.find((f) => f.key === 'civilStatus')
      const nativeAsyncField = (await nativeColl.describe({ resolveDictLabels: true })).fields.find((f) => f.key === 'civilStatus')
      expect(aliasAsyncField?.dict).toEqual(aliasField?.dict)
      expect(nativeAsyncField?.dict?.static).toBe(aliasAsyncField?.dict?.static)
      expect(nativeAsyncField?.dict?.values).toEqual(aliasAsyncField?.dict?.values)

      // .join() dressing
      const aliasJoin = aliasColl.query().where('id', '==', 'w1').join('civilStatus', { as: 'info' }).toArray()
      const nativeJoin = nativeColl.query().where('id', '==', 'w1').join('civilStatus', { as: 'info' }).toArray()
      expect((nativeJoin[0] as Record<string, unknown>)['info']).toEqual(
        (aliasJoin[0] as Record<string, unknown>)['info'],
      )
    })
  })
})
