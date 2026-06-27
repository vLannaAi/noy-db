/** E2E for hub write lifecycle hooks (#230). */
import { describe, expect, it } from 'vitest'
import { createNoydb, type Noydb, type WriteEvent } from '../src/noydb.js'
import { withTransactions } from '../src/tx/index.js'
import { memory } from '../../to/to-memory/src/index.js'

interface Inv extends Record<string, unknown> { id: string; amount: number }

async function setup(): Promise<Noydb> {
  return createNoydb({ store: memory(), user: 'alice', secret: 'write-hooks-pass-1234', txStrategy: withTransactions() })
}

describe('write lifecycle hooks (#230)', () => {
  it('onBeforeWrite sees create then update; onAfterWrite fires post-commit', async () => {
    const db = await setup()
    const v = await db.openVault('demo')
    const c = v.collection<Inv>('invoices')
    const events: WriteEvent[] = []
    db.onBeforeWrite((e) => { events.push(e) })

    await c.put('i1', { id: 'i1', amount: 1 })
    await c.put('i1', { id: 'i1', amount: 2 })

    expect(events.map(e => e.op)).toEqual(['create', 'update'])
    expect(events[0]!.before).toBeNull()
    expect(events[1]!.before).toMatchObject({ amount: 1 })
    expect(events[1]!.after).toMatchObject({ amount: 2 })
    expect(events[0]!.userId).toBe('alice')
  })

  it('WriteEvent carries the vault name (#228b)', async () => {
    const db = await setup()
    const v = await db.openVault('demo')
    const c = v.collection<Inv>('invoices')
    const events: WriteEvent[] = []
    db.onAfterWrite((e) => { events.push(e) })
    await c.put('i1', { id: 'i1', amount: 1 })
    expect(events).toHaveLength(1)
    expect(events[0]!.vault).toBe('demo')
    expect(events[0]!.collection).toBe('invoices')
  })

  it('a throwing onBeforeWrite aborts the write', async () => {
    const db = await setup()
    const v = await db.openVault('demo')
    const c = v.collection<Inv>('invoices')
    db.onBeforeWrite(() => { throw new Error('veto') })
    await expect(c.put('i1', { id: 'i1', amount: 1 })).rejects.toThrow('veto')
    expect(await c.get('i1')).toBeNull()
  })

  it('onAfterWrite is awaited and a write inside it does not recurse', async () => {
    const db = await setup()
    const v = await db.openVault('demo')
    const c = v.collection<Inv>('invoices')
    const audit = v.collection<{ id: string; op: string }>('_audit')
    let afterCalls = 0
    db.onAfterWrite(async (e) => {
      afterCalls++
      if (e.collection !== '_audit') {
        await audit.put(`log-${e.docId}`, { id: `log-${e.docId}`, op: e.op })
      }
    })
    await c.put('i1', { id: 'i1', amount: 1 })
    expect(afterCalls).toBe(1) // the nested _audit write did not re-trigger the hook
    expect((await audit.get('log-i1'))?.op).toBe('create')
  })

  it('delete fires op:delete with before set, after null', async () => {
    const db = await setup()
    const v = await db.openVault('demo')
    const c = v.collection<Inv>('invoices')
    await c.put('i1', { id: 'i1', amount: 9 })
    const events: WriteEvent[] = []
    db.onAfterWrite((e) => { events.push(e) })
    await c.delete('i1')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ op: 'delete', after: null })
    expect(events[0]!.before).toMatchObject({ amount: 9 })
  })

  it('txId is shared within one transaction and distinct across standalone writes', async () => {
    const db = await setup()
    const v = await db.openVault('demo')
    const c = v.collection<Inv>('invoices')
    const ids: string[] = []
    db.onAfterWrite((e) => { ids.push(e.txId) })

    await db.transaction(async (tx) => {
      const inv = tx.vault('demo').collection<Inv>('invoices')
      await inv.put('a', { id: 'a', amount: 1 })
      await inv.put('b', { id: 'b', amount: 2 })
    })
    await c.put('c', { id: 'c', amount: 3 })

    expect(ids).toHaveLength(3)
    expect(ids[0]).toBe(ids[1])     // same transaction → same txId
    expect(ids[2]).not.toBe(ids[0]) // standalone write → different txId
  })

  it('WriteEvent carries baseVersion and version (#228c)', async () => {
    const db = await setup()
    const v = await db.openVault('demo')
    const c = v.collection<Inv>('invoices')
    const events: WriteEvent[] = []
    db.onAfterWrite((e) => { events.push(e) })
    await c.put('i1', { id: 'i1', amount: 1 }) // create
    await c.put('i1', { id: 'i1', amount: 2 }) // update
    expect(events[0]!.baseVersion).toBe(0)
    expect(events[0]!.version).toBe(1)
    expect(events[1]!.baseVersion).toBe(1)
    expect(events[1]!.version).toBe(2)
  })
})
