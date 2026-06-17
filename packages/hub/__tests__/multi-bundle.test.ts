import { describe, it, expect, beforeEach } from 'vitest'
import {
  NOYDB_MULTI_BUNDLE_MAGIC,
  encodeMultiBundle,
  decodeMultiBundle,
  writeMultiVaultBundle,
  readNoydbBundleManifest,
  readMultiVaultBundleCompartment,
  type MultiBundleManifest,
} from '../src/bundle/multi-bundle.js'
import { writeNoydbBundle, readNoydbBundle } from '../src/bundle/bundle.js'
import { readNoydbBundleHeader } from '../src/bundle/bundle.js'
import { createNoydb } from '../src/noydb.js'
import type { Noydb } from '../src/noydb.js'
import type {
  NoydbStore,
  EncryptedEnvelope,
  VaultSnapshot,
  ListPageResult,
} from '../src/types.js'
import { ConflictError } from '../src/index.js'
import type { Vault } from '../src/vault.js'

/** Inline memory adapter — mirrors bundle.test.ts. */
function memory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function getCollection(c: string, col: string): Map<string, EncryptedEnvelope> {
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
    async listPage(c, col, cursor, limit = 100): Promise<ListPageResult> {
      const coll = store.get(c)?.get(col)
      if (!coll) return { items: [], nextCursor: null }
      const ids = [...coll.keys()].sort()
      const start = cursor ? parseInt(cursor, 10) : 0
      const end = Math.min(start + limit, ids.length)
      const items: ListPageResult['items'] = []
      for (let i = start; i < end; i++) {
        const id = ids[i]!
        const envelope = coll.get(id)
        if (envelope) items.push({ id, envelope })
      }
      return { items, nextCursor: end < ids.length ? String(end) : null }
    },
  }
}

describe('multi-bundle framing codec', () => {
  it('round-trips a manifest + inner byte blobs', () => {
    const inner0 = new Uint8Array([1, 2, 3, 4, 5])
    const inner1 = new Uint8Array([9, 8, 7])
    const manifest: MultiBundleManifest = {
      multiFormatVersion: 1,
      handle: '01HZZZZZZZZZZZZZZZZZZZZZZZ',
      compartments: [
        { handle: '01HAAAAAAAAAAAAAAAAAAAAAAA', exportedAt: '2026-06-17T00:00:00.000Z', innerBytes: 5, innerSha256: 'a'.repeat(64), roleTag: 'shard' },
        { handle: '01HBBBBBBBBBBBBBBBBBBBBBBB', exportedAt: '2026-06-17T00:00:00.000Z', innerBytes: 3, innerSha256: 'b'.repeat(64) },
      ],
    }
    const bytes = encodeMultiBundle(manifest, [inner0, inner1])
    expect(bytes.subarray(0, 4)).toEqual(NOYDB_MULTI_BUNDLE_MAGIC)
    const decoded = decodeMultiBundle(bytes)
    expect(decoded.manifest).toEqual(manifest)
    expect(decoded.inner[0]).toEqual(inner0)
    expect(decoded.inner[1]).toEqual(inner1)
  })

  it('rejects bytes without the NDBM magic', () => {
    expect(() => decodeMultiBundle(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]))).toThrow(/magic/i)
  })

  it('rejects a manifest whose innerBytes sum exceeds the body', () => {
    // Build a valid buffer (innerBytes matches actual length), then truncate
    // one byte so decode sees the declared innerBytes overrunning the buffer.
    const inner0 = new Uint8Array([1, 2, 3])
    const m: MultiBundleManifest = {
      multiFormatVersion: 1, handle: '01HZZZZZZZZZZZZZZZZZZZZZZZ',
      compartments: [{ handle: '01HAAAAAAAAAAAAAAAAAAAAAAA', exportedAt: '2026-06-17T00:00:00.000Z', innerBytes: 3, innerSha256: 'a'.repeat(64) }],
    }
    const good = encodeMultiBundle(m, [inner0])
    // Truncate the last byte — decode now sees innerBytes=3 but only 2 bytes available.
    expect(() => decodeMultiBundle(good.subarray(0, good.length - 1))).toThrow(/truncat|overrun|length/i)
  })

  it('encodeMultiBundle rejects an innerBytes / actual-length mismatch', () => {
    const m: MultiBundleManifest = {
      multiFormatVersion: 1, handle: '01HZZZZZZZZZZZZZZZZZZZZZZZ',
      compartments: [{ handle: '01HAAAAAAAAAAAAAAAAAAAAAAA', exportedAt: '2026-06-17T00:00:00.000Z', innerBytes: 99, innerSha256: 'a'.repeat(64) }],
    }
    expect(() => encodeMultiBundle(m, [new Uint8Array([1, 2, 3])])).toThrow(/innerBytes|declares/i)
  })

  it('decodeMultiBundle rejects trailing bytes after the last compartment', () => {
    const inner0 = new Uint8Array([1, 2, 3])
    const m: MultiBundleManifest = {
      multiFormatVersion: 1, handle: '01HZZZZZZZZZZZZZZZZZZZZZZZ',
      compartments: [{ handle: '01HAAAAAAAAAAAAAAAAAAAAAAA', exportedAt: '2026-06-17T00:00:00.000Z', innerBytes: 3, innerSha256: 'a'.repeat(64) }],
    }
    const good = encodeMultiBundle(m, [inner0])
    const withTrailer = new Uint8Array(good.length + 2)
    withTrailer.set(good, 0)
    expect(() => decodeMultiBundle(withTrailer)).toThrow(/trailing/i)
  })

  it('rejects duplicate compartment handles', () => {
    const dup = '01HAAAAAAAAAAAAAAAAAAAAAAA'
    const m: MultiBundleManifest = {
      multiFormatVersion: 1, handle: '01HZZZZZZZZZZZZZZZZZZZZZZZ',
      compartments: [
        { handle: dup, exportedAt: '2026-06-17T00:00:00.000Z', innerBytes: 1, innerSha256: 'a'.repeat(64) },
        { handle: dup, exportedAt: '2026-06-17T00:00:00.000Z', innerBytes: 1, innerSha256: 'b'.repeat(64) },
      ],
    }
    expect(() => encodeMultiBundle(m, [new Uint8Array([1]), new Uint8Array([2])])).toThrow(/duplicate/i)
  })
})

