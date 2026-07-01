/**
 * extractPartition + transfer seal (#203/#206) — Plan 3b.
 *
 * Covers:
 *   - reKeyClosure: re-encrypt closure records under fresh DEKs
 *   - sealDeks: mint transfer key + seal DEK set
 *   - extractPartition: owner-gated, produces extracted-partition bundle
 *   - end-to-end: unseal DEKs with transfer key, decrypt a re-keyed record
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { createNoydb } from '../src/noydb.js'
import type { Noydb } from '../src/noydb.js'
import { ref } from '../src/kernel/refs.js'
import { ConflictError } from '../src/kernel/errors.js'
import { decrypt, base64ToBuffer, generateDEK } from '../src/kernel/enclave/crypto.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { reKeyClosure, sealDeks, extractPartition } from '../src/with-cargo/extract-partition.js'
import { readNoydbBundle, readNoydbBundleHeader, parseExtractedPartitionBody } from '../src/with-pod/bundle.js'

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

describe('reKeyClosure', () => {
  let db: Noydb
  beforeEach(async () => {
    db = await createNoydb({ store: memory(), user: 'alice', secret: 'test-passphrase-1234' })
  })

  it('re-encrypts each closure record under a fresh DEK that decrypts to the same plaintext', async () => {
    const company = await db.openVault('demo-co')
    const clients = company.collection<Client>('clients')
    await clients.put('c-1', { id: 'c-1', name: 'Acme', operatorUserId: 'belle' })

    const closure = new Map([['clients', new Set(['c-1'])]])
    const { collections, deks } = await reKeyClosure(company, closure)

    const env = collections['clients']!['c-1']!
    const destDek = deks.get('clients')!
    const plaintext = await decrypt(env._iv, env._data, destDek)
    expect(JSON.parse(plaintext)).toMatchObject({ id: 'c-1', name: 'Acme', operatorUserId: 'belle' })
  })
})

describe('sealDeks', () => {
  it('seals DEKs under a 32-byte transfer key; payload decrypts back to the DEK set', async () => {
    const deks = new Map([['clients', await generateDEK()], ['bills', await generateDEK()]])

    const { seal, transferKey } = await sealDeks(deks)

    expect(transferKey.byteLength).toBe(32)
    expect(seal.v).toBe(1)
    expect(seal.alg).toBe('aes-256-gcm-pre-shared')
    expect(seal.sealId.length).toBeGreaterThan(0)

    const key = await crypto.subtle.importKey('raw', transferKey.slice(), 'AES-GCM', false, ['decrypt'])
    const rawBytes = base64ToBuffer(seal.payload)
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: rawBytes.slice(0, 12) }, key, rawBytes.slice(12))
    const map = JSON.parse(new TextDecoder().decode(pt)) as Record<string, string>
    expect(Object.keys(map).sort()).toEqual(['bills', 'clients'])
  })
})

describe('extractPartition', () => {
  let db: Noydb
  beforeEach(async () => {
    db = await createNoydb({ store: memory(), user: 'alice', secret: 'test-passphrase-1234' })
  })

  it('produces an extracted-partition bundle with bundleKind + transferSeal header', async () => {
    const company = await db.openVault('demo-co')
    const clients = company.collection<Client>('clients')
    const bills = company.collection<{ id: string; clientId: string }>(
      'bills', { refs: { clientId: ref('clients') } },
    )
    await clients.put('c-1', { id: 'c-1', name: 'Hotel', operatorUserId: 'belle' })
    await bills.put('b-1', { id: 'b-1', clientId: 'c-1' })

    const { bundleBytes, transferKey, sealId } = await extractPartition(company, {
      seeds: { clients: (c) => c['operatorUserId'] === 'belle' },
    })

    expect(transferKey.byteLength).toBe(32)
    expect(sealId.length).toBeGreaterThan(0)

    const header = await readNoydbBundleHeader(bundleBytes)
    expect(header.bundleKind).toBe('extracted-partition')
    expect(header.transferSeal?.sealId).toBe(sealId)
    expect(header.transferSeal?.alg).toBe('aes-256-gcm-pre-shared')
  })

  it('rejects a non-owner caller', async () => {
    const company = await db.openVault('demo-co')
    await company.collection<Client>('clients').put('c-1', { id: 'c-1', name: 'A', operatorUserId: 'belle' })

    // Minimal guard check: extractPartition reads vault.role and throws
    // unless 'owner'. Override the getter on a derived view.
    const fakeNonOwner = Object.create(company) as typeof company
    Object.defineProperty(fakeNonOwner, 'role', { get: () => 'operator' })
    await expect(
      extractPartition(fakeNonOwner, { seeds: { clients: () => true } }),
    ).rejects.toThrow(/owner/)
  })
})

describe('extractPartition end-to-end', () => {
  it('round-trips: unseal DEKs with the transfer key, decrypt a re-keyed record', async () => {
    const db = await createNoydb({ store: memory(), user: 'alice', secret: 'test-passphrase-1234' })
    const company = await db.openVault('demo-co')
    const clients = company.collection<Client>('clients')
    await clients.put('c-1', { id: 'c-1', name: 'Hotel', operatorUserId: 'belle' })

    const { bundleBytes, transferKey } = await extractPartition(company, {
      seeds: { clients: () => true },
    })

    const { dumpJson } = await readNoydbBundle(bundleBytes)
    const { dump, seal } = parseExtractedPartitionBody(dumpJson)
    const backup = JSON.parse(dump) as {
      keyrings: Record<string, unknown>
      collections: Record<string, Record<string, EncryptedEnvelope>>
    }

    // Unowned: empty keyring.
    expect(Object.keys(backup.keyrings)).toEqual([])

    // Unseal the DEK set with the transfer key.
    const key = await crypto.subtle.importKey('raw', transferKey.slice(), 'AES-GCM', false, ['decrypt'])
    const rawBytes = base64ToBuffer(seal.payload)
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: rawBytes.slice(0, 12) }, key, rawBytes.slice(12))
    const dekMap = JSON.parse(new TextDecoder().decode(pt)) as Record<string, string>

    // Import the clients DEK + decrypt the re-keyed record.
    const clientsDek = await crypto.subtle.importKey('raw', base64ToBuffer(dekMap['clients']!), 'AES-GCM', false, ['decrypt'])
    const env = backup.collections['clients']!['c-1']!
    const recordJson = await decrypt(env._iv, env._data, clientsDek)
    expect(JSON.parse(recordJson)).toMatchObject({ id: 'c-1', name: 'Hotel' })
  })
})
