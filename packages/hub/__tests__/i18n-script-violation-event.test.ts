/** #435 F2 — i18n:script-violation typed event channel. */
import { describe, it, expect, beforeEach } from 'vitest'
import { createNoydb } from '../src/noydb.js'
import { withI18n } from '../src/with-shape/i18n/index.js'
import { i18nText } from '../src/with-shape/i18n/core.js'
import type { Noydb } from '../src/noydb.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { ConflictError } from '../src/kernel/errors.js'

function memory(): NoydbStore {
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

interface Co { id: string; name: Record<string, string> }
async function freshDb(): Promise<Noydb> {
  return createNoydb({ store: memory(), user: 'a', secret: 'pw-sv-event', i18nStrategy: withI18n() })
}

describe('i18n:script-violation event', () => {
  let db: Noydb
  beforeEach(async () => { db = await freshDb() })

  it("emits for 'warn' mode and stores the value unchanged", async () => {
    const events: any[] = []
    db.on('i18n:script-violation', (e) => events.push(e))
    const v = await db.openVault('v', { locale: 'th' })
    const co = v.collection<Co>('co', {
      i18nFields: { name: i18nText({ languages: ['th', 'en'], required: 'any', script: 'auto', onScriptViolation: 'warn' }) },
    })
    await co.put('c1', { id: 'c1', name: { en: 'สมชาย' } }) // Thai in the en slot
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ vault: 'v', collection: 'co', id: 'c1', mode: 'warn' })
    expect(events[0].warning).toMatchObject({ field: 'name', locale: 'en' })
    const got = await co.get('c1', { locale: 'raw' })
    expect((got as any).name.en).toBe('สมชาย') // stored unchanged under 'warn'
  })

  it("emits for 'filter' mode and strips disallowed chars", async () => {
    const events: any[] = []
    db.on('i18n:script-violation', (e) => events.push(e))
    const v = await db.openVault('v', { locale: 'en' })
    const co = v.collection<Co>('co', {
      i18nFields: { name: i18nText({ languages: ['en'], required: 'any', script: { en: ['Latin'] }, onScriptViolation: 'filter' }) },
    })
    await co.put('c1', { id: 'c1', name: { en: 'Somสมchai' } })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ vault: 'v', collection: 'co', id: 'c1', mode: 'filter' })
    expect(events[0].warning).toMatchObject({ field: 'name', locale: 'en' })
    const got = await co.get('c1', { locale: 'raw' })
    expect((got as any).name.en).toBe('Somchai') // Thai stripped
  })

  it("does NOT emit for 'reject' mode (throws instead)", async () => {
    const events: any[] = []
    db.on('i18n:script-violation', (e) => events.push(e))
    const v = await db.openVault('v', { locale: 'th' })
    const co = v.collection<Co>('co', {
      i18nFields: { name: i18nText({ languages: ['th', 'en'], required: 'any', script: 'auto' }) }, // default reject
    })
    await expect(co.put('c1', { id: 'c1', name: { en: 'สมชาย' } })).rejects.toThrow()
    expect(events).toHaveLength(0)
  })
})
