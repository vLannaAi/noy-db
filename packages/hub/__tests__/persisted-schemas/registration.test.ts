import { describe, it, expect, beforeEach } from 'vitest'
import { z } from 'zod'
import { generateDEK } from '../../src/kernel/enclave/crypto.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../../src/kernel/types.js'
import { ConflictError } from '../../src/kernel/errors.js'
import { persistSchemaIfNeeded } from '../../src/with-shape/persisted-schemas/register.js'
import { loadPersistedSchema } from '../../src/with-shape/persisted-schemas/storage.js'

function inlineMemory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function gc(c: string, col: string) {
    let comp = store.get(c); if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col); if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
    async get(c, col, id) { return store.get(c)?.get(col)?.get(id) ?? null },
    async put(c, col, id, env, ev) {
      const coll = gc(c, col); const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      coll.set(id, env)
    },
    async delete(c, col, id) { store.get(c)?.get(col)?.delete(id) },
    async list(c, col) { const coll = store.get(c)?.get(col); return coll ? [...coll.keys()] : [] },
    async loadAll(c) {
      const comp = store.get(c); const s: VaultSnapshot = {}
      if (comp) for (const [n, coll] of comp) { if (!n.startsWith('_')) { const r: Record<string, EncryptedEnvelope> = {}; for (const [id, e] of coll) r[id] = e; s[n] = r } }
      return s
    },
    async saveAll() { /* unused */ },
  }
}

describe('persistSchemaIfNeeded', () => {
  const VAULT = 'acme'
  const COLLECTION = 'invoices'
  let store: NoydbStore
  let dek: CryptoKey

  beforeEach(async () => {
    store = inlineMemory()
    dek = await generateDEK()
  })

  it('writes a fresh envelope on first call for a Zod-validated collection', async () => {
    const Invoice = z.object({ id: z.string(), amount: z.number() })
    const result = await persistSchemaIfNeeded({
      store, vault: VAULT, collectionName: COLLECTION, validator: Invoice, dek,
    })
    expect(result.written).toBe(true)
    expect(result.skipped).toBe(false)
    expect(result.envelope.kind).toBe('Zod')
    expect(result.envelope.hash).toMatch(/^[0-9a-f]{64}$/)

    const stored = await loadPersistedSchema(store, VAULT, COLLECTION, dek)
    expect(stored?.hash).toBe(result.envelope.hash)
  })

  it('skips the write when the validator hash matches what is already stored', async () => {
    const Invoice = z.object({ id: z.string(), amount: z.number() })
    await persistSchemaIfNeeded({ store, vault: VAULT, collectionName: COLLECTION, validator: Invoice, dek })
    const before = (await store.get(VAULT, '_schemas', COLLECTION))!._v

    const result = await persistSchemaIfNeeded({ store, vault: VAULT, collectionName: COLLECTION, validator: Invoice, dek })
    expect(result.written).toBe(false)
    expect(result.skipped).toBe(true)

    const after = (await store.get(VAULT, '_schemas', COLLECTION))!._v
    expect(after).toBe(before) // no _v bump on skip
  })

  it('writes fresh when the validator shape changes (hash mismatch)', async () => {
    const v1 = z.object({ id: z.string() })
    const v2 = z.object({ id: z.string(), amount: z.number() })

    await persistSchemaIfNeeded({ store, vault: VAULT, collectionName: COLLECTION, validator: v1, dek })
    const before = (await store.get(VAULT, '_schemas', COLLECTION))!._v

    const result = await persistSchemaIfNeeded({ store, vault: VAULT, collectionName: COLLECTION, validator: v2, dek })
    expect(result.written).toBe(true)
    expect(result.skipped).toBe(false)

    const after = (await store.get(VAULT, '_schemas', COLLECTION))!._v
    expect(after).toBe(before + 1)
  })

  it('writes a stub envelope for non-Zod validators (kind=Unknown, jsonSchema=null)', async () => {
    const fakeArktype = { '~standard': { version: 1, vendor: 'arktype', validate: () => ({}) } }
    const result = await persistSchemaIfNeeded({
      store, vault: VAULT, collectionName: COLLECTION,
      validator: fakeArktype as unknown,
      dek,
    })
    expect(result.written).toBe(true)
    expect(result.envelope.kind).toBe('Unknown')
    expect(result.envelope.jsonSchema).toBeNull()
    expect(result.envelope.reason).toMatch(/derivation not yet supported/i)
  })

  it('subsequent call with the same non-Zod validator also skips on hash equality', async () => {
    // Stub envelopes have hash=null, so the skip path falls back to: if the
    // existing stored envelope has the same kind + null hash, skip.
    const fake = { '~standard': { version: 1, vendor: 'valibot', validate: () => ({}) } }
    await persistSchemaIfNeeded({ store, vault: VAULT, collectionName: COLLECTION, validator: fake, dek })
    const before = (await store.get(VAULT, '_schemas', COLLECTION))!._v

    const result = await persistSchemaIfNeeded({ store, vault: VAULT, collectionName: COLLECTION, validator: fake, dek })
    expect(result.skipped).toBe(true)
    const after = (await store.get(VAULT, '_schemas', COLLECTION))!._v
    expect(after).toBe(before)
  })
})