// ---------------------------------------------------------------------------
// Writer + reader integration (real vaults)
// ---------------------------------------------------------------------------

describe('multi-bundle > writer: writeMultiVaultBundle', () => {
  let db: Noydb
  let a: Vault
  let b: Vault

  beforeEach(async () => {
    db = await createNoydb({
      store: memory(),
      user: 'owner',
      secret: 'multi-bundle-test-passphrase-2026',
    })
    a = await db.openVault('VAULT-A')
    const invoicesA = a.collection<{ id: string; amount: number }>('invoices')
    await invoicesA.put('inv-1', { id: 'inv-1', amount: 100 })
    await invoicesA.put('inv-2', { id: 'inv-2', amount: 200 })

    b = await db.openVault('VAULT-B')
    const invoicesB = b.collection<{ id: string; status: string }>('payments')
    await invoicesB.put('pay-1', { id: 'pay-1', status: 'pending' })
    await invoicesB.put('pay-2', { id: 'pay-2', status: 'settled' })
  })

  it('two compartments: one disclosed, one undisclosed', async () => {
    const bytes = await writeMultiVaultBundle([
      { vault: a, roleTag: 'shard', exportedAt: '2026-06-17T00:00:00.000Z', disclose: { name: true, collections: true } },
      { vault: b, roleTag: 'pool' },
    ])
    const manifest = await readNoydbBundleManifest(bytes)
    expect(manifest).toHaveLength(2)

    // compartment [0]: roleTag and opt-in disclosures present
    expect(manifest[0]!.roleTag).toBe('shard')
    expect(manifest[0]!.name).toBe(a.name)                          // disclosed
    expect(manifest[0]!.collections?.length).toBeGreaterThan(0)     // disclosed
    expect(manifest[0]!.innerSha256).toMatch(/^[0-9a-f]{64}$/)

    // compartment [1]: roleTag present but opt-in fields absent
    expect(manifest[1]!.roleTag).toBe('pool')
    expect(manifest[1]!.name).toBeUndefined()                       // not disclosed
    expect(manifest[1]!.collections).toBeUndefined()                // not disclosed
    expect(manifest[1]!.innerSha256).toMatch(/^[0-9a-f]{64}$/)
  })
})

