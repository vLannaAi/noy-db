/**
 * #285 dictKey label-sort — orderBy(field, dir, { by: 'label' }) sorts a
 * dictKey/staticDict field by its resolved label at the query locale (or a
 * staticDict displayLocale), not by the stored code.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/kernel/noydb.js'
import { ConflictError } from '../src/kernel/errors.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { withI18n } from '../src/with-shape/i18n/index.js'
import { staticDict } from '../src/with-shape/i18n/dictionary.js'

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
    async saveAll(c, data) { for (const [n, recs] of Object.entries(data)) { const coll = gc(c, n); for (const [id, e] of Object.entries(recs)) coll.set(id, e) } },
  }
}

// Codes 'a1'/'z1' deliberately sort OPPOSITE to their labels:
//   by code asc → a1, z1   ;   by label(en) asc → z1(Apple), a1(Zebra)
interface Row extends Record<string, unknown> { id: string; cat: string }
const CAT = staticDict('cat', {
  a1: { en: 'Zebra', th: 'ม้าลาย' },
  z1: { en: 'Apple', th: 'แอปเปิล' },
}, { displayLocale: 'en' })
const SECRET = 'dictkey-label-sort-pass-2026'

async function seed() {
  const db = await createNoydb({ store: memory(), user: 'a', secret: SECRET, i18nStrategy: withI18n() })
  const vault = await db.openVault('v')
  const rows = vault.collection<Row>('rows', { dictKeyFields: { cat: CAT } })
  await rows.put('r-a', { id: 'r-a', cat: 'a1' })
  await rows.put('r-z', { id: 'r-z', cat: 'z1' })
  return { rows }
}

describe('#285 dictKey label-sort', () => {
  it('default orderBy sorts by the stored code', async () => {
    const { rows } = await seed()
    const out = rows.query().orderBy('cat', 'asc').toArray()
    expect(out.map((r) => r.id)).toEqual(['r-a', 'r-z']) // a1 < z1
  })

  it('orderBy({ by: "label" }) sorts by the resolved label (staticDict displayLocale, locale-less)', async () => {
    const { rows } = await seed()
    const out = rows.query().orderBy('cat', 'asc', { by: 'label' }).toArray()
    expect(out.map((r) => r.id)).toEqual(['r-z', 'r-a']) // Apple(z1) < Zebra(a1)
  })

  it('orderBy({ by: "label" }) honors the per-call query locale', async () => {
    const { rows } = await seed()
    // th labels sort by code point: ม (U+0E21, ม้าลาย/a1) < แ (U+0E41, แอปเปิล/z1)
    // → [r-a, r-z], which DIFFERS from the en order [r-z, r-a] → the locale flows.
    const out = rows.query().orderBy('cat', 'asc', { by: 'label' }).toArray({ locale: 'th' })
    expect(out.map((r) => r.id)).toEqual(['r-a', 'r-z'])
  })

  it('desc label-sort reverses', async () => {
    const { rows } = await seed()
    const out = rows.query().orderBy('cat', 'desc', { by: 'label' }).toArray()
    expect(out.map((r) => r.id)).toEqual(['r-a', 'r-z']) // Zebra(a1) > Apple(z1)
  })
})
