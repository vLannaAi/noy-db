import { describe, expect, it } from 'vitest'
import { createNoydb, type Noydb } from '../src/noydb.js'
import { withTransactions } from '../src/tx/index.js'
import { withGuard } from '../src/guards/with-guard.js'
import { memory } from '../../to-memory/src/index.js'

interface Inv extends Record<string, unknown> { id: string; amount: number }

async function setup(extra: Record<string, unknown> = {}): Promise<Noydb> {
  return createNoydb({ store: memory(), user: 'owner', secret: 'dryrun-pass-1234', encrypt: false, txStrategy: withTransactions(), ...extra })
}

describe('db.transaction({ dryRun: true }) (#231)', () => {
  it('reports affected create/update and commits nothing', async () => {
    const db = await setup()
    const v = await db.openVault('acme')
    const invoices = v.collection<Inv>('invoices')
    await invoices.put('i1', { id: 'i1', amount: 1 })

    const result = await db.transaction({ dryRun: true }, (tx) => {
      const inv = tx.vault('acme').collection<Inv>('invoices')
      inv.put('i2', { id: 'i2', amount: 2 }) // create
      inv.put('i1', { id: 'i1', amount: 99 }) // update
    })

    const ops = result.affected.slice().sort((a, b) => a.docId.localeCompare(b.docId))
    expect(ops).toHaveLength(2)
    expect(ops[0]).toMatchObject({ op: 'update', docId: 'i1', after: { amount: 99 } })
    expect(ops[0]!.before).toMatchObject({ amount: 1 })
    expect(ops[1]).toMatchObject({ op: 'create', docId: 'i2', before: null })

    // committed nothing
    expect(await invoices.get('i1')).toMatchObject({ amount: 1 })
    expect(await invoices.get('i2')).toBeNull()
  })

  it('reports delete with before set, after null', async () => {
    const db = await setup()
    const v = await db.openVault('acme')
    const invoices = v.collection<Inv>('invoices')
    await invoices.put('i1', { id: 'i1', amount: 5 })
    const result = await db.transaction({ dryRun: true }, (tx) => {
      tx.vault('acme').collection<Inv>('invoices').delete('i1')
    })
    expect(result.affected).toHaveLength(1)
    expect(result.affected[0]).toMatchObject({ op: 'delete', docId: 'i1', after: null })
    expect(result.affected[0]!.before).toMatchObject({ amount: 5 })
    expect(await invoices.get('i1')).toMatchObject({ amount: 5 }) // not deleted
  })

  it('collects guard violations instead of throwing; affected still complete', async () => {
    const db = await setup({
      guardStrategies: [withGuard<Inv>({
        collection: 'invoices',
        check: (rec) => { if ((rec.amount as number) < 0) throw new Error('amount must be >= 0') },
      })],
    })
    const v = await db.openVault('acme')
    const result = await db.transaction({ dryRun: true }, (tx) => {
      tx.vault('acme').collection<Inv>('invoices').put('bad', { id: 'bad', amount: -1 })
    })
    expect(result.affected).toHaveLength(1)
    expect(result.guardViolations).toHaveLength(1)
    expect(result.guardViolations[0]).toMatchObject({ collection: 'invoices', docId: 'bad' })
    expect(result.guardViolations[0]!.message).toMatch(/>= 0/)
  })

  it('does not fire write hooks during a dry-run', async () => {
    const db = await setup()
    await db.openVault('acme')
    let afterCalls = 0
    db.onAfterWrite(() => { afterCalls++ })
    await db.transaction({ dryRun: true }, (tx) => {
      tx.vault('acme').collection<Inv>('invoices').put('i1', { id: 'i1', amount: 1 })
    })
    expect(afterCalls).toBe(0)
  })
})
