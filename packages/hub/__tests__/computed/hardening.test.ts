// Computed-fields hardening (#378 maturity → stable).
//
// Boundary cases beyond the core eval/collection/guard coverage, so the
// preview→stable flip rests on the edges a fiscal app leans on: missing
// inputs, null results, a multi-step dependency chain, and a
// rounding-sensitive computed money field.

import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { createNoydb, MoneyPrecisionError } from '../../src/index.js'
import { evalComputedFields } from '../../src/with-formula/computed/index.js'
import { money } from '../../src/shape/via-money/descriptor.js'
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
        if (vname === v && cname && id) { out[cname] = out[cname] ?? {}; out[cname]![id] = env }
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

describe('evalComputedFields — hardening edges (#378)', () => {
  it('an empty computed map returns an equivalent record (no-op)', () => {
    const rec = { id: 'a', x: 1 }
    expect(evalComputedFields(rec, {}, 'a')).toEqual(rec)
  })

  it('a computed reading a missing input field sees undefined (no throw)', () => {
    const out = evalComputedFields(
      { id: 'a' } as Record<string, unknown>,
      { label: (r) => `v=${String((r as { missing?: number }).missing)}` },
      'a',
    )
    expect(out.label).toBe('v=undefined')
  })

  it('a computed may return null / undefined and it is stored as-is', () => {
    const out = evalComputedFields(
      { id: 'a', n: 0 } as Record<string, unknown>,
      {
        z: () => null,
        u: () => undefined,
      },
      'a',
    )
    expect(out.z).toBeNull()
    expect('u' in out).toBe(true)
    expect(out.u).toBeUndefined()
  })

  it('evaluates a 3-step dependency chain in declaration order', () => {
    const out = evalComputedFields(
      { id: 'a', base: 10 } as Record<string, unknown>,
      {
        net: (r) => (r as { base: number }).base * 2,        // 20
        tax: (r) => (r as { net: number }).net * 0.1,        // 2
        total: (r) => (r as { net: number; tax: number }).net + (r as { tax: number }).tax, // 22
      },
      'a',
    )
    expect(out).toMatchObject({ net: 20, tax: 2, total: 22 })
  })

  it('does not mutate the input even across a dependency chain', () => {
    const rec = { id: 'a', base: 5 } as Record<string, unknown>
    const snapshot = JSON.stringify(rec)
    evalComputedFields(rec, { net: (r) => (r as { base: number }).base * 3 }, 'a')
    expect(JSON.stringify(rec)).toBe(snapshot)
  })
})

describe('computed money field — rounding policy (#378)', () => {
  interface Line extends Record<string, unknown> { id: string; net: number; vat?: string | number | undefined }

  it('FAILS LOUD when a computed money value has sub-scale precision and no rounding mode', async () => {
    // Fiscal-safety default: an ambiguous rounding is an error, not a silent
    // truncation. VAT = 1.07 * 0.07 = 0.0749 → exceeds scale 2 → throws.
    const db = await createNoydb({ store: memory(), user: 'alice', secret: 'computed-hardening-a-2026' })
    const v = await db.openVault('books')
    v.collection<Line>('lines', {
      schema: z.object({ id: z.string(), net: z.number(), vat: z.union([z.number(), z.string()]).optional() }),
      computed: { vat: (r) => (r.net as number) * 0.07 },
      moneyFields: { vat: money({ currency: 'EUR', scale: 2 }) }, // no rounding
    })
    const lines = v.collection<Line>('lines')
    await expect(lines.put('b', { id: 'b', net: 1.07 } as Line)).rejects.toBeInstanceOf(MoneyPrecisionError)
  })

  it('quantizes deterministically once a rounding mode is configured', async () => {
    const db = await createNoydb({ store: memory(), user: 'alice', secret: 'computed-hardening-b-2026' })
    const v = await db.openVault('books')
    v.collection<Line>('lines', {
      schema: z.object({ id: z.string(), net: z.number(), vat: z.union([z.number(), z.string()]).optional() }),
      computed: { vat: (r) => (r.net as number) * 0.07 },
      moneyFields: { vat: money({ currency: 'EUR', scale: 2, rounding: 'half-up' }) },
    })
    const lines = v.collection<Line>('lines')
    await lines.put('a', { id: 'a', net: 1.0 } as Line)   // 0.07 exact
    await lines.put('b', { id: 'b', net: 1.07 } as Line)  // 0.0749 → 0.07
    await lines.put('c', { id: 'c', net: 10.5 } as Line)  // 0.735 → 0.74 (half-up)
    expect((await lines.get('a'))?.vat).toBe('0.07')
    expect((await lines.get('b'))?.vat).toBe('0.07')
    expect((await lines.get('c'))?.vat).toBe('0.74')
  })
})
