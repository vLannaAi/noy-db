/**
 * #285 export layer — exportStream/exportJSON({ resolveLabels }) read records at
 * the `export` layer: i18nText fields collapse to the locale string and
 * dictKey/staticDict `<field>Label`s resolve; the raw dictionary snapshot is
 * omitted. Without a locale, records stay raw (all-locale backup).
 */
import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { ConflictError } from '../src/kernel/errors.js'
import { createNoydb } from '../src/kernel/noydb.js'
import { withI18n } from '../src/via/i18n/index.js'
import { dictKey } from '../src/via/i18n/dictionary.js'
import { i18nText } from '../src/via/i18n/core.js'

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
    async saveAll() {},
  }
}

interface Item extends Record<string, unknown> { id: string; description: Record<string, string>; status: string }

async function setup() {
  const db = await createNoydb({ store: toMemory(), user: 'a', secret: 'export-i18n-pass-2026', i18nStrategy: withI18n() })
  const vault = await db.openVault('v')
  await vault.dictionary('status').putAll({
    draft: { en: 'Draft', th: 'ฉบับร่าง' },
    paid: { en: 'Paid', th: 'ชำระแล้ว' },
  } as Record<string, Record<string, string>>)
  const items = vault.collection<Item>('items', {
    i18nFields: { description: i18nText({ languages: ['en', 'th'], required: 'all' }) },
    dictKeyFields: { status: dictKey('status', ['draft', 'paid'] as const) },
  })
  await items.put('i1', { id: 'i1', description: { en: 'Consulting', th: 'ที่ปรึกษา' }, status: 'paid' })
  return { vault }
}

describe('#285 export layer', () => {
  it('exportJSON({ resolveLabels }) collapses i18nText + resolves dict labels at the export layer', async () => {
    const { vault } = await setup()
    const json = JSON.parse(await vault.exportJSON({ resolveLabels: 'th' }))
    const rec = (json.collections.items.records as Item[])[0]!
    expect(rec.description).toBe('ที่ปรึกษา')          // i18nText collapsed to 'th'
    expect((rec as { statusLabel?: string }).statusLabel).toBe('ชำระแล้ว') // dict label resolved
    expect(json._dictionaries).toBeUndefined()         // snapshot omitted (records are resolved)
  })

  it('exportJSON() with no locale keeps raw maps + embeds the dictionary snapshot', async () => {
    const { vault } = await setup()
    const json = JSON.parse(await vault.exportJSON())
    const rec = (json.collections.items.records as Item[])[0]!
    expect(rec.description).toEqual({ en: 'Consulting', th: 'ที่ปรึกษา' }) // raw map preserved
    expect(json._dictionaries?.items?.status?.paid?.th).toBe('ชำระแล้ว')   // snapshot present
  })

  it('exportStream({ resolveLabels }) resolves records + omits the per-chunk dictionary', async () => {
    const { vault } = await setup()
    const chunks: Array<{ collection: string; records: Item[]; dictionaries?: unknown }> = []
    for await (const c of vault.exportStream({ resolveLabels: 'en' })) chunks.push(c as never)
    const itemsChunk = chunks.find((c) => c.collection === 'items')!
    expect(itemsChunk.records[0]!.description).toBe('Consulting')
    expect(itemsChunk.dictionaries).toBeUndefined()
  })
})
