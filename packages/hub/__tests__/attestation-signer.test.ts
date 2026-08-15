import { describe, it, expect } from 'vitest'
import { loadOrCreateSigner, loadSigner, SIGNER_RECORD_ID, ATTESTATIONS_COLLECTION, type DocSigner } from '../src/with-audit/attestation/signer.js'
import { buildRecordAad, generateDEK, encrypt } from '../src/kernel/enclave/index.js'
import { ed25519Verify, signPayloadCore, generateDocSigningKeyPair } from '@noy-db/attestation'
import { NOYDB_FORMAT_VERSION } from '../src/kernel/types.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { ConflictError } from '../src/kernel/errors.js'

function toMemory(): NoydbStore {
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
    const store = toMemory()
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
    const store = toMemory()
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

/**
 * Models the exact lost-race sequence deterministically (no Promise.all
 * interleaving): the first `get` returns null (winner hasn't committed from
 * this caller's view, so it proceeds to mint), the `put(…, 0)` throws
 * ConflictError (another writer committed in between), and the re-read `get`
 * now returns the winner. With `winnerEnv: null` the winner stays invisible
 * even after the put — the pathological "record vanished" case.
 */
function lostRaceStore(winnerEnv: EncryptedEnvelope | null): { store: NoydbStore; putCalls: number } {
  const state = { putCalls: 0 }
  const store: NoydbStore = {
    name: 'lost-race',
    async get(_v, c, id) {
      if (c !== ATTESTATIONS_COLLECTION || id !== SIGNER_RECORD_ID) return null
      return state.putCalls > 0 ? winnerEnv : null // winner visible only after the losing put
    },
    async put() { state.putCalls++; throw new ConflictError(1, 'Version conflict: expected 0, found 1') },
    async delete() {},
    async list() { return [] },
    async loadAll() { return {} as VaultSnapshot },
    async saveAll() {},
  }
  return { store, get putCalls() { return state.putCalls } }
}

async function sealSigner(signer: DocSigner, dek: CryptoKey): Promise<EncryptedEnvelope> {
  // #1041: sealed against `_attestations/__signer__`, where it is stored.
  const { iv, data } = await encrypt(JSON.stringify(signer), dek, buildRecordAad({ collection: ATTESTATIONS_COLLECTION, id: SIGNER_RECORD_ID }))
  return { _noydb: NOYDB_FORMAT_VERSION, _v: 1, _ts: '2026-05-31T00:00:00.000Z', _iv: iv, _data: data }
}

describe('loadOrCreateSigner — concurrent first-mint (lost race)', () => {
  it('on ConflictError, re-reads and returns the winner signer (convergence, not its own mint)', async () => {
    const dek = await generateDEK()
    const getDEK = async () => dek
    const winner = await generateDocSigningKeyPair()
    const race = lostRaceStore(await sealSigner(winner, dek))

    const result = await loadOrCreateSigner(race.store, 'v1', getDEK)

    // The loser minted its own keypair in memory, but converges on the winner.
    expect(result.keyId).toBe(winner.keyId)
    expect(result.publicKeyB64).toBe(winner.publicKeyB64)
    expect(result.privateKeyPkcs8B64).toBe(winner.privateKeyPkcs8B64)
    expect(race.putCalls).toBe(1) // attempted once, did not retry/clobber
  })

  it('throws (not null) if the conflicting record vanishes before re-read', async () => {
    const dek = await generateDEK()
    const getDEK = async () => dek
    // get returns null (record gone), but put still throws ConflictError →
    // pathological: must surface a clear error, never let null escape.
    const { store } = lostRaceStore(null)

    await expect(loadOrCreateSigner(store, 'v1', getDEK)).rejects.toThrow()
  })
})

describe('loadSigner — pure read (never mints)', () => {
  it('returns null when no signer exists and writes nothing', async () => {
    const store = toMemory()
    const dek = await generateDEK()
    const getDEK = async () => dek

    const result = await loadSigner(store, 'v1', getDEK)

    expect(result).toBeNull()
    expect(await store.get('v1', ATTESTATIONS_COLLECTION, SIGNER_RECORD_ID)).toBeNull()
  })

  it('returns the persisted signer when one exists', async () => {
    const store = toMemory()
    const dek = await generateDEK()
    const getDEK = async () => dek
    const minted = await loadOrCreateSigner(store, 'v1', getDEK)

    const loaded = await loadSigner(store, 'v1', getDEK)
    expect(loaded?.keyId).toBe(minted.keyId)
  })
})
