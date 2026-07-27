import { describe, it, expect } from 'vitest'
import { createNoydb, RecordLockedError, ValidationError, InvariantError } from '../../src/index.js'
import type { GuardStrategyHandle } from '../../src/index.js'
import { immutableGuard } from '../../src/with-audit/guards/immutable-guard.js'
import { withTransactions } from '../../src/with-commit/tx/index.js'
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

interface Invoice extends Record<string, unknown> { id: string; status: string; total: number }

describe('immutableGuard — factory validation', () => {
  it('rejects providing neither after nor appendOnly', () => {
    expect(() => immutableGuard<Invoice>({ collection: 'invoices' })).toThrow(ValidationError)
  })
  it('rejects after + appendOnly together', () => {
    expect(() => immutableGuard<Invoice>({ collection: 'invoices', after: () => true, appendOnly: true }))
      .toThrow(ValidationError)
  })
  it('produces a guard handle for the named collection', () => {
    const h = immutableGuard<Invoice>({ collection: 'invoices', after: (r) => r.status === 'issued' })
    expect(h.spec.collection).toBe('invoices')
    expect(h.spec.amendment?.roles).toEqual(['admin', 'owner'])
  })
})

async function vaultWith(...guards: GuardStrategyHandle<Invoice>[]) {
  const db = await createNoydb({
    store: memory(), user: 'alice', secret: 'immutable-guard-secret-2026-pilot3',
    guardStrategies: guards, txStrategy: withTransactions(),
  })
  const vault = await db.openVault('books')
  return { db, vault }
}

describe('immutableGuard — after: predicate (WORM-after-issue)', () => {
  it('allows create, update, and the transition write; blocks updates once immutable', async () => {
    const { vault } = await vaultWith(immutableGuard<Invoice>({ collection: 'invoices', after: (r) => r.status === 'issued' }))
    const inv = vault.collection<Invoice>('invoices')

    await inv.put('a', { id: 'a', status: 'draft', total: 100 })       // create — ok
    await inv.put('a', { id: 'a', status: 'draft', total: 120 })       // update while draft — ok
    await inv.put('a', { id: 'a', status: 'issued', total: 120 })      // transition to issued — ok

    // now immutable — further updates blocked
    await expect(inv.put('a', { id: 'a', status: 'issued', total: 999 })).rejects.toBeInstanceOf(RecordLockedError)
    expect((await inv.get('a'))?.total).toBe(120)
  })

  it('blocks deletes of an immutable record', async () => {
    const { vault } = await vaultWith(immutableGuard<Invoice>({ collection: 'invoices', after: (r) => r.status === 'issued' }))
    const inv = vault.collection<Invoice>('invoices')
    await inv.put('a', { id: 'a', status: 'issued', total: 50 })
    await expect(inv.delete('a')).rejects.toBeInstanceOf(RecordLockedError)
    expect((await inv.get('a'))?.total).toBe(50)
  })

  it('an admin/owner amendment transaction overrides the lock', async () => {
    const { db, vault } = await vaultWith(immutableGuard<Invoice>({ collection: 'invoices', after: (r) => r.status === 'issued' }))
    const inv = vault.collection<Invoice>('invoices')
    await inv.put('a', { id: 'a', status: 'issued', total: 50 })

    // normal update blocked, amendment allowed
    await db.transaction({ amendment: true, reason: 'correct issued total' }, async (tx) => {
      tx.vault('books').collection<Invoice>('invoices').put('a', { id: 'a', status: 'issued', total: 55 })
    })
    expect((await inv.get('a'))?.total).toBe(55)
  })
})

describe('immutableGuard — amendmentInvariant', () => {
  it('a supplied invariant that throws on a frozen-field change rejects + rolls back the amendment', async () => {
    // Keep `total` inviolable even under amendment: re-throw whenever an
    // existing record's total changes. (`before !== null` skips the seed.)
    const { db, vault } = await vaultWith(
      immutableGuard<Invoice>({
        collection: 'invoices',
        after: (r) => r.status === 'issued',
        amendmentInvariant: (changes) => {
          for (const c of changes) {
            if (c.before !== null && c.after !== null && c.before.total !== c.after.total) {
              throw new InvariantError('total is frozen even under amendment')
            }
          }
        },
      }),
    )
    const inv = vault.collection<Invoice>('invoices')
    await inv.put('a', { id: 'a', status: 'issued', total: 50 })

    // Amendment attempting to change the frozen total is reverted.
    await expect(
      db.transaction({ amendment: true, reason: 'tamper total' }, async (tx) => {
        tx.vault('books').collection<Invoice>('invoices').put('a', { id: 'a', status: 'issued', total: 55 })
      }),
    ).rejects.toBeInstanceOf(InvariantError)
    expect((await inv.get('a'))?.total).toBe(50) // reverted
  })

  it('default (no amendmentInvariant) still allows any amendment — backward compat', async () => {
    const { db, vault } = await vaultWith(
      immutableGuard<Invoice>({ collection: 'invoices', after: (r) => r.status === 'issued' }),
    )
    const inv = vault.collection<Invoice>('invoices')
    await inv.put('a', { id: 'a', status: 'issued', total: 50 })

    await db.transaction({ amendment: true, reason: 'correct issued total' }, async (tx) => {
      tx.vault('books').collection<Invoice>('invoices').put('a', { id: 'a', status: 'issued', total: 55 })
    })
    expect((await inv.get('a'))?.total).toBe(55)
  })
})

describe('immutableGuard — appendOnly', () => {
  it('blocks any update or delete after the initial insert', async () => {
    const { vault } = await vaultWith(immutableGuard<Invoice>({ collection: 'ledger', appendOnly: true }))
    const ledger = vault.collection<Invoice>('ledger')
    await ledger.put('e1', { id: 'e1', status: 'x', total: 1 })   // insert — ok
    await expect(ledger.put('e1', { id: 'e1', status: 'y', total: 2 })).rejects.toBeInstanceOf(RecordLockedError)
    await expect(ledger.delete('e1')).rejects.toBeInstanceOf(RecordLockedError)
  })
})
