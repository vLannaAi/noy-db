/**
 * Read-layer policy: get/list honor a field's onMissing/substitute.
 *
 * The driving example — a person's firstName stored in one language,
 * read under an active locale that's absent — substitutes per the
 * declared chain, while a default (no onMissing) field still throws.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createNoydb } from '../src/kernel/noydb.js'
import { withI18n } from '../src/via/i18n/index.js'
import { i18nText } from '../src/via/i18n/core.js'
import { ConflictError } from '../src/kernel/errors.js'
import type { Noydb } from '../src/kernel/noydb.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'

function toMemory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function getCollection(c: string, col: string) {
    let comp = store.get(c)
    if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col)
    if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
    name: 'memory',
    async get(c, col, id) { return store.get(c)?.get(col)?.get(id) ?? null },
    async put(c, col, id, env, ev) {
      const coll = getCollection(c, col)
      const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      coll.set(id, env)
    },
    async delete(c, col, id) { store.get(c)?.get(col)?.delete(id) },
    async list(c, col) { const coll = store.get(c)?.get(col); return coll ? [...coll.keys()] : [] },
    async loadAll(c) {
      const comp = store.get(c); const s: VaultSnapshot = {}
      if (comp) for (const [n, coll] of comp) {
        if (!n.startsWith('_')) {
          const r: Record<string, EncryptedEnvelope> = {}
          for (const [id, e] of coll) r[id] = e
          s[n] = r
        }
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
      if (existing) {
        for (const [name, coll] of existing) {
          if (name.startsWith('_')) comp.set(name, coll)
        }
      }
      store.set(c, comp)
    },
  }
}

interface Person { id: string; firstName: Record<string, string> }

async function freshDb(): Promise<Noydb> {
  return createNoydb({
    store: toMemory(),
    user: 'alice',
    secret: 'test-secret-read-layer',
    i18nStrategy: withI18n(),
  })
}

describe('read-layer onMissing/substitute', () => {
  let db: Noydb
  beforeEach(async () => { db = await freshDb() })

  it("substitutes on get when active locale absent (read:'substitute')", async () => {
    const vault = await db.openVault('v', { locale: 'en' })
    const people = vault.collection<Person>('people', {
      i18nFields: {
        firstName: i18nText({
          languages: ['th', 'en'],
          required: 'any',
          substitute: ['en', 'th', 'any'],
          onMissing: { read: 'substitute' },
        }),
      },
    })
    await people.put('p1', { id: 'p1', firstName: { th: 'สมชาย' } })
    const p = await people.get('p1')
    expect(p?.firstName).toBe('สมชาย')
  })

  it("returns null on get under read:'null'", async () => {
    const vault = await db.openVault('v2', { locale: 'en' })
    const people = vault.collection<Person>('people', {
      i18nFields: {
        firstName: i18nText({
          languages: ['th', 'en'],
          required: 'any',
          onMissing: { read: 'null' },
        }),
      },
    })
    await people.put('p1', { id: 'p1', firstName: { th: 'สมชาย' } })
    const p = await people.get('p1')
    expect(p?.firstName).toBeNull()
  })

  it('default (no onMissing) field still throws on missing locale', async () => {
    const vault = await db.openVault('v3', { locale: 'en' })
    const people = vault.collection<Person>('people', {
      i18nFields: {
        firstName: i18nText({ languages: ['th', 'en'], required: 'any' }),
      },
    })
    await people.put('p1', { id: 'p1', firstName: { th: 'สมชาย' } })
    await expect(people.get('p1')).rejects.toThrow(/locale/i)
  })

  // #291 regression guard: the staticDict locale-gate edit must NOT change the
  // locale-less behavior of an i18nText-only collection. With no active locale,
  // a bare get() must still return the raw { th, en } map untouched — folding
  // hasI18n into the relaxed gate would break this.
  it('i18nText-only collection on a locale-less vault returns the raw map (gate regression)', async () => {
    const vault = await db.openVault('v4')   // NO locale
    const people = vault.collection<Person>('people', {
      i18nFields: {
        firstName: i18nText({ languages: ['th', 'en'], required: 'any' }),
      },
    })
    await people.put('p1', { id: 'p1', firstName: { th: 'สมชาย', en: 'Somchai' } })
    const p = await people.get('p1')
    expect(p?.firstName).toEqual({ th: 'สมชาย', en: 'Somchai' })  // raw map, unresolved
  })
})
