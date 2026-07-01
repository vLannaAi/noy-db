/**
 * carrySchemas opt-in (#204) — Plan 6. Carry persisted JSON Schemas into
 * an extracted partition, re-keyed under the destination DEKs.
 */

import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { createNoydb } from '../src/kernel/noydb.js'
import { ConflictError } from '../src/kernel/errors.js'
import { generateDEK, decrypt } from '../src/kernel/enclave/crypto.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { reKeySchemas, extractPartition } from '../src/with-cargo/extract-partition.js'
import { adoptPartition, createOwnerOnAdoptedPartition } from '../src/with-cargo/adopt-partition.js'
import { readNoydbBundle, parseExtractedPartitionBody } from '../src/with-pod/bundle.js'
import { loadPersistedSchema } from '../src/with-shape/persisted-schemas/storage.js'

function memory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function getCollection(c: string, col: string) {
    let comp = store.get(c)
    if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col)
    if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
    name: 'memory',
    async get(c, col, id) { return store.get(c)?.get(col)?.get(id) ?? null },
    async put(c, col, id, env, ev) {
      const coll = getCollection(c, col)
      const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      coll.set(id, env)
    },
    async delete(c, col, id) { store.get(c)?.get(col)?.delete(id) },
    async list(c, col) { const coll = store.get(c)?.get(col); return coll ? [...coll.keys()] : [] },
    async loadAll(c) {
      const comp = store.get(c); const s: VaultSnapshot = {}
      if (comp) for (const [n, coll] of comp) {
        if (!n.startsWith('_')) {
          const r: Record<string, EncryptedEnvelope> = {}
          for (const [id, e] of coll) r[id] = e
          s[n] = r
        }
      }
      return s
    },
    async saveAll(c, data) {
      const comp = new Map<string, Map<string, EncryptedEnvelope>>()
      for (const [name, records] of Object.entries(data)) {
        const coll = new Map<string, EncryptedEnvelope>()
        for (const [id, env] of Object.entries(records)) coll.set(id, env)
        comp.set(name, coll)
      }
      const existing = store.get(c)
      if (existing) {
        for (const [name, coll] of existing) {
          if (name.startsWith('_')) comp.set(name, coll)
        }
      }
      store.set(c, comp)
    },
  }
}

interface Client { id: string; name: string; operatorUserId: string }
const ClientSchema = z.object({ id: z.string(), name: z.string(), operatorUserId: z.string() })

/** A vault with a schema-persisting `clients` collection holding one record. */
async function vaultWithSchema() {
  const db = await createNoydb({ store: memory(), user: 'alice', secret: 'test-passphrase-1234' })
  const c = await db.openVault('demo-co')
  c.collection<Client>('clients', { schema: ClientSchema, persistJsonSchema: true })
  await c.collection<Client>('clients').put('c-1', { id: 'c-1', name: 'Hotel', operatorUserId: 'belle' })
  // Persisted-schema writes are deferred/queued — flush so _schemas/clients
  // is durable before we extract.
  await c._drainPendingSchemaWrites()
  return c
}

async function bundleBody(bytes: Uint8Array) {
  const { dump } = parseExtractedPartitionBody((await readNoydbBundle(bytes)).dumpJson)
  return JSON.parse(dump) as { collections: Record<string, unknown>; _internal?: { _schemas?: Record<string, unknown> } }
}

/**
 * Same memory adapter as above but defers `_schemas` writes by one macrotask,
 * so the schema row is not on disk by the time extractPartition reads it
 * unless extractPartition explicitly drains the pending-writes queue first.
 * Models the race that production stores (network, SQL) hit naturally.
 */
function delayedSchemaMemory(): NoydbStore {
  const inner = memory()
  return {
    ...inner,
    async put(c, col, id, env, ev) {
      if (col === '_schemas') await new Promise<void>((r) => setTimeout(r, 0))
      return inner.put(c, col, id, env, ev)
    },
  }
}

