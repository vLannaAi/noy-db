/**
 * adoptPartition (#207) — Plan 4. Recipient-side adoption of an extracted
 * partition bundle.
 *
 * Covers: error types; unsealDeks round-trip + wrong key; adopt happy path
 * (import + _meta/adoption, unowned); rejections (wrong key, non-extracted
 * bundle, double adoption, different-store re-adopt); end-to-end decrypt.
 */

import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/kernel/noydb.js'
import { withCargo } from '../src/index.js'
import { ref } from '../src/kernel/refs.js'
import { recordAadFor, decrypt, generateDEK, base64ToBuffer } from '../src/kernel/enclave/index.js'
import { TransferSealError, AdoptionStateError } from '../src/kernel/errors.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { ConflictError } from '../src/kernel/errors.js'
import { adoptPartition, unsealDeks } from '../src/with-cargo/adopt-partition.js'
import { extractPartition, sealDeks } from '../src/with-cargo/extract-partition.js'
import { writePod, readPod, parseExtractedPartitionBody } from '../src/with-pod/pod.js'

function toMemory(): NoydbStore {
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
  const db = await createNoydb({ cargoStrategy: withCargo(), store: toMemory(), user: 'alice', secret: 'test-secret-1234' })
  const company = await db.openVault('demo-co')
  const clients = company.collection<Client>('clients')
  const bills = company.collection<{ id: string; clientId: string }>('bills', { refs: { clientId: ref('clients') } })
  await clients.put('c-1', { id: 'c-1', name: 'Hotel', operatorUserId: 'belle' })
  await bills.put('b-1', { id: 'b-1', clientId: 'c-1' })
  return extractPartition(company, { seeds: { clients: () => true } })
}

describe('partition adoption error types', () => {
  it('exposes TransferSealError and AdoptionStateError as NoydbError subclasses', () => {
    expect(new TransferSealError('x')).toBeInstanceOf(Error)
    expect(new TransferSealError('x').name).toBe('TransferSealError')
    expect(new AdoptionStateError('y').name).toBe('AdoptionStateError')
  })
})

describe('unsealDeks', () => {
  it('round-trips sealDeks: recovers usable DEKs under the right transfer key', async () => {
    const original = new Map([['clients', await generateDEK()]])
    const { seal, transferKey } = await sealDeks(original)

    const deks = await unsealDeks(seal, transferKey)
    expect([...deks.keys()]).toEqual(['clients'])
    expect(deks.get('clients')!.algorithm.name).toBe('AES-GCM')
  })

  it('throws TransferSealError on a wrong transfer key', async () => {
    const { seal } = await sealDeks(new Map([['c', await generateDEK()]]))
    const wrong = crypto.getRandomValues(new Uint8Array(32))
    await expect(unsealDeks(seal, wrong)).rejects.toThrow(TransferSealError)
  })
})

describe('adoptPartition', () => {
  it('imports re-keyed collections + writes _meta/adoption, leaving the vault unowned', async () => {
    const { bundleBytes, transferKey, sealId } = await makeExtractedBundle()
    const dest = toMemory()

    const result = await adoptPartition(bundleBytes, { transferKey, destinationStore: dest, vaultName: 'acme-hotel' })

    expect(result).toEqual({ vaultName: 'acme-hotel', needsOwner: true, sealId })

    expect(await dest.get('acme-hotel', 'clients', 'c-1')).toBeTruthy()
    expect(await dest.get('acme-hotel', 'bills', 'b-1')).toBeTruthy()

    const adoptionEnv = await dest.get('acme-hotel', '_meta', 'adoption')
    expect(adoptionEnv).toBeTruthy()
    const adoption = JSON.parse(adoptionEnv!._data) as { sealId: string; needsOwner: boolean; transferSeal: unknown }
    expect(adoption.sealId).toBe(sealId)
    expect(adoption.needsOwner).toBe(true)
    expect(adoption.transferSeal).toBeTruthy()
    expect(await dest.list('acme-hotel', '_keyring')).toEqual([])
  })
})

