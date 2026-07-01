/**
 * createOwnerOnAdoptedPartition (#208) + seal cleanup (#209) — Plan 5.
 * Closes the extract → adopt → own ceremony.
 */

import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/noydb.js'
import { ref } from '../src/refs.js'
import { ConflictError, AdoptionStateError } from '../src/errors.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { extractPartition } from '../src/with-cargo/extract-partition.js'
import { adoptPartition, createOwnerOnAdoptedPartition } from '../src/with-cargo/adopt-partition.js'

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

async function makeExtractedBundle() {
  const db = await createNoydb({ store: memory(), user: 'alice', secret: 'test-passphrase-1234' })
  const company = await db.openVault('demo-co')
  const clients = company.collection<Client>('clients')
  const bills = company.collection<{ id: string; clientId: string }>('bills', { refs: { clientId: ref('clients') } })
  await clients.put('c-1', { id: 'c-1', name: 'Hotel', operatorUserId: 'belle' })
  await bills.put('b-1', { id: 'b-1', clientId: 'c-1' })
  return extractPartition(company, { seeds: { clients: () => true } })
}

async function extractAndAdopt() {
  const { bundleBytes, transferKey } = await makeExtractedBundle()
  const dest = memory()
  await adoptPartition(bundleBytes, { transferKey, destinationStore: dest, vaultName: 'acme' })
  return { dest, transferKey }
}

describe('createOwnerOnAdoptedPartition', () => {
  it('mints the recipient owner keyring and destroys the transfer seal', async () => {
    const { dest, transferKey } = await extractAndAdopt()

    const result = await createOwnerOnAdoptedPartition(dest, 'acme', {
      userId: 'belle', passphrase: 'belle-hotel-dept-2026', transferKey,
    })
    expect(result).toEqual({ vaultName: 'acme', userId: 'belle' })

    expect(await dest.list('acme', '_keyring')).toEqual(['belle'])

    const adoptionEnv = await dest.get('acme', '_meta', 'adoption')
    const adoption = JSON.parse(adoptionEnv!._data) as { sealId: string; consumedAt?: string; transferSeal?: unknown }
    expect(adoption.transferSeal).toBeUndefined()
    expect(adoption.consumedAt).toBeTruthy()
    expect(adoption.sealId).toBeTruthy()
  })
})

describe('createOwnerOnAdoptedPartition state guards', () => {
  it('rejects a vault that was not adopted (no _meta/adoption)', async () => {
    const store = memory()
    await expect(
      createOwnerOnAdoptedPartition(store, 'nope', {
        userId: 'belle', passphrase: 'p', transferKey: crypto.getRandomValues(new Uint8Array(32)),
      }),
    ).rejects.toThrow(AdoptionStateError)
  })

  it('rejects a second owner-create after the seal is consumed', async () => {
    const { dest, transferKey } = await extractAndAdopt()
    await createOwnerOnAdoptedPartition(dest, 'acme', { userId: 'belle', passphrase: 'p1', transferKey })
    await expect(
      createOwnerOnAdoptedPartition(dest, 'acme', { userId: 'belle', passphrase: 'p2', transferKey }),
    ).rejects.toThrow(AdoptionStateError)
  })

  it('rejects a wrong transfer key before writing any keyring', async () => {
    const { dest } = await extractAndAdopt()
    const wrong = crypto.getRandomValues(new Uint8Array(32))
    await expect(
      createOwnerOnAdoptedPartition(dest, 'acme', { userId: 'belle', passphrase: 'p', transferKey: wrong }),
    ).rejects.toThrow()
    expect(await dest.list('acme', '_keyring')).toEqual([])
  })
})

describe('full ceremony end-to-end', () => {
  it('recipient opens the adopted+owned vault with their passphrase and reads a re-keyed record', async () => {
    const { dest, transferKey } = await extractAndAdopt()
    await createOwnerOnAdoptedPartition(dest, 'acme', {
      userId: 'belle', passphrase: 'belle-hotel-dept-2026', transferKey,
    })

    const recipientDb = await createNoydb({ store: dest, user: 'belle', secret: 'belle-hotel-dept-2026' })
    const vault = await recipientDb.openVault('acme')

    const client = await vault.collection<Client>('clients').get('c-1')
    expect(client).toMatchObject({ id: 'c-1', name: 'Hotel', operatorUserId: 'belle' })

    const bill = await vault.collection<{ id: string; clientId: string }>('bills').get('b-1')
    expect(bill).toMatchObject({ id: 'b-1', clientId: 'c-1' })
  })
})

describe('bundle subpath export', () => {
  it('is exported from the @noy-db/hub/bundle subpath', async () => {
    const mod = await import('../src/bundle/index.js')
    expect(typeof mod.createOwnerOnAdoptedPartition).toBe('function')
  })
})
