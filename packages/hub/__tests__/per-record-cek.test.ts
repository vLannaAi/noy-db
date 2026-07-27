/**
 * Per-record content-encryption keys (CEK) — foundation (step 1).
 *
 * Spec: docs/superpowers/specs/2026-06-13-per-record-cek-foundation-design.md
 *
 * Covers the 5 build slices:
 *  1. Envelope `_cek` + wrap/unwrap on read/write + stable-CEK cache +
 *     `perRecordKeys` flag + legacy dual-read + tombstone-tolerant read.
 *  2. History under the record's stable CEK.
 *  3. Migration (`_applyCutoverTransform`) legacy→CEK re-encrypt pass.
 *  4. Tier elevate/demote CEK re-wrap.
 *  5. Bundle `reKeyClosure` CEK re-wrap (extract → adopt round-trip).
 */

import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/kernel/noydb.js'
import { withCargo } from '../src/index.js'
import { withTiers } from '../src/with-audit/tiers/index.js'
import { ConflictError } from '../src/kernel/errors.js'
import { NOYDB_FORMAT_VERSION } from '../src/kernel/types.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { withHistory } from '../src/with-commit/history/index.js'
import { extractPartition } from '../src/with-cargo/extract-partition.js'
import { adoptPartition, createOwnerOnAdoptedPartition } from '../src/with-cargo/adopt-partition.js'

