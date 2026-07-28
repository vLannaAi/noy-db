import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { createNoydb } from '../../src/index.js'
import { money } from '../../src/via/money/descriptor.js'
import { i18nText } from '../../src/via/i18n/core.js'
import { dictKey } from '../../src/via/i18n/dictionary.js'
import { withI18n } from '../../src/via/i18n/index.js'
import { via, isViaFieldSpec } from '../../src/kernel/via/compose.js'
import { ValidationError } from '../../src/kernel/errors.js'
import type { NoydbStore, EncryptedEnvelope } from '../../src/kernel/types.js'

// #623 Task 9 — via() public composer + sugar equivalence: declaring a field
// through `viaFields: { field: via(money(...)) }` must be indistinguishable
// from declaring it through the feature's own sugar key (`moneyFields`/
// `i18nFields`), and a field declared in both must be rejected.

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
        if (vname === v && cname !== undefined && id !== undefined) { out[cname] = out[cname] ?? {}; out[cname]![id] = env }
      }
      return out
    },
    async saveAll(v, payload) {
      for (const c of Object.keys(payload)) {
        for (const i of Object.keys(payload[c]!)) { data.set(k(v, c, i), payload[c]![i]!) }
      }
    },
  }
}

interface Invoice extends Record<string, unknown> { id: string; total: number | string }
interface Doc extends Record<string, unknown> { id: string; name: Record<string, string> }
interface Mixed extends Record<string, unknown> { id: string; total: number | string; note: Record<string, string> }
interface Order extends Record<string, unknown> { id: string; status: string }

