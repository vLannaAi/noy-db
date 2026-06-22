/**
 * Script enforcement wired into Collection.put (#283).
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createNoydb } from '../src/noydb.js'
import { withI18n } from '../src/i18n/index.js'
import { i18nText } from '../src/i18n/core.js'
import type { Noydb } from '../src/noydb.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/types.js'
import { ConflictError } from '../src/errors.js'

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

interface Person { id: string; name: Record<string, string> }
async function db(): Promise<Noydb> { return createNoydb({ store: memory(), user: 'a', secret: 'pw-i18n-r', i18nStrategy: withI18n() }) }

describe('retrieve() over i18nText (all locales) (#308 L1)', () => {
  let n: Noydb
  beforeEach(async () => { n = await db() })

  it('finds a bilingual record by a term in EITHER locale; hit carries matched locale', async () => {
    const v = await n.openVault('v')
    const c = v.collection<Person>('people', {
      i18nFields: { name: i18nText({ languages: ['th', 'en'], required: 'any' }) },
      textIndexes: ['name'],
    })
    await c.put('a', { id: 'a', name: { th: 'สมชาย', en: 'Somchai' } })
    const byEn = await c.retrieve('somchai')
    const byTh = await c.retrieve('สมชาย')
    expect(byEn[0]!.id).toBe('a'); expect(byEn[0]!.locale).toBe('en')
    expect(byTh[0]!.id).toBe('a'); expect(byTh[0]!.locale).toBe('th')
  })
})
