/**
 * decryptExtractedPartition — read-side decrypt of an extracted-partition
 * bundle. Validates that all records are decrypted to plaintext (per
 * collection) with envelope ts/version, without adopting into a vault.
 * Also validates that a wrong transfer key throws.
 *
 * Includes a per-record-CEK round-trip test that exercises the
 * `if (env._cek !== undefined)` branch in decrypt-partition.ts (slice 5
 * of the CEK feature). Without this test that branch is reachable only
 * by logic inspection.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { createNoydb } from '../src/kernel/noydb.js'
import { withCargo } from '../src/index.js'
import type { Noydb } from '../src/kernel/noydb.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { ConflictError } from '../src/kernel/errors.js'
import { extractPartition } from '../src/with-cargo/extract-partition.js'
import { decryptExtractedPartition } from '../src/with-cargo/decrypt-partition.js'

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

interface Bill { id: string; amount: number; clientId: string }
interface Client { id: string; name: string; operatorUserId: string }
interface Doc { id: string; name: string }

describe('decryptExtractedPartition', () => {
  let db: Noydb
  let bundleBytes: Uint8Array
  let transferKey: Uint8Array

  beforeEach(async () => {
    db = await createNoydb({ cargoStrategy: withCargo(), store: memory(), user: 'alice', secret: 'test-passphrase-1234' })
    const company = await db.openVault('demo-co')

    const clients = company.collection<Client>('clients')
    const bills = company.collection<Bill>('bills')

    await clients.put('c1', { id: 'c1', name: 'Acme', operatorUserId: 'bob' })
    await clients.put('c2', { id: 'c2', name: 'Beta Corp', operatorUserId: 'carol' })
    await bills.put('b1', { id: 'b1', amount: 100, clientId: 'c1' })
    await bills.put('b2', { id: 'b2', amount: 200, clientId: 'c2' })

    const result = await extractPartition(company, {
      seeds: { clients: () => true, bills: () => true },
    })
    bundleBytes = result.bundleBytes
    transferKey = result.transferKey
  })

  it('decrypts all records per collection with correct plaintext', async () => {
    const out = await decryptExtractedPartition(bundleBytes, transferKey)

    expect(Object.keys(out).sort()).toEqual(['bills', 'clients'])

    const billRecs = out['bills']!
    const b1 = billRecs.find((r) => r.id === 'b1')!
    expect(b1).toBeDefined()
    expect(b1.record).toMatchObject({ id: 'b1', amount: 100, clientId: 'c1' })
    expect(typeof b1.ts).toBe('string')
    expect(b1.ts.length).toBeGreaterThan(0)
    expect(typeof b1.version).toBe('number')

    const b2 = billRecs.find((r) => r.id === 'b2')!
    expect(b2).toBeDefined()
    expect(b2.record).toMatchObject({ id: 'b2', amount: 200, clientId: 'c2' })

    const clientRecs = out['clients']!
    const c1 = clientRecs.find((r) => r.id === 'c1')!
    expect(c1).toBeDefined()
    expect(c1.record).toMatchObject({ id: 'c1', name: 'Acme', operatorUserId: 'bob' })

    const c2 = clientRecs.find((r) => r.id === 'c2')!
    expect(c2).toBeDefined()
    expect(c2.record).toMatchObject({ id: 'c2', name: 'Beta Corp', operatorUserId: 'carol' })
  })

  it('throws on a wrong transfer key', async () => {
    await expect(
      decryptExtractedPartition(bundleBytes, new Uint8Array(32)),
    ).rejects.toThrow()
  })

  it('throws on a non-extracted-partition bundle', async () => {
    // A zero-length Uint8Array has no valid magic — should throw
    await expect(
      decryptExtractedPartition(new Uint8Array(16), transferKey),
    ).rejects.toThrow()
  })
})

describe('decryptExtractedPartition — per-record CEK branch', () => {
  /**
   * Exercises the `if (env._cek !== undefined)` branch in
   * decrypt-partition.ts.  A collection with `perRecordKeys: true` stores
   * a per-record CEK wrapped under the collection DEK; after
   * extractPartition re-keys the closure, each record's envelope still
   * carries `_cek` (re-wrapped under the new transfer-DEK).
   * decryptExtractedPartition must unwrap that CEK before decrypting the
   * body — this test proves the full round-trip.
   */
  it('decrypts a per-record-CEK record alongside a normal record', async () => {
    const db = await createNoydb({ cargoStrategy: withCargo(), store: memory(), user: 'alice', secret: 'test-passphrase-1234' })
    const company = await db.openVault('demo-co')

    // CEK collection: each record stores a wrapped _cek in its envelope.
    const cekColl = company.collection<Doc>('docs', { perRecordKeys: true })
    await cekColl.put('d-1', { id: 'd-1', name: 'Secret' })
    await cekColl.put('d-2', { id: 'd-2', name: 'TopSecret' })

    // Normal (legacy, no _cek) collection alongside.
    const plain = company.collection<Doc>('plain')
    await plain.put('p-1', { id: 'p-1', name: 'Ordinary' })

    const { bundleBytes, transferKey } = await extractPartition(company, {
      seeds: { docs: () => true, plain: () => true },
    })

    const out = await decryptExtractedPartition(bundleBytes, transferKey)

    // Both collections present.
    expect(Object.keys(out).sort()).toEqual(['docs', 'plain'])

    // CEK records: plaintext matches originals.
    const docs = out['docs']!
    const d1 = docs.find((r) => r.id === 'd-1')!
    expect(d1).toBeDefined()
    expect(d1.record).toMatchObject({ id: 'd-1', name: 'Secret' })
    expect(typeof d1.ts).toBe('string')
    expect(typeof d1.version).toBe('number')

    const d2 = docs.find((r) => r.id === 'd-2')!
    expect(d2).toBeDefined()
    expect(d2.record).toMatchObject({ id: 'd-2', name: 'TopSecret' })

    // Normal record: also correct.
    const plainRecs = out['plain']!
    const p1 = plainRecs.find((r) => r.id === 'p-1')!
    expect(p1).toBeDefined()
    expect(p1.record).toMatchObject({ id: 'p-1', name: 'Ordinary' })
  })
})