describe('via() composer (#623 Task 9)', () => {
  it('throws ValidationError with zero descriptors', () => {
    expect(() => via()).toThrow(ValidationError)
  })

  it('isViaFieldSpec identifies a via() container and rejects everything else', () => {
    const spec = via(money({ currency: 'EUR' }))
    expect(isViaFieldSpec(spec)).toBe(true)
    expect(isViaFieldSpec({})).toBe(false)
    expect(isViaFieldSpec(null)).toBe(false)
    expect(isViaFieldSpec(undefined)).toBe(false)
  })

  it('sugar equivalence — via(money(...)) writes the same stored envelope and describe() as moneyFields', async () => {
    const store = toMemory()
    const db = await createNoydb({ store, user: 'alice', secret: 'via-compose-money-equivalence-2026' })
    const sugarVault = await db.openVault('sugar')
    const viaVault = await db.openVault('via')

    const schema = z.object({ id: z.string(), total: z.union([z.number(), z.string()]) })
    const sugarCol = sugarVault.collection<Invoice>('invoices', {
      schema,
      moneyFields: { total: money({ currency: 'EUR', scale: 2 }) },
    })
    const viaCol = viaVault.collection<Invoice>('invoices', {
      schema,
      viaFields: { total: via(money({ currency: 'EUR', scale: 2 })) },
    })

    await sugarCol.put('a', { id: 'a', total: 123.45 })
    await viaCol.put('a', { id: 'a', total: 123.45 })

    // Plaintext-by-default store (no `secret`-derived encryption skipped here —
    // compare the non-crypto envelope fields; `_data` is ciphertext under a
    // fresh per-write IV, so compare it via the decoded record, not raw bytes.
    const sugarEnv = await store.get('sugar', 'invoices', 'a')
    const viaEnv = await store.get('via', 'invoices', 'a')
    expect(sugarEnv).not.toBeNull()
    expect(viaEnv).not.toBeNull()
    expect(viaEnv!._noydb).toBe(sugarEnv!._noydb)
    expect(viaEnv!._v).toBe(sugarEnv!._v)
    expect(viaEnv!._by).toBe(sugarEnv!._by)

    const sugarRead = await sugarCol.get('a')
    const viaRead = await viaCol.get('a')
    expect(viaRead).toEqual(sugarRead)
    expect((viaRead as Invoice).total).toBe('123.45')

    expect(viaCol.describe()).toEqual(sugarCol.describe())
  })

  it('sugar equivalence — plaintext store: via(money(...)) writes a byte-identical `_data` body', async () => {
    const store = toMemory()
    const db = await createNoydb({ store, user: 'alice', secret: 'via-compose-money-plaintext-2026', encrypt: false })
    const sugarVault = await db.openVault('sugar')
    const viaVault = await db.openVault('via')

    const schema = z.object({ id: z.string(), total: z.union([z.number(), z.string()]) })
    const sugarCol = sugarVault.collection<Invoice>('invoices', {
      schema,
      moneyFields: { total: money({ currency: 'EUR', scale: 2 }) },
    })
    const viaCol = viaVault.collection<Invoice>('invoices', {
      schema,
      viaFields: { total: via(money({ currency: 'EUR', scale: 2 })) },
    })

    await sugarCol.put('a', { id: 'a', total: 123.45 })
    await viaCol.put('a', { id: 'a', total: 123.45 })

    const sugarEnv = await store.get('sugar', 'invoices', 'a')
    const viaEnv = await store.get('via', 'invoices', 'a')
    // encrypt:false → `_data` IS the plaintext JSON body, so no ciphertext
    // randomness to exclude — the stored bodies must be byte-identical.
    expect(viaEnv!._iv).toBe('')
    expect(sugarEnv!._iv).toBe('')
    expect(viaEnv!._data).toBe(sugarEnv!._data)
  })

  it('sugar equivalence — via(i18nText(...)) fills the same missing slot and reads the same locale as i18nFields', async () => {
    const store = toMemory()
    const db = await createNoydb({
      store, user: 'alice', secret: 'via-compose-i18n-equivalence-2026',
      i18nStrategy: withI18n(),
    })
    const sugarVault = await db.openVault('sugar', { locale: 'en' })
    const viaVault = await db.openVault('via', { locale: 'en' })

    const descOptions = { languages: ['th', 'en'], required: 'any' as const, substitute: ['en', 'th'], densifyOnWrite: true }
    const sugarCol = sugarVault.collection<Doc>('docs', {
      i18nFields: { name: i18nText(descOptions) },
    })
    const viaCol = viaVault.collection<Doc>('docs', {
      viaFields: { name: via(i18nText(descOptions)) },
    })

    await sugarCol.put('c1', { id: 'c1', name: { th: 'สมชาย' } })
    await viaCol.put('c1', { id: 'c1', name: { th: 'สมชาย' } })

    // fill: the missing `en` slot densifies from `th` via the substitute chain
    const sugarRaw = await sugarCol.get('c1', { locale: 'raw' })
    const viaRaw = await viaCol.get('c1', { locale: 'raw' })
    expect(viaRaw).toEqual(sugarRaw)
    expect((viaRaw as Doc).name).toEqual({ th: 'สมชาย', en: 'สมชาย' })

    // locale read: the en reader sees the filled value, identically
    const sugarRead = await sugarCol.get('c1')
    const viaRead = await viaCol.get('c1')
    expect(viaRead).toEqual(sugarRead)
    expect((viaRead as Doc).name).toBe('สมชาย')

    expect(viaCol.describe()).toEqual(sugarCol.describe())
  })

  it('sugar equivalence — via(dictKey(...)) resolves the same <field>Label read as dictKeyFields', async () => {
    const store = toMemory()
    const db = await createNoydb({
      store, user: 'alice', secret: 'via-compose-dictkey-equivalence-2026',
      i18nStrategy: withI18n(),
    })
    const sugarVault = await db.openVault('sugar', { locale: 'th' })
    const viaVault = await db.openVault('via', { locale: 'th' })
    for (const v of [sugarVault, viaVault]) {
      await v.dictionary('status').put('paid', { en: 'Paid', th: 'ชำระแล้ว' })
    }

    const sugarCol = sugarVault.collection<Order>('orders', {
      dictKeyFields: { status: dictKey('status', ['paid'] as const) },
    })
    const viaCol = viaVault.collection<Order>('orders', {
      viaFields: { status: via(dictKey('status', ['paid'] as const)) },
    })

    await sugarCol.put('o1', { id: 'o1', status: 'paid' })
    await viaCol.put('o1', { id: 'o1', status: 'paid' })

    const sugarRead = await sugarCol.get('o1') as Record<string, unknown>
    const viaRead = await viaCol.get('o1') as Record<string, unknown>
    expect(viaRead.statusLabel).toBe('ชำระแล้ว')
    expect(viaRead).toEqual(sugarRead)
    expect(viaCol.describe()).toEqual(sugarCol.describe())
  })

  it('collision: a field declared in both a sugar key and viaFields throws ValidationError naming the field', async () => {
    const db = await createNoydb({ store: toMemory(), user: 'alice', secret: 'via-compose-collision-2026' })
    const vault = await db.openVault('v')

    expect(() => vault.collection<Invoice>('invoices', {
      moneyFields: { total: money({ currency: 'EUR' }) },
      viaFields: { total: via(money({ currency: 'EUR' })) },
    })).toThrow(ValidationError)

    expect(() => vault.collection<Invoice>('invoices2', {
      moneyFields: { total: money({ currency: 'EUR' }) },
      viaFields: { total: via(money({ currency: 'EUR' })) },
    })).toThrow(/total/)
  })

  it('mergeViaFields throws ValidationError naming the field and brand for an unrecognized _viaBrand', async () => {
    const db = await createNoydb({ store: toMemory(), user: 'alice', secret: 'via-compose-unknown-brand-2026' })
    const vault = await db.openVault('v')

    expect(() => vault.collection<Invoice>('invoices', {
      viaFields: { total: via({ _viaBrand: 'bogus' }) },
    })).toThrow(ValidationError)

    expect(() => vault.collection<Invoice>('invoices2', {
      viaFields: { total: via({ _viaBrand: 'bogus' }) },
    })).toThrow(/total/)

    expect(() => vault.collection<Invoice>('invoices3', {
      viaFields: { total: via({ _viaBrand: 'bogus' }) },
    })).toThrow(/bogus/)
  })

  it('stacks money + i18n on different fields in one viaFields map', async () => {
    const db = await createNoydb({
      store: toMemory(), user: 'alice', secret: 'via-compose-stack-2026',
      i18nStrategy: withI18n(),
    })
    const vault = await db.openVault('v', { locale: 'en' })
    const col = vault.collection<Mixed>('invoices', {
      schema: z.object({
        id: z.string(),
        total: z.union([z.number(), z.string()]),
        note: z.record(z.string(), z.string()),
      }),
      viaFields: {
        total: via(money({ currency: 'EUR', scale: 2 })),
        note: via(i18nText({ languages: ['en', 'th'], required: 'all' })),
      },
    })

    await col.put('a', { id: 'a', total: 123.45, note: { en: 'Hello', th: 'สวัสดี' } })
    const read = await col.get('a') as Mixed
    expect(read.total).toBe('123.45')
    expect(read.note).toBe('Hello')

    // required: 'all' still enforces — a record missing a required translation throws.
    await expect(col.put('b', { id: 'b', total: 1, note: { en: 'Only English' } })).rejects.toThrow()
  })
})
