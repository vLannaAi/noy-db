import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/kernel/noydb.js'
import { withAttestation } from '../src/with-audit/attestation/index.js'
import { AttestationNotEnabledError } from '../src/kernel/errors.js'
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
const attestation = { fields: [
  { path: 'invoiceNo', normalize: 'alnum-upper' as const },
  { path: 'total', normalize: 'cents' as const },
  { path: 'issueDate', normalize: 'iso-date' as const },
] }

describe('attestation capability gate (withAttestation)', () => {
  it('throws AttestationNotEnabledError when not opted in', async () => {
    const db = await createNoydb({ store: memory(), user: 'firm', secret: 'pw-123456' })
    const v = await db.openVault('books')
    await v.collection<Invoice>('invoices', { attestation }).put('x', { id: 'x', invoiceNo: 'A', total: 1, issueDate: '2026-05-29' })
    await expect(v.issueAttestation('invoices', 'x')).rejects.toThrow(AttestationNotEnabledError)
  })

  it('gates all six capability methods when not opted in', async () => {
    const db = await createNoydb({ store: memory(), user: 'firm', secret: 'pw-123456' })
    const v = await db.openVault('books')
    await v.collection<Invoice>('invoices', { attestation }).put('x', { id: 'x', invoiceNo: 'A', total: 1, issueDate: '2026-05-29' })
    await expect(v.issueAttestation('invoices', 'x')).rejects.toThrow(AttestationNotEnabledError)
    await expect(v.getDocumentSigningPublicKey()).rejects.toThrow(AttestationNotEnabledError)
    await expect(v.revokeAttestation('01JNEVERISSUED0000000000XX')).rejects.toThrow(AttestationNotEnabledError)
    await expect(v.unrevokeAttestation('01JNEVERISSUED0000000000XX')).rejects.toThrow(AttestationNotEnabledError)
    await expect(v.getRevokedDocIds()).rejects.toThrow(AttestationNotEnabledError)
    await expect(v.publishRevocationList()).rejects.toThrow(AttestationNotEnabledError)
  })

  it('works when opted in via withAttestation()', async () => {
    const db = await createNoydb({ store: memory(), user: 'firm', secret: 'pw-123456', attestationStrategy: withAttestation() })
    const v = await db.openVault('books')
    await v.collection<Invoice>('invoices', { attestation }).put('x', { id: 'x', invoiceNo: 'A', total: 1, issueDate: '2026-05-29' })
    const r = await v.issueAttestation('invoices', 'x')
    expect(r.docId).toHaveLength(26)
  })
})