describe('extractPartition({ carrySchemas: true })', () => {
  it('drains pending persisted-schema writes so the bundle never misses an in-flight schema', async () => {
    const db = await createNoydb({ store: delayedSchemaMemory(), user: 'alice', secret: 'test-passphrase-1234' })
    const c = await db.openVault('demo-co')
    c.collection<Client>('clients', { schema: ClientSchema, persistJsonSchema: true })
    await c.collection<Client>('clients').put('c-1', { id: 'c-1', name: 'Hotel', operatorUserId: 'belle' })
    // Deliberately DO NOT call c._drainPendingSchemaWrites() — extractPartition
    // must drain on its own when carrySchemas is true.
    const { bundleBytes } = await extractPartition(c, { seeds: { clients: () => true }, carrySchemas: true })
    const body = await bundleBody(bundleBytes)
    expect(body._internal?._schemas).toBeDefined()
    expect(Object.keys(body._internal!._schemas!)).toContain('clients')
  })
})

describe('reKeySchemas', () => {
  it('re-keys persisted schemas for closure collections under the destination DEKs', async () => {
    const company = await vaultWithSchema()
    const destDek = await generateDEK()
    const schemas = await reKeySchemas(company, new Map([['clients', new Set(['c-1'])]]), new Map([['clients', destDek]]))

    const env = schemas['clients']!
    const json = await decrypt(env._iv, env._data, destDek)
    expect(JSON.parse(json)._noydb_schema).toBe(1)
  })

  it('returns an empty map when no closure collection has a persisted schema', async () => {
    const db = await createNoydb({ store: memory(), user: 'alice', secret: 'test-passphrase-1234' })
    const company = await db.openVault('demo-co')
    await company.collection<Client>('clients').put('c-1', { id: 'c-1', name: 'A', operatorUserId: 'belle' })
    const schemas = await reKeySchemas(company, new Map([['clients', new Set(['c-1'])]]), new Map([['clients', await generateDEK()]]))
    expect(Object.keys(schemas)).toEqual([])
  })
})

describe('extractPartition carrySchemas', () => {
  it('carries _internal._schemas when carrySchemas: true', async () => {
    const company = await vaultWithSchema()
    const { bundleBytes } = await extractPartition(company, { seeds: { clients: () => true }, carrySchemas: true })
    const body = await bundleBody(bundleBytes)
    expect(body._internal?._schemas?.['clients']).toBeTruthy()
  })

  it('omits _internal by default (carrySchemas off)', async () => {
    const company = await vaultWithSchema()
    const { bundleBytes } = await extractPartition(company, { seeds: { clients: () => true } })
    const body = await bundleBody(bundleBytes)
    expect(body._internal).toBeUndefined()
  })
})

describe('adoptPartition imports carried schemas', () => {
  it('writes _schemas/<collection> into the destination store', async () => {
    const company = await vaultWithSchema()
    const { bundleBytes, transferKey } = await extractPartition(company, { seeds: { clients: () => true }, carrySchemas: true })
    const dest = memory()
    await adoptPartition(bundleBytes, { transferKey, destinationStore: dest, vaultName: 'acme' })
    expect(await dest.get('acme', '_schemas', 'clients')).toBeTruthy()
  })

  it('imports nothing extra when the bundle has no _internal (default)', async () => {
    const company = await vaultWithSchema()
    const { bundleBytes, transferKey } = await extractPartition(company, { seeds: { clients: () => true } })
    const dest = memory()
    await adoptPartition(bundleBytes, { transferKey, destinationStore: dest, vaultName: 'acme' })
    expect(await dest.get('acme', '_schemas', 'clients')).toBeNull()
  })
})

describe('carrySchemas full ceremony', () => {
  it('recipient owns the partition and the carried schema decrypts under their keyring DEK', async () => {
    const company = await vaultWithSchema()
    const { bundleBytes, transferKey } = await extractPartition(company, { seeds: { clients: () => true }, carrySchemas: true })

    const dest = memory()
    await adoptPartition(bundleBytes, { transferKey, destinationStore: dest, vaultName: 'acme' })
    await createOwnerOnAdoptedPartition(dest, 'acme', { userId: 'belle', passphrase: 'belle-2026', transferKey })

    const recipientDb = await createNoydb({ store: dest, user: 'belle', secret: 'belle-2026' })
    const vault = await recipientDb.openVault('acme')
    const clientsDek = await vault._introspectState().getDEK('clients')
    const schema = await loadPersistedSchema(dest, 'acme', 'clients', clientsDek)
    expect(schema?._noydb_schema).toBe(1)
  })
})
