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
import { createNoydb } from '../src/kernel/noydb.js'
import { withCargo } from '../src/index.js'
import type { Noydb } from '../src/kernel/noydb.js'
import { ref } from '../src/kernel/refs.js'
import { ConflictError } from '../src/kernel/errors.js'
import { decrypt, base64ToBuffer, generateDEK } from '../src/kernel/enclave/index.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { reKeyClosure, sealDeks, extractPartition } from '../src/with-cargo/extract-partition.js'
import { adoptPartition, createOwnerOnAdoptedPartition } from '../src/with-cargo/adopt-partition.js'
import { readNoydbBundle, readNoydbBundleHeader, parseExtractedPartitionBody } from '../src/with-pod/bundle.js'
import { withTiers } from '../src/with-audit/tiers/index.js'
import { withBlobs } from '../src/via/blob/index.js'
import { BLOB_SLOTS_PREFIX, BLOB_INDEX_COLLECTION } from '../src/with-shape/blobs/blob-set.js'

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

describe('reKeyClosure', () => {
  let db: Noydb
  beforeEach(async () => {
    db = await createNoydb({ cargoStrategy: withCargo(), store: toMemory(), user: 'alice', secret: 'test-secret-1234' })
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
    db = await createNoydb({ cargoStrategy: withCargo(), store: toMemory(), user: 'alice', secret: 'test-secret-1234' })
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
    const db = await createNoydb({ cargoStrategy: withCargo(), store: toMemory(), user: 'alice', secret: 'test-secret-1234' })
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

/**
 * #748 — pinning regression: an elevated record is structurally excluded from
 * an extract-partition closure/bundle. `walkClosure` selects roots via
 * `Collection.list()` and expands inbound via the same tier-gated read
 * surface (collection.ts `ensureHydrated`/`#getRaw` skip `_tier > 0`
 * envelopes) — an elevated record can never become a seed nor an
 * inbound-expansion target, so it (and any blob it owns) never enters the
 * closure `reKeyClosure`/`reKeyBlobs` re-key. Absence, not a thrown error:
 * the extraction succeeds and simply never mentions the elevated record.
 */
describe('extractPartition — #748: elevated records are structurally excluded', () => {
  interface Client { id: string; name: string }
  interface Invoice { id: string; clientId: string }

  it('an elevated blob-bearing parent (and its blob) is silently absent from the closure and bundle', async () => {
    const store = toMemory()
    const db = await createNoydb({
      cargoStrategy: withCargo(),
      store,
      user: 'alice',
      secret: 'test-secret-1234',
      tiersStrategy: withTiers(),
      blobsStrategy: withBlobs(),
    })
    const company = await db.openVault('demo-co')
    const clients = company.collection<Client>('clients', {
      tiers: [0, 1], perRecordKeys: true, blobFields: { attachment: {} },
    })
    const invoices = company.collection<Invoice>('invoices', { refs: { clientId: ref('clients') } })

    // c-1 would otherwise match the seed predicate below and travel with its
    // blob + FK-connected invoice — elevate it BEFORE extraction so it never
    // qualifies as a root.
    await clients.putAtTier('c-1', { id: 'c-1', name: 'Redacted Co' }, 0)
    await clients.blob('c-1').put('attachment', new TextEncoder().encode('ELEVATED SECRET BYTES'))
    await invoices.put('inv-1', { id: 'inv-1', clientId: 'c-1' })
    await clients.elevate('c-1', 1)

    // Sibling stays tier-0 — proves the exclusion is targeted, not global.
    await clients.putAtTier('c-2', { id: 'c-2', name: 'Visible Co' }, 0)
    await clients.blob('c-2').put('attachment', new TextEncoder().encode('VISIBLE SIBLING BYTES'))
    await invoices.put('inv-2', { id: 'inv-2', clientId: 'c-2' })

    // Matches every (visible) client — c-1 never reaches the predicate
    // because `Collection.list()` already filters it out.
    const { bundleBytes, transferKey } = await extractPartition(company, {
      seeds: { clients: () => true },
    })

    const { dumpJson } = await readNoydbBundle(bundleBytes)
    const { dump } = parseExtractedPartitionBody(dumpJson)
    const backup = JSON.parse(dump) as {
      collections: Record<string, Record<string, EncryptedEnvelope>>
      _internal?: Record<string, Record<string, EncryptedEnvelope>>
    }

    // The elevated record + its FK-connected invoice never entered the
    // closure at all — silently absent, not a tombstone/error placeholder.
    expect(Object.keys(backup.collections['clients'] ?? {})).toEqual(['c-2'])
    expect(Object.keys(backup.collections['invoices'] ?? {})).toEqual(['inv-2'])

    // Its blob artifacts never entered `_internal` either — only c-2's slot
    // map + a single carried blob (c-1's is absent, not just unreadable).
    const slots = backup._internal?.[`${BLOB_SLOTS_PREFIX}clients`] ?? {}
    expect(Object.keys(slots)).toEqual(['c-2'])
    expect(Object.keys(backup._internal?.[BLOB_INDEX_COLLECTION] ?? {})).toHaveLength(1)

    // End-to-end: the recipient never even learns c-1 existed, and c-2's
    // blob round-trips untouched.
    const dest = toMemory()
    await adoptPartition(bundleBytes, { transferKey, destinationStore: dest, vaultName: 'fresh' })
    await createOwnerOnAdoptedPartition(dest, 'fresh', {
      userId: 'belle', secret: 'belle-pass-phrase-2026', transferKey,
    })
    const recipientDb = await createNoydb({
      cargoStrategy: withCargo(), store: dest, user: 'belle', secret: 'belle-pass-phrase-2026',
      tiersStrategy: withTiers(), blobsStrategy: withBlobs(),
    })
    const recipientVault = await recipientDb.openVault('fresh')
    const recipientClients = recipientVault.collection<Client>('clients', {
      tiers: [0, 1], perRecordKeys: true, blobFields: { attachment: {} },
    })
    expect(await recipientClients.get('c-1')).toBeNull()
    expect(await recipientClients.get('c-2')).toMatchObject({ name: 'Visible Co' })
    const c2Blob = await recipientClients.blob('c-2').get('attachment')
    expect(c2Blob).not.toBeNull()
    expect(new TextDecoder().decode(c2Blob!)).toBe('VISIBLE SIBLING BYTES')

    recipientDb.close()
    db.close()
  })
})

/**
 * #759 — outbound completion must re-check a referenced parent's tier
 * visibility before admitting it into the closure, the same way root
 * selection / inbound expansion already do. Pre-fix, an elevated parent
 * referenced by a selected tier-0 child's FK entered the closure and
 * `reKeyClosure`'s #748 canary threw `PartitionExtractionError` on it.
 * Post-fix: the parent is silently excluded (matches root/inbound
 * semantics) and the resulting dangling FK is surfaced as a residue notice
 * on `ExtractPartitionResult.danglingRefs`.
 */
describe('extractPartition — #759: elevated FK parent is excluded with a dangling-ref residue notice', () => {
  interface Invoice { id: string; clientId: string }

  it('does NOT crash on an elevated FK parent; excludes it and reports the dangling ref', async () => {
    const store = toMemory()
    const db = await createNoydb({
      cargoStrategy: withCargo(),
      store,
      user: 'alice',
      secret: 'test-secret-1234',
      tiersStrategy: withTiers(),
    })
    const company = await db.openVault('demo-co')
    const clients = company.collection<Client>('clients', { tiers: [0, 1] })
    const invoices = company.collection<Invoice>('invoices', { refs: { clientId: ref('clients') } })

    await clients.putAtTier('c-1', { id: 'c-1', name: 'Redacted Co', operatorUserId: 'belle' }, 0)
    await invoices.put('inv-1', { id: 'inv-1', clientId: 'c-1' })
    // Elevate the parent AFTER the invoice's FK is established, so the
    // outbound-completion phase is the one that has to notice.
    await clients.elevate('c-1', 1)

    const { bundleBytes, transferKey, danglingRefs } = await extractPartition(company, {
      seeds: { invoices: () => true },
    })

    expect(danglingRefs).toEqual([
      { collection: 'invoices', id: 'inv-1', field: 'clientId', target: 'clients', targetId: 'c-1', reason: 'elevated' },
    ])

    const { dumpJson } = await readNoydbBundle(bundleBytes)
    const { dump } = parseExtractedPartitionBody(dumpJson)
    const backup = JSON.parse(dump) as { collections: Record<string, Record<string, EncryptedEnvelope>> }

    // The elevated parent never entered the partition...
    expect(backup.collections['clients']).toBeUndefined()
    // ...but the tier-0 child DID, keeping its (now dangling) FK value.
    expect(Object.keys(backup.collections['invoices'] ?? {})).toEqual(['inv-1'])

    // Round-trips cleanly: adoption doesn't choke on the dangling FK either.
    const dest = toMemory()
    await adoptPartition(bundleBytes, { transferKey, destinationStore: dest, vaultName: 'fresh' })
    await createOwnerOnAdoptedPartition(dest, 'fresh', {
      userId: 'belle', secret: 'belle-pass-phrase-2026', transferKey,
    })
    const recipientDb = await createNoydb({
      cargoStrategy: withCargo(), store: dest, user: 'belle', secret: 'belle-pass-phrase-2026',
      tiersStrategy: withTiers(),
    })
    const recipientVault = await recipientDb.openVault('fresh')
    expect(await recipientVault.collection<Client>('clients', { tiers: [0, 1] }).get('c-1')).toBeNull()
    expect(await recipientVault.collection<Invoice>('invoices', { refs: { clientId: ref('clients') } }).get('inv-1'))
      .toMatchObject({ id: 'inv-1', clientId: 'c-1' })

    recipientDb.close()
    db.close()
  })
})
