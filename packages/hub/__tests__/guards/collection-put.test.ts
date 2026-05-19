import { describe, it, expect } from 'vitest'
import { createNoydb, withGuard, RecordLockedError, FieldFrozenError } from '../../src/index.js'
import type { NoydbStore, EncryptedEnvelope } from '../../src/types.js'

// In-test memory store (matches the hub test convention — see other __tests__/guards/*.test.ts)
function memory(): NoydbStore {
  const data = new Map<string, EncryptedEnvelope>()
  const k = (v: string, c: string, i: string) => `${v}/${c}/${i}`
  return {
    capabilities: { casAtomic: true, auth: { kind: 'none' } },
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
        if (vname === v) {
          out[cname] = out[cname] ?? {}
          out[cname][id] = env
        }
      }
      return out
    },
    async saveAll(v, payload) {
      for (const c of Object.keys(payload)) {
        for (const i of Object.keys(payload[c])) {
          data.set(k(v, c, i), payload[c][i])
        }
      }
    },
  }
}

interface Invoice { id: string; status: 'draft' | 'issued'; total: number; notes?: string }
interface Line { id: string; invoiceId: string; amount: number }

describe('Collection.put — guard hook integration', () => {
  it('blocks a normal write when the cross-collection check throws', async () => {
    const lineGuard = withGuard<Line>({
      collection: 'lines',
      check: async (incoming, { vault }) => {
        const inv = await vault.collection<Invoice>('invoices').get(incoming.invoiceId)
        if (inv?.status === 'issued') {
          throw new RecordLockedError('lines', incoming.id, 'invoice is issued')
        }
      },
    })
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'guards-cross-collection-passphrase-2026',
      guardStrategies: [lineGuard],
    })
    const v = await db.openVault('demo')
    await v.collection<Invoice>('invoices').put('inv1', { id: 'inv1', status: 'issued', total: 100 })
    await expect(
      v.collection<Line>('lines').put('l1', { id: 'l1', invoiceId: 'inv1', amount: 50 }),
    ).rejects.toBeInstanceOf(RecordLockedError)
  })

  it('blocks an edit of a frozen field', async () => {
    const invoiceGuard = withGuard<Invoice>({
      collection: 'invoices',
      frozenFields: { when: r => r.status === 'issued', fields: ['total'] },
    })
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'guards-frozenfields-passphrase-2026',
      guardStrategies: [invoiceGuard],
    })
    const v = await db.openVault('demo')
    const invs = v.collection<Invoice>('invoices')
    await invs.put('inv1', { id: 'inv1', status: 'issued', total: 100 })
    await expect(
      invs.put('inv1', { id: 'inv1', status: 'issued', total: 200 }),
    ).rejects.toBeInstanceOf(FieldFrozenError)
    // editing a non-frozen field is allowed
    await expect(
      invs.put('inv1', { id: 'inv1', status: 'issued', total: 100, notes: 'paid' }),
    ).resolves.not.toThrow()
  })

  it('allows a write when no guard objects', async () => {
    const guard = withGuard<Line>({
      collection: 'lines',
      check: async () => {/* no-op */},
    })
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'guards-permits-passphrase-2026',
      guardStrategies: [guard],
    })
    const v = await db.openVault('demo')
    await expect(
      v.collection<Line>('lines').put('l1', { id: 'l1', invoiceId: 'inv-none', amount: 10 }),
    ).resolves.not.toThrow()
  })

  it('blocks a delete on a locked record', async () => {
    const guard = withGuard<Line>({
      collection: 'lines',
      check: async (_incoming, { existing }) => {
        if (existing) throw new RecordLockedError('lines', 'l1', 'no deletes')
      },
    })
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'guards-delete-passphrase-2026',
      guardStrategies: [guard],
    })
    const v = await db.openVault('demo')
    await v.collection<Line>('lines').put('l1', { id: 'l1', invoiceId: 'x', amount: 10 })
    await expect(v.collection('lines').delete('l1')).rejects.toBeInstanceOf(RecordLockedError)
  })
})
