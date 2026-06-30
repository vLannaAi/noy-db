/** Multi-client ack-barrier E2E (#232 sub-slice 3b). N instances, one shared store. */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createNoydb } from '../src/noydb.js'
import { memory } from '../../to-memory/src/index.js'
import { coordinatedCutover } from '../src/with-shape/schema-update/index.js'
import type { NoydbStore } from '../src/types.js'

interface InvOld extends Record<string, unknown> { id: string; total: number }
interface InvNew extends Record<string, unknown> { id: string; amount: { gross: number } }
const oldSchema = z.object({ id: z.string(), total: z.number() })
const newSchema = z.object({ id: z.string(), amount: z.object({ gross: z.number() }) })
const transform = (d: Record<string, unknown>) => ({ id: d['id'], amount: { gross: d['total'] } })

// All instances are the SAME identity (same user+secret) on different
// "tabs/devices" — distinguished only by their per-instance clientId.
const USER = 'acct'
const SECRET = 'mc-cutover-pass-1234'

async function openNew(store: NoydbStore) {
  const db = await createNoydb({ store, user: USER, secret: SECRET })
  const vault = await db.openVault('demo')
  const coll = vault.collection<InvNew>('invoices', {
    schema: newSchema, persistJsonSchema: true, schemaUpdate: [coordinatedCutover({ transform })],
  })
  await vault._drainPendingSchemaWrites()
  return { db, vault, coll }
}

describe('coordinatedCutover multi-client (#232 3b)', () => {
  it('migrator waits for a second active client to quiesce before transforming', async () => {
    const store = memory()
    // seed gen-0 old data
    const seed = await createNoydb({ store, user: USER, secret: SECRET })
    const sv = await seed.openVault('demo')
    const so = sv.collection<InvOld>('invoices', { schema: oldSchema, persistJsonSchema: true })
    await sv._drainPendingSchemaWrites()
    await so.put('i1', { id: 'i1', total: 100 })

    // two clients on the NEW schema (both register a pending cutover)
    const migrator = await openNew(store)
    const peer = await openNew(store)

    // peer announces itself active but NOT yet quiesced
    await peer.vault._fenceTick()

    let pollCount = 0
    const result = await migrator.vault.runSchemaCutover({
      onPoll: async () => { pollCount++; await peer.vault._fenceTick() }, // peer sees draining → flushes → acks
    })

    expect(result.migrated).toBe(1)
    expect(pollCount).toBeGreaterThan(0) // the barrier actually waited on the peer
    expect((await migrator.coll.get('i1'))?.amount.gross).toBe(100)
  })
})
