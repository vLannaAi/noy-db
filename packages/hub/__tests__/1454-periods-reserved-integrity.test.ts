/**
 * #1454 — the reserved periods family is not reachable through the public
 * collection API, and the inter-period hash chain is verified on load.
 *
 * Measured by the reporter and reproduced here: two `put()`s through
 * `vault.collection('_periods')` / `vault.collection('_period_reopens')`
 * rewrote a close, erased its append-only reopen log, and unsealed the cell
 * on the next cold open — no error, no event, no trace. The reserved-name
 * guard in `vault.collection()` covered only the SECRET-bearing reserved
 * collections; `_periods` is not secret, it is integrity-bearing, and nothing
 * answered "is this writable?".
 *
 * ⛔ What the chain CAN and CANNOT see, stated so nobody over-reads (2):
 *   - an interior record rewritten or deleted → its successor's
 *     `priorPeriodHash` / `priorPeriodName` no longer resolve → detected;
 *   - the NEWEST record in a timeline has no successor hashing it → a rewrite
 *     of the last close is invisible to the chain. (1) is what closes the
 *     reachable hole; (2) makes the remaining paths honest, not airtight.
 */
import { describe, it, expect } from 'vitest'
import { toMemory } from '../../to-memory/src/index.js'
import { createNoydb, ReservedCollectionNameError } from '../src/index.js'
import { PeriodChainError } from '../src/kernel/errors.js'
import { withPeriods } from '../src/with-audit/periods/index.js'
import type { NoydbStore } from '../src/kernel/types.js'

async function open(store: NoydbStore) {
  const db = await createNoydb({ store, user: 'owner', encrypt: false, periodsStrategy: withPeriods() })
  return db.openVault('acme')
}

describe('#1454 — the periods family is refused by vault.collection()', () => {
  it.each([
    '_periods',
    '_period_reopens',
    '_period_freezes',
    '_period_archives',
    '_period_target_purges',
  ])('%s', async (name) => {
    const vault = await open(toMemory())
    expect(() => vault.collection(name)).toThrow(ReservedCollectionNameError)
  })

  it('so the reporter\'s two-put rewrite has no public entry point', async () => {
    const store = toMemory()
    const vault = await open(store)
    await vault.closePeriod({ name: 'Q1', endDate: '2026-03-31', dateField: 'date' })
    await vault.reopenPeriod('Q1', { reason: 'late invoice' })
    await vault.reclosePeriod('Q1')

    expect(() => vault.collection('_period_reopens')).toThrow(ReservedCollectionNameError)
    expect(() => vault.collection('_periods')).toThrow(ReservedCollectionNameError)

    // Cold open: the close and its log are exactly as written.
    const again = await open(store)
    expect((await again.getPeriod('Q1'))?.endDate).toBe('2026-03-31')
    expect((await again.listPeriodReopens('Q1')).map((e) => e.op)).toEqual(['reopen', 'reclose'])
  })
})

describe('#1454 — loadPeriods verifies the hash chain', () => {
  /** Rewrite a stored (plaintext, encrypt:false) `_periods` record in place. */
  async function tamper(store: NoydbStore, key: string, patch: Record<string, unknown> | null) {
    if (patch === null) { await store.delete('acme', '_periods', key); return }
    const env = (await store.get('acme', '_periods', key))!
    const rec = JSON.parse(env._data) as Record<string, unknown>
    await store.put('acme', '_periods', key, { ...env, _data: JSON.stringify({ ...rec, ...patch }) })
  }

  it('an interior close rewritten under the store breaks its successor\'s anchor', async () => {
    const store = toMemory()
    const vault = await open(store)
    await vault.closePeriod({ name: 'Q1', endDate: '2026-03-31', dateField: 'date' })
    await vault.closePeriod({ name: 'Q2', endDate: '2026-06-30', dateField: 'date' })

    await tamper(store, 'Q1', { endDate: '2020-01-01' })

    const cold = await open(store)
    await expect(cold.listPeriods()).rejects.toThrow(PeriodChainError)
    // …and the write guard refuses to trust the tampered set rather than
    // evaluating a sealed cell against it.
    await expect(cold.collection('ledger').put('x', { id: 'x', date: '2026-02-01' })).rejects.toThrow(PeriodChainError)
  })

  it('an interior close DELETED under the store is detected too', async () => {
    const store = toMemory()
    const vault = await open(store)
    await vault.closePeriod({ name: 'Q1', endDate: '2026-03-31', dateField: 'date' })
    await vault.closePeriod({ name: 'Q2', endDate: '2026-06-30', dateField: 'date' })
    await tamper(store, 'Q1', null)
    const cold = await open(store)
    await expect(cold.listPeriods()).rejects.toThrow(PeriodChainError)
  })

  it('a close made AFTER a reopen still verifies — the anchor hashes the stored record, not the merged view', async () => {
    // `chainAnchor` used to hash whatever the cache held. After a write check
    // the cache carries merged reopen state (`reopenedAt`, `reopenCount`…),
    // which the stored record never has — so a close following a reopen was
    // anchored to a hash no loader could recompute. Latent until (2) made the
    // loader recompute it.
    const store = toMemory()
    const vault = await open(store)
    await vault.closePeriod({ name: 'Q1', endDate: '2026-03-31', dateField: 'date' })
    await vault.reopenPeriod('Q1')
    // A write check populates the MERGED cache…
    await vault.collection('ledger').put('a', { id: 'a', date: '2026-02-01' })
    await vault.reclosePeriod('Q1')
    await vault.collection('ledger').put('b', { id: 'b', date: '2026-09-01' })
    // …and the next close anchors off it.
    await vault.closePeriod({ name: 'Q2', endDate: '2026-06-30', dateField: 'date' })

    const cold = await open(store)
    await expect(cold.listPeriods()).resolves.toHaveLength(2)
  })

  it('an intact multi-partition vault loads clean', async () => {
    const store = toMemory()
    const db = await createNoydb({
      store, user: 'owner', encrypt: false,
      periodsStrategy: withPeriods({ subjects: { rows: (r) => [r.c as string] } }),
    })
    const vault = await db.openVault('acme')
    await vault.closePeriod({ name: '2026-01', endDate: '2026-01-31', dateField: 'date', partition: ['c1'] })
    await vault.closePeriod({ name: '2026-01', endDate: '2026-01-31', dateField: 'date', partition: ['c2'] })
    await vault.closePeriod({ name: '2026-02', endDate: '2026-02-28', dateField: 'date', partition: ['c1'] })
    const cold = await (await createNoydb({
      store, user: 'owner', encrypt: false,
      periodsStrategy: withPeriods({ subjects: { rows: (r) => [r.c as string] } }),
    })).openVault('acme')
    await expect(cold.listPeriods({ partition: ['c1'] })).resolves.toHaveLength(2)
  })
})
