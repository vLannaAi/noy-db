import { describe, expect, it } from 'vitest'
import { createNoydb } from '../src/kernel/noydb.js'
import { withTransactions } from '../src/with-commit/tx/index.js'
import { memory } from '../../to-memory/src/index.js'

describe('TxContext.txId', () => {
  it('each transaction gets a distinct non-empty txId exposed on the tx handle', async () => {
    const db = await createNoydb({ store: memory(), user: 'a', secret: 'txid-pass-1234', transactionsStrategy: withTransactions() })
    const id1 = await db.transaction((tx) => (tx as unknown as { txId: string }).txId)
    const id2 = await db.transaction((tx) => (tx as unknown as { txId: string }).txId)
    expect(typeof id1).toBe('string')
    expect(id1.length).toBeGreaterThan(0)
    expect(id1).not.toBe(id2)
  })
})