// ─── Task 3b: _source/_sourceTs surfaced on DecryptedRecord ────────────────

describe('decryptExtractedPartition — provenance source surfacing (FR-5 Task 3b)', () => {
  it('DecryptedRecord carries source/sourceTs when the source record was put with a source', async () => {
    const db = await createNoydb({ cargoStrategy: withCargo(), store: memory(), user: 'alice', secret: 'test-passphrase-1234' })
    const company = await db.openVault('demo-co')

    const clients = company.collection<Client>('clients', { provenance: true })
    await clients.put('c1', { id: 'c1', name: 'Acme', operatorUserId: 'bob' }, { source: 'crm-sync' })
    // Record without source — should have no source on DecryptedRecord
    await clients.put('c2', { id: 'c2', name: 'Beta', operatorUserId: 'carol' })

    const { bundleBytes, transferKey } = await extractPartition(company, {
      seeds: { clients: () => true },
    })

    const out = await decryptExtractedPartition(bundleBytes, transferKey)
    const recs = out['clients']!

    const c1 = recs.find((r) => r.id === 'c1')!
    expect(c1).toBeDefined()
    expect(c1.source).toBe('crm-sync')
    expect(typeof c1.sourceTs).toBe('string')
    expect(new Date(c1.sourceTs!).getTime()).toBeGreaterThan(0)

    const c2 = recs.find((r) => r.id === 'c2')!
    expect(c2).toBeDefined()
    expect(c2.source).toBeUndefined()
    expect(c2.sourceTs).toBeUndefined()
  })
})
