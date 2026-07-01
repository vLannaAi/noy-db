import { describe, expect, it, beforeEach } from 'vitest'
import { z } from 'zod'
import { generateDEK } from '../../src/kernel/enclave/crypto.js'
import { memory } from '../../../to-memory/src/index.js'
import { persistSchemaIfNeeded } from '../../src/with-shape/persisted-schemas/register.js'
import { SCHEMAS_COLLECTION } from '../../src/with-shape/persisted-schemas/storage.js'
import { additiveOnly } from '../../src/with-shape/schema-update/strategies.js'
import { NonAdditiveSchemaChangeError } from '../../src/errors.js'
import type { NoydbStore } from '../../src/kernel/types.js'

const VAULT = 'v1'
const COL = 'invoices'

describe('persistSchemaIfNeeded + update strategies', () => {
  let store: NoydbStore
  let dek: CryptoKey
  beforeEach(async () => {
    store = memory()
    dek = await generateDEK()
  })

  it('additive change with additiveOnly → allow + baseline written', async () => {
    await persistSchemaIfNeeded({ store, vault: VAULT, collectionName: COL, validator: z.object({ id: z.string() }), dek })
    const before = (await store.get(VAULT, SCHEMAS_COLLECTION, COL))!._v
    const result = await persistSchemaIfNeeded({
      store, vault: VAULT, collectionName: COL,
      validator: z.object({ id: z.string(), note: z.string().optional() }),
      dek, strategies: [additiveOnly()],
    })
    expect(result.decision).toEqual({ action: 'allow' })
    expect((await store.get(VAULT, SCHEMAS_COLLECTION, COL))!._v).toBe(before + 1)
  })

  it('non-additive change with additiveOnly → reject + baseline NOT overwritten', async () => {
    await persistSchemaIfNeeded({ store, vault: VAULT, collectionName: COL, validator: z.object({ id: z.string(), amount: z.number() }), dek })
    const before = (await store.get(VAULT, SCHEMAS_COLLECTION, COL))!._v
    const result = await persistSchemaIfNeeded({
      store, vault: VAULT, collectionName: COL,
      validator: z.object({ id: z.string() }), // removed 'amount' — non-additive
      dek, strategies: [additiveOnly()],
    })
    expect(result.decision?.action).toBe('reject')
    if (result.decision?.action === 'reject') expect(result.decision.error).toBeInstanceOf(NonAdditiveSchemaChangeError)
    expect(result.written).toBe(false)
    expect((await store.get(VAULT, SCHEMAS_COLLECTION, COL))!._v).toBe(before) // unchanged
  })

  it('first registration (no baseline) never rejects', async () => {
    const result = await persistSchemaIfNeeded({
      store, vault: VAULT, collectionName: COL,
      validator: z.object({ id: z.string() }), dek, strategies: [additiveOnly()],
    })
    expect(result.decision).toEqual({ action: 'allow' })
    expect(result.written).toBe(true)
  })
})
