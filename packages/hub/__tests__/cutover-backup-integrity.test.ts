/**
 * #964 — cutover migration ledger entries must carry a real ciphertext
 * `payloadHash`, not `''`. Without it, `verifyBackupIntegrity()`'s data
 * cross-check recomputes the migrated record's envelope hash, finds it
 * doesn't match the empty string on the ledger, and reports the record
 * as tampered — even though nothing is actually wrong. A pod that took a
 * coordinated schema cutover with history on cannot restore.
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createNoydb } from '../src/kernel/noydb.js'
import { withHistory } from '../src/with-commit/history/index.js'
import { coordinatedCutover } from '../src/with-shape/schema-update/index.js'
import { toMemory } from '../../to-memory/src/index.js'
import type { NoydbStore } from '../src/kernel/types.js'

interface InvOld extends Record<string, unknown> { id: string; total: number }
interface InvNew extends Record<string, unknown> { id: string; amount: { gross: number } }

const oldSchema = z.object({ id: z.string(), total: z.number() })
const newSchema = z.object({ id: z.string(), amount: z.object({ gross: z.number() }) })
const transform = (d: Record<string, unknown>) => ({ id: d['id'], amount: { gross: d['total'] } })

async function open(store: NoydbStore) {
  const db = await createNoydb({
    store, user: 'alice', secret: 'cutover-backup-pass-1234',
    historyStrategy: withHistory(),
  })
  return db.openVault('demo-co')
}

describe('cutover migration ledger entries carry a real payloadHash (#964)', () => {
  it('verifyBackupIntegrity() passes after a coordinated cutover with history on', async () => {
    const store = toMemory()

    // gen 0: seed old-shape data
    let v = await open(store)
    const invoicesOld = v.collection<InvOld>('invoices', { schema: oldSchema, persistJsonSchema: true })
    await v._drainPendingSchemaWrites()
    await invoicesOld.put('i1', { id: 'i1', total: 100 })

    // reopen with a NEW schema + coordinatedCutover → migrates the existing record
    v = await open(store)
    const invNew = v.collection<InvNew>('invoices', {
      schema: newSchema, persistJsonSchema: true,
      schemaUpdate: [coordinatedCutover({ transform })],
    })
    await v._drainPendingSchemaWrites()

    const result = await v.runSchemaCutover()
    expect(result.migrated).toBe(1)
    expect((await invNew.get('i1'))?.amount.gross).toBe(100)

    // The bug: the migration ledger entry's payloadHash was '', so the
    // data cross-check below reports a false tamper.
    const verifyResult = await v.verifyBackupIntegrity()
    expect(verifyResult.ok).toBe(true)
  })

  it('dump()/load() round-trips a pod that took a cutover with history on', async () => {
    const store = toMemory()
    let v = await open(store)
    const invoicesOld = v.collection<InvOld>('invoices', { schema: oldSchema, persistJsonSchema: true })
    await v._drainPendingSchemaWrites()
    await invoicesOld.put('i1', { id: 'i1', total: 100 })

    v = await open(store)
    v.collection<InvNew>('invoices', {
      schema: newSchema, persistJsonSchema: true,
      schemaUpdate: [coordinatedCutover({ transform })],
    })
    await v._drainPendingSchemaWrites()
    await v.runSchemaCutover()

    const backup = await v.dump()

    const targetStore = toMemory()
    const targetDb = await createNoydb({
      store: targetStore, user: 'alice', secret: 'cutover-backup-pass-1234',
      historyStrategy: withHistory(),
    })
    const targetVault = await targetDb.openVault('demo-co')
    await expect(targetVault.load(backup)).resolves.not.toThrow()
  })
})
