/** #435 F1 — densifyOnWrite. */
import { describe, it, expect } from 'vitest'
import { i18nText, applyI18nLocale } from '../src/i18n/core.js'
import { computeExemptFills, densify } from '../src/i18n/densify.js'
import { withI18n } from '../src/i18n/index.js'
import { NO_I18N } from '../src/i18n/strategy.js'
import { createNoydb } from '../src/noydb.js'
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

describe('densifyOnWrite config validation', () => {
  it('rejects densifyOnWrite + explicit scalar throw policy', () => {
    expect(() =>
      i18nText({ languages: ['th', 'en'], required: 'any', densifyOnWrite: true, onMissing: 'throw' }),
    ).toThrow(/densifyOnWrite/)
  })

  it('rejects densifyOnWrite + explicit per-layer throw policy', () => {
    expect(() =>
      i18nText({ languages: ['th', 'en'], required: 'any', densifyOnWrite: true, onMissing: { mv: 'throw' } }),
    ).toThrow(/densifyOnWrite/)
  })

  it('allows densifyOnWrite with no explicit onMissing (default throw is fine)', () => {
    expect(() =>
      i18nText({ languages: ['th', 'en'], required: 'any', densifyOnWrite: true }),
    ).not.toThrow()
  })

  it('allows densifyOnWrite with an explicit non-throw policy', () => {
    expect(() =>
      i18nText({ languages: ['th', 'en'], required: 'any', densifyOnWrite: true, onMissing: 'substitute' }),
    ).not.toThrow()
  })
})

describe('densify (pure)', () => {
  const fields = {
    name: i18nText({ languages: ['th', 'en'], required: 'any', substitute: ['en', 'th'], densifyOnWrite: true }),
  }

  it('fills empty slots and records provenance (insert)', () => {
    const rec: any = { id: 'c1', name: { th: 'สมชาย' } }
    densify(rec, undefined, fields)
    expect(rec.name).toEqual({ th: 'สมชาย', en: 'สมชาย' })
    expect(rec._i18nFilled).toEqual({ name: ['en'] })
  })

  it('refreshes an unchanged round-tripped fill when the source changed', () => {
    const prior: any = { name: { th: 'สมชาย', en: 'สมชาย' }, _i18nFilled: { name: ['en'] } }
    const rec: any = { id: 'c1', name: { th: 'สมชัย', en: 'สมชาย' } } // th corrected, en still old fill
    densify(rec, prior, fields)
    expect(rec.name.en).toBe('สมชัย')
    expect(rec._i18nFilled).toEqual({ name: ['en'] })
  })

  it('clears the marker when a slot becomes authored (no clobber)', () => {
    const prior: any = { name: { th: 'สมชาย', en: 'สมชาย' }, _i18nFilled: { name: ['en'] } }
    const rec: any = { id: 'c1', name: { th: 'สมชาย', en: 'Somchai' } } // real en authored
    densify(rec, prior, fields)
    expect(rec.name.en).toBe('Somchai')
    expect(rec._i18nFilled).toBeUndefined()
  })

  it('computeExemptFills exempts unchanged fills, not changed slots', () => {
    const prior: any = { name: { th: 'สมชาย', en: 'สมชาย' }, _i18nFilled: { name: ['en'] } }
    expect(computeExemptFills(prior, { name: { th: 'สมชัย', en: 'สมชาย' } }, fields).get('name')).toEqual(new Set(['en']))
    expect(computeExemptFills(prior, { name: { th: 'สมชาย', en: 'Somchai' } }, fields).get('name')).toBeUndefined()
    expect(computeExemptFills(undefined, { name: { th: 'สมชาย' } }, fields).size).toBe(0)
  })

  it('fills nothing when there is no source value', () => {
    const rec: any = { id: 'c1' } // name absent
    densify(rec, undefined, fields)
    expect(rec._i18nFilled).toBeUndefined()
  })

  it('drops a stale fill and clears the marker when its source disappears', () => {
    const prior: any = { name: { th: 'สมชาย', en: 'สมชาย' }, _i18nFilled: { name: ['en'] } }
    const rec: any = { id: 'c1', name: { en: 'สมชาย' } } // th removed, only the stale en fill remains
    densify(rec, prior, fields)
    expect(rec.name.en).toBeUndefined() // stale fill dropped — no authored source left
    expect(rec._i18nFilled).toBeUndefined()
  })

  it('fills multiple empty locales from one authored source in one pass', () => {
    const multi = {
      name: i18nText({ languages: ['th', 'en', 'lo'], required: 'any', substitute: ['th'], densifyOnWrite: true }),
    }
    const rec: any = { id: 'c1', name: { th: 'สมชาย' } }
    densify(rec, undefined, multi)
    expect(rec.name).toEqual({ th: 'สมชาย', en: 'สมชาย', lo: 'สมชาย' })
    expect(rec._i18nFilled.name).toEqual(expect.arrayContaining(['en', 'lo']))
    expect(rec._i18nFilled.name).toHaveLength(2)
  })

  it('treats an empty-string slot as eligible to fill', () => {
    const rec: any = { id: 'c1', name: { th: 'สมชาย', en: '' } }
    densify(rec, undefined, fields)
    expect(rec.name.en).toBe('สมชาย') // '' is empty, not authored → filled
    expect(rec._i18nFilled).toEqual({ name: ['en'] })
  })

  it('does not mutate the prior record', () => {
    const prior: any = { name: { th: 'สมชาย', en: 'สมชาย' }, _i18nFilled: { name: ['en'] } }
    const priorSnapshot = JSON.parse(JSON.stringify(prior))
    const rec: any = { id: 'c1', name: { th: 'สมชัย', en: 'สมชาย' } }
    densify(rec, prior, fields)
    expect(prior).toEqual(priorSnapshot)
  })

  it('keeps a re-authored value identical to the fill classified as a fill (value-equality limitation)', () => {
    // 'en' was filled from 'th'; the user re-types the same string for 'en'.
    // Value-equality provenance cannot tell this apart from the round-tripped fill.
    const prior: any = { name: { th: 'สมชาย', en: 'สมชาย' }, _i18nFilled: { name: ['en'] } }
    const rec: any = { id: 'c1', name: { th: 'สมชาย', en: 'สมชาย' } }
    densify(rec, prior, fields)
    expect(rec.name.en).toBe('สมชาย')
    expect(rec._i18nFilled).toEqual({ name: ['en'] }) // stays a fill (and stays script-exempt)
  })
})

