/** E2E single-client coordinatedCutover (#232 sub-slice 3a). */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createNoydb } from '../src/noydb.js'
import { memory } from '../../to-memory/src/index.js'
import { coordinatedCutover, additiveOnly } from '../src/with-shape/schema-update/index.js'
import { SchemaFenceError, MigrationRequiredError } from '../src/errors.js'
import type { NoydbStore } from '../src/types.js'

interface InvOld extends Record<string, unknown> { id: string; total: number }
interface InvNew extends Record<string, unknown> { id: string; amount: { gross: number } }

const oldSchema = z.object({ id: z.string(), total: z.number() })
const newSchema = z.object({ id: z.string(), amount: z.object({ gross: z.number() }) })
const transform = (d: Record<string, unknown>) => ({ id: d['id'], amount: { gross: d['total'] } })

async function open(store: NoydbStore) {
  const db = await createNoydb({ store, user: 'a', secret: 'cutover-e2e-pass-1234' })
  return db.openVault('demo')
}

describe('coordinatedCutover E2E (#232 3a)', () => {
  it('pending cutover blocks writes; runSchemaCutover migrates + unblocks', async () => {
    const store = memory()
    // gen 0: seed old-shape data
    let v = await open(store)
    const invoicesOld = v.collection<InvOld>('invoices', { schema: oldSchema, persistJsonSchema: true })
    await v._drainPendingSchemaWrites()
    await invoicesOld.put('i1', { id: 'i1', total: 100 })

    // reopen with NEW schema + coordinatedCutover → non-additive → cutover-pending
    v = await open(store)
    const invNew = v.collection<InvNew>('invoices', {
      schema: newSchema, persistJsonSchema: true,
      schemaUpdate: [coordinatedCutover({ transform }), additiveOnly()],
    })
    await v._drainPendingSchemaWrites()

    await expect(invNew.put('i2', { id: 'i2', amount: { gross: 5 } })).rejects.toBeInstanceOf(SchemaFenceError)

    const result = await v.runSchemaCutover()
    expect(result.migrated).toBe(1)
    expect((await invNew.get('i1'))?.amount.gross).toBe(100) // existing record transformed in place
    await expect(invNew.put('i2', { id: 'i2', amount: { gross: 5 } })).resolves.toBeUndefined() // writes now allowed
  })

  it('a still-open stale client hits MigrationRequiredError after a cutover bumps the generation', async () => {
    const store = memory()
    let v = await open(store)
    v.collection<InvOld>('invoices', { schema: oldSchema, persistJsonSchema: true })
    await v._drainPendingSchemaWrites()

    // stale client opens at gen 0
    const staleVault = await open(store)
    const staleInvoices = staleVault.collection<InvOld>('invoices', { schema: oldSchema, persistJsonSchema: true })
    await staleVault._drainPendingSchemaWrites()

    // a fresh client performs a cutover (bumps generation to 1)
    const migVault = await open(store)
    migVault.collection<InvNew>('invoices', { schema: newSchema, persistJsonSchema: true, schemaUpdate: [coordinatedCutover({ transform })] })
    await migVault._drainPendingSchemaWrites()
    await migVault.runSchemaCutover()

    // stale client (snapshot 0) now sees live counter 1 → MigrationRequiredError
    await expect(staleInvoices.put('i9', { id: 'i9', total: 1 })).rejects.toBeInstanceOf(MigrationRequiredError)
  })

  it('additive change alongside coordinatedCutover just passes', async () => {
    const store = memory()
    let v = await open(store)
    v.collection('logs', { schema: z.object({ id: z.string() }), persistJsonSchema: true })
    await v._drainPendingSchemaWrites()

    v = await open(store)
    const logs = v.collection<{ id: string; level?: string | undefined }>('logs', {
      schema: z.object({ id: z.string(), level: z.string().optional() }), // additive
      persistJsonSchema: true, schemaUpdate: [coordinatedCutover({ transform: (d) => d }), additiveOnly()],
    })
    await v._drainPendingSchemaWrites()
    await expect(logs.put('l1', { id: 'l1', level: 'info' })).resolves.toBeUndefined()
  })
})
