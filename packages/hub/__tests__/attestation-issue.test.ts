import { describe, it, expect } from 'vitest'
import { issueAttestationCore } from '../src/with-audit/attestation/issue.js'
import { verifyAttestation } from '@noy-db/attestation'
import type { AttestationFieldSchema } from '@noy-db/attestation'
import { generateDEK, decrypt } from '../src/kernel/enclave/crypto.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
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

const schema: AttestationFieldSchema = {
  fields: [
    { path: 'invoiceNo', normalize: 'alnum-upper' },
    { path: 'total', normalize: 'cents' },
    { path: 'issueDate', normalize: 'iso-date' },
  ],
}
const record = { invoiceNo: 'INV-1001', total: 1234.5, issueDate: '2026-05-29' }

async function makeCtx(over: Partial<{ role: string; readRecord: (c: string, id: string) => Promise<{ record: Record<string, unknown>; version: number } | null> }> = {}) {
  const store = memory()
  const dek = await generateDEK()
  return {
    store, dek,
    ctx: {
      store, vault: 'v1', role: 'owner',
      getDEK: async () => dek,
      readRecord: async (_c: string, _id: string) => ({ record, version: 3 }),
      ...over,
    },
  }
}

describe('issueAttestationCore', () => {
  it('issues a QR that verifyAttestation accepts for the same fields + published key', async () => {
    const { ctx } = await makeCtx()
    const out = await issueAttestationCore(ctx, { collection: 'invoices', id: 'inv-1001', fieldSchema: schema })
    expect(out.docId).toHaveLength(26)
    expect(out.keyId).toHaveLength(16)
    const r = await verifyAttestation({ qr: out.qr, claimedFields: record, fieldSchema: schema, publicKeys: { [out.keyId]: out.publicKeyB64 } })
    expect(r.valid).toBe(true)
    expect(r.perField.every((f) => f.match)).toBe(true)
  })

  it('detects a later edit: verifying against altered fields fails that field', async () => {
    const { ctx } = await makeCtx()
    const out = await issueAttestationCore(ctx, { collection: 'invoices', id: 'inv-1001', fieldSchema: schema })
    const r = await verifyAttestation({ qr: out.qr, claimedFields: { ...record, total: 9999 }, fieldSchema: schema, publicKeys: { [out.keyId]: out.publicKeyB64 } })
    expect(r.valid).toBe(false)
    expect(r.perField.find((f) => f.path === 'total')!.match).toBe(false)
  })

  it('writes an encrypted _attestations/<docId> index pinning the source version', async () => {
    const { ctx, store, dek } = await makeCtx()
    const out = await issueAttestationCore(ctx, { collection: 'invoices', id: 'inv-1001', fieldSchema: schema })
    const env = await store.get('v1', '_attestations', out.docId)
    expect(env).toBeTruthy()
    expect(env!._iv).not.toBe('')
    const idx = JSON.parse(await decrypt(env!._iv, env!._data, dek)) as { sourceRefs: { collection: string; id: string; version: number }[] }
    expect(idx.sourceRefs[0]).toEqual({ collection: 'invoices', id: 'inv-1001', version: 3 })
  })

  it('reuses the same signer across issues (stable keyId)', async () => {
    const { ctx } = await makeCtx()
    const a = await issueAttestationCore(ctx, { collection: 'invoices', id: 'inv-1001', fieldSchema: schema })
    const b = await issueAttestationCore(ctx, { collection: 'invoices', id: 'inv-1002', fieldSchema: schema })
    expect(b.keyId).toBe(a.keyId)
  })

  it('rejects a non-owner caller', async () => {
    const { ctx } = await makeCtx({ role: 'admin' })
    await expect(issueAttestationCore(ctx, { collection: 'invoices', id: 'inv-1001', fieldSchema: schema })).rejects.toThrow(/owner/)
  })

  it('rejects a missing source record', async () => {
    const { ctx } = await makeCtx({ readRecord: async () => null })
    await expect(issueAttestationCore(ctx, { collection: 'invoices', id: 'nope', fieldSchema: schema })).rejects.toThrow(/not found/)
  })
})
