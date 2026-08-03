/**
 * Schema-manifest storage + strict-CAS writer (#941 Task 2).
 *
 * Mirrors `persisted-schemas/storage.test.ts`'s inline-memory store pattern
 * (throws `ConflictError` on an `_v` mismatch) — the manifest storage layer
 * is the same shape, just for the pod-wide `_manifest/schema` record.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { generateDEK } from '../../src/kernel/enclave/index.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../../src/kernel/types.js'
import { ConflictError, ManifestConflictError } from '../../src/kernel/errors.js'
import {
  loadSchemaManifestEntry,
  saveSchemaManifest,
  computeAggregateHash,
} from '../../src/with-shape/manifest/storage.js'
import { writeSchemaManifest } from '../../src/with-shape/manifest/writer.js'
import { MANIFEST_SCHEMA_RECORD_ID } from '../../src/with-shape/manifest/types.js'
import type { SchemaManifest, SchemaManifestEntry } from '../../src/with-shape/manifest/types.js'
import { MANIFEST_COLLECTION } from '../../src/with-shape/manifest/reserved-collections.js'

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
    async saveAll() { /* not needed here */ },
  }
}

const VAULT = 'acme'

describe('schema-manifest storage + strict-CAS writer', () => {
  let store: NoydbStore
  let dek: CryptoKey
  let getDEK: (collection: string) => Promise<CryptoKey>

  beforeEach(async () => {
    store = inlineMemory()
    dek = await generateDEK()
    getDEK = async () => dek
  })

  it('returns undefined when no manifest has been saved', async () => {
    const out = await loadSchemaManifestEntry(store, VAULT, getDEK)
    expect(out).toBeUndefined()
  })

  it('round-trips a manifest through encrypted storage (byte-identical)', async () => {
    const collections: Record<string, SchemaManifestEntry> = {
      invoices: { generation: 1, contentHash: 'a'.repeat(64), fieldIds: { id: 'fid_1' } },
      customers: { generation: 1, contentHash: 'b'.repeat(64) },
    }
    const manifest: SchemaManifest = {
      v: 1,
      kind: 'schema',
      generation: 1,
      collections,
      aggregateHash: await computeAggregateHash(collections),
    }

    await saveSchemaManifest(store, VAULT, manifest, 0, getDEK)
    const loaded = await loadSchemaManifestEntry(store, VAULT, getDEK)

    expect(loaded).toBeDefined()
    expect(loaded!.version).toBe(1)
    expect(loaded!.manifest).toEqual(manifest)
  })

  it('stores ciphertext, not plaintext, at _manifest/schema', async () => {
    const collections: Record<string, SchemaManifestEntry> = {
      invoices: { generation: 1, contentHash: 'c'.repeat(64) },
    }
    const manifest: SchemaManifest = {
      v: 1, kind: 'schema', generation: 1, collections,
      aggregateHash: await computeAggregateHash(collections),
    }
    await saveSchemaManifest(store, VAULT, manifest, 0, getDEK)
    const raw = await store.get(VAULT, MANIFEST_COLLECTION, MANIFEST_SCHEMA_RECORD_ID)
    expect(raw).not.toBeNull()
    expect(raw!._iv.length).toBeGreaterThan(0)
    expect(() => {
      const parsed = JSON.parse(raw!._data) as Record<string, unknown>
      if (parsed.kind === 'schema') throw new Error('payload stored in plaintext!')
    }).toThrow()
  })

  it('aggregateHash is order-independent (canonicalJson sorts keys)', async () => {
    const a: Record<string, SchemaManifestEntry> = {
      invoices: { generation: 1, contentHash: 'a'.repeat(64) },
      customers: { generation: 2, contentHash: 'b'.repeat(64) },
    }
    // Same entries, different insertion order.
    const b: Record<string, SchemaManifestEntry> = {
      customers: { generation: 2, contentHash: 'b'.repeat(64) },
      invoices: { generation: 1, contentHash: 'a'.repeat(64) },
    }
    const hashA = await computeAggregateHash(a)
    const hashB = await computeAggregateHash(b)
    expect(hashA).toBe(hashB)
  })

  it('aggregateHash changes when a collection entry changes', async () => {
    const a: Record<string, SchemaManifestEntry> = {
      invoices: { generation: 1, contentHash: 'a'.repeat(64) },
    }
    const b: Record<string, SchemaManifestEntry> = {
      invoices: { generation: 2, contentHash: 'a'.repeat(64) },
    }
    expect(await computeAggregateHash(a)).not.toBe(await computeAggregateHash(b))
  })

  it('STRICT-CAS REFUSE: a stale expectedVersion throws ManifestConflictError, not a silent overwrite or a retry (#941 AC #1)', async () => {
    const collections: Record<string, SchemaManifestEntry> = {
      invoices: { generation: 1, contentHash: 'd'.repeat(64) },
    }
    const first: SchemaManifest = {
      v: 1, kind: 'schema', generation: 1, collections,
      aggregateHash: await computeAggregateHash(collections),
    }
    // v0 -> v1
    await writeSchemaManifest(store, VAULT, first, 0, getDEK)

    const secondCollections: Record<string, SchemaManifestEntry> = {
      invoices: { generation: 2, contentHash: 'e'.repeat(64) },
    }
    const second: SchemaManifest = {
      v: 1, kind: 'schema', generation: 2, collections: secondCollections,
      aggregateHash: await computeAggregateHash(secondCollections),
    }

    // Stale expectedVersion (0 again) — must be refused, not merged/retried.
    await expect(writeSchemaManifest(store, VAULT, second, 0, getDEK)).rejects.toThrow(ManifestConflictError)

    // The original write must still be intact — no silent overwrite happened.
    const loaded = await loadSchemaManifestEntry(store, VAULT, getDEK)
    expect(loaded!.manifest).toEqual(first)
    expect(loaded!.version).toBe(1)
  })

  it('a correct expectedVersion still succeeds after a prior write', async () => {
    const collections: Record<string, SchemaManifestEntry> = {
      invoices: { generation: 1, contentHash: 'f'.repeat(64) },
    }
    const first: SchemaManifest = {
      v: 1, kind: 'schema', generation: 1, collections,
      aggregateHash: await computeAggregateHash(collections),
    }
    await writeSchemaManifest(store, VAULT, first, 0, getDEK)

    const secondCollections: Record<string, SchemaManifestEntry> = {
      invoices: { generation: 2, contentHash: 'a1'.repeat(32) },
    }
    const second: SchemaManifest = {
      v: 1, kind: 'schema', generation: 2, collections: secondCollections,
      aggregateHash: await computeAggregateHash(secondCollections),
    }
    await writeSchemaManifest(store, VAULT, second, 1, getDEK)

    const loaded = await loadSchemaManifestEntry(store, VAULT, getDEK)
    expect(loaded!.manifest).toEqual(second)
    expect(loaded!.version).toBe(2)
  })
})