// ---------------------------------------------------------------------------
// Reader tests
// ---------------------------------------------------------------------------

describe('multi-bundle > readers', () => {
  let db: Noydb
  let a: Vault
  let b: Vault

  beforeEach(async () => {
    db = await createNoydb({
      store: memory(),
      user: 'owner',
      secret: 'multi-bundle-test-passphrase-2026',
    })
    a = await db.openVault('VAULT-A')
    const invoicesA = a.collection<{ id: string; amount: number }>('invoices')
    await invoicesA.put('inv-1', { id: 'inv-1', amount: 100 })
    await invoicesA.put('inv-2', { id: 'inv-2', amount: 200 })

    b = await db.openVault('VAULT-B')
    const invoicesB = b.collection<{ id: string; status: string }>('payments')
    await invoicesB.put('pay-1', { id: 'pay-1', status: 'pending' })
    await invoicesB.put('pay-2', { id: 'pay-2', status: 'settled' })
  })

  it('each compartment loads independently via readNoydbBundle', async () => {
    const bytes = await writeMultiVaultBundle([{ vault: a }, { vault: b }])
    const manifest = await readNoydbBundleManifest(bytes)
    for (const c of manifest) {
      const innerBytes = readMultiVaultBundleCompartment(bytes, c.handle)
      const { sha256Hex } = await import('../src/crypto.js')
      const verifySha = await sha256Hex(innerBytes)
      expect(verifySha).toBe(c.innerSha256)
      const read = await readNoydbBundle(innerBytes)   // loads independently
      expect(read.dumpJson.length).toBeGreaterThan(0)
    }
  })

  it('reads a single v1 bundle as a 1-entry manifest (back-compat)', async () => {
    const v1 = await writeNoydbBundle(a)
    const manifest = await readNoydbBundleManifest(v1)
    expect(manifest).toHaveLength(1)
    expect(manifest[0]!.handle).toBe(readNoydbBundleHeader(v1).handle)
    // the whole v1 bundle IS the only compartment:
    expect(readMultiVaultBundleCompartment(v1, manifest[0]!.handle)).toEqual(v1)
  })
})

// ---------------------------------------------------------------------------
// Backward-compat + default disclosure assertions
// ---------------------------------------------------------------------------

describe('multi-bundle > back-compat + default disclosure', () => {
  let db: Noydb
  let a: Vault

  beforeEach(async () => {
    db = await createNoydb({
      store: memory(),
      user: 'owner',
      secret: 'multi-bundle-test-passphrase-2026',
    })
    a = await db.openVault('VAULT-A')
    const invoicesA = a.collection<{ id: string; amount: number }>('invoices')
    await invoicesA.put('inv-1', { id: 'inv-1', amount: 100 })
    await invoicesA.put('inv-2', { id: 'inv-2', amount: 200 })
  })

  it('single-vault writeNoydbBundle is byte-unaffected by this feature', async () => {
    // Two writes of the same vault content produce stable handles (existing v1 guarantee).
    const x = await writeNoydbBundle(a)
    expect(readNoydbBundleHeader(x).formatVersion).toBe(1) // still v1; NDB1, not NDBM
    expect(x.subarray(0, 4)).not.toEqual(NOYDB_MULTI_BUNDLE_MAGIC)
  })

  it('default manifest discloses only handle/roleTag/exportedAt (+ integrity), not name/collections', async () => {
    const bytes = await writeMultiVaultBundle([{ vault: a, roleTag: 'shard' }])
    const [c] = await readNoydbBundleManifest(bytes)
    expect(c!.handle).toBeDefined()
    expect(c!.exportedAt).toBeDefined()
    expect(c!.roleTag).toBe('shard')
    expect(c!.name).toBeUndefined()
    expect(c!.collections).toBeUndefined()
    expect(c!.publicEnvelope).toBeUndefined()
  })
})
