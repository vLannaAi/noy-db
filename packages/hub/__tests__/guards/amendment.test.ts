/**
 * `withTransactions({ amendment: true, reason })` integration coverage.
 *
 * The amendment mode is the only sanctioned way for admin/owner to repair
 * a constraint-violating state through guarded collections. The four
 * scenarios below pin the contract:
 *
 *   1. Successful amendment commits all writes when invariants hold.
 *   2. Invariant failure rolls back the whole transaction.
 *   3. Missing `reason` is rejected at open with `ValidationError`.
 *   4. Successful amendment appends a structured ledger entry.
 */
import { describe, it, expect } from 'vitest'
import {
  createNoydb,
  withGuard,
  InvariantError,
  ValidationError,
} from '../../src/index.js'
import { withTransactions } from '../../src/tx/index.js'
import { withHistory } from '../../src/history/index.js'
import type { NoydbStore, EncryptedEnvelope } from '../../src/types.js'

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

interface Line extends Record<string, unknown> { id: string; amount: number }

const buildGuard = () => withGuard<Line>({
  collection: 'lines',
  check: async () => { throw new Error('locked — normal write blocked') },
  amendment: {
    roles: ['admin', 'owner'],
    invariant: (changes) => {
      // Genesis-only batch (every before === null) is treated as a
      // seed and skips the preserved-total constraint. Only re-balance
      // batches that include at least one prior record have to keep
      // the sum invariant.
      const isSeed = changes.every(c => c.before === null)
      if (isSeed) return
      const sum = (s: 'before' | 'after') =>
        changes.reduce((t, c) => t + ((c[s] as Line | null)?.amount ?? 0), 0)
      if (sum('before') !== sum('after')) {
        throw new InvariantError('total preserved')
      }
    },
  },
})

