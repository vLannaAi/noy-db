/**
 * Showcase 79 — withGuard (accounting end-to-end)
 *
 * What you'll learn
 * ─────────────────
 * Guards declare WHO can change WHAT, and WHEN. This showcase wires the
 * three primitives — `check`, `frozenFields`, and `amendment` — together
 * around a realistic accounting scenario:
 *
 *   - `invoices` collection freezes `total / netAmount / vatAmount`
 *     once `status === 'issued'`. Non-financial fields (e.g. `notes`)
 *     remain editable.
 *   - `disbursements` collection rejects normal writes whenever the
 *     parent invoice is `issued` (cross-collection lock via `check`),
 *     and allows admin/owner-driven amendments that preserve the sum.
 *   - Every successful amendment writes a structured `op: 'amendment'`
 *     entry to the vault's audit ledger.
 *
 * Why it matters
 * ──────────────
 * Guards are the mechanism; the policy lives in product code. This
 * inversion is what lets a regulated-domain consumer (an accounting
 * firm) declare its own immutability rules without forking the hub —
 * and what makes the audit ledger trustworthy: an amendment is the
 * ONLY way past a guard, and the ledger entry captures who/why/what.
 *
 * Prerequisites
 * ─────────────
 * - Showcase 00 + 07 (history) + 20 (transactions).
 *
 * What to read next
 * ─────────────────
 *   - docs/superpowers/specs/2026-05-18-guards-design.md
 *   - docs/subsystems/guards.md
 *
 * Spec mapping
 * ────────────
 * features.yaml → features → guards
 */

import { describe, it, expect } from 'vitest'
import {
  createNoydb,
  withGuard,
  RecordLockedError,
  FieldFrozenError,
  InvariantError,
  ValidationError,
} from '@noy-db/hub'
import { withTransactions } from '@noy-db/hub/tx'
import { withHistory } from '@noy-db/hub/history'
import { memory } from '@noy-db/to-memory'

interface Invoice extends Record<string, unknown> {
  id: string
  clientId: string
  status: 'draft' | 'issued'
  total: number
  netAmount: number
  vatAmount: number
  notes?: string
}

interface Disbursement extends Record<string, unknown> {
  id: string
  invoiceId: string
  description: string
  amount: number
}

const invoiceGuard = withGuard<Invoice>({
  collection: 'invoices',
  frozenFields: {
    when: (existing) => existing.status === 'issued',
    fields: ['total', 'netAmount', 'vatAmount'],
  },
})

const disbursementGuard = withGuard<Disbursement>({
  collection: 'disbursements',
  check: async (incoming, { vault }) => {
    const inv = await vault.collection<Invoice>('invoices').get(incoming.invoiceId)
    if (inv?.status === 'issued') {
      throw new RecordLockedError(
        'disbursements',
        incoming.id,
        `invoice ${incoming.invoiceId} is issued`,
      )
    }
  },
  amendment: {
    roles: ['admin', 'owner'],
    invariant: (changes) => {
      // Genesis-only batch (every `before === null`) is treated as a
      // seed and skips the preserved-total constraint. Only re-balance
      // batches that include at least one prior record need to keep
      // the sum invariant.
      const isSeed = changes.every((c) => c.before === null)
      if (isSeed) return
      const sum = (side: 'before' | 'after') =>
        changes.reduce(
          (t, c) => t + ((c[side] as Disbursement | null)?.amount ?? 0),
          0,
        )
      const before = sum('before')
      const after = sum('after')
      if (before !== after) {
        throw new InvariantError(
          'disbursement total must be preserved across amendment ' +
            `(before: ${before}, after: ${after})`,
        )
      }
    },
  },
})

async function openVault(passphrase: string) {
  const db = await createNoydb({
    store: memory(),
    user: 'alice',
    secret: passphrase,
    guardStrategies: [invoiceGuard, disbursementGuard],
    txStrategy: withTransactions(),
    historyStrategy: withHistory(),
  })
  const vault = await db.openVault('books')
  return { db, vault }
}

async function seedIssuedInvoiceWithLines(
  db: Awaited<ReturnType<typeof openVault>>['db'],
  vault: Awaited<ReturnType<typeof openVault>>['vault'],
) {
  // While the invoice is still `draft`, normal puts on disbursements
  // pass the `check` (the check only locks when status === 'issued').
  await vault.collection<Invoice>('invoices').put('inv1', {
    id: 'inv1',
    clientId: 'c1',
    status: 'draft',
    total: 100,
    netAmount: 80,
    vatAmount: 20,
  })
  await vault.collection<Disbursement>('disbursements').put('d1', {
    id: 'd1',
    invoiceId: 'inv1',
    description: 'travel',
    amount: 60,
  })
  await vault.collection<Disbursement>('disbursements').put('d2', {
    id: 'd2',
    invoiceId: 'inv1',
    description: 'meals',
    amount: 40,
  })
  // Promote the invoice to `issued`. The financial fields are unchanged
  // so the frozenFields guard passes; from this point on, edits to
  // those fields and writes to dependent disbursements are locked.
  await vault.collection<Invoice>('invoices').put('inv1', {
    id: 'inv1',
    clientId: 'c1',
    status: 'issued',
    total: 100,
    netAmount: 80,
    vatAmount: 20,
  })
}

