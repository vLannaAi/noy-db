/**
 * E2E for the schema-update framework (#245): a non-additive change with
 * additiveOnly() is rejected on the next write; additive passes; a
 * coordinatedCutover-less break falls through to the backstop.
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createNoydb } from '../src/kernel/noydb.js'
import { memory } from '../../to-memory/src/index.js'
import { additiveOnly, lockSchema } from '../src/with-shape/schema-update/index.js'
import { NonAdditiveSchemaChangeError, SchemaLockedError } from '../src/kernel/errors.js'
import type { NoydbStore } from '../src/kernel/types.js'

interface Invoice extends Record<string, unknown> { id: string; amount?: number | undefined }

async function reopen(store: NoydbStore) {
  const db = await createNoydb({ store, user: 'alice', secret: 'schema-update-test-pass-1234' })
  return db.openVault('demo')
}

describe('schema-update framework (#245)', () => {
  it('additive change → write succeeds', async () => {
    const store = memory()
    let v = await reopen(store)
    v.collection<Invoice>('invoices', { schema: z.object({ id: z.string() }), persistJsonSchema: true, schemaUpdate: [additiveOnly()] })
    await v._drainPendingSchemaWrites()

    v = await reopen(store)
    const invoices = v.collection<Invoice>('invoices', {
      schema: z.object({ id: z.string(), amount: z.number().optional() }), // additive
      persistJsonSchema: true, schemaUpdate: [additiveOnly()],
    })
    await v._drainPendingSchemaWrites()
    await expect(invoices.put('i1', { id: 'i1', amount: 10 })).resolves.toBeUndefined()
  })

  it('non-additive change → next put throws NonAdditiveSchemaChangeError', async () => {
    const store = memory()
    let v = await reopen(store)
    v.collection<Invoice>('invoices', { schema: z.object({ id: z.string(), amount: z.number() }), persistJsonSchema: true, schemaUpdate: [additiveOnly()] })
    await v._drainPendingSchemaWrites()

    v = await reopen(store)
    const invoices = v.collection<Invoice>('invoices', {
      schema: z.object({ id: z.string() }), // removed 'amount' — non-additive
      persistJsonSchema: true, schemaUpdate: [additiveOnly()],
    })
    await v._drainPendingSchemaWrites()
    await expect(invoices.put('i1', { id: 'i1' })).rejects.toBeInstanceOf(NonAdditiveSchemaChangeError)
  })

  it('lockSchema first → SchemaLockedError wins over additiveOnly', async () => {
    const store = memory()
    let v = await reopen(store)
    v.collection<Invoice>('invoices', { schema: z.object({ id: z.string() }), persistJsonSchema: true, schemaUpdate: [lockSchema(), additiveOnly()] })
    await v._drainPendingSchemaWrites()

    v = await reopen(store)
    const invoices = v.collection<Invoice>('invoices', {
      schema: z.object({ id: z.string(), note: z.string().optional() }), // additive, but locked
      persistJsonSchema: true, schemaUpdate: [lockSchema(), additiveOnly()],
    })
    await v._drainPendingSchemaWrites()
    await expect(invoices.put('i1', { id: 'i1' })).rejects.toBeInstanceOf(SchemaLockedError)
  })

  it('no schemaUpdate strategy → non-additive change is accepted (blind, back-compat)', async () => {
    const store = memory()
    let v = await reopen(store)
    v.collection<Invoice>('invoices', { schema: z.object({ id: z.string(), amount: z.number() }), persistJsonSchema: true })
    await v._drainPendingSchemaWrites()

    v = await reopen(store)
    const invoices = v.collection<Invoice>('invoices', { schema: z.object({ id: z.string() }), persistJsonSchema: true })
    await v._drainPendingSchemaWrites()
    await expect(invoices.put('i1', { id: 'i1' })).resolves.toBeUndefined()
  })
})
