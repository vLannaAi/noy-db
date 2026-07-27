import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { createNoydb } from '../../src/index.js'
import { money, MoneyPrecisionError } from '../../src/via/money/descriptor.js'
import type { NoydbStore, EncryptedEnvelope } from '../../src/kernel/types.js'

function memory(): NoydbStore {
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
        if (vname === v) { out[cname!] = out[cname!] ?? {}; out[cname!]![id!] = env }
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

interface Invoice extends Record<string, unknown> {
  id: string
  total: number | string
}

async function openVault() {
  const db = await createNoydb({
    store: memory(),
    user: 'alice',
    secret: 'money-collection-roundtrip-secret-2026-pilot3',
  })
  return db.openVault('books')
}

describe('money field — collection write/read round-trip', () => {
  it('quantizes on put and decodes on get with locale formatting', async () => {
    const vault = await openVault()
    vault.collection<Invoice>('invoices', {
      schema: z.object({ id: z.string(), total: z.union([z.number(), z.string()]) }),
      moneyFields: { total: money({ currency: 'EUR', scale: 2 }) },
    })
    const col = vault.collection<Invoice>('invoices')
    await col.put('a', { id: 'a', total: 123.45 })

    const read = await col.get('a', { locale: 'de-DE' }) as Record<string, unknown>
    expect(read.total).toBe('123.45')           // exact decimal string
    expect(String(read.totalFormatted)).toContain('123,45')
    expect(read.totalNumber).toBe(123.45)
  })

  it('decodes the primary even with no locale (no raw-integer leak)', async () => {
    const vault = await openVault()
    vault.collection<Invoice>('invoices', {
      schema: z.object({ id: z.string(), total: z.union([z.number(), z.string()]) }),
      moneyFields: { total: money({ currency: 'EUR', scale: 2 }) },
    })
    const col = vault.collection<Invoice>('invoices')
    await col.put('a', { id: 'a', total: '99.90' })

    const read = await col.get('a') as Record<string, unknown>
    expect(read.total).toBe('99.90') // NOT '9990'
  })

  it('exact past 2^53 round-trips through encryption', async () => {
    const vault = await openVault()
    vault.collection<Invoice>('invoices', {
      schema: z.object({ id: z.string(), total: z.union([z.number(), z.string()]) }),
      moneyFields: { total: money({ currency: 'EUR', scale: 2 }) },
    })
    const col = vault.collection<Invoice>('invoices')
    await col.put('big', { id: 'big', total: '90071992547409.91' })

    const read = await col.get('big', { locale: 'de-DE' }) as Record<string, unknown>
    expect(read.total).toBe('90071992547409.91')
    expect(String(read.totalFormatted)).toContain('90.071.992.547.409,91')
  })

  it('rejects excess precision with MoneyPrecisionError on put', async () => {
    const vault = await openVault()
    vault.collection<Invoice>('invoices', {
      schema: z.object({ id: z.string(), total: z.union([z.number(), z.string()]) }),
      moneyFields: { total: money({ currency: 'EUR', scale: 2 }) },
    })
    const col = vault.collection<Invoice>('invoices')
    await expect(col.put('bad', { id: 'bad', total: '1.234' })).rejects.toBeInstanceOf(MoneyPrecisionError)
  })
})
