import { describe, it, expect, beforeEach } from 'vitest'
import {
  loadUserEnvelope,
  saveUserEnvelope,
  deleteUserEnvelope,
  listUserEnvelopeIds,
  USER_ENVELOPE_COLLECTION,
  USER_ENVELOPE_MAX_BYTES,
  UserEnvelopeOversizedError,
} from '../src/meta/user-envelope/index.js'
import { generateDEK } from '../src/kernel/enclave/crypto.js'
import { ConflictError } from '../src/kernel/errors.js'
import type { NoydbStore, EncryptedEnvelope } from '../src/kernel/types.js'

function inlineMemory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function gc(c: string, col: string) {
    let comp = store.get(c)
    if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col)
    if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
    name: 'inline-memory',
    async get(c: string, col: string, id: string) { return gc(c, col).get(id) },
    async put(c: string, col: string, id: string, env: EncryptedEnvelope) { gc(c, col).set(id, env) },
    async delete(c: string, col: string, id: string) { gc(c, col).delete(id) },
    async list(c: string, col: string) { return [...gc(c, col).keys()] },
    async loadAll() { return {} },
    async saveAll() {},
    capabilities: { casAtomic: true, auth: { kind: 'none' } },
  } as unknown as NoydbStore
}

function memory(): NoydbStore {
  return inlineMemory()
}

interface SampleProfile {
  profile: { displayName: string; locale?: string }
  preferences: { theme: 'light' | 'dark' }
}

