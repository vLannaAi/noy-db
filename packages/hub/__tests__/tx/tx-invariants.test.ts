/**
 * Commit-time changeset invariants for ordinary transactions (#342 / AU+026).
 *
 * `withTransactions({ invariants: [{ scope, check }] })` registers set-level
 * constraints that fire at commit for NORMAL `db.transaction(fn)` calls (no
 * amendment, no role gate). The scenarios below pin the contract:
 *
 *   1. Passing invariant → tx commits.
 *   2. Throwing invariant → InvariantError + ALL writes rolled back.
 *   3. before/after correctness (insert → before null; update → before prior).
 *   4. An invariant whose scope wasn't touched is not called.
 *   5. Invariants are additive with amendment — an amendment tx runs them too.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, InvariantError, withGuard } from '../../src/index.js'
import { withTransactions } from '../../src/with-commit/tx/index.js'
import type { TransactionInvariant } from '../../src/with-commit/tx/index.js'
import type { NoydbStore, EncryptedEnvelope } from '../../src/kernel/types.js'

function memory(): NoydbStore {
  const data = new Map<string, EncryptedEnvelope>()
  const k = (v: string, c: string, i: string) => `${v}/${c}/${i}`
  return {
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
        if (vname === v && cname && id) {
          out[cname] = out[cname] ?? {}
          out[cname]![id] = env
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

interface Payment extends Record<string, unknown> {
  id: string
  amount: number
  receiptAmount: number
}

// assertR1: every payment must be 100% receipted (receiptAmount === amount).
const assertR1: TransactionInvariant = {
  scope: 'payments',
  check: (changes) => {
    for (const { after } of changes) {
      const p = after as Payment | null
      if (p !== null && p.receiptAmount !== p.amount) {
        throw new InvariantError(`R1: payment ${p.id} not fully receipted`)
      }
    }
  },
}

describe('withTransactions({ invariants }) — commit-time changeset invariants', () => {
  it('commits when the invariant passes', async () => {
    const db = await createNoydb({
      store: memory(),
      user: 'owner',
      secret: 'tx-invariants-pass-passphrase-2026',
      txStrategy: withTransactions({ invariants: [assertR1] }),
    })
    const v = await db.openVault('acme')

    await db.transaction(async (tx) => {
      tx.vault('acme').collection<Payment>('payments').put('p1', { id: 'p1', amount: 100, receiptAmount: 100 })
    })

    expect(await v.collection<Payment>('payments').get('p1')).toEqual({ id: 'p1', amount: 100, receiptAmount: 100 })
  })

  it('throws InvariantError and rolls back ALL writes when the invariant fails', async () => {
    const db = await createNoydb({
      store: memory(),
      user: 'owner',
      secret: 'tx-invariants-fail-passphrase-2026',
      txStrategy: withTransactions({ invariants: [assertR1] }),
    })
    const v = await db.openVault('acme')

    // Seed a prior valid payment OUTSIDE the failing tx.
    await v.collection<Payment>('payments').put('good', { id: 'good', amount: 50, receiptAmount: 50 })

    await expect(
      db.transaction(async (tx) => {
        const pay = tx.vault('acme').collection<Payment>('payments')
        // Both writes are in one tx; the bad one trips R1.
        pay.put('good', { id: 'good', amount: 50, receiptAmount: 50 }) // still valid, but in the batch
        pay.put('bad', { id: 'bad', amount: 100, receiptAmount: 40 })  // under-receipted → R1 fails
      }),
    ).rejects.toBeInstanceOf(InvariantError)

    // The bad record must be absent and the prior valid one unchanged.
    expect(await v.collection<Payment>('payments').get('bad')).toBeNull()
    expect(await v.collection<Payment>('payments').get('good')).toEqual({ id: 'good', amount: 50, receiptAmount: 50 })
  })

  it('before is null on insert and the prior record on update', async () => {
    const seen: Array<{ before: Payment | null; after: Payment | null }> = []
    const captureInv: TransactionInvariant = {
      scope: 'payments',
      check: (changes) => {
        for (const c of changes) {
          seen.push({ before: c.before as Payment | null, after: c.after as Payment | null })
        }
      },
    }
    const db = await createNoydb({
      store: memory(),
      user: 'owner',
      secret: 'tx-invariants-beforeafter-passphrase-2026',
      txStrategy: withTransactions({ invariants: [captureInv] }),
    })
    await db.openVault('acme')

    // Insert: before === null.
    await db.transaction(async (tx) => {
      tx.vault('acme').collection<Payment>('payments').put('p1', { id: 'p1', amount: 100, receiptAmount: 100 })
    })
    expect(seen).toHaveLength(1)
    expect(seen[0]!.before).toBeNull()
    expect(seen[0]!.after).toEqual({ id: 'p1', amount: 100, receiptAmount: 100 })

    // Update: before === prior committed record.
    seen.length = 0
    await db.transaction(async (tx) => {
      tx.vault('acme').collection<Payment>('payments').put('p1', { id: 'p1', amount: 100, receiptAmount: 100 })
    })
    expect(seen).toHaveLength(1)
    expect(seen[0]!.before).toEqual({ id: 'p1', amount: 100, receiptAmount: 100 })
  })

  it('does not call an invariant whose scope was not touched', async () => {
    let called = false
    const unrelated: TransactionInvariant = {
      scope: 'receipts',
      check: () => { called = true },
    }
    const db = await createNoydb({
      store: memory(),
      user: 'owner',
      secret: 'tx-invariants-unrelated-passphrase-2026',
      txStrategy: withTransactions({ invariants: [assertR1, unrelated] }),
    })
    await db.openVault('acme')

    await db.transaction(async (tx) => {
      tx.vault('acme').collection<Payment>('payments').put('p1', { id: 'p1', amount: 10, receiptAmount: 10 })
    })

    expect(called).toBe(false)
  })

  it('is additive with amendment — an amendment tx still runs the invariant', async () => {
    // A WORM guard so the collection is amendment-gated; the commit-time
    // invariant must ALSO fire on the amendment commit.
    const guard = withGuard<Payment>({
      collection: 'payments',
      check: async () => { throw new Error('locked — normal write blocked') },
      amendment: {
        roles: ['admin', 'owner'],
        invariant: () => { /* amendment override allowed */ },
      },
    })
    const db = await createNoydb({
      store: memory(),
      user: 'owner',
      secret: 'tx-invariants-amendment-passphrase-2026',
      guardStrategies: [guard],
      txStrategy: withTransactions({ invariants: [assertR1] }),
    })
    const v = await db.openVault('acme')

    // Valid amendment commits (passes R1).
    await db.transaction({ amendment: true, reason: 'seed receipted payment' }, async (tx) => {
      tx.vault('acme').collection<Payment>('payments').put('p1', { id: 'p1', amount: 100, receiptAmount: 100 })
    })
    expect((await v.collection<Payment>('payments').get('p1'))?.receiptAmount).toBe(100)

    // R1-violating amendment is rejected + rolled back even though the
    // guard amendment.invariant would have allowed it.
    await expect(
      db.transaction({ amendment: true, reason: 'under-receipt' }, async (tx) => {
        tx.vault('acme').collection<Payment>('payments').put('p1', { id: 'p1', amount: 100, receiptAmount: 40 })
      }),
    ).rejects.toBeInstanceOf(InvariantError)
    // Unchanged — reverted to the valid prior.
    expect((await v.collection<Payment>('payments').get('p1'))?.receiptAmount).toBe(100)
  })
})
