import { describe, it, expect } from 'vitest'
import { loadOrCreateSigner } from '../src/attestation/signer.js'
import { generateDEK } from '../src/crypto.js'
import { ed25519Verify, signPayloadCore } from '@noy-db/attestation'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/types.js'
import { ConflictError } from '../src/errors.js'

function memory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const gc = (v: string, c: string) => {
    let comp = store.get(v); if (!comp) { comp = new Map(); store.set(v, comp) }
    let coll = comp.get(c); if (!coll) { coll = new Map(); comp.set(c, coll) }
    return coll
  }
  return {
    name: 'memory',
    async get(v, c, id) { return store.get(v)?.get(c)?.get(id) ?? null },
    async put(v, c, id, env, ev) { const coll = gc(v, c); const ex = coll.get(id); if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v); coll.set(id, env) },
    async delete(v, c, id) { store.get(v)?.get(c)?.delete(id) },
    async list(v, c) { const coll = store.get(v)?.get(c); return coll ? [...coll.keys()] : [] },
    async loadAll(v) { const comp = store.get(v); const s: VaultSnapshot = {}; if (comp) for (const [n, coll] of comp) { if (!n.startsWith('_')) { const r: Record<string, EncryptedEnvelope> = {}; for (const [id, e] of coll) r[id] = e; s[n] = r } } return s },
    async saveAll(v, data) { const comp = new Map<string, Map<string, EncryptedEnvelope>>(); for (const [n, recs] of Object.entries(data)) { const coll = new Map<string, EncryptedEnvelope>(); for (const [id, e] of Object.entries(recs)) coll.set(id, e); comp.set(n, coll) } const ex = store.get(v); if (ex) for (const [n, coll] of ex) if (n.startsWith('_')) comp.set(n, coll); store.set(v, comp) },
  }
}

describe('loadOrCreateSigner', () => {
  it('mints + persists a signer on first call, reuses it on the second (same keyId)', async () => {
    const store = memory()
    const dek = await generateDEK()
    const getDEK = async () => dek

    const a = await loadOrCreateSigner(store, 'v1', getDEK)
    expect(a.keyId).toHaveLength(16)
    expect(a.publicKeyB64).toBeTruthy()

    const b = await loadOrCreateSigner(store, 'v1', getDEK)
    expect(b.keyId).toBe(a.keyId)
    expect(b.publicKeyB64).toBe(a.publicKeyB64)
    expect(b.privateKeyPkcs8B64).toBe(a.privateKeyPkcs8B64)
  })

  it('the persisted _signer record is encrypted (non-empty _iv) and round-trips a real signature', async () => {
    const store = memory()
    const dek = await generateDEK()
    const getDEK = async () => dek
    const signer = await loadOrCreateSigner(store, 'v1', getDEK)

    const env = await store.get('v1', '_attestations', '_signer')
    expect(env).toBeTruthy()
    expect(env!._iv).not.toBe('')

    const sig = await signPayloadCore({ v: 1, docId: 'd', salt: 's', keyId: signer.keyId, fieldHashes: ['h'] }, signer.privateKeyPkcs8B64)
    const { utf8, canonicalJson } = await import('@noy-db/attestation')
    const core = utf8(canonicalJson({ v: 1, docId: 'd', salt: 's', keyId: signer.keyId, fieldHashes: ['h'] }))
    expect(await ed25519Verify(signer.publicKeyB64, sig, core)).toBe(true)
  })
})