describe('user-envelope storage primitive', () => {
  let store: NoydbStore
  let dek: CryptoKey

  beforeEach(async () => {
    store = memory()
    dek = await generateDEK()
  })

  it('returns null when no envelope has been persisted', async () => {
    const got = await loadUserEnvelope<SampleProfile>(store, 'demo', 'alice', dek)
    expect(got).toBeNull()
  })

  it('round-trips a payload through encrypt → store → decrypt', async () => {
    const payload: SampleProfile = {
      profile: { displayName: 'Alice', locale: 'en-US' },
      preferences: { theme: 'dark' },
    }
    const written = await saveUserEnvelope(store, 'demo', 'alice', payload, dek)
    expect(written.keyringId).toBe('alice')
    expect(written.data).toEqual(payload)
    expect(written._v).toBe(1)
    expect(written._ts).toMatch(/^\d{4}-\d{2}-\d{2}T/)

    const read = await loadUserEnvelope<SampleProfile>(store, 'demo', 'alice', dek)
    expect(read).not.toBeNull()
    expect(read!.data).toEqual(payload)
    expect(read!._v).toBe(1)
  })

  it('encrypts the payload — store sees ciphertext, not plaintext', async () => {
    const payload: SampleProfile = {
      profile: { displayName: 'TopSecret' },
      preferences: { theme: 'light' },
    }
    await saveUserEnvelope(store, 'demo', 'alice', payload, dek)
    const raw = await store.get('demo', USER_ENVELOPE_COLLECTION, 'alice')
    expect(raw).toBeDefined()
    expect(raw!._iv).not.toBe('')
    // The plaintext displayName must not appear in the ciphertext blob.
    expect(raw!._data).not.toContain('TopSecret')
  })

  it('increments _v on each write', async () => {
    const a = await saveUserEnvelope(store, 'demo', 'alice', { n: 1 }, dek)
    const b = await saveUserEnvelope(store, 'demo', 'alice', { n: 2 }, dek)
    const c = await saveUserEnvelope(store, 'demo', 'alice', { n: 3 }, dek)
    expect(a._v).toBe(1)
    expect(b._v).toBe(2)
    expect(c._v).toBe(3)
  })

  it('throws ConflictError on stale expectedVersion', async () => {
    await saveUserEnvelope(store, 'demo', 'alice', { n: 1 }, dek)
    await saveUserEnvelope(store, 'demo', 'alice', { n: 2 }, dek)
    // Caller thinks they're at v1 but the store has v2.
    await expect(
      saveUserEnvelope(store, 'demo', 'alice', { n: 3 }, dek, /* expectedVersion */ 1),
    ).rejects.toThrow(ConflictError)
  })

  it('expectedVersion: 0 succeeds on first write, fails after', async () => {
    await saveUserEnvelope(store, 'demo', 'alice', { n: 1 }, dek, 0)
    await expect(
      saveUserEnvelope(store, 'demo', 'alice', { n: 2 }, dek, 0),
    ).rejects.toThrow(ConflictError)
  })

  it('rejects payloads exceeding the soft size cap', async () => {
    // Build a payload whose JSON serialization exceeds 64 KiB. A string of
    // length > 64K is enough on its own (each ASCII char = 1 byte in JSON).
    const huge = 'x'.repeat(USER_ENVELOPE_MAX_BYTES + 100)
    await expect(
      saveUserEnvelope(store, 'demo', 'alice', { huge }, dek),
    ).rejects.toThrow(UserEnvelopeOversizedError)
  })

  it('counts UTF-8 bytes correctly for multi-byte characters', async () => {
    // A 3-byte UTF-8 character (e.g. Thai consonant) repeated such that
    // .length is below the cap but byte-length is above. Without TextEncoder
    // the .length-based check would let this through.
    const thaiChar = 'ก' // 3 bytes in UTF-8
    const repeat = Math.ceil(USER_ENVELOPE_MAX_BYTES / 3) + 10
    const huge = thaiChar.repeat(repeat)
    await expect(
      saveUserEnvelope(store, 'demo', 'alice', { huge }, dek),
    ).rejects.toThrow(UserEnvelopeOversizedError)
  })

  it('deletes idempotently', async () => {
    await saveUserEnvelope(store, 'demo', 'alice', { n: 1 }, dek)
    await deleteUserEnvelope(store, 'demo', 'alice')
    expect(await loadUserEnvelope(store, 'demo', 'alice', dek)).toBeNull()
    // Second delete is a no-op.
    await expect(deleteUserEnvelope(store, 'demo', 'alice')).resolves.toBeUndefined()
  })

  it('lists all keyring ids with persisted envelopes', async () => {
    await saveUserEnvelope(store, 'demo', 'alice', { n: 1 }, dek)
    await saveUserEnvelope(store, 'demo', 'bob', { n: 1 }, dek)
    await saveUserEnvelope(store, 'demo', 'carol', { n: 1 }, dek)
    const ids = await listUserEnvelopeIds(store, 'demo')
    expect([...ids].sort()).toEqual(['alice', 'bob', 'carol'])

    await deleteUserEnvelope(store, 'demo', 'bob')
    const ids2 = await listUserEnvelopeIds(store, 'demo')
    expect([...ids2].sort()).toEqual(['alice', 'carol'])
  })

  it('isolates envelopes per vault', async () => {
    await saveUserEnvelope(store, 'vaultA', 'alice', { vault: 'A' }, dek)
    await saveUserEnvelope(store, 'vaultB', 'alice', { vault: 'B' }, dek)
    const a = await loadUserEnvelope<{ vault: string }>(store, 'vaultA', 'alice', dek)
    const b = await loadUserEnvelope<{ vault: string }>(store, 'vaultB', 'alice', dek)
    expect(a!.data.vault).toBe('A')
    expect(b!.data.vault).toBe('B')
  })

  it('preserves arbitrary JSON-serializable payloads opaquely', async () => {
    // Hub does not introspect the payload — any JSON-serializable shape
    // must round-trip identically.
    const exotic = {
      profile: { displayName: 'Vícioṩ' },
      app: { tags: ['a', 'b'], nested: { deep: { value: 42 } }, opt: null },
      preferences: { keyWithDot: 'v', 'key with space': 'v' },
    }
    await saveUserEnvelope(store, 'demo', 'alice', exotic, dek)
    const got = await loadUserEnvelope<typeof exotic>(store, 'demo', 'alice', dek)
    expect(got!.data).toEqual(exotic)
  })
})