describe('Showcase 79 — withGuard (accounting)', () => {
  it('normal write on a draft invoice succeeds', async () => {
    const { vault } = await openVault('showcase-79-draft-passphrase-2026')
    await vault.collection<Invoice>('invoices').put('inv1', {
      id: 'inv1',
      clientId: 'c1',
      status: 'draft',
      total: 100,
      netAmount: 80,
      vatAmount: 20,
    })
    await expect(
      vault.collection<Disbursement>('disbursements').put('d1', {
        id: 'd1',
        invoiceId: 'inv1',
        description: 'travel',
        amount: 60,
      }),
    ).resolves.not.toThrow()
  })

  it('blocks a write to a disbursement when the invoice is issued', async () => {
    const { db, vault } = await openVault('showcase-79-locked-passphrase-2026')
    await seedIssuedInvoiceWithLines(db, vault)
    await expect(
      vault.collection<Disbursement>('disbursements').put('d3', {
        id: 'd3',
        invoiceId: 'inv1',
        description: 'late',
        amount: 5,
      }),
    ).rejects.toBeInstanceOf(RecordLockedError)
  })

  it('blocks edit of a frozen field on an issued invoice', async () => {
    const { db, vault } = await openVault('showcase-79-frozen-passphrase-2026')
    await seedIssuedInvoiceWithLines(db, vault)
    await expect(
      vault.collection<Invoice>('invoices').put('inv1', {
        id: 'inv1',
        clientId: 'c1',
        status: 'issued',
        total: 999,
        netAmount: 80,
        vatAmount: 20,
      }),
    ).rejects.toBeInstanceOf(FieldFrozenError)
  })

  it('allows edit of a non-frozen field on an issued invoice', async () => {
    const { db, vault } = await openVault('showcase-79-notes-passphrase-2026')
    await seedIssuedInvoiceWithLines(db, vault)
    await expect(
      vault.collection<Invoice>('invoices').put('inv1', {
        id: 'inv1',
        clientId: 'c1',
        status: 'issued',
        total: 100,
        netAmount: 80,
        vatAmount: 20,
        notes: 'paid in cash',
      }),
    ).resolves.not.toThrow()
    const inv = await vault.collection<Invoice>('invoices').get('inv1')
    expect(inv?.notes).toBe('paid in cash')
  })

  it('amendment with preserved total commits', async () => {
    const { db, vault } = await openVault('showcase-79-amend-ok-passphrase-2026')
    await seedIssuedInvoiceWithLines(db, vault)
    await db.transaction(
      { amendment: true, reason: 'correct split between travel and meals' },
      async (tx) => {
        tx.vault('books').collection<Disbursement>('disbursements').put('d1', {
          id: 'd1',
          invoiceId: 'inv1',
          description: 'travel',
          amount: 50,
        })
        tx.vault('books').collection<Disbursement>('disbursements').put('d2', {
          id: 'd2',
          invoiceId: 'inv1',
          description: 'meals',
          amount: 50,
        })
      },
    )
    const d1 = await vault.collection<Disbursement>('disbursements').get('d1')
    const d2 = await vault.collection<Disbursement>('disbursements').get('d2')
    expect(d1?.amount).toBe(50)
    expect(d2?.amount).toBe(50)
  })

  it('amendment with broken invariant rolls back', async () => {
    const { db, vault } = await openVault('showcase-79-amend-fail-passphrase-2026')
    await seedIssuedInvoiceWithLines(db, vault)
    await expect(
      db.transaction(
        { amendment: true, reason: 'attempting to change total — should fail' },
        async (tx) => {
          tx.vault('books').collection<Disbursement>('disbursements').put('d1', {
            id: 'd1',
            invoiceId: 'inv1',
            description: 'travel',
            amount: 200,
          })
        },
      ),
    ).rejects.toBeInstanceOf(InvariantError)
    const d1 = await vault.collection<Disbursement>('disbursements').get('d1')
    expect(d1?.amount).toBe(60) // reverted
  })

  it('amendment writes a ledger entry visible in vault.ledger()', async () => {
    const { db, vault } = await openVault('showcase-79-audit-passphrase-2026')
    await seedIssuedInvoiceWithLines(db, vault)
    await db.transaction(
      { amendment: true, reason: 'recategorize meals as travel' },
      async (tx) => {
        tx.vault('books').collection<Disbursement>('disbursements').put('d1', {
          id: 'd1',
          invoiceId: 'inv1',
          description: 'travel',
          amount: 70,
        })
        tx.vault('books').collection<Disbursement>('disbursements').put('d2', {
          id: 'd2',
          invoiceId: 'inv1',
          description: 'meals',
          amount: 30,
        })
      },
    )
    const entries = await vault.ledger().entries()
    const amendments = entries.filter((e) => e.op === 'amendment')
    expect(amendments.length).toBeGreaterThanOrEqual(1)
    const last = amendments[amendments.length - 1]!
    expect(last.amendment?.reason).toBe('recategorize meals as travel')
    expect(last.amendment?.role).toMatch(/owner|admin/)
    expect(last.amendment?.changes.length).toBe(2)
  })

  it('amendment without reason rejects with ValidationError', async () => {
    const { db } = await openVault('showcase-79-no-reason-passphrase-2026')
    await expect(
      // @ts-expect-error — runtime validation test: reason is required.
      db.transaction({ amendment: true }, async () => {}),
    ).rejects.toBeInstanceOf(ValidationError)
  })
})