describe('adoptPartition rejections', () => {
  it('throws TransferSealError on the wrong transfer key', async () => {
    const { bundleBytes } = await makeExtractedBundle()
    const wrong = crypto.getRandomValues(new Uint8Array(32))
    await expect(
      adoptPartition(bundleBytes, { transferKey: wrong, destinationStore: toMemory(), vaultName: 'v' }),
    ).rejects.toThrow(TransferSealError)
  })

  it('throws ValidationError for a non-extracted (ordinary) bundle', async () => {
    const db = await createNoydb({ cargoStrategy: withCargo(), store: toMemory(), user: 'alice', secret: 'test-secret-1234' })
    const company = await db.openVault('demo-co')
    await company.collection<Client>('clients').put('c-1', { id: 'c-1', name: 'A', operatorUserId: 'belle' })
    const ordinary = await writePod(company)
    await expect(
      adoptPartition(ordinary, { transferKey: crypto.getRandomValues(new Uint8Array(32)), destinationStore: toMemory(), vaultName: 'v' }),
    ).rejects.toThrow(/extracted-partition/)
  })

  it('rejects double adoption of the same partition into the same store', async () => {
    const { bundleBytes, transferKey } = await makeExtractedBundle()
    const dest = toMemory()
    await adoptPartition(bundleBytes, { transferKey, destinationStore: dest, vaultName: 'acme' })
    await expect(
      adoptPartition(bundleBytes, { transferKey, destinationStore: dest, vaultName: 'acme' }),
    ).rejects.toThrow(AdoptionStateError)
  })

  it('refuses to adopt into a vaultName that already holds a regular (non-adopted) vault', async () => {
    // A vault created the ordinary way has NO _meta/adoption marker, so a
    // marker-only guard would let adoptPartition's saveAll clobber it — on SQL
    // adapters that's DELETE WHERE vault=? and wipes the existing keyring,
    // making the downstream other-owners check meaningless.
    const dest = toMemory()
    const aliceDb = await createNoydb({ cargoStrategy: withCargo(), store: dest, user: 'alice', secret: 'alice-secret-2026' })
    await (await aliceDb.openVault('taken')).collection<Client>('clients').put('a-1', { id: 'a-1', name: 'A', operatorUserId: 'alice' })
    expect(await dest.list('taken', '_keyring')).toEqual(['alice'])

    const { bundleBytes, transferKey } = await makeExtractedBundle()
    await expect(
      adoptPartition(bundleBytes, { transferKey, destinationStore: dest, vaultName: 'taken' }),
    ).rejects.toThrow(AdoptionStateError)

    // Alice's keyring + a-1 must survive the rejected adoption.
    expect(await dest.list('taken', '_keyring')).toEqual(['alice'])
    expect(await dest.get('taken', 'clients', 'a-1')).toBeTruthy()
  })

  it('refuses to adopt a DIFFERENT partition into a vault that already holds one (no clobber)', async () => {
    const a = await makeExtractedBundle()
    const b = await makeExtractedBundle() // fresh seal + transfer key → different sealId
    const dest = toMemory()
    await adoptPartition(a.bundleBytes, { transferKey: a.transferKey, destinationStore: dest, vaultName: 'acme' })

    await expect(
      adoptPartition(b.bundleBytes, { transferKey: b.transferKey, destinationStore: dest, vaultName: 'acme' }),
    ).rejects.toThrow(AdoptionStateError)

    // The original adoption marker must survive the rejected second bundle.
    const adoptionEnv = await dest.get('acme', '_meta', 'adoption')
    const adoption = JSON.parse(adoptionEnv!._data) as { sealId: string }
    expect(adoption.sealId).toBe(a.sealId)
  })

  it('allows adopting the same partition into a DIFFERENT store (bundle is unchanged)', async () => {
    const { bundleBytes, transferKey, sealId } = await makeExtractedBundle()
    await adoptPartition(bundleBytes, { transferKey, destinationStore: toMemory(), vaultName: 'a' })
    const second = await adoptPartition(bundleBytes, { transferKey, destinationStore: toMemory(), vaultName: 'b' })
    expect(second.sealId).toBe(sealId)
  })
})

describe('adoptPartition end-to-end', () => {
  it('adopted records decrypt under the DEKs recovered from the transfer seal', async () => {
    const { bundleBytes, transferKey } = await makeExtractedBundle()
    const dest = toMemory()
    await adoptPartition(bundleBytes, { transferKey, destinationStore: dest, vaultName: 'acme' })

    const { seal } = parseExtractedPartitionBody((await readPod(bundleBytes)).dumpJson)
    const deks = await unsealDeks(seal, transferKey)

    const env = await dest.get('acme', 'clients', 'c-1')
    const plaintext = await decrypt(env!._iv, env!._data, deks.get('clients')!, recordAadFor({ collection: 'clients', id: 'c-1' }, env!))
    expect(JSON.parse(plaintext)).toMatchObject({ id: 'c-1', name: 'Hotel' })
  })
})
