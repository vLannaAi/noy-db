/**
 * Tests for the `reason` option threaded through `collection.put(id, record, { reason })`
 * down to the ledger entry. Audit consumers use this to distinguish manual
 * edits from imported rows or other tagged operations.
 *
 * Spec: #1 (feat(as-*): ledger entry tagged 'import:<format>' on apply)
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { createNoydb, type Noydb } from '../src/kernel/noydb.js'
import { withHistory } from '../src/with-commit/history/index.js'
import { memory } from '../../to-memory/src/index.js'

interface Invoice extends Record<string, unknown> {
  id: string
  amount: number
}

describe('collection.put(_, _, { reason }) — ledger entry carries `reason` (#1)', () => {
  let db: Noydb

  beforeEach(async () => {
    db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'reason-test-secret-1234',
      historyStrategy: withHistory(),
    })
  })

  it('omits `reason` from the ledger entry when not passed (back-compat)', async () => {
    const vault = await db.openVault('demo')
    const invoices = vault.collection<Invoice>('invoices')
    await invoices.put('i1', { id: 'i1', amount: 100 })
    const entries = await vault.ledger().entries()
    expect(entries).toHaveLength(1)
    expect(entries[0]?.reason).toBeUndefined()
  })

  it('stamps `reason` on the put-ledger entry when passed', async () => {
    const vault = await db.openVault('demo')
    const invoices = vault.collection<Invoice>('invoices')
    await invoices.put('i1', { id: 'i1', amount: 100 }, { reason: 'import:json' })
    const entries = await vault.ledger().entries()
    expect(entries).toHaveLength(1)
    expect(entries[0]?.reason).toBe('import:json')
  })

  it('preserves `reason` across multiple puts with different reasons', async () => {
    const vault = await db.openVault('demo')
    const invoices = vault.collection<Invoice>('invoices')
    await invoices.put('i1', { id: 'i1', amount: 100 }, { reason: 'import:csv' })
    await invoices.put('i2', { id: 'i2', amount: 200 }) // no reason
    await invoices.put('i3', { id: 'i3', amount: 300 }, { reason: 'import:xlsx' })
    const entries = await vault.ledger().entries()
    expect(entries.map(e => e.reason)).toEqual(['import:csv', undefined, 'import:xlsx'])
  })

  it('canonicalizes — different reason → different ledger hash, same hash chain still verifies', async () => {
    const vault = await db.openVault('demo')
    const invoices = vault.collection<Invoice>('invoices')
    await invoices.put('i1', { id: 'i1', amount: 100 }, { reason: 'import:json' })
    await invoices.put('i2', { id: 'i2', amount: 200 })
    const ledger = vault.ledger()
    const verify = await ledger.verify()
    expect(verify.ok).toBe(true)
  })

  it('audit filter usage: vault.ledger().entries().filter(e => e.reason?.startsWith("import:"))', async () => {
    const vault = await db.openVault('demo')
    const invoices = vault.collection<Invoice>('invoices')
    await invoices.put('manual-1', { id: 'manual-1', amount: 1 })
    await invoices.put('imp-1', { id: 'imp-1', amount: 2 }, { reason: 'import:csv' })
    await invoices.put('imp-2', { id: 'imp-2', amount: 3 }, { reason: 'import:json' })
    await invoices.put('manual-2', { id: 'manual-2', amount: 4 })

    const entries = await vault.ledger().entries()
    const imports = entries.filter(e => e.reason?.startsWith('import:'))
    expect(imports.map(e => e.id)).toEqual(['imp-1', 'imp-2'])
  })
})
