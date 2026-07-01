import { describe, it, expect } from 'vitest'
import {
  revokeDocCore, unrevokeDocCore, getRevokedDocIdsCore, publishRevocationListCore,
  type RevokeContext,
} from '../src/with-audit/attestation/revoke.js'
import { loadOrCreateSigner } from '../src/with-audit/attestation/signer.js'
import { generateDEK } from '../src/kernel/enclave/crypto.js'
import { verifyRevocationList, isRevoked } from '@noy-db/attestation'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { NOYDB_FORMAT_VERSION } from '../src/kernel/types.js'
import { ConflictError } from '../src/errors.js'

function memory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const gc = (v: string, c: string) => { let comp = store.get(v); if (!comp) { comp = new Map(); store.set(v, comp) } let coll = comp.get(c); if (!coll) { coll = new Map(); comp.set(c, coll) } return coll }
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

async function seedIssued(store: NoydbStore, vault: string, docId: string) {
  const env: EncryptedEnvelope = { _noydb: NOYDB_FORMAT_VERSION, _v: 1, _ts: 't', _iv: 'iv', _data: 'data' }
  await store.put(vault, '_attestations', docId, env)
}

async function makeCtx(role = 'owner') {
  const store = memory()
  const dek = await generateDEK()
  const ctx: RevokeContext = { store, vault: 'v1', role, getDEK: async () => dek }
  return { store, dek, ctx }
}

describe('revoke core', () => {
  it('revoke adds a docId; idempotent; getRevokedDocIds reflects it', async () => {
    const { store, ctx } = await makeCtx()
    await seedIssued(store, 'v1', 'd1')
    await revokeDocCore(ctx, 'd1')
    await revokeDocCore(ctx, 'd1')
    expect(await getRevokedDocIdsCore(ctx)).toEqual(['d1'])
  })

  it('accumulates multiple docIds (sorted)', async () => {
    const { store, ctx } = await makeCtx()
    await seedIssued(store, 'v1', 'd2'); await seedIssued(store, 'v1', 'd1')
    await revokeDocCore(ctx, 'd2'); await revokeDocCore(ctx, 'd1')
    expect(await getRevokedDocIdsCore(ctx)).toEqual(['d1', 'd2'])
  })

  it('unrevoke removes a docId (no-op if absent)', async () => {
    const { store, ctx } = await makeCtx()
    await seedIssued(store, 'v1', 'd1')
    await revokeDocCore(ctx, 'd1')
    await unrevokeDocCore(ctx, 'd1')
    await unrevokeDocCore(ctx, 'nope')
    expect(await getRevokedDocIdsCore(ctx)).toEqual([])
  })

  it('revoking an un-issued docId throws not-found', async () => {
    const { ctx } = await makeCtx()
    await expect(revokeDocCore(ctx, 'never-issued')).rejects.toThrow(/not found/)
  })

  it('non-owner cannot revoke or publish', async () => {
    const { store, ctx } = await makeCtx('admin')
    await seedIssued(store, 'v1', 'd1')
    await expect(revokeDocCore(ctx, 'd1')).rejects.toThrow(/owner/)
    await expect(publishRevocationListCore(ctx)).rejects.toThrow(/owner/)
  })

  it('publishRevocationList signs a list that verifies + reports the docId revoked', async () => {
    const { store, dek, ctx } = await makeCtx()
    await seedIssued(store, 'v1', 'd1')
    await revokeDocCore(ctx, 'd1')
    const list = await publishRevocationListCore(ctx)
    const signer = await loadOrCreateSigner(store, 'v1', () => Promise.resolve(dek))
    expect(list.keyId).toBe(signer.keyId)
    expect(await verifyRevocationList(list, signer.publicKeyB64)).toBe(true)
    expect(isRevoked('d1', list)).toBe(true)
    expect(isRevoked('other', list)).toBe(false)
  })

  it('publishing an empty set yields a valid signed empty list', async () => {
    const { store, dek, ctx } = await makeCtx()
    const list = await publishRevocationListCore(ctx)
    const signer = await loadOrCreateSigner(store, 'v1', () => Promise.resolve(dek))
    expect(list.revokedDocIds).toEqual([])
    expect(await verifyRevocationList(list, signer.publicKeyB64)).toBe(true)
  })

  it('retries once on a ConflictError during the read-modify-write', async () => {
    const { store, ctx } = await makeCtx()
    await seedIssued(store, 'v1', 'd1')
    let firstPut = true
    const wrapped: NoydbStore = {
      ...store,
      async put(v, c, id, env, ev) {
        if (c === '_attestations' && id === '_revoked' && firstPut) { firstPut = false; throw new ConflictError(99) }
        return store.put(v, c, id, env, ev)
      },
    }
    const ctx2: RevokeContext = { ...ctx, store: wrapped }
    await revokeDocCore(ctx2, 'd1')
    expect(await getRevokedDocIdsCore(ctx2)).toEqual(['d1'])
  })
})
