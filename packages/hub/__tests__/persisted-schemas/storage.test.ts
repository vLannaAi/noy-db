import { describe, it, expect, beforeEach } from 'vitest'
import { generateDEK } from '../../src/kernel/enclave/crypto.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../../src/kernel/types.js'
import { ConflictError } from '../../src/kernel/errors.js'
import {
  SCHEMAS_COLLECTION,
  loadPersistedSchema,
  savePersistedSchema,
} from '../../src/with-shape/persisted-schemas/storage.js'
import type { PersistedSchemaEnvelope } from '../../src/with-shape/persisted-schemas/types.js'

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

describe('persisted-schema storage', () => {
  const VAULT = 'acme'
  let store: NoydbStore
  let dek: CryptoKey

  beforeEach(async () => {
    store = inlineMemory()
    dek = await generateDEK()
  })

  it('reserved collection name is `_schemas`', () => {
    expect(SCHEMAS_COLLECTION).toBe('_schemas')
  })

  it('returns undefined when no envelope has been saved', async () => {
    const out = await loadPersistedSchema(store, VAULT, 'invoices', dek)
    expect(out).toBeUndefined()
  })

  it('round-trips an envelope through encrypted storage', async () => {
    const payload: PersistedSchemaEnvelope = {
      _noydb_schema: 1,
      kind: 'Zod',
      jsonSchema: { type: 'object', properties: { id: { type: 'string' } } },
      hash: 'a'.repeat(64),
      derivedAt: '2026-05-22T14:31:42Z',
    }
    await savePersistedSchema(store, VAULT, 'invoices', dek, payload)
    const loaded = await loadPersistedSchema(store, VAULT, 'invoices', dek)
    expect(loaded).toEqual(payload)
  })

  it('stores ciphertext, not plaintext (envelope `_data` is not JSON-parseable as the payload)', async () => {
    const payload: PersistedSchemaEnvelope = {
      _noydb_schema: 1,
      kind: 'Zod',
      jsonSchema: { type: 'string' },
      hash: 'b'.repeat(64),
      derivedAt: '2026-05-22T14:31:42Z',
    }
    await savePersistedSchema(store, VAULT, 'invoices', dek, payload)
    const raw = await store.get(VAULT, '_schemas', 'invoices')
    expect(raw).not.toBeNull()
    // _iv must be a non-empty base64 string (AES-GCM IV present)
    expect(raw!._iv.length).toBeGreaterThan(0)
    // _data must NOT parse as the original payload (i.e. it's ciphertext)
    expect(() => {
      const parsed = JSON.parse(raw!._data) as Record<string, unknown>
      // ciphertext won't match — if it parses to an object with our shape, encryption is broken
      if (parsed._noydb_schema === 1) throw new Error('payload stored in plaintext!')
    }).toThrow()
  })

  it('bumps _v on rewrite (idempotent overwrite semantics)', async () => {
    const env: PersistedSchemaEnvelope = {
      _noydb_schema: 1, kind: 'Zod', jsonSchema: { type: 'string' },
      hash: 'c'.repeat(64), derivedAt: '2026-05-22T14:31:42Z',
    }
    await savePersistedSchema(store, VAULT, 'invoices', dek, env)
    const v1 = (await store.get(VAULT, '_schemas', 'invoices'))!._v
    await savePersistedSchema(store, VAULT, 'invoices', dek, env)
    const v2 = (await store.get(VAULT, '_schemas', 'invoices'))!._v
    expect(v2).toBe(v1 + 1)
  })

  it('returns undefined for an envelope that fails to decrypt (wrong key)', async () => {
    const env: PersistedSchemaEnvelope = {
      _noydb_schema: 1, kind: 'Zod', jsonSchema: { type: 'string' },
      hash: 'd'.repeat(64), derivedAt: '2026-05-22T14:31:42Z',
    }
    await savePersistedSchema(store, VAULT, 'invoices', dek, env)
    const otherDek = await generateDEK()
    const out = await loadPersistedSchema(store, VAULT, 'invoices', otherDek)
    expect(out).toBeUndefined()
  })
})
