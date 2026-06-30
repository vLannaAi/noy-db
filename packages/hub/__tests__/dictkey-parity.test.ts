/**
 * dictKey parity (Slice 3): array-of-keys pair objects, wildcard-path
 * resolution (#282), and substitute for labels.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createNoydb } from '../src/noydb.js'
import { withI18n } from '../src/with-shape/i18n/index.js'
import { dictKey } from '../src/with-shape/i18n/dictionary.js'
import { ConflictError } from '../src/errors.js'
import type { Noydb } from '../src/noydb.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/types.js'

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

async function setup() {
  const db: Noydb = await createNoydb({ store: memory(), user: 'a', secret: 'pw-dictkey', i18nStrategy: withI18n() })
  const vault = await db.openVault('v', { locale: 'th' })
  // honorific dictionary: mr/ms both → คุณ in Thai
  const dict = vault.dictionary('contactTitle')
  await dict.put('mr', { en: 'Mr.', th: 'คุณ' })
  await dict.put('ms', { en: 'Ms.', th: 'คุณ' })
  const tags = vault.dictionary('tag')
  await tags.put('urgent', { en: 'Urgent', th: 'ด่วน' })
  await tags.put('vip', { en: 'VIP' }) // no th label
  return { db, vault }
}

describe('dictKey parity', () => {
  it('wildcard-path contacts[].title adds per-element titleLabel (#282)', async () => {
    const { vault } = await setup()
    interface Entity { id: string; contacts: { name: string; title: string }[] }
    const entities = vault.collection<Entity>('entities', {
      dictKeyFields: { 'contacts[].title': dictKey('contactTitle', ['mr', 'ms'] as const) },
    })
    await entities.put('e1', {
      id: 'e1',
      contacts: [{ name: 'Somchai', title: 'mr' }, { name: 'Jane', title: 'ms' }],
    })
    const e = await entities.get('e1') as unknown as Record<string, unknown>
    const contacts = e.contacts as Record<string, unknown>[]
    expect(contacts[0]).toMatchObject({ title: 'mr', titleLabel: 'คุณ' })
    expect(contacts[1]).toMatchObject({ title: 'ms', titleLabel: 'คุณ' })
    // identity preserved: keys stay distinct even though labels collapse
    expect(contacts[0]!.title).not.toBe(contacts[1]!.title)
  })

  it('array-of-keys resolves to [{key,label}] pair objects', async () => {
    const { vault } = await setup()
    interface Doc { id: string; tags: string[] }
    const docs = vault.collection<Doc>('docs', {
      dictKeyFields: { tags: dictKey('tag') },
    })
    await docs.put('d1', { id: 'd1', tags: ['urgent', 'vip', 'x'] })
    const d = await docs.get('d1') as unknown as Record<string, unknown>
    expect(d.tagsLabel).toEqual([
      { key: 'urgent', label: 'ด่วน' },
      { key: 'vip', label: null }, // no th label
      { key: 'x', label: null },   // dangling key
    ])
  })

  it('scalar dictKey still adds <field>Label (unchanged)', async () => {
    const { vault } = await setup()
    interface Doc { id: string; title: string }
    const docs = vault.collection<Doc>('docs2', {
      dictKeyFields: { title: dictKey('contactTitle', ['mr', 'ms'] as const) },
    })
    await docs.put('d1', { id: 'd1', title: 'mr' })
    const d = await docs.get('d1') as unknown as Record<string, unknown>
    expect(d.titleLabel).toBe('คุณ')
  })
})
