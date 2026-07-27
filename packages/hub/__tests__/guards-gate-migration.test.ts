import { describe, it, expect } from 'vitest'
import { createNoydb, withGuard, RecordLockedError } from '../src/index.js'
import type { NoydbStore, EncryptedEnvelope } from '../src/kernel/types.js'

// Minimal in-test memory store — follows the hub convention (see __tests__/guards/*.test.ts)
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
        const [vname, cname, id] = key.split('/') as [string, string, string]
        if (vname === v) {
          out[cname] = out[cname] ?? {}
          out[cname][id] = env
        }
      }
      return out
    },
    async saveAll(v, payload) {
      for (const c of Object.keys(payload)) {
        for (const i of Object.keys(payload[c]!)) {
          data.set(k(v, c, i), payload[c]![i]!)
        }
      }
    },
  }
}

interface Invoice extends Record<string, unknown> { id: string; status: 'draft' | 'issued'; total: number }

describe('guards-gate-migration — gate handler registration', () => {
  it('plain Noydb (no guardStrategies, no periods) registers no beforePut gate handlers', async () => {
    const plain = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'guards-gate-plain-secret-2026',
    })
    expect((plain as any)._subsystemBus.hasGateHandlers('beforePut')).toBe(false)
  })

  it('guardStrategies Noydb registers a beforePut gate handler', async () => {
    const guard = withGuard<Invoice>({
      collection: 'invoices',
      check: async () => { /* no-op */ },
    })
    const g = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'guards-gate-registered-secret-2026',
      guardStrategies: [guard],
    })
    expect((g as any)._subsystemBus.hasGateHandlers('beforePut')).toBe(true)
  })

  it('guardStrategies Noydb registers a beforeDelete gate handler', async () => {
    const guard = withGuard<Invoice>({
      collection: 'invoices',
      onDelete: async () => { /* no-op */ },
    })
    const g = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'guards-gate-delete-registered-secret-2026',
      guardStrategies: [guard],
    })
    expect((g as any)._subsystemBus.hasGateHandlers('beforeDelete')).toBe(true)
  })
})

describe('guards-gate-migration — enforcement via gate', () => {
  it('a record-locked write is rejected (check via gate)', async () => {
    // Reuse the same scenario as __tests__/guards/collection-put.test.ts:
    // a guard's `check` throws RecordLockedError when a cross-collection
    // condition is violated. After migration, this fires via the gate bus.
    const invoiceGuard = withGuard<Invoice>({
      collection: 'invoices',
      check: async (incoming) => {
        if (incoming.status === 'issued') {
          throw new RecordLockedError('invoices', (incoming as Invoice).id, 'already issued')
        }
      },
    })
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'guards-gate-enforcement-secret-2026',
      guardStrategies: [invoiceGuard],
    })
    const v = await db.openVault('demo')
    // First put should succeed (draft)
    await v.collection<Invoice>('invoices').put('inv1', { id: 'inv1', status: 'draft', total: 100 })
    // Second put with status=issued triggers the check
    await expect(
      v.collection<Invoice>('invoices').put('inv2', { id: 'inv2', status: 'issued', total: 200 }),
    ).rejects.toBeInstanceOf(RecordLockedError)
  })
})
