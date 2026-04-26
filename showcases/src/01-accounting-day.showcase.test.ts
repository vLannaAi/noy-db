/**
 * Showcase 01 — "A Day at the Office"
 * GitHub issue: https://github.com/vLannaAi/noy-db/issues/166
 *
 * Framework: Pinia (`defineNoydbStore`)
 * Store:     `memory()`
 * Pattern:   Local only (see docs/guides/topology-matrix.md, Pattern A)
 * Dimension: Easy-to-use — reactive store + real-world workflow in ~30 lines
 *
 * What this proves:
 *   1. Pinia + noy-db is drop-in: one `setActiveNoydb(...)` call, then
 *      `defineNoydbStore<Invoice>(...)` behaves like an ordinary Pinia store.
 *   2. `store.items` and `store.count` are genuinely reactive — adding and
 *      updating records re-runs downstream computations.
 *   3. The in-memory query DSL (`where`/`aggregate`/`sum`) works through the
 *      Pinia store surface, not just the raw `Collection`.
 *   4. All on-disk data is ciphertext. The one peek at the memory store at
 *      the bottom confirms the envelope shape (`_iv`, `_data`) and that
 *      nothing leaks plaintext.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createNoydb, sum, type Noydb, type NoydbStore } from '@noy-db/hub'
import { withAggregate } from '@noy-db/hub/aggregate'
import { memory } from '@noy-db/to-memory'
import { defineNoydbStore, setActiveNoydb } from '@noy-db/in-pinia'

import {
  type Invoice,
  sampleClients,
  SHOWCASE_PASSPHRASE,
} from './_fixtures.js'

describe('Showcase 01 — A Day at the Office (Pinia)', () => {
  let db: Noydb
  let rawStore: NoydbStore
  let store: ReturnType<ReturnType<typeof defineNoydbStore<Invoice>>>

  beforeEach(async () => {
    setActivePinia(createPinia())

    // Keep a direct handle to the memory adapter so step 6 can peek at
    // the ciphertext that actually landed on disk.
    rawStore = memory()

    db = await createNoydb({
      store: rawStore,
      user: 'owner', aggregateStrategy: withAggregate(),
      secret: SHOWCASE_PASSPHRASE,
    })
    await db.openVault('firm-demo')
    setActiveNoydb(db)

    const useInvoices = defineNoydbStore<Invoice>('invoices', {
      vault: 'firm-demo',
    })
    store = useInvoices()
    await store.$ready
  })

  afterEach(async () => {
    setActiveNoydb(null)
    await db.close()
  })

  it('step 1 — empty store hydrates cleanly', () => {
    // The Pinia store mirrors the empty encrypted collection. `items` is an
    // empty array, `count` is zero, `byId` returns undefined for anything.
    expect(store.items).toEqual([])
    expect(store.count).toBe(0)
    expect(store.byId('inv-001')).toBeUndefined()
  })

  it('step 2 — adding invoices updates reactive state immediately', async () => {
    // Add three draft invoices for three different clients. After each call,
    // the reactive `items` + `count` are already updated — no explicit
    // refresh required.
    await store.add('inv-001', {
      id: 'inv-001',
      clientId: sampleClients[0].id,
      amount: 12_500,
      currency: 'THB',
      status: 'draft',
      issueDate: '2026-04-01',
      dueDate: '2026-05-01',
      month: '2026-04',
    })
    expect(store.count).toBe(1)

    await store.add('inv-002', {
      id: 'inv-002',
      clientId: sampleClients[1].id,
      amount: 8_000,
      currency: 'THB',
      status: 'draft',
      issueDate: '2026-04-05',
      dueDate: '2026-05-05',
      month: '2026-04',
    })
    await store.add('inv-003', {
      id: 'inv-003',
      clientId: sampleClients[2].id,
      amount: 42_000,
      currency: 'THB',
      status: 'open',
      issueDate: '2026-04-10',
      dueDate: '2026-05-10',
      month: '2026-04',
    })

    expect(store.count).toBe(3)
    expect(store.byId('inv-002')?.amount).toBe(8_000)
    expect(store.items.map(i => i.id)).toEqual(['inv-001', 'inv-002', 'inv-003'])
  })

  it('step 3 — query DSL runs through the Pinia store', async () => {
    await seedThreeInvoices(store)

    // Aggregate over drafts only. Real-world analogue: "how much revenue do
    // we have in un-sent drafts?"
    const draftTotal = store
      .query()
      .where('status', '==', 'draft')
      .aggregate({ total: sum('amount') })
      .run()

    expect(draftTotal.total).toBe(20_500) // 12500 + 8000

    // And a count terminal — same DSL, different aggregation target.
    const openCount = store.query().where('status', '==', 'open').count()
    expect(openCount).toBe(1)
  })

  it('step 4 — updating a record re-runs aggregates correctly', async () => {
    await seedThreeInvoices(store)

    // Accountant promotes inv-001 from draft to open. Now the draft total
    // should drop by 12,500 and the open total should rise by the same.
    const current = store.byId('inv-001')!
    await store.update('inv-001', { ...current, status: 'open' })

    const draftTotal = store
      .query()
      .where('status', '==', 'draft')
      .aggregate({ total: sum('amount') })
      .run()
    expect(draftTotal.total).toBe(8_000) // only inv-002 remains a draft

    const openTotal = store
      .query()
      .where('status', '==', 'open')
      .aggregate({ total: sum('amount') })
      .run()
    expect(openTotal.total).toBe(54_500) // inv-001 + inv-003
  })

  it('step 5 — removing a record shrinks the reactive set', async () => {
    await seedThreeInvoices(store)
    expect(store.count).toBe(3)

    await store.remove('inv-002')

    expect(store.count).toBe(2)
    expect(store.byId('inv-002')).toBeUndefined()
  })

  it('step 6 — recap: store sees only ciphertext', async () => {
    // This is the "zero-knowledge" proof point. The Pinia store gave us a
    // plaintext Invoice; the underlying `memory()` adapter holds an
    // EncryptedEnvelope whose `_data` is opaque ciphertext. The adapter
    // never saw the original amount, status, or client id.
    await store.add('inv-secret', {
      id: 'inv-secret',
      clientId: sampleClients[0].id,
      amount: 99_999_999,
      currency: 'THB',
      status: 'draft',
      issueDate: '2026-04-20',
      dueDate: '2026-05-20',
      month: '2026-04',
      notes: 'confidential retainer',
    })

    // Peek at what's actually on disk. Using the adapter directly to cross
    // the zero-knowledge boundary — this is the whole point of step 6. The
    // envelope has no plaintext fields.
    const envelope = await rawStore.get('firm-demo', 'invoices', 'inv-secret')
    expect(envelope).toBeTruthy()
    expect(envelope!._noydb).toBe(1)
    expect(typeof envelope!._data).toBe('string')
    expect(typeof envelope!._iv).toBe('string')
    // The literal string "99999999" is nowhere in the ciphertext — AES-GCM
    // scrambled it. Same for "confidential retainer".
    expect(envelope!._data).not.toContain('99999999')
    expect(envelope!._data).not.toContain('confidential')
  })
})

/**
 * Shared fixture for steps 3/4/5 — three invoices across two drafts and one
 * open. Kept in-file because it's showcase-specific; fixtures that are
 * shared across showcases live in `_fixtures.ts`.
 */
async function seedThreeInvoices(
  store: ReturnType<ReturnType<typeof defineNoydbStore<Invoice>>>,
): Promise<void> {
  await store.add('inv-001', {
    id: 'inv-001', clientId: sampleClients[0].id, amount: 12_500,
    currency: 'THB', status: 'draft',
    issueDate: '2026-04-01', dueDate: '2026-05-01', month: '2026-04',
  })
  await store.add('inv-002', {
    id: 'inv-002', clientId: sampleClients[1].id, amount: 8_000,
    currency: 'THB', status: 'draft',
    issueDate: '2026-04-05', dueDate: '2026-05-05', month: '2026-04',
  })
  await store.add('inv-003', {
    id: 'inv-003', clientId: sampleClients[2].id, amount: 42_000,
    currency: 'THB', status: 'open',
    issueDate: '2026-04-10', dueDate: '2026-05-10', month: '2026-04',
  })
}