describe('densify wired into the strategy', () => {
  const fields = { name: i18nText({ languages: ['th', 'en'], required: 'any', substitute: ['en', 'th'], densifyOnWrite: true }) }

  it('withI18n().densify fills slots', () => {
    const rec: any = { id: 'c1', name: { th: 'สมชาย' } }
    withI18n().densify(rec, undefined, fields)
    expect(rec.name.en).toBe('สมชาย')
  })

  it('NO_I18N densify is a no-op and computeExemptFills is empty', () => {
    const rec: any = { id: 'c1', name: { th: 'สมชาย' } }
    NO_I18N.densify(rec, undefined, fields)
    expect(rec._i18nFilled).toBeUndefined()
    expect(NO_I18N.computeExemptFills(undefined, rec, fields).size).toBe(0)
  })
})

describe('applyI18nLocale strips the _i18nFilled marker (#435)', () => {
  const fields = { name: i18nText({ languages: ['th', 'en'], required: 'any' }) }

  it('removes _i18nFilled from output without mutating the input', () => {
    const rec: any = { id: 'c1', name: { th: 'A', en: 'A' }, _i18nFilled: { name: ['en'] } }
    const out: any = applyI18nLocale(rec, fields, 'raw')
    expect('_i18nFilled' in out).toBe(false)
    expect(rec._i18nFilled).toEqual({ name: ['en'] }) // input untouched
  })
})

interface Co { id: string; name: Record<string, string> }
async function densDb(): Promise<Noydb> {
  return createNoydb({ store: memory(), user: 'a', secret: 'pw-densify', i18nStrategy: withI18n() })
}

describe('densifyOnWrite (integration)', () => {
  it('fills en from th, hides the marker, exposes it via i18nProvenance', async () => {
    const db = await densDb()
    const v = await db.openVault('v', { locale: 'en' })
    const co = v.collection<Co>('co', {
      i18nFields: { name: i18nText({ languages: ['th', 'en'], required: 'any', substitute: ['en', 'th'], densifyOnWrite: true }) },
    })
    await co.put('c1', { id: 'c1', name: { th: 'สมชาย' } })
    expect((await co.get('c1') as any).name).toBe('สมชาย') // en reader sees the fill
    const raw = await co.get('c1', { locale: 'raw' })
    expect('_i18nFilled' in (raw as any)).toBe(false)
    expect((raw as any).name).toEqual({ th: 'สมชาย', en: 'สมชาย' }) // dense
    expect(await co.i18nProvenance('c1')).toEqual({ name: ['en'] })
  })

  it('refreshes on source change and does not clobber an authored value (the round-trip proof)', async () => {
    const db = await densDb()
    const v = await db.openVault('v', { locale: 'en' })
    const co = v.collection<Co>('co', {
      i18nFields: { name: i18nText({ languages: ['th', 'en'], required: 'any', substitute: ['en', 'th'], densifyOnWrite: true, script: 'auto' }) },
    })
    await co.put('c1', { id: 'c1', name: { th: 'สมชาย' } }) // en filled = สมชาย (Thai)
    const r1 = await co.get('c1', { locale: 'raw' })
    await co.put('c1', { id: 'c1', name: { ...(r1 as any).name, th: 'สมชัย' } })
    const r2 = await co.get('c1', { locale: 'raw' })
    expect((r2 as any).name.en).toBe('สมชัย') // refreshed, NOT script-rejected
    expect(await co.i18nProvenance('c1')).toEqual({ name: ['en'] })
    await co.put('c1', { id: 'c1', name: { th: 'สมชัย', en: 'Somchai' } })
    const r3 = await co.get('c1', { locale: 'raw' })
    expect((r3 as any).name.en).toBe('Somchai')
    expect(await co.i18nProvenance('c1')).toBeUndefined() // marker cleared
  })
})
