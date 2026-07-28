import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { createNoydb, withGuard, money, FieldFrozenError } from '../../src/index.js'
import { withTransactions } from '../../src/with-commit/tx/index.js'
import type { NoydbStore, EncryptedEnvelope } from '../../src/kernel/types.js'

// #332 — guard gate context must present money() fields in the SAME
// canonical decoded encoding on both sides. Before the fix, `existing`
// arrived as the RAW stored scaled-int ('1000000') while `incoming`
// carried whatever the caller wrote ('10000.00' when spreading a read),
// so every freeze-style guard flagged every money field as changed on
// every update — even pure telemetry updates ({...record, sentAt}).

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

interface Certificate extends Record<string, unknown> {
  id: string
  status: 'draft' | 'issued'
  totalPaid: number | string
  sentAt: string | null
}

const certSchema = z.object({
  id: z.string(),
  status: z.enum(['draft', 'issued']),
  totalPaid: z.union([z.number(), z.string()]),
  sentAt: z.string().nullable(),
})

describe('money + guards — gate context encoding parity (#332)', () => {
  it('check() sees existing and incoming money in the SAME canonical decoded form', async () => {
    const seen: Array<{ incoming: unknown; existing: unknown }> = []
    const guard = withGuard<Certificate>({
      collection: 'certificates',
      check: (incoming, ctx) => {
        seen.push({ incoming: incoming.totalPaid, existing: (ctx.existing as Certificate | null)?.totalPaid })
      },
    })
    const db = await createNoydb({
      store: toMemory(),
      user: 'alice',
      secret: 'money-guard-parity-secret-2026',
      guardStrategies: [guard],
    })
    const vault = await db.openVault('books')
    const col = vault.collection<Certificate>('certificates', {
      schema: certSchema,
      moneyFields: { totalPaid: money({ currency: 'THB', scale: 2 }) },
    })

    await col.put('c1', { id: 'c1', status: 'issued', totalPaid: 10000, sentAt: null })

    // The niwat markSent shape: spread a read (decoded money) + telemetry change.
    const read = await col.get('c1') as Certificate
    expect(read.totalPaid).toBe('10000.00')
    await col.put('c1', { ...read, sentAt: '2026-06-12T00:00:00Z' })

    // create: existing null, incoming canonicalized from the number input
    expect(seen[0]).toEqual({ incoming: '10000.00', existing: undefined })
    // update: BOTH sides canonical — '10000.00' === '10000.00', not '1000000'
    expect(seen[1]).toEqual({ incoming: '10000.00', existing: '10000.00' })
  })

  it('incoming written as a bare number is canonicalized for the gate too', async () => {
    const seen: unknown[] = []
    const guard = withGuard<Certificate>({
      collection: 'certificates',
      check: (incoming) => { seen.push(incoming.totalPaid) },
    })
    const db = await createNoydb({
      store: toMemory(), user: 'alice',
      secret: 'money-guard-number-secret-2026',
      guardStrategies: [guard],
    })
    const col = (await db.openVault('books')).collection<Certificate>('certificates', {
      schema: certSchema,
      moneyFields: { totalPaid: money({ currency: 'THB', scale: 2 }) },
    })
    await col.put('c1', { id: 'c1', status: 'draft', totalPaid: 99.9, sentAt: null })
    expect(seen[0]).toBe('99.90')
  })

  it('frozenFields does NOT flag an unchanged money field on a telemetry update (CERT-LOCK-001 regression)', async () => {
    const guard = withGuard<Certificate>({
      collection: 'certificates',
      frozenFields: {
        when: (existing) => existing.status === 'issued',
        fields: ['totalPaid', 'status'],
      },
    })
    const db = await createNoydb({
      store: toMemory(), user: 'alice',
      secret: 'money-guard-frozen-secret-2026',
      guardStrategies: [guard],
    })
    const col = (await db.openVault('books')).collection<Certificate>('certificates', {
      schema: certSchema,
      moneyFields: { totalPaid: money({ currency: 'THB', scale: 2 }) },
    })
    await col.put('c1', { id: 'c1', status: 'issued', totalPaid: '10000.00', sentAt: null })

    // markSent: spread the decoded read, change only telemetry — must pass.
    const read = await col.get('c1') as Certificate
    await expect(col.put('c1', { ...read, sentAt: '2026-06-12T00:00:00Z' })).resolves.toBeUndefined()

    // Actually changing the frozen money field must still throw.
    const read2 = await col.get('c1') as Certificate
    await expect(col.put('c1', { ...read2, totalPaid: '20000.00' }))
      .rejects.toThrow(FieldFrozenError)
  })

  it('frozenFields passes when the caller re-sends the amount as a number (10000 vs stored 1000000)', async () => {
    const guard = withGuard<Certificate>({
      collection: 'certificates',
      frozenFields: {
        when: (existing) => existing.status === 'issued',
        fields: ['totalPaid'],
      },
    })
    const db = await createNoydb({
      store: toMemory(), user: 'alice',
      secret: 'money-guard-frozen-num-secret-2026',
      guardStrategies: [guard],
    })
    const col = (await db.openVault('books')).collection<Certificate>('certificates', {
      schema: certSchema,
      moneyFields: { totalPaid: money({ currency: 'THB', scale: 2 }) },
    })
    await col.put('c1', { id: 'c1', status: 'issued', totalPaid: 10000, sentAt: null })
    await expect(
      col.put('c1', { id: 'c1', status: 'issued', totalPaid: 10000, sentAt: '2026-06-12T00:00:00Z' }),
    ).resolves.toBeUndefined()
  })

  it('multi-currency mode: both sides decode to the same { amount, currency } shape', async () => {
    interface Payment extends Record<string, unknown> {
      id: string
      amount: unknown
      note: string | null
    }
    const seen: Array<{ incoming: unknown; existing: unknown }> = []
    const guard = withGuard<Payment>({
      collection: 'payments',
      check: (incoming, ctx) => {
        seen.push({ incoming: incoming.amount, existing: (ctx.existing as Payment | null)?.amount })
      },
    })
    const db = await createNoydb({
      store: toMemory(), user: 'alice',
      secret: 'money-guard-multi-secret-2026',
      guardStrategies: [guard],
    })
    const col = (await db.openVault('books')).collection<Payment>('payments', {
      schema: z.object({ id: z.string(), amount: z.unknown(), note: z.string().nullable() }),
      moneyFields: { amount: money({ currencies: ['EUR', 'USD'] }) },
    })
    await col.put('p1', { id: 'p1', amount: { amount: 123.45, currency: 'EUR' }, note: null })
    const read = await col.get('p1') as Payment
    await col.put('p1', { ...read, note: 'telemetry only' })

    expect(seen[1]).toEqual({
      incoming: { amount: '123.45', currency: 'EUR' },
      existing: { amount: '123.45', currency: 'EUR' },
    })
  })

  it('onDelete sees the decoded canonical value, not the stored scaled-int', async () => {
    let seenExisting: unknown
    const guard = withGuard<Certificate>({
      collection: 'certificates',
      onDelete: (existing) => { seenExisting = existing.totalPaid },
    })
    const db = await createNoydb({
      store: toMemory(), user: 'alice',
      secret: 'money-guard-delete-secret-2026',
      guardStrategies: [guard],
    })
    const col = (await db.openVault('books')).collection<Certificate>('certificates', {
      schema: certSchema,
      moneyFields: { totalPaid: money({ currency: 'THB', scale: 2 }) },
    })
    await col.put('c1', { id: 'c1', status: 'draft', totalPaid: '55.50', sentAt: null })
    await col.delete('c1')
    expect(seenExisting).toBe('55.50')
  })

  it('invalid money input passes through the gate and the write path throws the REAL error', async () => {
    let gateSaw: unknown
    const guard = withGuard<Certificate>({
      collection: 'certificates',
      check: (incoming) => { gateSaw = incoming.totalPaid },
    })
    const db = await createNoydb({
      store: toMemory(), user: 'alice',
      secret: 'money-guard-invalid-secret-2026',
      guardStrategies: [guard],
    })
    const col = (await db.openVault('books')).collection<Certificate>('certificates', {
      schema: certSchema,
      moneyFields: { totalPaid: money({ currency: 'THB', scale: 2 }) },
    })
    await expect(
      col.put('c1', { id: 'c1', status: 'draft', totalPaid: 'not-a-number', sentAt: null }),
    ).rejects.toThrow(/not a finite decimal/)
    // Gate ran first with the un-canonicalizable input passed through verbatim.
    expect(gateSaw).toBe('not-a-number')
  })

  it('amendment invariant change-set carries canonical money on both before and after', async () => {
    const snapshots: Array<{ before: unknown; after: unknown }> = []
    const guard = withGuard<Certificate>({
      collection: 'certificates',
      check: () => { throw new Error('locked outside amendments') },
      amendment: {
        roles: ['admin', 'owner'],
        invariant: (changes) => {
          for (const ch of changes) {
            snapshots.push({
              before: (ch.before as Certificate | null)?.totalPaid,
              after: (ch.after as Certificate | null)?.totalPaid,
            })
          }
        },
      },
    })
    const db = await createNoydb({
      store: toMemory(), user: 'alice',
      secret: 'money-guard-amendment-secret-2026',
      guardStrategies: [guard],
      transactionsStrategy: withTransactions(),
    })
    const vault = await db.openVault('books')
    const col = vault.collection<Certificate>('certificates', {
      schema: certSchema,
      moneyFields: { totalPaid: money({ currency: 'THB', scale: 2 }) },
    })
    await db.transaction({ amendment: true, reason: 'seed' }, async (tx) => {
      tx.vault('books').collection<Certificate>('certificates')
        .put('c1', { id: 'c1', status: 'issued', totalPaid: 10000, sentAt: null })
    })
    await db.transaction({ amendment: true, reason: 'correct amount' }, async (tx) => {
      tx.vault('books').collection<Certificate>('certificates')
        .put('c1', { id: 'c1', status: 'issued', totalPaid: 12000, sentAt: null })
    })
    expect(snapshots[0]).toEqual({ before: undefined, after: '10000.00' })
    expect(snapshots[1]).toEqual({ before: '10000.00', after: '12000.00' })
  })
})