/** In-memory store that also exposes the raw stored envelopes for assertions. */
function memory(): NoydbStore & { raw(c: string, col: string, id: string): EncryptedEnvelope | undefined } {
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
    raw(c, col, id) { return store.get(c)?.get(col)?.get(id) },
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

interface Doc { id: string; name: string; note?: string }

describe('per-record CEK — slice 1: round-trip + flag + cache', () => {
  it('round-trips a perRecordKeys record and stamps _cek on the envelope', async () => {
    const store = memory()
    const db = await createNoydb({ cargoStrategy: withCargo(), store, user: 'alice', secret: 'test-secret-1234' })
    const vault = await db.openVault('v')
    const cek = vault.collection<Doc>('cek', { perRecordKeys: true })

    await cek.put('d-1', { id: 'd-1', name: 'Alpha' })
    expect(await cek.get('d-1')).toMatchObject({ id: 'd-1', name: 'Alpha' })

    const env = store.raw('v', 'cek', 'd-1')!
    expect(env._cek).toBeDefined()
    expect(typeof env._cek).toBe('string')
    expect(env._data.length).toBeGreaterThan(0)
  })

  it('a CEK record body differs from a legacy record body for the same plaintext', async () => {
    const store = memory()
    const db = await createNoydb({ cargoStrategy: withCargo(), store, user: 'alice', secret: 'test-secret-1234' })
    const vault = await db.openVault('v')
    const legacy = vault.collection<Doc>('legacy')
    const cek = vault.collection<Doc>('cek', { perRecordKeys: true })

    await legacy.put('d-1', { id: 'd-1', name: 'Same' })
    await cek.put('d-1', { id: 'd-1', name: 'Same' })

    const legacyEnv = store.raw('v', 'legacy', 'd-1')!
    const cekEnv = store.raw('v', 'cek', 'd-1')!
    expect(legacyEnv._cek).toBeUndefined()
    expect(cekEnv._cek).toBeDefined()
    // Different keys + random IVs → different ciphertext.
    expect(cekEnv._data).not.toBe(legacyEnv._data)
  })
})

describe('per-record CEK — legacy dual-read', () => {
  it('a non-perRecordKeys collection is byte-identical to legacy (no _cek)', async () => {
    const store = memory()
    const db = await createNoydb({ cargoStrategy: withCargo(), store, user: 'alice', secret: 'test-secret-1234' })
    const vault = await db.openVault('v')
    const legacy = vault.collection<Doc>('legacy')

    await legacy.put('d-1', { id: 'd-1', name: 'Plain' })
    const env = store.raw('v', 'legacy', 'd-1')!
    expect(env._cek).toBeUndefined()
    expect(await legacy.get('d-1')).toMatchObject({ id: 'd-1', name: 'Plain' })
  })

  it('a mixed vault reads both legacy and CEK records', async () => {
    const store = memory()
    const db = await createNoydb({ cargoStrategy: withCargo(), store, user: 'alice', secret: 'test-secret-1234' })
    const vault = await db.openVault('v')
    const legacy = vault.collection<Doc>('legacy')
    const cek = vault.collection<Doc>('cek', { perRecordKeys: true })

    await legacy.put('l-1', { id: 'l-1', name: 'Legacy' })
    await cek.put('c-1', { id: 'c-1', name: 'Cek' })

    expect(await legacy.get('l-1')).toMatchObject({ name: 'Legacy' })
    expect(await cek.get('c-1')).toMatchObject({ name: 'Cek' })

    // Reopen the vault (fresh collection instances, cold CEK cache).
    const db2 = await createNoydb({ cargoStrategy: withCargo(), store, user: 'alice', secret: 'test-secret-1234' })
    const vault2 = await db2.openVault('v')
    expect(await vault2.collection<Doc>('legacy').get('l-1')).toMatchObject({ name: 'Legacy' })
    expect(await vault2.collection<Doc>('cek', { perRecordKeys: true }).get('c-1')).toMatchObject({ name: 'Cek' })
    // A collection that NEVER set the flag still reads CEK records — `_cek`
    // presence is the format discriminant, not the flag.
    expect(await vault2.collection<Doc>('cek').get('c-1')).toMatchObject({ name: 'Cek' })
  })
})

describe('per-record CEK — slice 1/2: update reuses CEK + history', () => {
  it('an update reuses the same CEK (identical wrapped _cek) and history decrypts', async () => {
    const store = memory()
    const db = await createNoydb({ cargoStrategy: withCargo(), store, user: 'alice', secret: 'test-secret-1234', historyStrategy: withHistory() })
    const vault = await db.openVault('v')
    const cek = vault.collection<Doc>('cek', { perRecordKeys: true })

    await cek.put('d-1', { id: 'd-1', name: 'v1' })
    const env1 = store.raw('v', 'cek', 'd-1')!
    const wrapped1 = env1._cek!

    await cek.put('d-1', { id: 'd-1', name: 'v2' })
    const env2 = store.raw('v', 'cek', 'd-1')!
    const wrapped2 = env2._cek!

    // AES-KW is deterministic over (key, kek), so the same CEK wrapped under
    // the same collection DEK produces the identical wrapped string — proof
    // the update reused the record's stable CEK rather than minting a fresh
    // one.
    expect(wrapped2).toBe(wrapped1)

    expect(await cek.get('d-1')).toMatchObject({ name: 'v2' })

    // History version 1 carries the same _cek and decrypts under it.
    const v1 = await cek.getVersion('d-1', 1)
    expect(v1).toMatchObject({ name: 'v1' })
  })

  it('all history versions of a CEK record decrypt under the shared CEK', async () => {
    const store = memory()
    const db = await createNoydb({ cargoStrategy: withCargo(), store, user: 'alice', secret: 'test-secret-1234', historyStrategy: withHistory() })
    const vault = await db.openVault('v')
    const cek = vault.collection<Doc>('cek', { perRecordKeys: true })

    await cek.put('d-1', { id: 'd-1', name: 'v1' })
    await cek.put('d-1', { id: 'd-1', name: 'v2' })
    await cek.put('d-1', { id: 'd-1', name: 'v3' })

    expect(await cek.getVersion('d-1', 1)).toMatchObject({ name: 'v1' })
    expect(await cek.getVersion('d-1', 2)).toMatchObject({ name: 'v2' })
    expect(await cek.get('d-1')).toMatchObject({ name: 'v3' })

    // Survives a cold reopen (history snapshot envelopes carry the CEK).
    const db2 = await createNoydb({ cargoStrategy: withCargo(), store, user: 'alice', secret: 'test-secret-1234', historyStrategy: withHistory() })
    const cek2 = (await db2.openVault('v')).collection<Doc>('cek', { perRecordKeys: true })
    expect(await cek2.getVersion('d-1', 1)).toMatchObject({ name: 'v1' })
    expect(await cek2.getVersion('d-1', 2)).toMatchObject({ name: 'v2' })
  })
})

describe('per-record CEK — slice 4: tiers', () => {
  it('elevate then demote a CEK record preserves decryptability at each tier', async () => {
    const store = memory()
    const db = await createNoydb({ cargoStrategy: withCargo(), store, user: 'alice', secret: 'test-secret-1234', tiersStrategy: withTiers() })
    const vault = await db.openVault('v')
    const cek = vault.collection<Doc>('cek', { perRecordKeys: true, tiers: [1] })

    await cek.put('d-1', { id: 'd-1', name: 'secret' })
    expect((store.raw('v', 'cek', 'd-1')!)._cek).toBeDefined()

    await cek.elevate('d-1', 1)
    const elevated = store.raw('v', 'cek', 'd-1')!
    expect(elevated._tier).toBe(1)
    expect(elevated._cek).toBeDefined()
    expect(await cek.getAtTier('d-1')).toMatchObject({ name: 'secret' })

    await cek.demote('d-1', 0)
    const demoted = store.raw('v', 'cek', 'd-1')!
    expect(demoted._tier).toBeUndefined()
    expect(demoted._cek).toBeDefined()
    expect(await cek.getAtTier('d-1')).toMatchObject({ name: 'secret' })
    expect(await cek.get('d-1')).toMatchObject({ name: 'secret' })
  })
})

describe('per-record CEK — slice 5: extract/adopt round-trip', () => {
  it('extractPartition → adopt → recipient decrypts every CEK record', async () => {
    const srcStore = memory()
    const db = await createNoydb({ cargoStrategy: withCargo(), store: srcStore, user: 'alice', secret: 'test-secret-1234' })
    const company = await db.openVault('demo-co')
    const cek = company.collection<Doc>('cek', { perRecordKeys: true })
    await cek.put('c-1', { id: 'c-1', name: 'Hotel' })
    await cek.put('c-2', { id: 'c-2', name: 'Cafe' })
    // Update one record so its history chain shares the CEK before extraction.
    await cek.put('c-1', { id: 'c-1', name: 'Hotel-Renamed' })

    const { bundleBytes, transferKey } = await extractPartition(company, { seeds: { cek: () => true } })

    const dest = memory()
    await adoptPartition(bundleBytes, { transferKey, destinationStore: dest, vaultName: 'acme' })
    await createOwnerOnAdoptedPartition(dest, 'acme', {
      userId: 'belle', secret: 'belle-hotel-dept-2026', transferKey,
    })

    const recipientDb = await createNoydb({ cargoStrategy: withCargo(), store: dest, user: 'belle', secret: 'belle-hotel-dept-2026' })
    const recipientVault = await recipientDb.openVault('acme')
    const recipientCek = recipientVault.collection<Doc>('cek')

    // The re-keyed envelope still carries a _cek (re-wrapped under the
    // destination DEK), and the recipient decrypts it.
    expect(dest.raw('acme', 'cek', 'c-1')!._cek).toBeDefined()
    expect(await recipientCek.get('c-1')).toMatchObject({ id: 'c-1', name: 'Hotel-Renamed' })
    expect(await recipientCek.get('c-2')).toMatchObject({ id: 'c-2', name: 'Cafe' })
  })
})

describe('per-record CEK — slice 1: tombstone tolerance', () => {
  it('get() on a body-less / CEK-less envelope returns null and does not throw', async () => {
    const store = memory()
    const db = await createNoydb({ cargoStrategy: withCargo(), store, user: 'alice', secret: 'test-secret-1234' })
    const vault = await db.openVault('v')
    const cek = vault.collection<Doc>('cek', { perRecordKeys: true, prefetch: false, cache: { maxRecords: 100 } })

    await cek.put('d-1', { id: 'd-1', name: 'present' })

    // Hand-construct a shred tombstone on a fresh id (lazy LRU never cached
    // it, so the read goes through the adapter + tombstone guard). `_v`/`_ts`
    // survive; no `_data`/`_cek`.
    await store.put('v', 'cek', 'tomb', {
      _noydb: NOYDB_FORMAT_VERSION,
      _v: 2,
      _ts: new Date().toISOString(),
      _iv: '',
      _data: '',
      _by: 'alice',
    } as EncryptedEnvelope)

    await expect(cek.get('tomb')).resolves.toBeNull()
    // The live record is unaffected.
    expect(await cek.get('d-1')).toMatchObject({ name: 'present' })
  })

  it('eager-mode hydration skips tombstones rather than throwing TamperedError', async () => {
    const store = memory()
    const db = await createNoydb({ cargoStrategy: withCargo(), store, user: 'alice', secret: 'test-secret-1234' })
    const vault = await db.openVault('v')
    const cek = vault.collection<Doc>('cek', { perRecordKeys: true })
    await cek.put('keep', { id: 'keep', name: 'keep' })

    // Tombstone a separate id, then reopen so eager hydration walks it.
    await store.put('v', 'cek', 'gone', {
      _noydb: NOYDB_FORMAT_VERSION, _v: 5, _ts: new Date().toISOString(), _iv: '', _data: '', _by: 'alice',
    } as EncryptedEnvelope)

    const db2 = await createNoydb({ cargoStrategy: withCargo(), store, user: 'alice', secret: 'test-secret-1234' })
    const cek2 = (await db2.openVault('v')).collection<Doc>('cek', { perRecordKeys: true })
    await expect(cek2.get('gone')).resolves.toBeNull()
    expect(await cek2.get('keep')).toMatchObject({ name: 'keep' })
  })
})
