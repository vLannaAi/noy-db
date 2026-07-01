import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/kernel/noydb.js'
import { verifyRevocationList, isRevoked, type AttestationFieldSchema } from '@noy-db/attestation'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { ConflictError } from '../src/kernel/errors.js'

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

interface Invoice { id: string; invoiceNo: string; total: number; issueDate: string }
const attestation: AttestationFieldSchema = {
  fields: [
    { path: 'invoiceNo', normalize: 'alnum-upper' },
    { path: 'total', normalize: 'cents' },
    { path: 'issueDate', normalize: 'iso-date' },
  ],
}

async function ownerVault() {
  const db = await createNoydb({ store: memory(), user: 'firm', secret: 'firm-passphrase-2026' })
  const vault = await db.openVault('books')
  await vault.collection<Invoice>('invoices', { attestation }).put('inv-1', { id: 'inv-1', invoiceNo: 'INV-1', total: 1234.5, issueDate: '2026-05-29' })
  return vault
}

describe('vault revocation (integration)', () => {
  it('revoke → publish → the signed list verifies + reports the docId revoked', async () => {
    const vault = await ownerVault()
    const { docId, keyId } = await vault.issueAttestation('invoices', 'inv-1')

    await vault.revokeAttestation(docId)
    expect(await vault.getRevokedDocIds()).toEqual([docId])

    const list = await vault.publishRevocationList()
    const { publicKeyB64 } = await vault.getDocumentSigningPublicKey()
    expect(list.keyId).toBe(keyId)
    expect(await verifyRevocationList(list, publicKeyB64)).toBe(true)
    expect(isRevoked(docId, list)).toBe(true)
  })

  it('unrevoke clears it; a fresh list no longer reports it revoked', async () => {
    const vault = await ownerVault()
    const { docId } = await vault.issueAttestation('invoices', 'inv-1')
    await vault.revokeAttestation(docId)
    await vault.unrevokeAttestation(docId)
    expect(await vault.getRevokedDocIds()).toEqual([])
    const list = await vault.publishRevocationList()
    expect(isRevoked(docId, list)).toBe(false)
  })

  it('revoking an un-issued docId throws', async () => {
    const vault = await ownerVault()
    await expect(vault.revokeAttestation('01JNEVERISSUED0000000000XX')).rejects.toThrow(/not found/)
  })
})
