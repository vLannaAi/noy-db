/**
 * #965 — a bare `runSchemaCutover()` generation bump (a registered cutover
 * whose collection has NO records to migrate, so `applyCutoverTransform`'s
 * loop never runs) leaves zero ledger evidence today: per-record `migration`
 * entries only fire from `applyCutoverTransform` when records + a transform
 * exist. This asserts the bump itself is audited — one `op: 'lifecycle'`
 * entry naming the new generation, distinct from any per-record `migration`
 * entries.
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createNoydb } from '../../src/kernel/noydb.js'
import { withHistory } from '../../src/with-commit/history/index.js'
import { coordinatedCutover } from '../../src/with-shape/schema-update/index.js'
import { toMemory } from '../../../to-memory/src/index.js'
import type { NoydbStore } from '../../src/kernel/types.js'

interface InvOld extends Record<string, unknown> { id: string; total: number }
interface InvNew extends Record<string, unknown> { id: string; amount: { gross: number } }

const oldSchema = z.object({ id: z.string(), total: z.number() })
const newSchema = z.object({ id: z.string(), amount: z.object({ gross: z.number() }) })
const transform = (d: Record<string, unknown>) => ({ id: d['id'], amount: { gross: d['total'] } })

async function open(store: NoydbStore) {
  const db = await createNoydb({
    store, user: 'alice', secret: 'bare-cutover-audit-pass-1234',
    historyStrategy: withHistory(),
  })
  return db.openVault('demo-co')
}

describe('bare schema generation bump is audited in the ledger (#965)', () => {
  it('a cutover with NO records leaves exactly one bump entry naming the new generation', async () => {
    const store = toMemory()

    // gen 0: declare the OLD schema, no records ever written.
    let v = await open(store)
    v.collection<InvOld>('invoices', { schema: oldSchema, persistJsonSchema: true })
    await v._drainPendingSchemaWrites()

    // reopen with a NEW schema + coordinatedCutover -> registers a pending
    // cutover for 'invoices', but the collection has zero records.
    v = await open(store)
    v.collection<InvNew>('invoices', {
      schema: newSchema, persistJsonSchema: true,
      schemaUpdate: [coordinatedCutover({ transform })],
    })
    await v._drainPendingSchemaWrites()

    const result = await v.runSchemaCutover()
    expect(result.migrated).toBe(1) // one collection ran through the barrier (`migrated` counts collections, not records)

    const entries = await v.ledger().entries()
    // `op: 'migration'` is also used, unrelated, by persisted-schema-manifest
    // sync (`reason: 'schema-manifest-sync:...'`) — scope the per-record
    // cutover check to its own reason so that entry doesn't confuse the count.
    const perRecordCutoverEntries = entries.filter((e) => e.op === 'migration' && e.reason === 'schema:coordinated-cutover')
    const bumpEntries = entries.filter((e) => e.op === 'lifecycle' && e.reason?.startsWith('schema:generation-bump='))

    expect(perRecordCutoverEntries).toHaveLength(0) // no records -> nothing to migrate
    expect(bumpEntries).toHaveLength(1) // exactly one bump-audit entry
    expect(bumpEntries[0]?.reason).toBe('schema:generation-bump=1')
    expect(bumpEntries[0]?.payloadHash).toBe('')
  })

  it('a cutover WITH per-record migrations still gets exactly one distinct bump entry', async () => {
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

    const result = await v.runSchemaCutover()
    expect(result.migrated).toBe(1)

    const entries = await v.ledger().entries()
    const perRecordCutoverEntries = entries.filter((e) => e.op === 'migration' && e.reason === 'schema:coordinated-cutover')
    const bumpEntries = entries.filter((e) => e.op === 'lifecycle' && e.reason?.startsWith('schema:generation-bump='))

    expect(perRecordCutoverEntries).toHaveLength(1) // the per-record entry (#964's payloadHash fix)
    expect(bumpEntries).toHaveLength(1) // still exactly one bump entry — not conflated with the per-record one
    expect(bumpEntries[0]?.reason).toBe('schema:generation-bump=1')
  })
})