describe('withTransactions amendment mode', () => {
  it('owner amendment with preserved total commits both writes atomically', async () => {
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'guards-amendment-ok-passphrase-2026',
      guardStrategies: [buildGuard()],
      txStrategy: withTransactions(),
    })
    const v = await db.openVault('demo')
    // Seed via amendment (normal put would be blocked by the guard)
    await db.transaction({ amendment: true, reason: 'seed' }, async (tx) => {
      tx.vault('demo').collection<Line>('lines').put('l1', { id: 'l1', amount: 100 })
      tx.vault('demo').collection<Line>('lines').put('l2', { id: 'l2', amount: 0 })
    })
    // Amend: shift 20 between them; total preserved
    await db.transaction({ amendment: true, reason: 'correct split' }, async (tx) => {
      tx.vault('demo').collection<Line>('lines').put('l1', { id: 'l1', amount: 80 })
      tx.vault('demo').collection<Line>('lines').put('l2', { id: 'l2', amount: 20 })
    })
    const l1 = await v.collection<Line>('lines').get('l1')
    const l2 = await v.collection<Line>('lines').get('l2')
    expect(l1?.amount).toBe(80)
    expect(l2?.amount).toBe(20)
  })

  it('invariant failure rolls back the whole transaction', async () => {
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'guards-amendment-fail-passphrase-2026',
      guardStrategies: [buildGuard()],
      txStrategy: withTransactions(),
    })
    const v = await db.openVault('demo')
    await db.transaction({ amendment: true, reason: 'seed' }, async (tx) => {
      tx.vault('demo').collection<Line>('lines').put('l1', { id: 'l1', amount: 100 })
    })
    await expect(
      db.transaction({ amendment: true, reason: 'bad' }, async (tx) => {
        tx.vault('demo').collection<Line>('lines').put('l1', { id: 'l1', amount: 999 })
      }),
    ).rejects.toBeInstanceOf(InvariantError)
    const l1 = await v.collection<Line>('lines').get('l1')
    expect(l1?.amount).toBe(100)  // reverted
  })

  it('amendment: true on vault with no guardStrategies throws ValidationError', async () => {
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'guards-amendment-no-strategies-passphrase-2026',
      txStrategy: withTransactions(),
    })
    await db.openVault('demo')
    await expect(
      db.transaction({ amendment: true, reason: 'no guards here' }, async (tx) => {
        tx.vault('demo')
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('amendment: true without reason throws ValidationError at open', async () => {
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'guards-amendment-no-reason-passphrase-2026',
      guardStrategies: [buildGuard()],
      txStrategy: withTransactions(),
    })
    await db.openVault('demo')
    await expect(
      // @ts-expect-error — runtime guard for missing reason
      db.transaction({ amendment: true }, async () => {}),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('invariant ctx.vault exposes the real ReadOnlyVaultFacade for cross-collection reads', async () => {
    // Regression: an earlier draft passed a stub vault into the invariant
    // runner that returned null/[] for every collection, which broke any
    // amendment that needed to validate against a sibling collection
    // (e.g. "lines sum to invoice total"). This test pins the contract
    // that ctx.vault is the same facade Collection.put's guard hook sees.
    interface Invoice extends Record<string, unknown> { id: string; total: number }
    interface XLine extends Record<string, unknown> { id: string; invoiceId: string; amount: number }
    let observedInvoice: Invoice | null = 'sentinel' as unknown as Invoice
    const lineGuard = withGuard<XLine>({
      collection: 'xlines',
      check: async () => { throw new Error('locked — normal write blocked') },
      amendment: {
        roles: ['admin', 'owner'],
        invariant: async (changes, ctx) => {
          // Cross-collection read — this is what the stub broke.
          const invoiceId = changes[0]!.after.invoiceId
          observedInvoice = await ctx.vault
            .collection<Invoice>('invoices')
            .get(invoiceId)
          const sum = changes.reduce((t, c) => t + c.after.amount, 0)
          if (observedInvoice && sum !== observedInvoice.total) {
            throw new InvariantError(
              `lines sum ${sum} ≠ invoice total ${observedInvoice.total}`,
            )
          }
        },
      },
    })
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'guards-amendment-xread-passphrase-2026',
      guardStrategies: [lineGuard],
      txStrategy: withTransactions(),
    })
    const v = await db.openVault('demo')
    // Seed the invoice via a normal put (no guard on `invoices`).
    await v.collection<Invoice>('invoices').put('inv-1', { id: 'inv-1', total: 100 })
    // Amend the lines under amendment mode — the invariant reads
    // `invoices/inv-1` through ctx.vault. With the stub it would have
    // received null and either (a) silently passed or (b) thrown the
    // wrong error; with the real facade it sees total=100 and the
    // matching sum makes the invariant pass.
    await db.transaction({ amendment: true, reason: 'seed lines' }, async (tx) => {
      tx.vault('demo').collection<XLine>('xlines').put('ln-1', { id: 'ln-1', invoiceId: 'inv-1', amount: 60 })
      tx.vault('demo').collection<XLine>('xlines').put('ln-2', { id: 'ln-2', invoiceId: 'inv-1', amount: 40 })
    })
    expect(observedInvoice).not.toBeNull()
    expect(observedInvoice).toMatchObject({ id: 'inv-1', total: 100 })
    // And the mismatched case still throws — confirms the invariant
    // actually consulted the cross-collection read.
    await expect(
      db.transaction({ amendment: true, reason: 'bad split' }, async (tx) => {
        tx.vault('demo').collection<XLine>('xlines').put('ln-1', { id: 'ln-1', invoiceId: 'inv-1', amount: 60 })
        tx.vault('demo').collection<XLine>('xlines').put('ln-2', { id: 'ln-2', invoiceId: 'inv-1', amount: 41 })
      }),
    ).rejects.toBeInstanceOf(InvariantError)
  })

  it('writes an AmendmentLedgerEntry on commit (op: amendment, role, reason)', async () => {
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'guards-amendment-audit-passphrase-2026',
      guardStrategies: [buildGuard()],
      txStrategy: withTransactions(),
      historyStrategy: withHistory(),
    })
    const v = await db.openVault('demo')
    await db.transaction({ amendment: true, reason: 'seeding under amendment' }, async (tx) => {
      tx.vault('demo').collection<Line>('lines').put('l1', { id: 'l1', amount: 100 })
    })
    const ledger = v.ledger()
    const entries = await ledger.entries()
    const amendments = entries.filter((e) => e.op === 'amendment')
    expect(amendments.length).toBeGreaterThanOrEqual(1)
    const last = amendments[amendments.length - 1]!
    expect(last.amendment?.reason).toBe('seeding under amendment')
    expect(last.amendment?.role).toMatch(/owner|admin/)
    expect(last.amendment?.changes).toHaveLength(1)
    expect(last.amendment?.changes[0]?.collection).toBe('lines')
    expect(last.amendment?.changes[0]?.id).toBe('l1')
  })
})
