import { describe, it, expect } from 'vitest'
import { createNoydb, withGuard, RecordLockedError, InvariantError } from '../../src/index.js'
import { withTransactions } from '../../src/tx/index.js'
import type { NoydbStore, EncryptedEnvelope } from '../../src/types.js'

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
        if (vname === v) {
          out[cname!] = out[cname!] ?? {}
          out[cname!]![id!] = env
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

interface Invoice extends Record<string, unknown> {
  id: string
  status: 'new' | 'draft' | 'sent' | 'paid' | 'cancelled'
  total: number
}

describe('withGuard.onDelete (#145)', () => {
  it('rejects delete when onDelete throws — BILL-DELETE-001 shape', async () => {
    // Only unsent / cancelled invoices may be deleted.
    const guard = withGuard<Invoice>({
      collection: 'invoices',
      onDelete: (existing) => {
        if (!['new', 'draft', 'cancelled'].includes(existing.status)) {
          throw new RecordLockedError(
            'invoices',
            existing.id,
            `cannot delete invoice in status "${existing.status}"`,
          )
        }
      },
    })
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'guards-ondelete-bill-delete-passphrase-2026',
      guardStrategies: [guard],
    })
    const v = await db.openVault('demo')
    const invs = v.collection<Invoice>('invoices')

    await invs.put('inv1', { id: 'inv1', status: 'draft', total: 100 })
    await invs.put('inv2', { id: 'inv2', status: 'sent', total: 200 })
    await invs.put('inv3', { id: 'inv3', status: 'cancelled', total: 300 })

    // draft → allowed
    await expect(invs.delete('inv1')).resolves.not.toThrow()
    // sent → rejected
    await expect(invs.delete('inv2')).rejects.toBeInstanceOf(RecordLockedError)
    // cancelled → allowed
    await expect(invs.delete('inv3')).resolves.not.toThrow()
    // record still present after rejected delete
    expect(await invs.get('inv2')).not.toBeNull()
  })

  it('skips onDelete entirely when target record is absent (idempotent delete)', async () => {
    let onDeleteCalls = 0
    const guard = withGuard<Invoice>({
      collection: 'invoices',
      onDelete: () => { onDeleteCalls++ },
    })
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'guards-ondelete-absent-passphrase-2026',
      guardStrategies: [guard],
    })
    const v = await db.openVault('demo')
    await v.collection<Invoice>('invoices').delete('never-existed')
    expect(onDeleteCalls).toBe(0)
  })

  it('receives ctx.vault — cross-collection check on delete', async () => {
    interface Receipt extends Record<string, unknown> { id: string; invoiceId: string }
    // Reject delete of an invoice if a receipt references it.
    const guard = withGuard<Invoice>({
      collection: 'invoices',
      onDelete: async (existing, ctx) => {
        const receipts = await ctx.vault.collection<Receipt>('receipts').list()
        if (receipts.some(r => r.invoiceId === existing.id)) {
          throw new RecordLockedError(
            'invoices',
            existing.id,
            'has receipts referencing it',
          )
        }
      },
    })
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'guards-ondelete-cross-collection-passphrase-2026',
      guardStrategies: [guard],
    })
    const v = await db.openVault('demo')
    await v.collection<Invoice>('invoices').put('inv1', { id: 'inv1', status: 'paid', total: 500 })
    await v.collection<Invoice>('invoices').put('inv2', { id: 'inv2', status: 'cancelled', total: 100 })
    await v.collection<Receipt>('receipts').put('r1', { id: 'r1', invoiceId: 'inv1' })

    await expect(v.collection('invoices').delete('inv1')).rejects.toBeInstanceOf(RecordLockedError)
    await expect(v.collection('invoices').delete('inv2')).resolves.not.toThrow()
  })

  it('bypassed inside an amendment transaction (admin override)', async () => {
    let onDeleteCalls = 0
    const guard = withGuard<Invoice>({
      collection: 'invoices',
      onDelete: () => { onDeleteCalls++; throw new RecordLockedError('invoices', '', 'no normal-mode deletes') },
      amendment: {
        roles: ['admin', 'owner'],
        invariant: () => {/* allow */},
      },
    })
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'guards-ondelete-amendment-passphrase-2026',
      guardStrategies: [guard],
      txStrategy: withTransactions(),
    })
    const v = await db.openVault('demo')
    const invs = v.collection<Invoice>('invoices')
    await invs.put('inv1', { id: 'inv1', status: 'paid', total: 999 })

    // Normal-mode delete: onDelete fires and rejects
    await expect(invs.delete('inv1')).rejects.toBeInstanceOf(RecordLockedError)
    expect(onDeleteCalls).toBe(1)

    // Amendment delete: onDelete skipped, invariant runs at commit
    await db.transaction(
      { amendment: true, reason: 'historical correction' },
      async (tx) => {
        await tx.vault('demo').collection('invoices').delete('inv1')
      },
    )
    expect(onDeleteCalls).toBe(1) // not incremented during amendment
    expect(await invs.get('inv1')).toBeNull()
  })

  it('unconditional delete-block — pair onDelete + amendment.invariant (RCT-CANCEL-001 shape)', async () => {
    // Niwat-review on #145: `onDelete: () => throw` alone is NOT
    // unconditional — admin amendments still bypass it. For
    // legal-document immutability (e.g. Thai Revenue Code §86: receipts
    // are append-only forever), the consumer must pair the two hooks:
    //
    //   - `onDelete` blocks normal-mode user deletes
    //   - `amendment.invariant` re-throws on any `before !== null &&
    //     after === null` change, blocking the amendment escape too
    //
    // This test pins the canonical pairing so consumers copying the
    // worked example don't ship with a silent amendment-shaped gap.
    interface Receipt extends Record<string, unknown> { id: string; amount: number }
    const guard = withGuard<Receipt>({
      collection: 'receipts',
      onDelete: () => {
        throw new RecordLockedError('receipts', '', 'receipts are append-only (RCT-CANCEL-001)')
      },
      amendment: {
        roles: ['admin', 'owner'],
        invariant: (changes) => {
          for (const c of changes) {
            if (c.before !== null && c.after === null) {
              throw new RecordLockedError(
                'receipts',
                '',
                'receipts are append-only — amendment cannot delete (RCT-CANCEL-001)',
              )
            }
          }
        },
      },
    })
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'guards-ondelete-unconditional-passphrase-2026',
      guardStrategies: [guard],
      txStrategy: withTransactions(),
    })
    const v = await db.openVault('demo')
    await v.collection<Receipt>('receipts').put('r1', { id: 'r1', amount: 100 })

    // Normal-mode delete: blocked by onDelete
    await expect(
      v.collection('receipts').delete('r1'),
    ).rejects.toBeInstanceOf(RecordLockedError)
    expect(await v.collection<Receipt>('receipts').get('r1')).not.toBeNull()

    // Amendment delete: blocked by invariant at commit (onDelete IS
    // bypassed as designed; invariant catches it). The thrown
    // RecordLockedError is wrapped in InvariantError by
    // GuardExecutor.runInvariant — the message survives.
    await expect(
      db.transaction(
        { amendment: true, reason: 'attempt to delete' },
        async (tx) => {
          await tx.vault('demo').collection('receipts').delete('r1')
        },
      ),
    ).rejects.toThrow(/RCT-CANCEL-001/)
    expect(InvariantError).toBeDefined() // sanity import
    // Record still present — invariant rolled back the staged delete
    expect(await v.collection<Receipt>('receipts').get('r1')).not.toBeNull()
  })
})
